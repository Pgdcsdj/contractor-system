/**
 * 承包商安全活动模块 · 公开填报端 /api/open/activity（免登录）
 *
 * 身份留痕：单位（四级网格下拉）+ 录入人姓名 + 电话，无登录态。
 * 与 contractorDoc.js 同一模式；本人可用「单位 + 电话」回显/覆盖自己的上报。
 *
 * 三类期次统一入口：
 *   - monday / wednesday：结构化表单 form_json + 附件
 *   - inspection：下载标准表 → 上传回填（整单覆盖） / 在线补录逐行
 */
const express = require('express')
const multer  = require('multer')
const { pool } = require('../db/db')
const { decodeFilename } = require('../utils/filename')
const { uploadFile } = require('../services/cosUpload')
const store = require('../services/activityStore')
const svc   = require('../services/activityService')

const router = express.Router()

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = decodeFilename(file.originalname).toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) cb(null, true)
    else cb(new Error('仅支持 .xlsx / .xls 格式'))
  },
})
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xlsx', 'xls']
const uploadFileMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = decodeFilename(file.originalname).split('.').pop().toLowerCase()
    if (ALLOWED_EXT.includes(ext)) cb(null, true)
    else cb(new Error('仅支持 PDF / 图片 / Word / Excel 格式'))
  },
})
function guard(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: '单个文件不得超过 20MB' })
    return res.status(400).json({ success: false, error: err.message || '文件上传失败' })
  }
  next()
}
function ok(res, data) { res.json({ success: true, data }) }
function fail(res, e, code = 500) {
  console.error('[activity-open]', e && e.message ? e.message : e)
  res.status(code).json({ success: false, error: e && e.message ? e.message : '操作失败' })
}
function safeJson(v, fallback) {
  try { return JSON.parse(v || JSON.stringify(fallback)) } catch (e) { return fallback }
}

// ─── 公开：单位下拉（四级网格，与承包商准入打通）───────────────────────────
router.get('/units', async (req, res) => {
  try { ok(res, await store.listUnits(req.query.keyword || '')) } catch (e) { fail(res, e) }
})

// ─── 公开：可填报期次列表 ──────────────────────────────────────────────────
router.get('/periods', async (req, res) => {
  try {
    const { type = '' } = req.query
    const params = []
    let where = "WHERE status = 'open'"
    if (type) { where += ' AND period_type = ?'; params.push(type) }
    const [list] = await pool.query(
      `SELECT id, period_type, title, activity_date, due_at, remind_days, description,
              template_name, expected_unit_ids, status, created_at,
              CASE WHEN due_at IS NOT NULL AND NOW() > due_at THEN 1 ELSE 0 END AS is_overdue
       FROM t_activity_period ${where} ORDER BY activity_date DESC, id DESC`, params
    )
    ok(res, list.map((p) => ({ ...p, columns_json: undefined })))
  } catch (e) { fail(res, e) }
})

// ─── 公开：期次详情（含动态列定义）─────────────────────────────────────────
router.get('/periods/:id', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const def = store.parseDef(p)
    ok(res, {
      id: p.id, period_type: p.period_type, title: p.title,
      activity_date: p.activity_date, due_at: p.due_at, description: p.description,
      status: p.status, template_name: p.template_name,
      columns: def.columns, templateRowCount: def.templateRows.length,
      is_overdue: p.due_at ? (await pool.query('SELECT NOW() > ? AS v', [p.due_at]))[0][0].v : 0,
    })
  } catch (e) { fail(res, e) }
})

// ─── 公开：下载标准表 / 空白填报模板 ────────────────────────────────────────
router.get('/periods/:id/template', async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ success: false, error: '期次不存在' })
    const def = store.parseDef(p)
    if (!def.columns.length) return res.status(400).json({ success: false, error: '该期次暂无标准表' })
    const blank = req.query.blank === '1'
    const buf = blank
      ? svc.buildBlankWorkbook(def, `${p.title} · 填报模板`)
      : svc.buildTemplateWorkbook(def, p.title)
    res.setHeader('Content-Type', XLSX_MIME)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${p.title}_${blank ? '空白填报模板' : '标准表'}.xlsx`)}`)
    res.send(buf)
  } catch (e) { fail(res, e) }
})

/** 校验并解析报送身份，返回 { period, unit } */
async function resolveIdentity(body) {
  const period_id = Number(body.period_id)
  const unit_id = Number(body.unit_id)
  const uploader_name = String(body.uploader_name || '').trim()
  const uploader_phone = String(body.uploader_phone || '').trim()
  if (!Number.isInteger(period_id) || !Number.isInteger(unit_id)) throw new Error('请选择活动期次和承包商单位')
  if (!uploader_name) throw new Error('请填写录入人姓名')
  const phoneDigits = uploader_phone.replace(/[\s-]/g, '')
  if (!/^1\d{10}$|^\d{7,12}$/.test(phoneDigits)) throw new Error('请填写有效的联系电话（手机号或座机）')
  const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [period_id])
  if (!p) throw new Error('活动期次不存在')
  if (p.status !== 'open') throw new Error('该期次已关闭，无法再上报')
  const units = await store.expectedUnits(p)
  const unit = units.find((u) => u.id === unit_id)
  if (!unit) throw new Error('所选单位不在本期应报范围内')
  return { p, unit, uploader_name, uploader_phone }
}

/**
 * upsert 上报主记录（同单位同期限一条，重复提交为覆盖更新）
 * preserve=true：仅刷新留痕时间，保留已有 form_json / source（上传附件时用，避免清空已填表单）
 */
async function upsertRecord(p, unit, uploader_name, uploader_phone, form, source, preserve = false) {
  const [[old]] = await pool.query(
    'SELECT * FROM t_activity_record WHERE period_id = ? AND unit_id = ?', [p.id, unit.id]
  )
  if (old) {
    if (preserve) {
      await pool.execute(
        `UPDATE t_activity_record SET unit_name=?, grid_l2=?, grid_level=?,
          uploader_name=?, uploader_phone=?, submitted_at=NOW() WHERE id=?`,
        [unit.unit_name, unit.grid_l2 || '', unit.grid_level || '', uploader_name, uploader_phone, old.id]
      )
    } else {
      await pool.execute(
        `UPDATE t_activity_record SET unit_name=?, grid_l2=?, grid_level=?, form_json=?,
          uploader_name=?, uploader_phone=?, source=?, submitted_at=NOW() WHERE id=?`,
        [unit.unit_name, unit.grid_l2 || '', unit.grid_level || '', JSON.stringify(form || {}),
         uploader_name, uploader_phone, source, old.id]
      )
    }
    return old.id
  }
  const [r] = await pool.execute(
    `INSERT INTO t_activity_record
      (period_id, unit_id, unit_name, grid_l2, grid_level, form_json, uploader_name, uploader_phone, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.id, unit.id, unit.unit_name, unit.grid_l2 || '', unit.grid_level || '',
     JSON.stringify(form || {}), uploader_name, uploader_phone, source]
  )
  return r.insertId
}

// ─── 公开：提交结构化表单（周一 / 周三）─────────────────────────────────────
router.post('/submit', async (req, res) => {
  try {
    const { p, unit, uploader_name, uploader_phone } = await resolveIdentity(req.body || {})
    if (p.period_type === 'inspection') {
      return res.status(400).json({ success: false, error: '类比排查请下载标准表后回填上传，或使用在线补录' })
    }
    const form = req.body.form || {}
    const id = await upsertRecord(p, unit, uploader_name, uploader_phone, form, 'form')
    ok(res, { record_id: id, period_title: p.title, unit_name: unit.unit_name })
  } catch (e) { fail(res, e, 400) }
})

// ─── 公开：上传填好的标准表回填（整单覆盖，含跳过未修改行）─────────────────
router.post('/import', uploadXlsx.single('file'), guard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传填报好的标准表' })
    const { p, unit, uploader_name, uploader_phone } = await resolveIdentity(req.body || {})
    if (p.period_type !== 'inspection') {
      return res.status(400).json({ success: false, error: '该期次为活动表单，请直接填写表单提交' })
    }
    const def = store.parseDef(p)
    if (!def.columns.length) return res.status(400).json({ success: false, error: '该批次未配置标准表，请联系管理员' })
    const parsed = svc.parseFilledWorkbook(req.file.buffer, def)
    if (!parsed.rows.length && !parsed.headerMatched) {
      return res.status(400).json({ success: false, error: '未能定位表头，请下载系统标准表后填写再上传' })
    }
    const id = await upsertRecord(p, unit, uploader_name, uploader_phone, {}, 'import')
    // 整单覆盖：清掉本单位本期旧明细
    await pool.execute('DELETE FROM t_activity_row WHERE period_id = ? AND unit_id = ?', [p.id, unit.id])
    for (let i = 0; i < parsed.rows.length; i++) {
      await pool.execute(
        'INSERT INTO t_activity_row (period_id, unit_id, record_id, row_json, sort_no) VALUES (?, ?, ?, ?, ?)',
        [p.id, unit.id, id, JSON.stringify(parsed.rows[i]), i]
      )
    }
    // 原表留档到附件
    try {
      const name = decodeFilename(req.file.originalname)
      const cos = await uploadFile(req.file.buffer, `回填_${unit.unit_name}_${Date.now()}_${name}`, 'activity-submit')
      await pool.execute(
        `INSERT INTO t_activity_file
          (period_id, unit_id, record_id, category, original_name, cos_key, cos_url, file_ext, file_size, uploader_name, uploader_phone)
         VALUES (?, ?, ?, '回填表', ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, unit.id, id, name, cos.key, cos.url, name.split('.').pop().toLowerCase(),
         req.file.buffer.length, uploader_name, uploader_phone]
      )
    } catch (ce) { console.error('[activity-open] 回填表 COS 留档失败:', ce.message) }

    ok(res, {
      record_id: id, unit_name: unit.unit_name, imported: parsed.rows.length,
      skipped: parsed.skipped, headerMatched: parsed.headerMatched, columns: def.columns,
    })
  } catch (e) { fail(res, e, 400) }
})

// ─── 公开：在线补录（按动态列逐行提交）─────────────────────────────────────
router.post('/rows', async (req, res) => {
  try {
    const { p, unit, uploader_name, uploader_phone } = await resolveIdentity(req.body || {})
    if (p.period_type !== 'inspection') {
      return res.status(400).json({ success: false, error: '仅类比排查支持在线补录明细' })
    }
    const rows = Array.isArray(req.body.rows) ? req.body.rows : []
    if (!rows.length) return res.status(400).json({ success: false, error: '请至少填写一行排查内容' })
    const def = store.parseDef(p)
    const id = await upsertRecord(p, unit, uploader_name, uploader_phone, {}, 'online')
    // 在线补录为追加模式（不清空回填导入的数据）
    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM t_activity_row WHERE period_id = ? AND unit_id = ?', [p.id, unit.id]
    )
    let sort = cnt
    for (const r of rows) {
      const obj = {}
      def.columns.forEach((c) => { obj[c] = svc.cleanCell(r?.[c]) })
      if (!Object.values(obj).some(Boolean)) continue
      await pool.execute(
        'INSERT INTO t_activity_row (period_id, unit_id, record_id, row_json, sort_no) VALUES (?, ?, ?, ?, ?)',
        [p.id, unit.id, id, JSON.stringify(obj), sort++]
      )
    }
    ok(res, { record_id: id, unit_name: unit.unit_name, added: rows.length })
  } catch (e) { fail(res, e, 400) }
})

// ─── 公开：附件上传（签到表 / 照片 / 学习材料等）───────────────────────────
router.post('/files', uploadFileMw.single('file'), guard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择文件' })
    const { p, unit, uploader_name, uploader_phone } = await resolveIdentity(req.body || {})
    const name = decodeFilename(req.file.originalname)
    let cos
    try {
      cos = await uploadFile(req.file.buffer, `${unit.unit_name}_${Date.now()}_${name}`, 'activity-files')
    } catch (ce) {
      return res.status(500).json({ success: false, error: '文件存储失败，请稍后重试' })
    }
    const id = await upsertRecord(p, unit, uploader_name, uploader_phone, {}, 'form', true)
    const [r] = await pool.execute(
      `INSERT INTO t_activity_file
        (period_id, unit_id, record_id, category, original_name, cos_key, cos_url, file_ext, file_size, uploader_name, uploader_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, unit.id, id, String(req.body.category || '其他附件').slice(0, 30), name,
       cos.key, cos.url, name.split('.').pop().toLowerCase(), req.file.buffer.length,
       uploader_name, uploader_phone]
    )
    ok(res, { id: r.insertId, original_name: name, cos_url: cos.url })
  } catch (e) { fail(res, e, 400) }
})

// ─── 公开：本人上报回显（单位 + 电话自校验）────────────────────────────────
router.get('/mine', async (req, res) => {
  try {
    const period_id = Number(req.query.period_id)
    const unit_id = Number(req.query.unit_id)
    const phone = String(req.query.phone || '').trim()
    if (!Number.isInteger(period_id) || !Number.isInteger(unit_id) || !phone) {
      return res.status(400).json({ success: false, error: '缺少期次/单位/电话参数' })
    }
    const [[r]] = await pool.query(
      'SELECT * FROM t_activity_record WHERE period_id = ? AND unit_id = ? AND uploader_phone = ?',
      [period_id, unit_id, phone]
    )
    if (!r) return ok(res, null)
    const [rows] = await pool.query('SELECT id, row_json, sort_no FROM t_activity_row WHERE record_id = ? ORDER BY sort_no, id', [r.id])
    const [files] = await pool.query('SELECT id, category, original_name, cos_url, file_size FROM t_activity_file WHERE record_id = ? ORDER BY id', [r.id])
    const [[p]] = await pool.query('SELECT * FROM t_activity_period WHERE id = ?', [r.period_id])
    ok(res, {
      record: { ...r, form: safeJson(r.form_json, {}) },
      rows: rows.map((w) => ({ id: w.id, data: safeJson(w.row_json, {}) })),
      files, columns: p ? store.parseDef(p).columns : [],
    })
  } catch (e) { fail(res, e) }
})

// ─── 公开：删除本人补录的某一行（姓名+电话自校验）──────────────────────────
router.delete('/rows/:id', async (req, res) => {
  try {
    const uploader_phone = String(req.body?.uploader_phone || req.query.uploader_phone || '').trim()
    const uploader_name = String(req.body?.uploader_name || req.query.uploader_name || '').trim()
    if (!uploader_phone || !uploader_name) return res.status(400).json({ success: false, error: '请提供录入人姓名与电话' })
    const [[w]] = await pool.query(
      `SELECT w.id, r.uploader_name, r.uploader_phone FROM t_activity_row w
       JOIN t_activity_record r ON r.id = w.record_id WHERE w.id = ?`, [req.params.id]
    )
    if (!w) return res.status(404).json({ success: false, error: '明细行不存在' })
    if (w.uploader_name !== uploader_name || w.uploader_phone !== uploader_phone) {
      return res.status(403).json({ success: false, error: '只能删除本人录入的内容' })
    }
    await pool.execute('DELETE FROM t_activity_row WHERE id = ?', [w.id])
    ok(res, { id: w.id })
  } catch (e) { fail(res, e) }
})

module.exports = router
