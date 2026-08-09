/**
 * 隐患定时任务服务（Sprint 3 / P0-2 / P0-6 / P0-7，模块三）
 *
 * 进程内定时器（原生 setInterval，无 node-cron）：
 *   1) 超期扫描：每 scanIntervalMin 分钟，扫描「未闭环 + 计划时间已过 + 当日未通知」的隐患，
 *      按超期天数分级 @责任人 / 单位安全员 / 安全环保室，并落库 last_overdue_notify_at。
 *   2) 未整改隐患周报（模块三）：每周三 01:00 窗口，生成「全部未整改隐患 Excel」传 COS，
 *      钉钉发 markdown 统计 + 下载链接；周 key 去重，失败清 key 允许窗口内重试。
 *
 * 模块三停用（保留函数定义与导出，便于回退）：
 *   - checkWeeklyReport / sendWeeklyReport（周报 WEEKLY）
 *   - checkDailyDigest / sendDailyDigest（每日摘要 DIGEST）
 *   - 上报/分派/验收即时通知的停用见 routes/hazardLoop.js fireNotify 白名单。
 *
 * 通知 fire-and-forget：先落库（每日幂等护栏），再 try/catch 调 sendHazardNotification，
 * 通知失败仅 console.error，不抛错、不回滚、不影响后续隐患。
 */

const { sendHazardNotification, mergeMobiles } = require('./dingtalk/notify')
const { sendWeeklyUnclosedToDingtalk } = require('./unclosedHazardReport')
const { chooseEscalationTarget, OVERDUE_ESCALATE_OFFICE_DAYS } = require('../constants/hazardStates')
const schedulerConfig = require('./schedulerConfig')

// 周报去重：已发送的周 key（内存，进程内单实例足够）
let lastWeeklyKey = ''

// 未整改隐患周报去重：已发送的周 key（内存，进程内单实例足够）
let lastWeeklyExcelKey = ''

// 每日摘要去重：已发送日期 + 上次校验日期（跨进程重启为内存态，单实例足够）
let dailyDigestSentDate = ''
let lastCheckedDate = ''

/**
 * 加载承包商单位安全员映射（id / unit_name → { name, phone }），供升级判定兜底（P1-5）
 * @param {Object} pool
 * @returns {Promise<{ byId: Map, byName: Map }>}
 */
async function loadUnitOfficers(pool) {
  try {
    const [rows] = await pool.query(
      'SELECT id, unit_name, safety_officer_name, safety_officer_phone FROM t_contractor_unit'
    )
    const byId = new Map()
    const byName = new Map()
    rows.forEach((u) => {
      const phone = u.safety_officer_phone || ''
      const name = u.safety_officer_name || ''
      if (u.id != null) byId.set(Number(u.id), { name, phone })
      if (u.unit_name) byName.set(u.unit_name, { name, phone })
    })
    return { byId, byName }
  } catch (e) {
    console.error('[scheduler] 加载单位安全员失败（将回退责任人）', e.message)
    return { byId: new Map(), byName: new Map() }
  }
}

/**
 * 超期扫描：扫描所有「未闭环 + 计划时间已过 + 当日未通知」的隐患
 * @param {Object} pool
 * @returns {Promise<{ scanned:number, notified:number }>}
 */
async function scanOverdueHazards(pool) {
  // 注：schedulerConfig.safetyOfficeMobile 是「未拆分的整串」（env DINGTALK_SAFETY_OFFICE_MOBILE 原值），
  //     不可直接当单个手机号使用（会注入非法 mobile）。安全环保室联系人应使用已拆好的数组 safetyOfficeMobiles。
  //     改造 2（周报）同样使用 safetyOfficeMobiles，这里保持一致。
  const officeMobiles = schedulerConfig.safetyOfficeMobiles || []
  const units = await loadUnitOfficers(pool)

  const [rows] = await pool.query(
    `SELECT h.id, h.hazard_code, h.description, h.unit_name,
            h.responsible_person, h.business_dept_head, h.plan_finish_time,
            cu.safety_officer_name, cu.safety_officer_phone
       FROM t_hazard h
       LEFT JOIN t_contractor_unit cu ON h.contractor_unit_id = cu.id
      WHERE h.status <> 'closed'
        AND h.plan_finish_time IS NOT NULL
        AND h.plan_finish_time < NOW()
        AND (h.last_overdue_notify_at IS NULL OR DATE(h.last_overdue_notify_at) < CURDATE())`
  )

  // 按「整改责任人(responsible_person)」分组：同一责任人的多条超期隐患合并成一条提醒，只 @ 一次。
  const groups = new Map()
  for (const h of rows) {
    const key = (h.responsible_person || '').trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(h)
  }

  let notifiedGroups = 0
  for (const [key, group] of groups) {
    // 兜底：责任人姓名/手机缺失时，用首条隐患的单位安全员；再无则降级安全环保室单值。
    let officer_name = ''
    let officer_phone = ''
    for (const h of group) {
      if (!officer_phone) {
        officer_phone = h.safety_officer_phone || ''
        officer_name = h.safety_officer_name || ''
        if (!officer_phone) {
          const byId = units.byId.get(Number(h.contractor_unit_id))
          const byName = h.unit_name ? units.byName.get(h.unit_name) : null
          const alt = byId || byName
          if (alt) {
            officer_name = alt.name || officer_name
            officer_phone = alt.phone || officer_phone
          }
        }
      }
    }

    const ownerName = key || officer_name || '安全环保室'
    // 责任人手机：优先取兜底单位安全员 officer_phone；再无则安全环保室联系人（取拆分数组首值，合法单号）。
    // 注：原整改责任人电话字段已废弃（录入不再采集），超期通知改在消息正文点名业务口负责人，不再 @ 责任人手机。
    const ownerMobile =
      officer_phone ||
      officeMobiles[0] ||
      ''

    const hazards = group.map((h) => {
      const plan = new Date(h.plan_finish_time).getTime()
      const overdueDays = Math.max(0, Math.floor((Date.now() - plan) / 86400000))
      return {
        hazardNo: h.hazard_code,
        title: h.description,
        overdueDays,
        businessDeptHead: h.business_dept_head,
      }
    })
    const maxOverdueDays = Math.max(...hazards.map((x) => x.overdueDays))

    // 升级语义保留：组内存在超期 > OVERDUE_ESCALATE_OFFICE_DAYS 天的隐患时，额外 @ 安全环保室全部联系人（拆分数组，非整串）。
    const escalateToOffice = maxOverdueDays > OVERDUE_ESCALATE_OFFICE_DAYS && officeMobiles.length > 0
    const atMobiles = mergeMobiles(ownerMobile, escalateToOffice ? officeMobiles : [])

    // 先落库（每日幂等护栏：同自然日不重复通知），再 fire-and-forget 通知（失败仅记录）。
    const ids = group.map((h) => h.id)
    await pool.execute(
      `UPDATE t_hazard SET last_overdue_notify_at = NOW(), is_overdue = 1, overdue_notified = 1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    try {
      await sendHazardNotification('OVERDUE_DIGEST', {
        ownerName,
        ownerMobile,
        hazards,
        atMobiles,
        maxOverdueDays,
      })
      notifiedGroups++
    } catch (e) {
      console.error('[scheduler] OVERDUE_DIGEST 通知失败', ownerName, e.message)
    }
  }

  if (rows.length) {
    console.log(
      `[scheduler] 超期扫描完成：命中 ${rows.length} 条，合并为 ${groups.size} 个责任人组，已通知 ${notifiedGroups} 条`
    )
  }
  return { scanned: rows.length, groups: groups.size, notified: notifiedGroups }
}

/** 取某日期所在周的周一（本地时区，与 Date.getDay 对齐） */
function mondayOf(date) {
  const d = new Date(date)
  const day = d.getDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

/** 格式化为 YYYY-MM-DD */
function ymd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 周 key（本周周一日期，唯一标识一周） */
function getWeekKey(date) {
  return ymd(mondayOf(date))
}

/**
 * 周报：每周一 09:00 前后触发，统计「上周」并推送项目部群
 * @param {Object} pool
 */
async function sendWeeklyReport(pool) {
  const now = new Date()
  const thisMonday = mondayOf(now)
  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(thisMonday.getDate() - 7)
  const lastSunday = new Date(thisMonday)
  lastSunday.setDate(thisMonday.getDate() - 1)
  lastSunday.setHours(23, 59, 59, 0)

  const ws = ymd(lastMonday)
  const we = ymd(lastSunday)

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_hazard
      WHERE report_time >= ? AND report_time <= ?`,
    [ws + ' 00:00:00', we + ' 23:59:59']
  )
  const [[{ closed }]] = await pool.execute(
    `SELECT COUNT(*) AS closed FROM t_hazard
      WHERE closed_at >= ? AND closed_at <= ?`,
    [ws + ' 00:00:00', we + ' 23:59:59']
  )
  const [[{ overdue }]] = await pool.execute(
    `SELECT COUNT(*) AS overdue FROM t_hazard
      WHERE status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()`
  )
  const [unitRows] = await pool.query(
    `SELECT unit_name, COUNT(*) AS c FROM t_hazard
      GROUP BY unit_name ORDER BY c DESC LIMIT 5`
  )
  const topUnits = unitRows.map((u) => ({ unit: u.unit_name || '未标注', count: u.c }))

  // 周报 @ 范围：仅 @ 有未闭环隐患的承包商整改反馈人 + 其甲方联系人 + 项目部安全环保室（常设管理方）。
  const [atRows] = await pool.query(
    `SELECT cu.safety_officer_phone, cu.party_a_contact_phone
       FROM t_contractor_unit cu
      WHERE cu.id IN (
        SELECT DISTINCT contractor_unit_id FROM t_hazard
         WHERE status <> 'closed' AND contractor_unit_id IS NOT NULL
      )`
  )
  const splitMobiles = (s) =>
    String(s || '')
      .split(/[/,、]/)
      .map((x) => x.trim())
      .filter(Boolean)
  const weeklyAtMobiles = mergeMobiles(
    schedulerConfig.safetyOfficeMobiles,
    ...atRows.flatMap((r) => splitMobiles(r.safety_officer_phone)),
    ...atRows.flatMap((r) => splitMobiles(r.party_a_contact_phone))
  )

  const weekRange = `${ws} ~ ${we}`
  try {
    await sendHazardNotification('WEEKLY', {
      weekRange,
      total,
      closed,
      overdue,
      topUnits,
      atMobiles: weeklyAtMobiles,
    })
    console.log(
      `[scheduler] 周通报已发送（${weekRange}）：新增 ${total} / 闭环 ${closed} / 超期 ${overdue} / @ ${weeklyAtMobiles.length} 人`
    )
  } catch (e) {
    console.error('[scheduler] 周通报发送失败', weekRange, e.message)
  }
  return { weekRange, total, closed, overdue, topUnits, atMobiles: weeklyAtMobiles }
}

/**
 * 每日摘要：汇总「今日录入」的隐患，@ 安全环保室 + 各承包商安全员 + 甲方联系人。
 * 今日无新隐患时仅 console.log，不发送（避免空卡片噪音）。
 * @param {Object} pool
 * @returns {Promise<{sent:boolean, count:number}>}
 */
async function sendDailyDigest(pool) {
  const [rows] = await pool.query(
    `SELECT h.hazard_code, h.unit_name, h.description, h.hazard_level AS level, h.status,
            cu.safety_officer_phone, cu.party_a_contact_phone
       FROM t_hazard h
       LEFT JOIN t_contractor_unit cu ON h.contractor_unit_id = cu.id
      WHERE DATE(h.report_time) = CURDATE()`
  )

  if (!rows.length) {
    console.log('[scheduler] 今日无新隐患，跳过每日摘要发送')
    return { sent: false, count: 0 }
  }

  const hazards = rows.map((r) => ({
    hazardNo: r.hazard_code,
    unit: r.unit_name,
    title: r.description || '',
    level: r.level,
    status: r.status,
  }))

  // 多人手机用 / 分隔；mergeMobiles 会把整串当一个元素，故先按 / 、 , 拆平再传入
  const officerPhones = rows.flatMap((r) =>
    String(r.safety_officer_phone || '')
      .split(/[\/,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const partyAPhones = rows.flatMap((r) =>
    String(r.party_a_contact_phone || '')
      .split(/[\/,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const atMobiles = mergeMobiles(
    schedulerConfig.safetyOfficeMobiles,
    officerPhones,
    partyAPhones
  )

  const date = ymd(new Date())
  try {
    await sendHazardNotification('DIGEST', { date, count: rows.length, hazards, atMobiles })
    console.log(
      `[scheduler] 每日摘要已发送（${date}）：共 ${rows.length} 条隐患，@ ${atMobiles.length} 人`
    )
    return { sent: true, count: rows.length }
  } catch (e) {
    console.error('[scheduler] 每日摘要发送失败', date, e.message)
    throw e
  }
}

/**
 * 每日 17:00 前后窗口校验 + 日期去重（保证每天仅发一次）。
 * @param {Object} pool
 * @returns {Promise<boolean>} 是否触发了发送
 */
async function checkDailyDigest(pool) {
  const now = new Date()
  const todayKey = ymd(now)

  // 跨天：重置发送标记
  if (todayKey !== lastCheckedDate) {
    dailyDigestSentDate = ''
    lastCheckedDate = todayKey
  }

  if (now.getHours() >= 17 && dailyDigestSentDate !== todayKey) {
    dailyDigestSentDate = todayKey // 先占位，避免窗口内重复触发
    try {
      await sendDailyDigest(pool)
      return true
    } catch (e) {
      console.error('[scheduler] 每日摘要异常', e.message)
      dailyDigestSentDate = '' // 失败则允许下次重试（仍在窗口内）
      return false
    }
  }
  return false
}

/**
 * 每周一 09:00 前后窗口校验 + 周 key 去重
 * @param {Object} pool
 * @returns {Promise<boolean>} 是否触发了发送
 */
async function checkWeeklyReport(pool) {
  const now = new Date()
  const cfg = schedulerConfig
  const isTargetDay = now.getDay() === cfg.weeklyDay
  const isTargetHour = now.getHours() === cfg.weeklyHour
  const withinWindow = now.getMinutes() >= cfg.weeklyMin && now.getMinutes() < cfg.weeklyMin + 10
  if (!(isTargetDay && isTargetHour && withinWindow)) return false

  const weekKey = getWeekKey(now)
  if (weekKey === lastWeeklyKey) return false // 本周已发

  lastWeeklyKey = weekKey // 占位，避免窗口内重复发送
  try {
    await sendWeeklyReport(pool)
    return true
  } catch (e) {
    console.error('[scheduler] 周报执行异常', e.message)
    lastWeeklyKey = '' // 失败则允许下次重试（仍在窗口内）
    return false
  }
}

/**
 * 未整改隐患周报：生成 Excel → 传 COS → 钉钉发统计 + 下载链接（每周三 01:00）
 * @param {Object} pool
 * @returns {Promise<{ok:boolean, url:string, count:number, overdueCount:number}>}
 */
async function sendWeeklyExcel(pool) {
  const result = await sendWeeklyUnclosedToDingtalk(pool)
  console.log(
    `[scheduler] 未整改隐患周报已发送：未整改 ${result.count} 条 / 已超期 ${result.overdueCount} 条，Excel 已传 COS: ${result.url}`
  )
  return result
}

/** 未整改隐患周报窗口判定：每周三 01:00 - 01:09（纯函数，便于测试） */
function isWeeklyExcelWindow(now) {
  const isTargetDay = now.getDay() === 3 // 3 = 周三
  const isTargetHour = now.getHours() === 1
  const withinWindow = now.getMinutes() >= 0 && now.getMinutes() < 10
  return isTargetDay && isTargetHour && withinWindow
}

/**
 * 每周三 01:00 前后窗口校验 + 周 key 去重（失败清 key 允许窗口内重试）。
 * @param {Object} pool
 * @returns {Promise<boolean>} 是否触发了发送
 */
async function checkWeeklyExcel(pool) {
  const now = new Date()
  if (!isWeeklyExcelWindow(now)) return false

  const weekKey = getWeekKey(now)
  if (weekKey === lastWeeklyExcelKey) return false // 本周已发

  lastWeeklyExcelKey = weekKey // 占位，避免窗口内重复发送
  try {
    await sendWeeklyExcel(pool)
    return true
  } catch (e) {
    console.error('[scheduler] 未整改隐患周报执行异常', e.message)
    lastWeeklyExcelKey = '' // 失败则允许下次重试（仍在窗口内）
    return false
  }
}

/**
 * 启动定时任务（在 autoMigrate 成功后调用，确保 last_overdue_notify_at 列已存在）
 * @param {Object} pool
 */
function startSchedulers(pool) {
  if (!pool) {
    console.error('[scheduler] 未提供数据库连接，定时任务未启动')
    return
  }
  const cfg = schedulerConfig
  const hh = String(cfg.weeklyHour).padStart(2, '0')
  const mm = String(cfg.weeklyMin).padStart(2, '0')
  console.log(
    `[scheduler] 已启动：超期扫描每 ${cfg.scanIntervalMin} 分钟；` +
    `未整改隐患周报每周三 01:00（周 key 去重）；` +
    `周报(每周${cfg.weeklyDay} ${hh}:${mm})与每日摘要(17:00)已按模块三停用`
  )

  const scanMs = Math.max(1, cfg.scanIntervalMin) * 60 * 1000
  setInterval(() => {
    scanOverdueHazards(pool).catch((e) => console.error('[scheduler] 超期扫描异常', e.message))
  }, scanMs)

  // 模块三：停用「周报(WEEKLY) / 每日摘要(DIGEST)」定时触发（保留函数定义与导出，便于回退）。
  // setInterval(() => {
  //   checkWeeklyReport(pool).catch((e) => console.error('[scheduler] 周报校验异常', e.message))
  // }, 60 * 1000)
  //
  // // 每日摘要：每分钟校验是否到达 17:00 且当日未发（到达后每天发一次）
  // setInterval(() => {
  //   checkDailyDigest(pool).catch((e) => console.error('[scheduler] 每日摘要校验异常', e.message))
  // }, 60 * 1000)

  // 模块三：未整改隐患周报（每周三 01:00 窗口，周 key 去重）——每分钟校验是否命中窗口
  setInterval(() => {
    checkWeeklyExcel(pool).catch((e) => console.error('[scheduler] 未整改周报校验异常', e.message))
  }, 60 * 1000)

  // 启动后立即跑一次超期扫描（幂等，不会重复通知）
  scanOverdueHazards(pool).catch((e) => console.error('[scheduler] 初始超期扫描异常', e.message))
}

module.exports = {
  startSchedulers,
  scanOverdueHazards,
  sendWeeklyReport,
  checkWeeklyReport,
  sendDailyDigest,
  checkDailyDigest,
  sendWeeklyExcel,
  checkWeeklyExcel,
  isWeeklyExcelWindow,
}
