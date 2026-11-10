'use strict'

/**
 * 直接作业预约报备 · 钉钉表格同步
 * ───────────────────────────────────────────────────────────────────────────
 * 数据流：钉钉在线表格（「通南巴直接作业」群）→ 本服务解析 → t_site_permit
 *
 * 同步策略：
 *   - 每天 22:00 由 node-cron 触发（也可在后台点「立即同步」）
 *   - **全表镜像**：以 (sheet_name + row_hash) 为键 upsert，
 *     本次没再出现的旧行置 is_active=0（保留历史，列表默认只看在用行）
 *   - 行哈希取「施工单位 + 施工内容 + 预计施工时间 + 上报人」等业务字段，
 *     与行在表格中的位置无关，别人插行/调序不会造成重复
 *
 * 配置存 t_system_config（config_key = 'site_permit_sync_config'）。
 */

const crypto = require('crypto')
const { pool } = require('../db/db')
const dingDoc = require('./dingtalkDoc')

const CONFIG_KEY = 'site_permit_sync_config'

const DEFAULT_CONFIG = {
  enabled: false,
  sourceType: 'workbook',        // workbook=钉钉表格 | notable=智能表格(AI表格)
  appKey: '',
  appSecret: '',
  workbookId: '',                // 钉钉表格文档 ID
  baseId: '',                    // 智能表格 baseId
  operatorId: '',                // 操作人 unionId（必须是表格协作者）
  sheetNames: [],                // 空=全部分表
  rangeEnd: 'Q300',
  cronHour: 22,
  cronMinute: 0,
  lastSyncAt: null,
  lastSyncStatus: '',            // ok | fail | ''
  lastSyncMsg: '',
}

// ─── 配置读写 ────────────────────────────────────────────────────────────────
async function loadConfig() {
  const [rows] = await pool.execute(
    'SELECT config_value FROM t_system_config WHERE config_key = ? LIMIT 1', [CONFIG_KEY]
  )
  let saved = {}
  if (rows.length && rows[0].config_value) {
    try { saved = JSON.parse(rows[0].config_value) || {} } catch (e) { saved = {} }
  }
  return { ...DEFAULT_CONFIG, ...saved }
}

async function saveConfig(patch) {
  const cur = await loadConfig()
  const next = { ...cur }
  const allow = [
    'enabled', 'sourceType', 'appKey', 'appSecret', 'workbookId', 'baseId',
    'operatorId', 'sheetNames', 'rangeEnd', 'cronHour', 'cronMinute',
  ]
  for (const k of allow) {
    if (patch[k] !== undefined) next[k] = patch[k]
  }
  // 前端未改动密钥时会回传掩码，原样保留旧值
  if (typeof next.appSecret === 'string' && /^\*+$/.test(next.appSecret.trim())) next.appSecret = cur.appSecret
  next.cronHour = Math.min(23, Math.max(0, Number(next.cronHour) || 22))
  next.cronMinute = Math.min(59, Math.max(0, Number(next.cronMinute) || 0))
  if (!Array.isArray(next.sheetNames)) next.sheetNames = []
  next.rangeEnd = String(next.rangeEnd || 'Q300').replace(/[^A-Z0-9:]/gi, '').toUpperCase() || 'Q300'

  await pool.execute(
    `INSERT INTO t_system_config (config_key, config_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [CONFIG_KEY, JSON.stringify(next)]
  )
  return next
}

/** 对外展示用：密钥打码 */
function maskConfig(cfg) {
  const out = { ...cfg }
  if (out.appSecret) out.appSecret = '******'
  return out
}

// ─── 值解析 ──────────────────────────────────────────────────────────────────
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/**
 * 数值 → 北京时间墙上时间
 * Excel/钉钉序列号的整数部分是日期、小数部分是当天时刻（.375 = 9:00），
 * 序列号表达的**本身就是北京时间的墙上时间**，所以直接按 UTC 读出来即可，
 * 千万不要再 +8 小时（否则纯日期的 00:00 会变成 08:00，整表日期错位一天）。
 */
function serialToDate(n) {
  // 取整到分钟：.3333333 这种浮点误差否则会显示成 07:59
  const ms = EXCEL_EPOCH + Number(n) * 86400000
  return new Date(Math.round(ms / 60000) * 60000)
}

/**
 * 解析日期/时间单元格，返回 { date:'YYYY-MM-DD', time:'HH:mm'|'', dt:'YYYY-MM-DD HH:mm:ss'|null }
 * 容忍：2026/11/9、2026.11.9、2026年11月9日、2026//11/10、46337.375、2026-11-09 09:00
 */
function parseDateTime(v) {
  if (v === null || v === undefined || v === '') return { date: '', time: '', dt: null }
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const d = serialToDate(v)
    if (Number.isNaN(d.getTime())) return { date: '', time: '', dt: null }
    const p = (x) => String(x).padStart(2, '0')
    const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    const hh = d.getUTCHours()
    const mm = d.getUTCMinutes()
    const time = hh || mm ? `${p(hh)}:${p(mm)}` : ''
    return { date, time, dt: time ? `${date} ${time}:00` : `${date} 00:00:00` }
  }
  let s = String(v).trim()
  s = s.replace(/[年月]/g, '-').replace(/日/g, '')
  s = s.replace(/[.\/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2}))?/)
  if (!m) return { date: '', time: '', dt: null }
  const y = Number(m[1]); const mo = Number(m[2]); const da = Number(m[3])
  if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return { date: '', time: '', dt: null }
  const p = (x) => String(x).padStart(2, '0')
  const date = `${y}-${p(mo)}-${p(da)}`
  const time = m[4] !== undefined ? `${p(Number(m[4]))}:${p(Number(m[5] || 0))}` : ''
  return { date, time, dt: time ? `${date} ${time}:00` : `${date} 00:00:00` }
}

function str(v) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\r\n?/g, '\n').trim()
}

// ─── 表头识别 ────────────────────────────────────────────────────────────────
/** 表头关键字 → 数据库字段（顺序即优先级，先匹配到的先占位） */
const FIELD_MAP = [
  ['seq_no', ['序号']],
  ['apply_unit', ['申请单位']],
  ['work_unit', ['施工单位']],
  ['content', ['施工内容']],
  ['place', ['施工地点']],
  ['camera', ['监控设备']],
  ['work_type', ['施工作业类别', '作业类别']],
  ['dual_op', ['双边作业']],
  ['risk_level', ['风险分级', '风险等级']],
  ['measures', ['风险管控措施', '管控措施']],
  ['leader', ['带班人']],
  ['supervisor', ['监护人']],
  ['plan_time_raw', ['预计施工时间', '计划施工时间', '施工时间']],
  ['auditor', ['审核人']],
  ['reporter', ['上报人']],
  ['report_date_raw', ['上报日期']],
  ['remark', ['备注']],
]

function normHeader(h) {
  return String(h || '').replace(/[\s\n\t]/g, '')
}

/** 在前 12 行里找表头行：命中「序号」+「施工单位/施工内容」 */
function detectHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = (rows[i] || []).map(normHeader)
    const joined = cells.join('|')
    if (/序号/.test(joined) && /(施工单位|施工内容|风险分级)/.test(joined)) {
      return { index: i, headers: cells }
    }
  }
  return null
}

/** 表头 → { 字段: 列下标 } */
function buildColumnMap(headers) {
  const map = {}
  const used = new Set()
  for (const [field, keys] of FIELD_MAP) {
    for (let c = 0; c < headers.length; c++) {
      if (used.has(c)) continue
      const h = headers[c]
      if (!h) continue
      if (keys.some((k) => h.includes(k))) {
        map[field] = c
        used.add(c)
        break
      }
    }
  }
  return map
}

function rowHash(sheetName, row, map) {
  const parts = [
    sheetName,
    str(row[map.work_unit]), str(row[map.content]),
    str(row[map.plan_time_raw]), str(row[map.reporter]),
    str(row[map.place]),
  ]
  return crypto.createHash('md5').update(parts.join('\u0001')).digest('hex')
}

/**
 * 单元格原值 → 展示用文本
 * 钉钉/Excel 里日期常是序列号（46337.8333333333），直接落库后前端只能显示一串数字。
 * 若能解析出日期，就用解析结果回填；否则保留原文（可能是「2026-11-09 20:00-00:00」这类手写文本）。
 */
function prettyRaw(v, parsed) {
  const s = str(v)
  if (!s) return ''
  const isSerial = typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(s)
  if (!isSerial) return s.slice(0, 60)
  if (!parsed || !parsed.date) return s.slice(0, 60)
  return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date
}

/** 一张工作表的二维数组 → 结构化记录 */
function parseSheet(sheetName, rows) {
  const head = detectHeader(rows)
  if (!head) {
    // 标准表里常夹带「作业类别下拉选项」这类辅助页（每行一个词，无表头），
    // 属于正常情况，静默跳过，不算错误。
    return { error: '', skipped: true, records: [] }
  }
  const map = buildColumnMap(head.headers)
  if (map.work_unit === undefined && map.content === undefined) {
    return { error: `工作表「${sheetName}」表头缺少「施工单位/施工内容」列`, skipped: false, records: [] }
  }
  const records = []
  for (let r = head.index + 1; r < rows.length; r++) {
    const row = rows[r] || []
    const workUnit = str(row[map.work_unit])
    const content = str(row[map.content])
    if (!workUnit && !content) continue                       // 整行空 → 跳过
    if (/序号/.test(normHeader(row[map.seq_no]))) continue     // 重复表头行
    const plan = parseDateTime(row[map.plan_time_raw])
    const report = parseDateTime(row[map.report_date_raw])
    records.push({
      sheet_name: sheetName,
      row_hash: rowHash(sheetName, row, map),
      seq_no: str(row[map.seq_no]).slice(0, 20),
      apply_unit: str(row[map.apply_unit]).slice(0, 100),
      work_unit: workUnit.slice(0, 150),
      content,
      place: str(row[map.place]).slice(0, 200),
      camera: str(row[map.camera]).slice(0, 200),
      work_type: str(row[map.work_type]).slice(0, 50),
      dual_op: str(row[map.dual_op]).slice(0, 20),
      risk_level: str(row[map.risk_level]).slice(0, 20),
      measures: str(row[map.measures]),
      leader: str(row[map.leader]),
      supervisor: str(row[map.supervisor]),
      plan_time_raw: prettyRaw(row[map.plan_time_raw], plan),
      plan_date: plan.date || null,
      plan_start: plan.dt,
      auditor: str(row[map.auditor]).slice(0, 100),
      reporter: str(row[map.reporter]).slice(0, 100),
      report_date_raw: prettyRaw(row[map.report_date_raw], report),
      report_date: report.date || null,
      remark: str(row[map.remark]),
    })
  }
  return { error: '', records, headerIndex: head.index, columns: map }
}

// ─── 同步主流程 ──────────────────────────────────────────────────────────────
async function startLog(triggeredBy) {
  const [r] = await pool.execute(
    'INSERT INTO t_site_permit_sync (triggered_by, status, message, started_at) VALUES (?, ?, ?, NOW())',
    [triggeredBy, 'running', '']
  )
  return r.insertId
}

async function finishLog(id, status, message, stat) {
  const s = stat || {}
  await pool.execute(
    `UPDATE t_site_permit_sync
       SET status=?, message=?, total_rows=?, new_rows=?, updated_rows=?, inactive_rows=?,
           finished_at=NOW(), duration_ms=TIMESTAMPDIFF(MICROSECOND, started_at, NOW())/1000
     WHERE id=?`,
    [status, String(message || '').slice(0, 1000), s.total || 0, s.inserted || 0, s.updated || 0, s.inactive || 0, id]
  )
}

/** 把一批记录写入 t_site_permit（insert / update / 失效旧行） */
async function persist(records, syncId, stat) {
  const empty = { total: records.length, inserted: 0, updated: 0, inactive: 0, ...(stat || {}) }
  // 用「本批出现的 sheet 名」定位旧行范围，做全表镜像。
  // 注意：必须在写入**之前**快照旧的在用行，否则刚 INSERT 的新行会被误判成"本次没出现的旧行"。
  const sheets = [...new Set(records.map((r) => r.sheet_name))]
  let oldActive = []
  if (sheets.length) {
    const ph = sheets.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT id FROM t_site_permit WHERE source='dingtalk' AND is_active=1 AND sheet_name IN (${ph})`,
      sheets
    )
    oldActive = rows.map((r) => r.id)
  }
  const touched = new Set()

  for (const rec of records) {
    const [exist] = await pool.execute(
      'SELECT id FROM t_site_permit WHERE row_hash = ? LIMIT 1', [rec.row_hash]
    )
    const cols = [
      'sheet_name', 'row_hash', 'seq_no', 'apply_unit', 'work_unit', 'content', 'place', 'camera',
      'work_type', 'dual_op', 'risk_level', 'measures', 'leader', 'supervisor',
      'plan_time_raw', 'plan_date', 'plan_start', 'auditor', 'reporter',
      'report_date_raw', 'report_date', 'remark', 'is_active', 'source', 'sync_id',
    ]
    const vals = [
      rec.sheet_name, rec.row_hash, rec.seq_no, rec.apply_unit, rec.work_unit, rec.content, rec.place, rec.camera,
      rec.work_type, rec.dual_op, rec.risk_level, rec.measures, rec.leader, rec.supervisor,
      rec.plan_time_raw, rec.plan_date, rec.plan_start, rec.auditor, rec.reporter,
      rec.report_date_raw, rec.report_date, rec.remark, 1, 'dingtalk', syncId,
    ]
    if (exist.length) {
      touched.add(exist[0].id)
      await pool.execute(
        `UPDATE t_site_permit SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=NOW() WHERE id=?`,
        [...vals, exist[0].id]
      )
      empty.updated += 1
    } else {
      const [ins] = await pool.execute(
        `INSERT INTO t_site_permit (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        vals
      )
      touched.add(ins.insertId)
      empty.inserted += 1
    }
  }

  // 写入前在用的、本次却没再出现的行 → 失效（保留历史）
  const toOff = oldActive.filter((id) => !touched.has(id))
  if (toOff.length) {
    const ph2 = toOff.map(() => '?').join(',')
    await pool.execute(`UPDATE t_site_permit SET is_active=0, updated_at=NOW() WHERE id IN (${ph2})`, toOff)
    empty.inactive = toOff.length
  }
  return empty
}

/**
 * 执行一次同步
 * @param {'cron'|'manual'} triggeredBy
 * @param {object} opt { dryRun:boolean, rowsBySheet?:[{name,rows}] 用于免凭证自测 }
 */
async function syncNow(triggeredBy, opt) {
  const options = opt || {}
  const cfg = await loadConfig()
  const logId = await startLog(triggeredBy)
  const stat = { total: 0, inserted: 0, updated: 0, inactive: 0 }
  try {
    let sheets
    if (Array.isArray(options.rowsBySheet)) {
      sheets = options.rowsBySheet
    } else {
      const fetched = await dingDoc.fetchAll(cfg)
      sheets = fetched.sheets
    }

    const records = []
    const warnings = []
    const skipped = []
    for (const s of sheets) {
      const p = parseSheet(s.name, s.rows || [])
      if (p.error) { warnings.push(p.error); continue }
      if (p.skipped) { skipped.push(s.name); continue }
      records.push(...p.records)
    }
    stat.total = records.length
    if (!records.length) {
      const msg = warnings.length
        ? warnings.join('；')
        : `钉钉表格里没有读到有效数据行${skipped.length ? `（已跳过无表头的工作表：${skipped.join('、')}）` : ''}`
      await finishLog(logId, 'fail', msg, stat)
      await touchConfig({ lastSyncStatus: 'fail', lastSyncMsg: msg })
      return { ok: false, message: msg, stat, warnings, skipped }
    }

    if (options.dryRun) {
      await finishLog(logId, 'ok', `预演：解析到 ${records.length} 行（未写库）`, stat)
      return { ok: true, dryRun: true, message: `预演：解析到 ${records.length} 行`, stat, warnings, skipped, sample: records.slice(0, 5) }
    }

    const res = await persist(records, logId, stat)
    const msg = `解析 ${res.total} 行：新增 ${res.inserted}，更新 ${res.updated}，失效 ${res.inactive}`
      + (skipped.length ? `；跳过无表头工作表：${skipped.join('、')}` : '')
      + (warnings.length ? `；注意：${warnings.join('；')}` : '')
    await finishLog(logId, 'ok', msg, res)
    await touchConfig({ lastSyncAt: new Date().toISOString(), lastSyncStatus: 'ok', lastSyncMsg: msg })
    return { ok: true, message: msg, stat: res, warnings, skipped }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    await finishLog(logId, 'fail', msg, stat)
    await touchConfig({ lastSyncStatus: 'fail', lastSyncMsg: msg })
    return { ok: false, message: msg, stat }
  }
}

/** 只更新运行时状态字段（不动用户配置） */
async function touchConfig(patch) {
  const cfg = await loadConfig()
  const next = { ...cfg, ...patch }
  await pool.execute(
    `INSERT INTO t_system_config (config_key, config_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [CONFIG_KEY, JSON.stringify(next)]
  )
}

module.exports = {
  CONFIG_KEY, DEFAULT_CONFIG,
  loadConfig, saveConfig, maskConfig,
  parseSheet, parseDateTime, detectHeader, buildColumnMap,
  syncNow,
}
