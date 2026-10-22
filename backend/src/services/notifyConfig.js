'use strict'

/**
 * 钉钉通知配置（隐患闭环）
 * ───────────────────────────────────────────────────────────────────────────
 * 存于 t_system_config（config_key = 'dingtalk_notify_config'，JSON 字符串）。
 * 提供：
 *   - loadNotifyConfig()   同步读缓存（运行时热路径，不查 DB）
 *   - saveNotifyConfig(cfg) 异步校验 + 持久化 + 刷新缓存
 *   - refreshCache()       异步从 DB 重载缓存（server 启动 / 保存后调用）
 *   - DEFAULT_DINGTALK_NOTIFY_CONFIG 默认值
 *   - EVENT_TO_KEY          事件类型 → 配置 events 的 key 映射
 *
 * 设计要点：
 *   - 缓存为空时 loadNotifyConfig 同步返回默认并 fire-and-forget 触发 refresh，
 *     避免同步阻塞（pool 为 promise，无法同步查库）。
 *   - server 启动 autoMigrate 后主动 refreshCache 一次，使缓存尽快生效。
 *   - PUT 保存后立即 refreshCache，配置变更即时生效（无需重启）。
 */

const { pool } = require('../db/db')

const CONFIG_KEY = 'dingtalk_notify_config'

const DEFAULT_DINGTALK_NOTIFY_CONFIG = {
  // 总开关（DB 优先，覆盖 .env 的 DINGTALK_ROBOT_ENABLED）
  enabled: true,
  // 各事件独立开关（满足"提醒什么内容"）
  events: {
    overdue: true,        // 超期合并提醒（OVERDUE / OVERDUE_DIGEST）
    weekly_excel: true,   // 未整改隐患周报（WEEKLY_EXCEL）
    report: false,        // 新隐患上报（REPORT）
    assign: false,        // 整改分派（ASSIGN）
    verify: false,        // 验收结果（VERIFY）
    weekly: false,        // 周通报（WEEKLY）
    daily_digest: false,  // 每日摘要（DIGEST）
  },
  // 频次
  frequency: {
    overdue_interval_days: 1, // 超期提醒通知间隔（天）：1=每天 / 2 / 3 / 7=每周
    scan_interval_min: 60,    // 超期扫描间隔（分钟）
    weekly_excel_day: 3,      // 未整改周报发送日（1-7，周一~周日）
    weekly_excel_hour: 1,     // 未整改周报发送时刻（0-23）
    weekly_day: 1,            // 周通报发送日（预留）
    weekly_hour: 9,           // 周通报时刻（预留）
  },
  // @范围（提醒发给谁）
  at_scope: {
    owner: true,        // @整改责任人
    party_a: true,      // @甲方（业务主管部门）联系人
    safety_office: true, // @项目部安全环保室
  },
}

// 事件类型 → 配置 events 的 key
const EVENT_TO_KEY = {
  OVERDUE: 'overdue',
  OVERDUE_DIGEST: 'overdue',
  WEEKLY_EXCEL: 'weekly_excel',
  REPORT: 'report',
  ASSIGN: 'assign',
  VERIFY: 'verify',
  WEEKLY: 'weekly',
  DIGEST: 'daily_digest',
}

let cache = null

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!over || typeof over !== 'object') return out
  for (const k of Object.keys(over)) {
    const bv = base ? base[k] : undefined
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, over[k])
    } else {
      out[k] = over[k]
    }
  }
  return out
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_DINGTALK_NOTIFY_CONFIG))
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 同步读缓存；缓存为空时返回默认并异步触发刷新 */
function loadNotifyConfig() {
  if (cache) return cache
  refreshCache().catch((e) => console.error('[notifyConfig] 初始化刷新失败', e.message))
  return cloneDefault()
}

/** 异步从 DB 重载缓存 */
async function refreshCache() {
  try {
    const [rows] = await pool.execute(
      'SELECT config_value FROM t_system_config WHERE config_key = ? LIMIT 1',
      [CONFIG_KEY]
    )
    if (rows.length && rows[0].config_value) {
      const saved = JSON.parse(rows[0].config_value)
      cache = deepMerge(cloneDefault(), saved)
    } else {
      cache = cloneDefault()
    }
  } catch (e) {
    console.error('[notifyConfig] 读取失败，使用默认配置:', e.message)
    cache = cloneDefault()
  }
  return cache
}

/** 校验 + 持久化 + 刷新缓存 */
async function saveNotifyConfig(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('配置必须是对象')
  }
  const merged = deepMerge(cloneDefault(), input)

  // 布尔归一
  merged.enabled = !!merged.enabled
  for (const k of Object.keys(merged.events)) merged.events[k] = !!merged.events[k]
  for (const k of Object.keys(merged.at_scope)) merged.at_scope[k] = !!merged.at_scope[k]

  // 数值范围校验
  const f = merged.frequency
  f.overdue_interval_days = clampInt(f.overdue_interval_days, 1, 30, 1)
  f.scan_interval_min = clampInt(f.scan_interval_min, 5, 1440, 60)
  f.weekly_excel_day = clampInt(f.weekly_excel_day, 1, 7, 3)
  f.weekly_excel_hour = clampInt(f.weekly_excel_hour, 0, 23, 1)
  f.weekly_day = clampInt(f.weekly_day, 1, 7, 1)
  f.weekly_hour = clampInt(f.weekly_hour, 0, 23, 9)

  const json = JSON.stringify(merged)
  await pool.execute(
    'INSERT INTO t_system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
    [CONFIG_KEY, json, json]
  )
  await refreshCache()
  return merged
}

module.exports = {
  CONFIG_KEY,
  DEFAULT_DINGTALK_NOTIFY_CONFIG,
  EVENT_TO_KEY,
  loadNotifyConfig,
  saveNotifyConfig,
  refreshCache,
}
