/**
 * 承包商开工资料电子化上报路由（需求 C / MVP 全量）
 *
 * 设计要点：
 *   - 公开端（免登录）：承包商按"工程/项目"建包 → 树状目录逐项上传 PDF/JPG。
 *   - 录入人身份以「录入人姓名 + 电话」留痕，用于本人删除/修改自校验（无登录态兜底）。
 *   - 单文件 ≤20MB，支持 PDF / JPG（含 jpeg）/ DOC / DOCX / Excel（.xlsx / .xls）。
 *   - 文件名自动按规则生成：[承包商简称]-[资料分类]-[日期].[ext]
 *   - 管理端（admin/superadmin）：目录维护 + 跨单位齐全度查看 + 台账导出。
 *   - 不做到期提醒（用户明确剔除）。
 *
 * 表：t_doc_catalog（目录项）/ t_doc_package（每项目一张表）/ t_doc_file（附件）
 */

const express = require('express')
const multer  = require('multer')
const path    = require('path')
const { pool } = require('../db/db')
const { uploadFile, deleteFile } = require('../services/cosUpload')
const { requireRole } = require('../services/permission')

const router = express.Router()

// ─── 录入人身份校验中间件（无登录态：姓名+电话 双因子兜底）──────────────────
// 仅用于本人删/改自校验：比对 t_doc_file.uploader_name + uploader_phone。
async function loadOwnFile(req, res, next) {
  const fileId = Number(req.params.id)
  if (!Number.isInteger(fileId)) return res.status(400).json({ success: false, error: '无效的文件 ID' })
  const [rows] = await pool.execute('SELECT * FROM t_doc_file WHERE id = ?', [fileId])
  if (!rows.length) return res.status(404).json({ success: false, error: '文件不存在' })
  req.docFile = rows[0]
  next()
}
function assertOwner(req, res) {
  const { uploader_name = '', uploader_phone = '' } = req.body || {}
  const f = req.docFile
  if (uploader_name !== f.uploader_name || uploader_phone !== f.uploader_phone) {
    return res.status(403).json({ success: false, error: '只能删除/修改本人录入的文件' })
  }
  return true
}

// ─── 上传中间件（内存存储，20MB，PDF / JPG / Word / Excel）─────────────────
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'doc', 'docx', 'xlsx', 'xls']
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase()
    if (ALLOWED_EXT.includes(ext)) cb(null, true)
    else cb(new Error('仅支持 PDF / 图片 / Word / Excel 格式'))
  },
})

// multer 错误兜底（文件过大 / 类型不符 → 友好报文）
function uploadGuard(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: '单个文件不得超过 20MB' })
    return res.status(400).json({ success: false, error: err.message || '文件上传失败' })
  }
  next()
}

// ─── 工具：生成系统文件名 ────────────────────────────────────────────────────
function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s()（）]+/g, '_').slice(0, 40)
}
function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

// ─── 公共上传/替换逻辑（公开端本人操作与管理端代管共用，行为一致）────────────
// 上传新文件：查包/资料项 → 生成系统名 → COS 上传 → INSERT → 触包更新时间。
// 抛错统一带 { status }，调用方按 status 返回对应 HTTP 码。
async function createFileRecord({ package_id, catalog_id, buffer, originalname, uploader_name, uploader_phone }) {
  const [pkg] = await pool.execute('SELECT id, unit_short, unit_name FROM t_doc_package WHERE id = ?', [package_id])
  if (!pkg.length) throw Object.assign(new Error('项目不存在'), { status: 400 })
  const [cat] = await pool.execute('SELECT id, item_name, category FROM t_doc_catalog WHERE id = ? AND is_active = 1', [catalog_id])
  if (!cat.length) throw Object.assign(new Error('资料项不存在或已停用'), { status: 400 })

  const ext = originalname.split('.').pop().toLowerCase()
  const short = sanitize(pkg[0].unit_short || pkg[0].unit_name)
  const catName = sanitize(cat[0].category)
  const sysName = `${short}-${catName}-${ymd()}.${ext}`

  let cos
  try {
    cos = await uploadFile(buffer, sysName, 'contractor-docs')
  } catch (ce) {
    console.error('[contractorDoc] COS 上传失败', ce.message)
    throw Object.assign(new Error('文件存储失败，请稍后重试'), { status: 500 })
  }

  const [r] = await pool.execute(
    `INSERT INTO t_doc_file
      (package_id, catalog_id, catalog_name, category, original_name, sys_name, cos_key, cos_url, file_ext, file_size, uploader_name, uploader_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [package_id, catalog_id, cat[0].item_name, cat[0].category, originalname, sysName,
     cos.key, cos.url, ext, buffer.length, uploader_name, uploader_phone]
  )
  await pool.execute('UPDATE t_doc_package SET updated_at = NOW() WHERE id = ?', [package_id])
  return { id: r.insertId, sys_name: sysName, cos_url: cos.url }
}

// 替换文件：新文件上传 COS → 删除旧 COS 对象 → UPDATE 记录 → 触包更新时间。
async function replaceFileRecord(docFile, buffer, originalname) {
  const ext = originalname.split('.').pop().toLowerCase()
  const [pkg] = await pool.execute('SELECT unit_short, unit_name FROM t_doc_package WHERE id = ?', [docFile.package_id])
  const [cat] = await pool.execute('SELECT item_name, category FROM t_doc_catalog WHERE id = ?', [docFile.catalog_id])
  const short = sanitize(pkg[0] ? (pkg[0].unit_short || pkg[0].unit_name) : '')
  const catName = sanitize(cat[0] ? cat[0].category : '')
  const sysName = `${short}-${catName}-${ymd()}.${ext}`

  let cos
  try {
    cos = await uploadFile(buffer, sysName, 'contractor-docs')
  } catch (ce) {
    console.error('[contractorDoc] COS 上传失败', ce.message)
    throw Object.assign(new Error('文件存储失败，请稍后重试'), { status: 500 })
  }
  try { await deleteFile(docFile.cos_key) } catch (e) { console.error('[contractorDoc] 旧文件删除失败(忽略)', e.message) }
  await pool.execute(
    `UPDATE t_doc_file SET original_name=?, sys_name=?, cos_key=?, cos_url=?, file_ext=?, file_size=? WHERE id=?`,
    [originalname, sysName, cos.key, cos.url, ext, buffer.length, docFile.id]
  )
  await pool.execute('UPDATE t_doc_package SET updated_at = NOW() WHERE id = ?', [docFile.package_id])
  return { id: docFile.id, sys_name: sysName, cos_url: cos.url }
}

// ════════════════════════════════════════════════════════════════════════════
//  公开端（免登录）
// ════════════════════════════════════════════════════════════════════════════

// GET /api/contractor-docs/units —— 在册单位下拉
router.get('/units', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, unit_name,
              CASE WHEN short_name IS NULL OR short_name = '' THEN unit_name ELSE short_name END AS short_name
       FROM t_contractor_unit WHERE is_active = 1 ORDER BY unit_name`
    )
    res.json({ success: true, data: rows })
  } catch (e) {
    console.error('[contractorDoc] units', e.message)
    res.status(500).json({ success: false, error: '获取单位列表失败' })
  }
})

// GET /api/contractor-docs/catalog —— 树状目录（按体系分类分组）
router.get('/catalog', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, category, item_name, freq, required_type, sort_order
       FROM t_doc_catalog WHERE is_active = 1 ORDER BY category, sort_order, id`
    )
    // 按 category 聚合
    const tree = []
    const map = {}
    for (const r of rows) {
      if (!map[r.category]) {
        map[r.category] = { category: r.category, items: [] }
        tree.push(map[r.category])
      }
      map[r.category].items.push({
        id: r.id, name: r.item_name, freq: r.freq, requiredType: r.required_type,
      })
    }
    res.json({ success: true, data: tree })
  } catch (e) {
    console.error('[contractorDoc] catalog', e.message)
    res.status(500).json({ success: false, error: '获取目录失败' })
  }
})

// POST /api/contractor-docs/packages —— 建包（每个工程/项目一张表）
router.post('/packages', async (req, res) => {
  try {
    const { unit_id, project_name, reporter_name = '', reporter_phone = '' } = req.body || {}
    if (!unit_id || !project_name) {
      return res.status(400).json({ success: false, error: '请选择承包商并填写项目名称' })
    }
    const [u] = await pool.execute(
      `SELECT id, unit_name,
              CASE WHEN short_name IS NULL OR short_name = '' THEN unit_name ELSE short_name END AS short_name
       FROM t_contractor_unit WHERE id = ? AND is_active = 1`,
      [unit_id]
    )
    if (!u.length) return res.status(400).json({ success: false, error: '承包商不存在或未在册' })

    const [r] = await pool.execute(
      `INSERT INTO t_doc_package (unit_id, unit_name, unit_short, project_name, reporter_name, reporter_phone, status)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [unit_id, u[0].unit_name, u[0].short_name, project_name, reporter_name, reporter_phone]
    )
    res.json({ success: true, data: { id: r.insertId, project_name, unit_name: u[0].unit_name } })
  } catch (e) {
    console.error('[contractorDoc] create package', e.message)
    res.status(500).json({ success: false, error: '建包失败' })
  }
})

// GET /api/contractor-docs/packages —— 查包（建/选：按单位+关键字）
router.get('/packages', async (req, res) => {
  try {
    const { unit_id = '', keyword = '' } = req.query
    const where = []
    const params = []
    if (unit_id) { where.push('p.unit_id = ?'); params.push(unit_id) }
    if (keyword) { where.push('p.project_name LIKE ?'); params.push(`%${keyword}%`) }
    const sql = `SELECT p.id, p.project_name, p.unit_name, p.unit_short, p.reporter_name,
                        p.status, p.updated_at,
                        (SELECT COUNT(*) FROM t_doc_file f WHERE f.package_id = p.id) AS file_count
                 FROM t_doc_package p
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY p.updated_at DESC LIMIT 50`
    const [rows] = await pool.execute(sql, params)
    res.json({ success: true, data: rows })
  } catch (e) {
    console.error('[contractorDoc] list packages', e.message)
    res.status(500).json({ success: false, error: '查询项目失败' })
  }
})

// PATCH /api/contractor-docs/packages/:id —— 更新状态/上报人（自填状态）
router.patch('/packages/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { status, reporter_name, reporter_phone } = req.body || {}
    const sets = []
    const params = []
    if (status !== undefined) { sets.push('status = ?'); params.push(status ? 1 : 0) }
    if (reporter_name !== undefined) { sets.push('reporter_name = ?'); params.push(reporter_name) }
    if (reporter_phone !== undefined) { sets.push('reporter_phone = ?'); params.push(reporter_phone) }
    if (!sets.length) return res.status(400).json({ success: false, error: '无可更新字段' })
    params.push(id)
    await pool.execute(`UPDATE t_doc_package SET ${sets.join(', ')} WHERE id = ?`, params)
    res.json({ success: true })
  } catch (e) {
    console.error('[contractorDoc] patch package', e.message)
    res.status(500).json({ success: false, error: '更新失败' })
  }
})

// GET /api/contractor-docs/packages/:id/files —— 某包已传文件（含包信息）
router.get('/packages/:id/files', async (req, res) => {
  try {
    const packageId = Number(req.params.id)
    const [rows] = await pool.execute(
      `SELECT f.id, f.catalog_id, f.catalog_name, f.category, f.original_name, f.sys_name,
              f.cos_url, f.file_ext, f.file_size, f.uploader_name, f.uploaded_at
       FROM t_doc_file f WHERE f.package_id = ? ORDER BY f.catalog_id, f.uploaded_at`,
      [packageId]
    )
    const [pkg] = await pool.execute(
      'SELECT id, unit_id, unit_name, unit_short, project_name, reporter_name, reporter_phone, status FROM t_doc_package WHERE id = ?',
      [packageId]
    )
    res.json({ success: true, data: rows, package: pkg[0] || null })
  } catch (e) {
    console.error('[contractorDoc] package files', e.message)
    res.status(500).json({ success: false, error: '获取文件列表失败' })
  }
})

// POST /api/contractor-docs/files —— 上传附件（公开，需带录入人姓名+电话）
router.post('/files', upload.single('file'), uploadGuard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择文件' })
    const { package_id, catalog_id, uploader_name = '', uploader_phone = '' } = req.body || {}
    if (!package_id || !catalog_id) return res.status(400).json({ success: false, error: '缺少项目或资料项' })
    if (!uploader_name || !uploader_phone) {
      return res.status(400).json({ success: false, error: '请填写录入人姓名与电话（用于本人留痕）' })
    }
    const data = await createFileRecord({
      package_id, catalog_id,
      buffer: req.file.buffer, originalname: req.file.originalname,
      uploader_name, uploader_phone,
    })
    res.json({ success: true, data })
  } catch (e) {
    console.error('[contractorDoc] upload file', e.message)
    res.status(e.status || 500).json({ success: false, error: e.message || '上传失败' })
  }
})

// DELETE /api/contractor-docs/files/:id —— 仅本人（姓名+电话校验）
router.delete('/files/:id', loadOwnFile, async (req, res) => {
  try {
    const ok = assertOwner(req, res)
    if (ok !== true) return
    try { await deleteFile(req.docFile.cos_key) } catch (e) { console.error('[contractorDoc] COS 删除失败(忽略)', e.message) }
    await pool.execute('DELETE FROM t_doc_file WHERE id = ?', [req.docFile.id])
    res.json({ success: true })
  } catch (e) {
    console.error('[contractorDoc] delete file', e.message)
    res.status(500).json({ success: false, error: '删除失败' })
  }
})

// PUT /api/contractor-docs/files/:id —— 替换文件（仅本人）
router.put('/files/:id', loadOwnFile, upload.single('file'), uploadGuard, async (req, res) => {
  try {
    const ok = assertOwner(req, res)
    if (ok !== true) return
    if (!req.file) return res.status(400).json({ success: false, error: '请选择新文件' })
    const data = await replaceFileRecord(req.docFile, req.file.buffer, req.file.originalname)
    res.json({ success: true, data })
  } catch (e) {
    console.error('[contractorDoc] replace file', e.message)
    res.status(e.status || 500).json({ success: false, error: e.message || '替换失败' })
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  管理端（admin / superadmin）
// ════════════════════════════════════════════════════════════════════════════

// 目录维护 ────────────────────────────────────────────────────────────────────
router.get('/admin/catalog', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, category, item_name, freq, required_type, sort_order, is_active
       FROM t_doc_catalog ORDER BY category, sort_order, id`
    )
    res.json({ success: true, data: rows })
  } catch (e) { res.status(500).json({ success: false, error: '获取目录失败' }) }
})

router.post('/admin/catalog', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { category, item_name, freq = '', required_type = 'dynamic', sort_order = 0 } = req.body || {}
    if (!category || !item_name) return res.status(400).json({ success: false, error: '请填写体系分类与资料名称' })
    const rt = required_type === 'gate' ? 'gate' : 'dynamic'
    const [r] = await pool.execute(
      `INSERT INTO t_doc_catalog (category, item_name, freq, required_type, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [category, item_name, freq, rt, sort_order]
    )
    res.json({ success: true, data: { id: r.insertId } })
  } catch (e) { res.status(500).json({ success: false, error: '新增目录项失败' }) }
})

router.put('/admin/catalog/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { category, item_name, freq, required_type, sort_order, is_active } = req.body || {}
    const sets = [], params = []
    if (category !== undefined) { sets.push('category = ?'); params.push(category) }
    if (item_name !== undefined) { sets.push('item_name = ?'); params.push(item_name) }
    if (freq !== undefined) { sets.push('freq = ?'); params.push(freq) }
    if (required_type !== undefined) { sets.push('required_type = ?'); params.push(required_type === 'gate' ? 'gate' : 'dynamic') }
    if (sort_order !== undefined) { sets.push('sort_order = ?'); params.push(sort_order) }
    if (is_active !== undefined) { sets.push('is_active = ?'); params.push(is_active ? 1 : 0) }
    if (!sets.length) return res.status(400).json({ success: false, error: '无可更新字段' })
    params.push(id)
    await pool.execute(`UPDATE t_doc_catalog SET ${sets.join(', ')} WHERE id = ?`, params)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ success: false, error: '更新目录项失败' }) }
})

router.delete('/admin/catalog/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    // 软删除：保留历史文件关联
    await pool.execute('UPDATE t_doc_catalog SET is_active = 0 WHERE id = ?', [id])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ success: false, error: '删除目录项失败' }) }
})

// 跨单位齐全度总览 ──────────────────────────────────────────────────────────────
router.get('/admin/packages', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { unit_id = '', keyword = '', status = '' } = req.query
    const where = [], params = []
    if (unit_id) { where.push('p.unit_id = ?'); params.push(unit_id) }
    if (keyword) { where.push('(p.project_name LIKE ? OR p.unit_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
    if (status !== '') { where.push('p.status = ?'); params.push(status === '1' ? 1 : 0) }

    const [rows] = await pool.execute(
      `SELECT p.id, p.unit_id, p.unit_name, p.unit_short, p.project_name, p.reporter_name,
              p.reporter_phone, p.status, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM t_doc_file f JOIN t_doc_catalog c ON f.catalog_id=c.id
               WHERE f.package_id=p.id AND c.required_type='gate' AND c.is_active=1) AS gate_done,
              (SELECT COUNT(*) FROM t_doc_file f JOIN t_doc_catalog c ON f.catalog_id=c.id
               WHERE f.package_id=p.id AND c.required_type='dynamic' AND c.is_active=1) AS dyn_done
       FROM t_doc_package p
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.updated_at DESC LIMIT 200`,
      params
    )
    // 全局门槛/动态总数（用于齐全度分母）
    const [tot] = await pool.execute(
      `SELECT
         SUM(required_type='gate' AND is_active=1) AS gate_total,
         SUM(required_type='dynamic' AND is_active=1) AS dyn_total
       FROM t_doc_catalog`
    )
    res.json({
      success: true,
      data: rows,
      totals: { gate_total: tot[0].gate_total || 0, dyn_total: tot[0].dyn_total || 0 },
    })
  } catch (e) {
    console.error('[contractorDoc] admin packages', e.message)
    res.status(500).json({ success: false, error: '查询台账失败' })
  }
})

// 管理端查看某包文件（含录入人留痕）
router.get('/admin/packages/:id/files', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const packageId = Number(req.params.id)
    const [rows] = await pool.execute(
      `SELECT f.id, f.catalog_id, f.catalog_name, f.category, f.original_name, f.sys_name,
              f.cos_url, f.file_ext, f.file_size, f.uploader_name, f.uploader_phone, f.uploaded_at
       FROM t_doc_file f WHERE f.package_id = ? ORDER BY f.catalog_id, f.uploaded_at`,
      [packageId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { res.status(500).json({ success: false, error: '获取文件失败' }) }
})

// 管理端强制删除（清理用）
router.delete('/admin/files/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [rows] = await pool.execute('SELECT cos_key FROM t_doc_file WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '文件不存在' })
    try { await deleteFile(rows[0].cos_key) } catch (e) { console.error('[contractorDoc] COS 删除失败(忽略)', e.message) }
    await pool.execute('DELETE FROM t_doc_file WHERE id = ?', [id])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ success: false, error: '删除失败' }) }
})

// 管理端删除整包 —— 连包带全部文件（COS + DB）一并删除，刷新后不再残留
router.delete('/admin/packages/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [pkgs] = await pool.execute('SELECT id FROM t_doc_package WHERE id = ?', [id])
    if (!pkgs.length) return res.status(404).json({ success: false, error: '项目不存在' })
    const [files] = await pool.execute('SELECT id, cos_key FROM t_doc_file WHERE package_id = ?', [id])
    for (const f of files) {
      try { await deleteFile(f.cos_key) } catch (e) { console.error('[contractorDoc] 删除包内文件 COS 失败(忽略)', e.message) }
    }
    if (files.length) await pool.execute('DELETE FROM t_doc_file WHERE package_id = ?', [id])
    await pool.execute('DELETE FROM t_doc_package WHERE id = ?', [id])
    res.json({ success: true, data: { removed_files: files.length } })
  } catch (e) {
    console.error('[contractorDoc] delete package', e.message)
    res.status(500).json({ success: false, error: '删除失败' })
  }
})

// 管理端替换文件 —— 不管谁录的，管理员均可替换文件内容（绕过本人校验）
router.put('/admin/files/:id', requireRole('admin', 'superadmin'), loadOwnFile, upload.single('file'), uploadGuard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择新文件' })
    const data = await replaceFileRecord(req.docFile, req.file.buffer, req.file.originalname)
    res.json({ success: true, data })
  } catch (e) {
    console.error('[contractorDoc] admin replace file', e.message)
    res.status(e.status || 500).json({ success: false, error: e.message || '替换失败' })
  }
})

// 管理端修改文件信息 —— 换资料项 / 改原文件名（不管谁录的）
router.patch('/admin/files/:id', requireRole('admin', 'superadmin'), loadOwnFile, async (req, res) => {
  try {
    const { catalog_id, original_name } = req.body || {}
    if (catalog_id === undefined && original_name === undefined) {
      return res.status(400).json({ success: false, error: '无可更新字段' })
    }
    const sets = [], params = []
    if (original_name !== undefined) {
      const name = String(original_name || '').trim()
      if (!name) return res.status(400).json({ success: false, error: '原文件名不能为空' })
      sets.push('original_name = ?'); params.push(name)
    }
    if (catalog_id !== undefined) {
      const cid = Number(catalog_id)
      const [cat] = await pool.execute('SELECT id, item_name, category FROM t_doc_catalog WHERE id = ? AND is_active = 1', [cid])
      if (!cat.length) return res.status(400).json({ success: false, error: '资料项不存在或已停用' })
      sets.push('catalog_id = ?', 'catalog_name = ?', 'category = ?')
      params.push(cid, cat[0].item_name, cat[0].category)
    }
    params.push(req.docFile.id)
    await pool.execute(`UPDATE t_doc_file SET ${sets.join(', ')} WHERE id = ?`, params)
    await pool.execute('UPDATE t_doc_package SET updated_at = NOW() WHERE id = ?', [req.docFile.package_id])
    res.json({ success: true })
  } catch (e) {
    console.error('[contractorDoc] admin patch file', e.message)
    res.status(500).json({ success: false, error: '更新失败' })
  }
})

// 管理端增补文件 —— 帮承包商补录（留痕管理员，不管原来谁录的）
router.post('/admin/packages/:id/files', requireRole('admin', 'superadmin'), upload.single('file'), uploadGuard, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请选择文件' })
    const packageId = Number(req.params.id)
    const catalog_id = Number(req.body.catalog_id)
    if (!catalog_id) return res.status(400).json({ success: false, error: '请选择资料项' })
    const adminName = (req.admin && req.admin.username) || '管理员'
    const data = await createFileRecord({
      package_id: packageId, catalog_id,
      buffer: req.file.buffer, originalname: req.file.originalname,
      uploader_name: adminName, uploader_phone: adminName,
    })
    res.json({ success: true, data })
  } catch (e) {
    console.error('[contractorDoc] admin add file', e.message)
    res.status(e.status || 500).json({ success: false, error: e.message || '上传失败' })
  }
})

// 台账导出 Excel（汇总表 + 明细表）
router.get('/admin/export', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const xlsx = require('xlsx')
    const { unit_id = '', keyword = '', status = '' } = req.query
    const where = [], params = []
    if (unit_id) { where.push('p.unit_id = ?'); params.push(unit_id) }
    if (keyword) { where.push('(p.project_name LIKE ? OR p.unit_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
    if (status !== '') { where.push('p.status = ?'); params.push(status === '1' ? 1 : 0) }

    const [pkgs] = await pool.execute(
      `SELECT p.id, p.unit_name, p.unit_short, p.project_name, p.reporter_name, p.reporter_phone,
              p.status, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM t_doc_file f JOIN t_doc_catalog c ON f.catalog_id=c.id
               WHERE f.package_id=p.id AND c.required_type='gate' AND c.is_active=1) AS gate_done,
              (SELECT COUNT(*) FROM t_doc_file f JOIN t_doc_catalog c ON f.catalog_id=c.id
               WHERE f.package_id=p.id AND c.required_type='dynamic' AND c.is_active=1) AS dyn_done
       FROM t_doc_package p
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.updated_at DESC`,
      params
    )
    const [tot] = await pool.execute(
      `SELECT SUM(required_type='gate' AND is_active=1) AS gate_total,
              SUM(required_type='dynamic' AND is_active=1) AS dyn_total FROM t_doc_catalog`
    )
    const gateTotal = tot[0].gate_total || 0, dynTotal = tot[0].dyn_total || 0

    const summary = pkgs.map((p, i) => ({
      序号: i + 1,
      承包商: p.unit_name,
      简称: p.unit_short,
      项目名称: p.project_name,
      上报人: p.reporter_name,
      上报人电话: p.reporter_phone,
      开工门槛齐全: `${p.gate_done}/${gateTotal}`,
      动态维护齐全: `${p.dyn_done}/${dynTotal}`,
      状态: p.status ? '已提交' : '进行中',
      更新时间: p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN') : '',
    }))

    const [files] = await pool.execute(
      `SELECT p.unit_name, p.unit_short, p.project_name, f.catalog_name, f.category,
              f.original_name, f.sys_name, f.cos_url, f.uploader_name, f.uploaded_at
       FROM t_doc_file f JOIN t_doc_package p ON f.package_id = p.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.unit_name, p.project_name, f.catalog_id`,
      params
    )
    const detail = files.map((f, i) => ({
      序号: i + 1,
      承包商: f.unit_name,
      项目名称: f.project_name,
      体系分类: f.category,
      资料名称: f.catalog_name,
      原文件名: f.original_name,
      系统命名: f.sys_name,
      录入人: f.uploader_name,
      上传时间: f.uploaded_at ? new Date(f.uploaded_at).toLocaleString('zh-CN') : '',
      下载链接: f.cos_url,
    }))

    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(summary), '项目齐全度')
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(detail), '资料明细')
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Disposition', 'attachment; filename="contractor_docs.xlsx"')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buf)
  } catch (e) {
    console.error('[contractorDoc] export', e.message)
    res.status(500).json({ success: false, error: '导出失败' })
  }
})

module.exports = router
