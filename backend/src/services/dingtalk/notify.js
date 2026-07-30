/**
 * 隐患事件 → 钉钉群机器人 消息映射（Tier 0）
 *
 * 设计依据：方案 v2.1 §13.4 事件→钉钉映射表
 * 说明：Sprint 1 先用群机器人广播（@责任人手机号）+ 系统 Web 站内信兜底。
 *      等申请到企业应用（工作通知 + 待办）后，再开启 Tier 1（见 §13.10）。
 *
 * 本模块只做"消息拼装 + 发送 + 审计落库"，不查库 —— 手机号等接收人信息由调用方传入，保持无状态。
 *
 * 群@路由（Tier 0）：
 *   - REPORT（隐患上报）：@整改反馈人(责任人) + 项目部安全环保室 + 业务主管部门(甲方联系人)
 *   - ASSIGN（分派）    ：@整改反馈人(责任人) + 安全环保室 + 甲方联系人
 *   - VERIFY（验收）    ：@安全环保室 + 甲方联系人
 *   - OVERDUE / WEEKLY  ：保持原逻辑（超期升级 @ 见 hazardScheduler）
 */

const { pool } = require('../../db/db')
const { sendGroupRobot } = require('./groupRobot')
const schedulerConfig = require('../schedulerConfig')

// ─── 内部 helper：合并多个手机号数组，扁平化 + trim + 去空 + 去重 ────────────────
/**
 * 合并多个手机号来源（支持数组与单个字符串标量），扁平化 + trim + 去空 + 去重。
 * 钉钉群机器人 API 会拒绝空 mobile，必须保证输出无空串、无重复。
 * 例：mergeMobiles(ownerMobile, safetyOfficeMobiles, partyAMobiles)
 *     —— ownerMobile 可为字符串标量，其余为数组，均会被扁平合并。
 * @param {...(string|string[]|undefined|null)} items
 * @returns {string[]}
 */
function mergeMobiles(...items) {
  const seen = new Set()
  const out = []
  const pushOne = (m) => {
    const mobile = String(m == null ? '' : m).trim()
    if (!mobile) return
    if (seen.has(mobile)) return
    seen.add(mobile)
    out.push(mobile)
  }
  for (const item of items) {
    if (Array.isArray(item)) {
      for (const m of item) pushOne(m)
    } else {
      pushOne(item) // 标量（如单个 ownerMobile 字符串）直接作为一条
    }
  }
  return out
}

// ─── 各事件消息模板 ───────────────────────────────────────────────────────────

function buildReportMsg({ hazardNo, title, unit, ownerName, ownerMobile, partyAMobiles, safetyOfficeMobiles }) {
  const lines = [
    '## 🆕 新隐患上报通知',
    `**隐患编号**：\`${hazardNo}\``,
    `**隐患概要**：${title}`,
    `**责任单位**：${unit}`,
    `**整改责任人**：${ownerName}`,
    '> 已同步通知：整改反馈人、项目部安全环保室、业务主管部门（甲方联系人）。',
  ]
  return {
    msgtype: 'markdown',
    title: '新隐患上报通知',
    content: lines.join('\n\n'),
    atMobiles: mergeMobiles(ownerMobile, safetyOfficeMobiles, partyAMobiles),
  }
}

function buildAssignMsg({ hazardNo, title, unit, ownerName, ownerMobile, deadline, partyAMobiles, safetyOfficeMobiles }) {
  const lines = [
    '## 📋 隐患整改分派通知',
    `**隐患编号**：\`${hazardNo}\``,
    `**隐患概要**：${title}`,
    `**责任单位**：${unit}`,
    `**整改责任人**：${ownerName}`,
    `**计划完成**：${deadline}`,
    '> 请责任人登录隐患闭环系统接收任务并按时整改。',
  ]
  return {
    msgtype: 'markdown',
    title: '隐患整改分派通知',
    content: lines.join('\n\n'),
    atMobiles: mergeMobiles(ownerMobile, safetyOfficeMobiles, partyAMobiles),
  }
}

function buildVerifyMsg({ hazardNo, title, result, verifyBy, partyAMobiles, safetyOfficeMobiles }) {
  const ok = result === 'pass'
  const lines = [
    `## ${ok ? '✅' : '⚠️'} 隐患整改验收结果`,
    `**隐患编号**：\`${hazardNo}\``,
    `**隐患概要**：${title}`,
    `**验收结论**：${ok ? '通过闭环' : '退回重整改'}`,
    `**验收人**：${verifyBy}`,
  ]
  return {
    msgtype: 'markdown',
    title: '隐患整改验收结果',
    content: lines.join('\n\n'),
    atMobiles: mergeMobiles(safetyOfficeMobiles, partyAMobiles),
  }
}

function buildOverdueMsg({ hazardNo, title, ownerName, ownerMobile, overdueDays, businessDeptHead }) {
  const lines = [
    '## 🚨 隐患整改超期升级',
    `**隐患编号**：\`${hazardNo}\``,
    `**隐患概要**：${title}`,
    `**责任人**：${ownerName}`,
    `**业务口负责人**：${businessDeptHead || '（未指定）'}（请督促整改）`,
    `**已超期**：${overdueDays} 天`,
    '> 已升级至安全环保室，请立即处理。',
  ]
  return {
    msgtype: 'markdown',
    title: '隐患整改超期升级',
    content: lines.join('\n\n'),
    atMobiles: ownerMobile ? [ownerMobile] : [],
  }
}

function buildWeeklyMsg({ weekRange, total, closed, overdue, topUnits, atMobiles = [] }) {
  const top = (topUnits || []).map((u, i) => `${i + 1}. ${u.unit}（${u.count} 项）`).join('\n')
  const lines = [
    '## 📊 隐患闭环周通报',
    `**统计周期**：${weekRange}`,
    `- 本周新增：${total}`,
    `- 本周闭环：${closed}`,
    `- 超期未闭环：${overdue}`,
    '**隐患较多单位**：',
    top || '（无）',
  ]
  return {
    msgtype: 'markdown',
    title: '隐患闭环周通报',
    content: lines.join('\n\n'),
    atMobiles: Array.isArray(atMobiles) ? atMobiles : [],
  }
}

/**
 * 超期合并提醒（同一责任人多条超期隐患合并成一条，只 @ 一次）
 * @param {Object} param
 * @param {string} param.ownerName           责任人姓名（分组键）
 * @param {string} param.ownerMobile         责任人手机（兜底可能为空串）
 * @param {Array<{hazardNo:string,title:string,overdueDays:number}>} param.hazards 该责任人名下超期隐患列表
 * @param {string[]} param.atMobiles         实际 @ 的手机号（含责任人 + 必要时安全环保室）
 * @param {number} param.maxOverdueDays      组内最大超期天数
 */
function buildOverdueDigestMsg({ ownerName, ownerMobile, hazards = [], atMobiles, maxOverdueDays, businessDeptHead }) {
  const list = Array.isArray(hazards) ? hazards : []
  const lines = [
    `## 🚨 隐患整改超期升级（合并 ${list.length} 条）`,
  ]
  list.forEach((h, i) => {
    const no = h.hazardNo || `H${i + 1}`
    const title = h.title || ''
    const days = Number(h.overdueDays) || 0
    // 逐条隐患一行：`- [编号] 概要 | 已超期 X 天`
    lines.push(`- [\`${no}\`] ${title} | 已超期 ${days} 天 | 业务口负责人：${h.businessDeptHead || '（未指定）'}（请督促整改）`)
  })
  lines.push(`**责任人**：${ownerName || ''}`)

  // 若同时 @ 了安全环保室（即组内存在超期 > 阈值的隐患，调用方已注入拆分数组中的任一安全环保室手机号），提示已升级；否则仅 @ 责任人。
  // 注意：schedulerConfig.safetyOfficeMobile 是未拆分的整串，判断升级需用已拆好的数组 safetyOfficeMobiles。
  const mobiles = Array.isArray(atMobiles) ? atMobiles : []
  const officeMobiles = schedulerConfig.safetyOfficeMobiles || []
  if (officeMobiles.some((m) => mobiles.includes(m))) {
    lines.push('> 已升级至安全环保室，请立即处理。')
  }

  return {
    msgtype: 'markdown',
    title: '隐患整改超期升级',
    content: lines.join('\n\n'),
    atMobiles: mobiles,
  }
}

/**
 * 每日摘要消息（隐患录入每日提醒，每天 17:00 由 scheduler 汇总发送）
 * @param {Object} param
 * @param {string} param.date       日期 YYYY-MM-DD
 * @param {number} param.count      当日录入隐患条数
 * @param {Array<{hazardNo:string,unit:string,title:string,level:string,status:string}>} param.hazards 隐患列表
 * @param {string[]} param.atMobiles 已合并好的 @手机号（调用方传入，已去空去重）
 * @returns {{msgtype:string,title:string,content:string,atMobiles:string[]}}
 */
function buildDailyDigestMsg({ date, count, hazards, atMobiles }) {
  const lines = [
    `## 📅 隐患录入每日提醒（${date}）`,
    `今日共录入 ${count} 条隐患，详情如下：`,
  ]
  ;(hazards || []).forEach((h) => {
    const no = h.hazardNo || ''
    const unit = h.unit || ''
    const title = h.title || ''
    const level = h.level || ''
    const status = h.status || ''
    lines.push(`- [${no}] ${unit} | ${title} | ${level} | ${status}`)
  })
  lines.push('> 已 @ 业务主管部门、项目部安全环保室、相关承包商整改反馈人。')
  return {
    msgtype: 'markdown',
    title: '隐患录入每日提醒',
    content: lines.join('\n\n'),
    atMobiles: Array.isArray(atMobiles) ? atMobiles : [],
  }
}

// ─── 审计落库（表结构与 migrations/002_dingtalk_notify_log.sql 对应）───────────
async function logNotify({ event, receiver, content, status, errmsg }) {
  try {
    await pool.execute(
      `INSERT INTO dingtalk_notify_log (event, channel, receiver, content, status, errmsg)
       VALUES (?, 'group_robot', ?, ?, ?, ?)`,
      [event, receiver || '', content || '', status, errmsg || null]
    )
  } catch (e) {
    // 审计失败不影响主流程
    console.error('[dingtalk] 审计落库失败（已忽略）:', e.message)
  }
}

// ─── 统一入口 ───────────────────────────────────────────────────────────────────

/**
 * 按事件类型发送隐患通知
 * @param {'ASSIGN'|'VERIFY'|'OVERDUE'|'OVERDUE_DIGEST'|'WEEKLY'|'REPORT'|'DIGEST'} event
 * @param {Object} payload 各事件对应的字段（见上方 build* 函数）
 * @returns {Promise<{ok:boolean}>}
 */
async function sendHazardNotification(event, payload = {}) {
  let msg
  switch (event) {
    case 'REPORT':  msg = buildReportMsg(payload);  break
    case 'ASSIGN':  msg = buildAssignMsg(payload);  break
    case 'VERIFY':  msg = buildVerifyMsg(payload);  break
    case 'OVERDUE': msg = buildOverdueMsg(payload); break
    case 'OVERDUE_DIGEST': msg = buildOverdueDigestMsg(payload); break
    case 'WEEKLY':  msg = buildWeeklyMsg(payload);  break
    case 'DIGEST':  msg = buildDailyDigestMsg(payload);  break
    default: throw new Error('未知事件类型: ' + event)
  }

  const receiver = (msg.atMobiles && msg.atMobiles.join(',')) || 'group'
  try {
    const r = await sendGroupRobot(msg)
    await logNotify({ event, receiver, content: msg.content, status: r.skipped ? 'skipped' : 'sent' })
    return { ok: true, ...r }
  } catch (e) {
    await logNotify({ event, receiver, content: msg.content, status: 'failed', errmsg: e.message })
    throw e
  }
}

module.exports = {
  sendHazardNotification,
  sendGroupRobot,
  mergeMobiles,
  buildReportMsg,
  buildAssignMsg,
  buildVerifyMsg,
  buildOverdueMsg,
  buildOverdueDigestMsg,
  buildWeeklyMsg,
  buildDailyDigestMsg,
}
