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

/** 应报单位权威来源：安全活动看板的「受控单位名单」t_activity_stat_unit
 *  - LEFT JOIN t_contractor_unit 补齐二级板块/三级网格（手工填写的行没有网格信息）
 *  - 同一单位可能因多个队/井出现多行，统计口径按单位去重
 *  - unit_id 为空的手工行用负数合成 id，保证前端 :key 唯一 */
async function statExpectedUnits() {
  await statUnits() // 空表时自动从三四级网格初始化
  const [rows] = await pool.query(
    `SELECT s.id AS stat_row_id, s.unit_id, s.unit_name, s.team_name, s.well_no, s.seq_no,
            u.grid_l2, u.grid_level, u.parent_unit_name, u.parent_id
     FROM t_activity_stat_unit s
     LEFT JOIN t_contractor_unit u ON u.id = s.unit_id
     WHERE s.is_active = 1
     ORDER BY s.sort_no, s.seq_no, s.id`
  )
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const key = r.unit_id != null ? `id:${r.unit_id}` : `name:${r.unit_name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: r.unit_id != null ? r.unit_id : -r.stat_row_id,
      stat_row_id: r.stat_row_id,
      unit_id: r.unit_id,
      unit_name: r.unit_name,
      team_name: r.team_name || '',
      well_no: r.well_no || '',
      grid_l2: r.grid_l2 || '',
      grid_level: r.grid_level || '',
      parent_unit_name: r.parent_unit_name || '',
      parent_id: r.parent_id || null,
    })
  }
  return out
}

/** 按期次配置解析应报单位
 *  - 期次显式指定了范围（如专项类比排查只指定几家）：直接按网格单位表取，保持该模块原口径
 *  - 未指定范围（周一/周三固定活动）：= 安全活动看板的「受控单位名单」
 */
async function expectedUnits(period) {
  let ids = []
  try { ids = JSON.parse(period.expected_unit_ids || '[]') } catch (e) { ids = [] }
  if (Array.isArray(ids)) {
    ids = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } else {
    ids = []
  }
  if (ids.length) {
    const marks = ids.map(() => '?').join(',')
    const [rows] = await pool.query(
      `SELECT id, id AS unit_id, unit_name, grid_l2, grid_level, parent_unit_name, parent_id
       FROM t_contractor_unit WHERE is_active = 1 AND id IN (${marks})
       ORDER BY FIELD(grid_level, '一级','二级','三级','四级'), CAST(seq_no AS UNSIGNED), id`,
      ids
    )
    if (rows.length) return rows
  }
  return statExpectedUnits()
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
  // 匹配口径：unit_id 优先，其次按单位名称（受控名单里手工填写的行没有 unit_id）
  const byId = new Map()
  const byName = new Map()
  records.forEach((r) => {
    if (r.unit_id != null && !byId.has(r.unit_id)) byId.set(r.unit_id, r)
    if (!byName.has(r.unit_name)) byName.set(r.unit_name, r)
  })
  const used = new Set()
  const reported = []
  const unreported = []
  units.forEach((u) => {
    let r = (u.unit_id != null ? byId.get(u.unit_id) : null) || byName.get(u.unit_name) || null
    if (r) {
      used.add(r.id)
      reported.push({ ...u, record: r, row_count: r.row_count, file_count: r.file_count })
    } else {
      unreported.push(u)
    }
  })
  // 已上报但不在受控名单里的单位（名单漏配/单位退场等情况），仍计入已报
  const extra = records.filter((r) => !used.has(r.id)).map((r) => ({
    id: r.unit_id != null ? r.unit_id : -r.id, unit_id: r.unit_id,
    unit_name: r.unit_name, grid_l2: '', grid_level: '', parent_unit_name: '',
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

// ─── 月度统计（周一 / 周三 活动完成情况）─────────────────────────────────────
/** 受控单位名单：为空时按在册三/四级单位自动初始化一份 */
// 首次自动初始化只允许执行一次（看板会并发取周一+周三，两个请求同时发现空表会重复插入）
let statInitPromise = null

async function statUnits() {
  const sql = `SELECT id, unit_id, seq_no, unit_name, team_name, well_no
               FROM t_activity_stat_unit WHERE is_active = 1
               ORDER BY sort_no, seq_no, id`
  const [rows] = await pool.query(sql)
  if (rows.length) return rows
  if (!statInitPromise) {
    const p = (async () => {
      // 双检：拿到锁后再确认一次，避免前一个初始化刚完成又被插入一遍
      const [again] = await pool.query('SELECT id FROM t_activity_stat_unit LIMIT 1')
      if (again.length) return
      const units = await listUnits()
      let i = 1
      for (const u of units) {
        await pool.execute(
          'INSERT INTO t_activity_stat_unit (unit_id, seq_no, unit_name, sort_no) VALUES (?,?,?,?)',
          [u.id, i, u.unit_name, i]
        )
        i++
      }
    })().catch(() => {})
    statInitPromise = p
    p.then(() => { if (statInitPromise === p) statInitPromise = null })
  }
  await statInitPromise
  const [fresh] = await pool.query(sql)
  return fresh
}

/** 保存受控单位名单（整表覆盖） */
async function saveStatUnits(list) {
  await pool.execute('DELETE FROM t_activity_stat_unit')
  let i = 1
  for (const r of list || []) {
    const name = String(r.unit_name || '').trim()
    if (!name) continue
    const seq = Number(r.seq_no) || i
    await pool.execute(
      `INSERT INTO t_activity_stat_unit (unit_id, seq_no, unit_name, team_name, well_no, sort_no)
       VALUES (?,?,?,?,?,?)`,
      [
        Number(r.unit_id) || null, seq, name.slice(0, 200),
        String(r.team_name || '').slice(0, 100), String(r.well_no || '').slice(0, 120), i,
      ]
    )
    i++
  }
  return statUnits()
}

/** 有期次的月份列表（近 24 个月） */
async function statMonths() {
  const [rows] = await pool.query(
    `SELECT DISTINCT DATE_FORMAT(activity_date, '%Y-%m') AS m
     FROM t_activity_period
     WHERE period_type IN ('monday','wednesday') AND activity_date IS NOT NULL
     ORDER BY m DESC LIMIT 24`
  )
  return rows.map((r) => r.m).filter(Boolean)
}

/** 某月某类型的完成情况：行=受控单位，列=该月各期 */
async function monthlyStat(month, type) {
  const [periods] = await pool.query(
    `SELECT id, DATE_FORMAT(activity_date, '%Y-%m-%d') AS date, title
     FROM t_activity_period
     WHERE period_type = ? AND activity_date IS NOT NULL
       AND DATE_FORMAT(activity_date, '%Y-%m') = ?
     ORDER BY activity_date`,
    [type, month]
  )
  const units = await statUnits()
  const ids = periods.map((p) => p.id)
  let recs = []
  if (ids.length) {
    const [r] = await pool.query(
      `SELECT period_id, unit_id, unit_name FROM t_activity_record
       WHERE period_id IN (${ids.map(() => '?').join(',')})`,
      ids
    )
    recs = r
  }
  const byId = new Set(recs.map((r) => `${r.period_id}|${r.unit_id}`))
  const byName = new Set(recs.map((r) => `${r.period_id}|${r.unit_name}`))
  const rows = units.map((u) => {
    const cells = periods.map((p) => byId.has(`${p.id}|${u.unit_id}`) || byName.has(`${p.id}|${u.unit_name}`))
    const reported = cells.filter(Boolean).length
    return {
      id: u.id, unit_id: u.unit_id, seq_no: u.seq_no,
      unit_name: u.unit_name, team_name: u.team_name, well_no: u.well_no,
      cells, reported, missing: periods.length - reported,
    }
  })
  const totalReported = rows.reduce((a, r) => a + r.reported, 0)
  return {
    periods,
    rows,
    totals: {
      units: rows.length,
      periodCount: periods.length,
      reported: totalReported,
      missing: rows.length * periods.length - totalReported,
      rate: rows.length && periods.length
        ? Math.round((totalReported / (rows.length * periods.length)) * 100) : 0,
    },
  }
}

/** 填报页单位下拉：与「应报」同源（受控单位名单），支持关键字筛选 */
async function statUnitOptions(keyword = '') {
  const list = await statExpectedUnits()
  const kw = String(keyword || '').trim()
  if (!kw) return list.map((u) => ({ id: u.id, unit_name: u.unit_name, grid_l2: u.grid_l2, grid_level: u.grid_level, parent_unit_name: u.parent_unit_name }))
  return list
    .filter((u) => u.unit_name.includes(kw) || (u.grid_l2 || '').includes(kw) || (u.parent_unit_name || '').includes(kw))
    .map((u) => ({ id: u.id, unit_name: u.unit_name, grid_l2: u.grid_l2, grid_level: u.grid_level, parent_unit_name: u.parent_unit_name }))
}

module.exports = {
  listUnits, expectedUnits, periodStats, parseDef,
  ensureReminders, listReminders, ensureWeeklyPeriods,
  statUnits, saveStatUnits, statMonths, monthlyStat,
  statExpectedUnits, statUnitOptions,
}
