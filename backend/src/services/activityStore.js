/**
 * 承包商安全活动 · 数据访问公共层（管理端与公开端共用）
 * 单位来源统一为「承包商准入 → 四级网格」t_contractor_unit，实现两个模块数据打通。
 */
const { pool } = require('../db/db')

/** 在册四级网格单位（下拉 + 应报范围）
 *  默认只取「三、四级」网格（真正承担作业的承包商单位）；一、二级为项目部内部机构，不计入应报与下拉。 */
const CONTRACTOR_LEVELS = ['三级', '四级']
async function listUnits(keyword = '', levels = CONTRACTOR_LEVELS) {
  const params = []
  let where = 'WHERE is_active = 1'
  if (Array.isArray(levels) && levels.length) {
    where += ` AND grid_level IN (${levels.map(() => '?').join(',')})`
    params.push(...levels)
  }
  if (keyword) {
    where += ' AND (unit_name LIKE ? OR grid_l2 LIKE ? OR parent_unit_name LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const [rows] = await pool.query(
    `SELECT id, unit_name, grid_l2, grid_level, parent_unit_name, parent_id
     FROM t_contractor_unit ${where}
     ORDER BY FIELD(grid_level, '一级','二级','三级','四级'), CAST(seq_no AS UNSIGNED), id`,
    params
  )
  return rows
}

/** 按期次配置解析应报单位；未配置 = 全部在册单位 */
async function expectedUnits(period) {
  let ids = []
  try { ids = JSON.parse(period.expected_unit_ids || '[]') } catch (e) { ids = [] }
  if (!Array.isArray(ids)) return listUnits()
  ids = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (!ids.length) return listUnits()
  const marks = ids.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT id, unit_name, grid_l2, grid_level, parent_unit_name, parent_id
     FROM t_contractor_unit WHERE is_active = 1 AND id IN (${marks})
     ORDER BY FIELD(grid_level, '一级','二级','三级','四级'), CAST(seq_no AS UNSIGNED), id`,
    ids
  )
  return rows
}

/**
 * 期次上报统计：已报单位 / 未报单位 / 明细行数 / 附件数
 * 已报口径：t_activity_record 有记录（表单或回填或在线补录均会写记录）
 */
async function periodStats(period) {
  const units = await expectedUnits(period)
  const [records] = await pool.query(
    `SELECT r.id, r.unit_id, r.unit_name, r.uploader_name, r.uploader_phone, r.source,
            r.submitted_at, r.updated_at,
            (SELECT COUNT(*) FROM t_activity_row w WHERE w.record_id = r.id) AS row_count,
            (SELECT COUNT(*) FROM t_activity_file f WHERE f.record_id = r.id) AS file_count
     FROM t_activity_record r WHERE r.period_id = ? ORDER BY r.submitted_at DESC`,
    [period.id]
  )
  const byUnit = {}
  records.forEach((r) => { if (!byUnit[r.unit_id]) byUnit[r.unit_id] = r })
  const reported = []
  const unreported = []
  units.forEach((u) => {
    const r = byUnit[u.id]
    if (r) reported.push({ ...u, record: r, row_count: r.row_count, file_count: r.file_count })
    else unreported.push(u)
  })
  // 已上报但已不在应报名单里的单位（单位退场等情况），仍计入已报
  const expectedIds = new Set(units.map((u) => u.id))
  const extra = records.filter((r) => !expectedIds.has(r.unit_id)).map((r) => ({
    id: r.unit_id, unit_name: r.unit_name, grid_l2: '', grid_level: '',
    record: r, row_count: r.row_count, file_count: r.file_count,
  }))
  return {
    expected: units.length,
    reportedCount: reported.length + extra.length,
    unreportedCount: unreported.length,
    reported: [...reported, ...extra],
    unreported,
    rowTotal: records.reduce((a, r) => a + (r.row_count || 0), 0),
    fileTotal: records.reduce((a, r) => a + (r.file_count || 0), 0),
  }
}

/** 解析期次的 columns_json（兼容旧数据/空值） */
function parseDef(period) {
  try {
    const d = JSON.parse(period.columns_json || '{}')
    return { columns: Array.isArray(d.columns) ? d.columns : [], headerRowIndex: d.headerRowIndex || 0, templateRows: Array.isArray(d.templateRows) ? d.templateRows : [] }
  } catch (e) {
    return { columns: [], headerRowIndex: 0, templateRows: [] }
  }
}

/**
 * 生成系统内到期提醒（惰性 + 幂等）。
 * - before_due：距截止 <= remind_days 天且未到截止
 * - overdue：已过截止（用户要求「到期后在系统里提醒」）
 * 只针对「上级检查问题类比排查」批次（创建项目时设置 due_at/remind_days）。
 */
async function ensureReminders() {
  // 日期判断一律交给 SQL（NOW()/DATE_SUB），避免 JS 时区与 DATE 红线问题
  const [periods] = await pool.query(
    `SELECT * FROM (
       SELECT id, title, due_at, remind_days,
              DATE_FORMAT(due_at, '%Y-%m-%d %H:%i') AS due_text,
              CASE WHEN NOW() >= due_at THEN 'overdue'
                   WHEN NOW() >= DATE_SUB(due_at, INTERVAL remind_days DAY) THEN 'before_due'
                   ELSE NULL END AS phase
       FROM t_activity_period
       WHERE period_type = 'inspection' AND due_at IS NOT NULL AND status = 'open'
     ) t WHERE t.phase IS NOT NULL`
  )
  for (const p of periods) {
    const stats = await periodStats(p)
    const unreadLine = `已报 ${stats.reportedCount}/${stats.expected} 家，未报 ${stats.unreportedCount} 家`
    const dueText = p.due_text || String(p.due_at).slice(0, 16).replace('T', ' ')
    const isOverdue = p.phase === 'overdue'
    // 幂等且实时刷新统计数字（已报/未报会随上报变化）
    await pool.query(
      `INSERT INTO t_activity_remind (period_id, remind_type, title, content)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content)`,
      [
        p.id, p.phase,
        `${isOverdue ? '已到期' : '即将截止'}：${p.title}`,
        isOverdue
          ? `${unreadLine}；截止时间 ${dueText} 已过。请在系统内查看已报单位并导出汇总表。`
          : `${unreadLine}；截止时间 ${dueText}。请及时催报并汇总。`,
      ]
    )
  }
}

/** 取提醒列表（先惰性生成，保证到期后系统里一定能看到） */
async function listReminders() {
  await ensureReminders()
  const [rows] = await pool.query(
    `SELECT r.*, p.period_type, p.title AS period_title, p.due_at
     FROM t_activity_remind r LEFT JOIN t_activity_period p ON p.id = r.period_id
     WHERE r.is_read = 0 OR r.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     ORDER BY r.is_read ASC, r.created_at DESC LIMIT 100`
  )
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM t_activity_remind WHERE is_read = 0')
  return { list: rows, unread }
}

// ─── 固定活动期次自动生成（周一 / 周三长期固定开展，无需管理员手工建批次）──────
const WEEKLY_TYPES = [
  { type: 'monday',    label: '周一安全活动', offset: 0, desc: '长期固定开展，每周一进行；请按本队实际活动情况填写。' },
  { type: 'wednesday', label: '周三学习活动', offset: 2, desc: '长期固定开展，每周三进行；请按本队实际培训情况填写。' },
]

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDays(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  d.setDate(d.getDate() + n)
  return d
}

let lastWeeklyCheck = 0
/**
 * 惰性补齐「周一 / 周三」固定期次：以数据库 CURDATE() 为准，前后各 N 周。
 * 幂等：按 (period_type, activity_date) 判重，已存在则跳过；5 分钟内不重复扫描。
 * @returns {Promise<number>} 本次新建条数
 */
async function ensureWeeklyPeriods(weeksBack = 3, weeksAhead = 3) {
  if (Date.now() - lastWeeklyCheck < 5 * 60 * 1000) return 0
  lastWeeklyCheck = Date.now()

  const [[{ today }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today")
  const [y, m, d] = String(today).split('-').map(Number)
  const now = new Date(y, m - 1, d)
  const dow = now.getDay()                                // 0=周日
  const monday = addDays(now, dow === 0 ? -6 : 1 - dow)   // 本周一

  const first = addDays(monday, -7 * weeksBack)
  const last = addDays(monday, 7 * weeksAhead + 2)
  const [exist] = await pool.query(
    `SELECT period_type, DATE_FORMAT(activity_date, '%Y-%m-%d') AS d
     FROM t_activity_period
     WHERE period_type IN ('monday','wednesday') AND activity_date BETWEEN ? AND ?`,
    [ymd(first), ymd(last)]
  )
  const known = new Set(exist.map((r) => `${r.period_type}|${r.d}`))

  let created = 0
  for (let k = -weeksBack; k <= weeksAhead; k++) {
    for (const t of WEEKLY_TYPES) {
      const dateStr = ymd(addDays(monday, k * 7 + t.offset))
      const key = `${t.type}|${dateStr}`
      if (known.has(key)) continue
      // 当周周日 23:59:59 为上截止（周一 6 天、周三 4 天）
      const dueStr = `${ymd(addDays(monday, k * 7 + 6))} 23:59:59`
      await pool.execute(
        `INSERT INTO t_activity_period
           (period_type, title, activity_date, due_at, remind_days, description, status)
         VALUES (?, ?, ?, ?, 3, ?, 'open')`,
        [t.type, `${t.label}（${dateStr}）`, dateStr, dueStr, t.desc]
      )
      known.add(key)
      created++
    }
  }
  if (created) console.log(`[activity] 自动生成固定活动期次 ${created} 条（周一/周三）`)
  return created
}

module.exports = {
  listUnits, expectedUnits, periodStats, parseDef,
  ensureReminders, listReminders, ensureWeeklyPeriods,
}
