/**
 * 承包商安全活动模块 · 管理端路由 /api/activity（需 admin token）
 *
 * 三个栏目：monday 周一安全活动 / wednesday 周三学习活动 / inspection 上级检查问题类比排查
 *   - 周一周三：结构化表单（form_json），台账 + 详情 + 附件 + 汇总导出
 *   - 类比排查：管理员创建批次时上传「标准表」自定义排查项目 + 设置截止时间与提醒天数，
 *              系统按标准表列头动态生成填报模板；承包商回填/在线补录；
 *              到期在系统内提醒；实时统计已报单位；自动汇总成一张表并可导出。
 */
const express = require('express')
const multer  = require('multer')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const { decodeFilename } = require('../utils/filename')
const { uploadFile, deleteFile } = require('../services/cosUpload')
const store = require('../services/activityStore')
const svc   = require('../services/activityService')

const router = express.Router()

function adminAuth(req, res, next) {
  const h = req.headers['authorization']
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  const payload = verifyAdminToken(h.slice(7))
  if (!payload) return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  req.admin = payload
  next()
}
router.use(adminAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = decodeFilename(file.originalname).toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) cb(null, true)
    else cb(new Error('标准表仅支持 .xlsx / .xls 格式'))
  },
})
function uploadGuard(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: '标准表不得超过 20MB' })
    return res.status(400).json({ success: false, error: err.message || '文件上传失败' })
  }
  next()
}

function safeJson(v, fallback) {
  if (v && typeof v === 'object') return v  // PUT 传数组/对象时直接返回，避免 JSON.parse 误清空
  try { return JSON.parse(v || JSON.stringify(fallback)) } catch (e) { return fallback }
}
function ok(res, data) { res.json({ success: true, data }) }
function fail(res, e, code = 500) {
  console.error('[activity]', e && e.message ? e.message : e)
  res.status(code).json({ success: false, error: e && e.message ? e.message : '操作失败' })
}
function xlsxDownload(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

// ─── 单位下拉（四级网格，与承包商准入打通）─────────────────────────────────
router.get('/units', async (req, res) => {
  try { ok(res, await store.listUnits(req.query.keyword || '')) } catch (e) { fail(res, e) }
})

// 填报单位下拉：与「本期应报」同源（受控单位名单）
router.get('/report-units', async (req, res) => {
  try { ok(res, await store.statUnitOptions(req.query.keyword || '')) } catch (e) { fail(res, e) }
})

// ─── 期次列表 ──────────────────────────────────────────────────────────────
router.get('/periods', async (req, res) => {
  try {
    // 周一/周三为长期固定活动：按周自动补齐最近期次（幂等，失败不影响查询）
    try { await store.ensureWeeklyPeriods() } catch (e) { console.error('[activity] 自动建期次失败:', e.message) }
    const { type = '', status = '' } = req.query
    const params = []
    let where = 'WHERE 1=1'
    if (type) { where += ' AND period_type = ?'; params.push(type) }
    if (status) { where += ' AND status = ?'; params.push(status) }
    const [list] = await pool.query(
      `SELECT *,
        CASE WHEN due_at IS NOT NULL AND NOW() >= due_at THEN 1 ELSE 0 END AS is_due
       FROM t_activity_period ${where} ORDER BY activity_date DESC, id DESC`, params
    )
    // 附带统计（列表卡片直接显示已报/未报）；is_due 由 SQL 计算，避免日期红线与逐行查询
    const enriched = []
    for (const p of list) {
      const s = await store.periodStats(p)
      enriched.push({
        ...p,
        columns_json: undefined,
        columnCount: store.parseDef(p).columns.length,
        expected: s.expected, reportedCount: s.reportedCount,
        unreportedCount: s.unreportedCount, rowTotal: s.rowTotal, fileTotal: s.fileTotal,
      })
    }
    ok(res, enriched)
  } catch (e) { fail(res, e) }
})

// ─── 创建期次（排查批次需上传标准表 + 设置截止时间/提醒天数）─────────────────
router.post('/periods', upload.single('template'), uploadGuard, async (req, res) => {
  try {
    const {
      period_type = 'monday', title = '', activity_date = null, due_at = null,
      remind_days = 3, description = '', expected_unit_ids = '[]', status = 'open',
    } = req.body || {}
    if (!['monday', 'wednesday', 'inspection'].includes(period_type)) {
      return res.status(400).json({ success: false, error: '无效的活动类型' })
    }
    if (!String(title).trim()) return res.status(400).json({ success: false, error: '请填写期次/批次名称' })

    let def = { columns: [], headerRowIndex: 0, templateRows: [] }
    let tplName = '', tplKey = '', tplUrl = ''
    if (req.file) {
      def = svc.parseStandardWorkbook(req.file.buffer)
      if (!def.columns.length) return res.status(400).json({ success: false, error: '标准表未解析出有效列头' })
      tplName = decodeFilename(req.file.originalname)
      try {
        const cos = await uploadFile(req.file.buffer, `标准表_${Date.now()}_${tplName}`, 'activity-templates')
        tplKey = cos.key; tplUrl = cos.url
      } catch (ce) {
        console.error('[activity] 标准表 COS 留档失败（不影响解析）:', ce.message)
      }
    }
    if (period_type === 'inspection' && !def.columns.length) {
      return res.status(400).json({ success: false, error: '类比排查批次必须上传标准表格（用于自定义排查项目）' })
    }
    if (period_type === 'inspection' && !due_at) {
      return res.status(400).json({ success: false, error: '请设置上报截止时间（到期在系统内提醒）' })
    }

    const [r] = await pool.execute(
      `INSERT INTO t_activity_period
        (period_type, title, activity_date, due_at, remind_days, description,
         columns_json, template_name, template_key, template_url, expected_unit_ids, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        period_type, String(title).trim(), activity_date || null, due_at || null,
        Number(remind_days) || 3, String(description || ''),
        JSON.stringify(def), tplName, tplKey, tplUrl,
        JSON.stringify(safeJson(expected_unit_ids, [])), status, req.admin.id || null,
      ]
    )
    ok(res, { id: r.insertId, columns: def.columns, templateRows: def.templateRows.length })
  } catch (e) { fail(res, e, 400) }
})

// ─── 期次详情（含统计 + 已报/未报单位 + 列定义）─────────────────────────────
router.get('/periods/:id', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const stats = await store.periodStats(p)
    ok(res, { ...p, def: store.parseDef(p), stats })
  } catch (e) { fail(res, e) }
})

// ─── 编辑期次（可改截止时间/提醒天数/应报单位/状态）─────────────────────────
router.put('/periods/:id', async (req, res) => {
  try {
    const id = req.params.id
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const b = req.body || {}
    await pool.execute(
      `UPDATE t_activity_period SET title=?, activity_date=?, due_at=?, remind_days=?,
        description=?, expected_unit_ids=?, status=? WHERE id=?`,
      [
        b.title ?? p.title, b.activity_date ?? p.activity_date, b.due_at ?? p.due_at,
        b.remind_days ?? p.remind_days, b.description ?? p.description,
        b.expected_unit_ids !== undefined ? JSON.stringify(safeJson(b.expected_unit_ids, [])) : p.expected_unit_ids,
        b.status ?? p.status, id,
      ]
    )
    ok(res, { id: Number(id) })
  } catch (e) { fail(res, e, 400) }
})

// ─── 重传标准表（更换排查项目列定义）────────────────────────────────────────
router.post('/periods/:id/template', upload.single('template'), uploadGuard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传标准表格' })
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const def = svc.parseStandardWorkbook(req.file.buffer)
    const name = decodeFilename(req.file.originalname)
    let key = p.template_key, url = p.template_url
    try {
      const cos = await uploadFile(req.file.buffer, `标准表_${Date.now()}_${name}`, 'activity-templates')
      key = cos.key; url = cos.url
      if (p.template_key) { try { await deleteFile(p.template_key) } catch (e) { /* 忽略 */ } }
    } catch (ce) { console.error('[activity] COS 留档失败:', ce.message) }
    await pool.execute(
      'UPDATE t_activity_period SET columns_json=?, template_name=?, template_key=?, template_url=? WHERE id=?',
      [JSON.stringify(def), name, key, url, p.id]
    )
    ok(res, { columns: def.columns, templateRows: def.templateRows.length })
  } catch (e) { fail(res, e, 400) }
})

// ─── 删除期次（连带记录/明细/附件/提醒）─────────────────────────────────────
router.delete('/periods/:id', async (req, res) => {
  try {
    const id = req.params.id
    const [[p]] = await pool.query('SELECT template_key FROM t_activity_period WHERE id = ?', [id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const [files] = await pool.query('SELECT cos_key FROM t_activity_file WHERE period_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_row WHERE period_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_file WHERE period_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_record WHERE period_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_remind WHERE period_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_period WHERE id = ?', [id])
    const keys = files.map((f) => f.cos_key).filter(Boolean)
    if (p.template_key) keys.push(p.template_key)
    keys.forEach((k) => { deleteFile(k).catch(() => {}) })
    ok(res, { id: Number(id) })
  } catch (e) { fail(res, e) }
})

// ─── 下载标准表 / 空白填报模板 ──────────────────────────────────────────────
router.get('/periods/:id/template', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const def = store.parseDef(p)
    if (!def.columns.length) return res.status(400).json({ success: false, error: '该期次未上传标准表' })
    const blank = req.query.blank === '1'
    const buf = blank
      ? svc.buildBlankWorkbook(def, `${p.title} · 填报模板`)
      : svc.buildTemplateWorkbook(def, p.title)
    xlsxDownload(res, buf, `${p.title}_${blank ? '空白填报模板' : '标准表'}.xlsx`)
  } catch (e) { fail(res, e) }
})

// ─── 记录列表（台账）───────────────────────────────────────────────────────
router.get('/records', async (req, res) => {
  try {
    const { period_id = '', keyword = '', unit_id = '' } = req.query
    const params = []
    let where = 'WHERE 1=1'
    if (period_id) { where += ' AND r.period_id = ?'; params.push(Number(period_id)) }
    if (unit_id) { where += ' AND r.unit_id = ?'; params.push(Number(unit_id)) }
    if (keyword) {
      where += ' AND (r.unit_name LIKE ? OR r.uploader_name LIKE ? OR r.uploader_phone LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }
    const [list] = await pool.query(
      `SELECT r.*, p.title AS period_title, p.period_type, p.due_at,
        u.parent_unit_name AS grid_l3,
        (SELECT COUNT(*) FROM t_activity_row w WHERE w.record_id = r.id) AS row_count,
        (SELECT COUNT(*) FROM t_activity_file f WHERE f.record_id = r.id) AS file_count
       FROM t_activity_record r
       LEFT JOIN t_activity_period p ON p.id = r.period_id
       LEFT JOIN t_contractor_unit u ON u.id = r.unit_id
       ${where} ORDER BY r.submitted_at DESC LIMIT 500`, params
    )
    ok(res, list)
  } catch (e) { fail(res, e) }
})

// ─── 记录详情（表单 + 明细行 + 附件）────────────────────────────────────────
router.get('/records/:id', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT * FROM t_activity_record WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ success: false, error: '记录不存在' })
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [r.period_id])
    const [rows] = await pool.query('SELECT * FROM t_activity_row WHERE record_id = ? ORDER BY sort_no, id', [r.id])
    const [files] = await pool.query('SELECT * FROM t_activity_file WHERE record_id = ? ORDER BY id', [r.id])
    ok(res, {
      record: { ...r, form: safeJson(r.form_json, {}) },
      period: p ? { ...p, def: store.parseDef(p) } : null,
      rows: rows.map((w) => ({ id: w.id, sort_no: w.sort_no, data: safeJson(w.row_json, {}) })),
      files,
    })
  } catch (e) { fail(res, e) }
})

// ─── 删除记录 ──────────────────────────────────────────────────────────────
router.delete('/records/:id', async (req, res) => {
  try {
    const id = req.params.id
    const [files] = await pool.query('SELECT cos_key FROM t_activity_file WHERE record_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_row WHERE record_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_file WHERE record_id = ?', [id])
    await pool.execute('DELETE FROM t_activity_record WHERE id = ?', [id])
    files.forEach((f) => { if (f.cos_key) deleteFile(f.cos_key).catch(() => {}) })
    ok(res, { id: Number(id) })
  } catch (e) { fail(res, e) }
})

// ─── 汇总数据（所有单位填写内容合成一张表，页面预览）────────────────────────
router.get('/periods/:id/summary', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const def = store.parseDef(p)
    const [rows] = await pool.query(
      `SELECT w.row_json, r.unit_name, r.grid_l2, r.uploader_name, r.submitted_at, r.source
       FROM t_activity_row w JOIN t_activity_record r ON r.id = w.record_id
       WHERE w.period_id = ? ORDER BY r.unit_name, w.sort_no, w.id`, [p.id]
    )
    const stats = await store.periodStats(p)
    ok(res, {
      period: { id: p.id, title: p.title, period_type: p.period_type, due_at: p.due_at },
      columns: def.columns,
      rows: rows.map((w) => ({ ...w, data: safeJson(w.row_json, {}) })),
      stats,
    })
  } catch (e) { fail(res, e) }
})

// ─── 汇总导出（自动汇总到一张 Excel）───────────────────────────────────────
router.get('/periods/:id/export', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    if (p.period_type === 'inspection') {
      const def = store.parseDef(p)
      const [rows] = await pool.query(
        `SELECT w.row_json, r.unit_name, r.grid_l2, r.uploader_name, r.submitted_at, r.source
         FROM t_activity_row w JOIN t_activity_record r ON r.id = w.record_id
         WHERE w.period_id = ? ORDER BY r.unit_name, w.sort_no, w.id`, [p.id]
      )
      xlsxDownload(res, svc.buildSummaryWorkbook(def, rows, p.title), `${p.title}_类比排查汇总.xlsx`)
    } else {
      const [records] = await pool.query(
        `SELECT r.*, (SELECT COUNT(*) FROM t_activity_file f WHERE f.record_id = r.id) AS file_count
         FROM t_activity_record r WHERE r.period_id = ? ORDER BY r.unit_name`, [p.id]
      )
      xlsxDownload(res, svc.buildFormSummaryWorkbook(records, p.period_type, p.title), `${p.title}_活动记录汇总.xlsx`)
    }
  } catch (e) { fail(res, e) }
})

// ─── 月度看板：周一 / 周三 安全活动完成情况统计 ──────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    try { await store.ensureWeeklyPeriods() } catch (e) { /* 自动建期次失败不影响看板 */ }
    const months = await store.statMonths()
    let month = String(req.query.month || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      const [[{ m }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m') AS m")
      month = m
    }
    const [monday, wednesday] = await Promise.all([
      store.monthlyStat(month, 'monday'),
      store.monthlyStat(month, 'wednesday'),
    ])
    ok(res, { month, months, monday, wednesday })
  } catch (e) { fail(res, e) }
})

// 受控单位名单（月度统计表的行设置：单位 / 队别 / 井号）
router.get('/stat-units', async (req, res) => {
  try { ok(res, await store.statUnits()) } catch (e) { fail(res, e) }
})
router.post('/stat-units', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
    if (!rows) return res.status(400).json({ success: false, error: '参数错误：rows 应为数组' })
    ok(res, await store.saveStatUnits(rows))
  } catch (e) { fail(res, e) }
})

// 月度统计导出（两个 sheet，与手工台账同版式）
router.get('/dashboard/export', async (req, res) => {
  try {
    const month = String(req.query.month || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: '请指定月份（YYYY-MM）' })
    }
    const [monday, wednesday] = await Promise.all([
      store.monthlyStat(month, 'monday'),
      store.monthlyStat(month, 'wednesday'),
    ])
    xlsxDownload(res, svc.buildMonthlyStatWorkbook(month, monday, wednesday), `${month}_安全活动完成情况统计.xlsx`)
  } catch (e) { fail(res, e) }
})

// ─── 系统内到期提醒 ────────────────────────────────────────────────────────
router.get('/reminders', async (req, res) => {
  try { ok(res, await store.listReminders()) } catch (e) { fail(res, e) }
})
router.put('/reminders/:id/read', async (req, res) => {
  try {
    await pool.execute('UPDATE t_activity_remind SET is_read = 1 WHERE id = ?', [req.params.id])
    ok(res, { id: Number(req.params.id) })
  } catch (e) { fail(res, e) }
})

module.exports = router
