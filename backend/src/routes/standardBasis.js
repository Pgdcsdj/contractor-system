/**
 * 问题依据库路由（标准依据条款）
 *
 * GET    /api/hazards/standard-basis          列表（?page&pageSize&keyword）
 * POST   /api/hazards/standard-basis          新增
 * PUT    /api/hazards/standard-basis/:id       修改
 * DELETE /api/hazards/standard-basis/:id       删除
 * POST   /api/hazards/standard-basis/match     单条匹配（body {category}）
 * POST   /api/hazards/standard-basis/import    导入（xlsx，multipart file）
 * GET    /api/hazards/standard-basis/template  下载模板
 * GET    /api/hazards/standard-basis/export     导出 xlsx
 *
 * 注意：/template /export /import /match 为静态路径，必须在 /:id（PUT/DELETE）之前定义。
 * 鉴权：管理员 / 安全员双角色（requireAdminOrSafety）。
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const multer = require('multer')
const XLSX = require('xlsx')
const svc = require('../services/standardBasisService')

const router = express.Router()

// ─── 双角色鉴权中间件 ────────────────────────────────────────────────────────
function requireAdminOrSafety(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname) || file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    cb(null, ok)
  },
})

// ─── 列表 ────────────────────────────────────────────────────────────────────
router.get('/', requireAdminOrSafety, async (req, res) => {
  try {
    const { page, pageSize, keyword } = req.query
    const result = await svc.listLibrary({ page, pageSize, keyword })
    res.json({ success: true, data: result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 单条匹配 ────────────────────────────────────────────────────────────────
router.post('/match', requireAdminOrSafety, async (req, res) => {
  try {
    const { category } = req.body || {}
    const m = await svc.matchStandardBasisDb(pool, { category })
    res.json({ success: true, data: m })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 导入 ────────────────────────────────────────────────────────────────────
router.post('/import', requireAdminOrSafety, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '请上传 xlsx 文件' })
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    // 定位表头行
    let headerIdx = -1
    for (let i = 0; i < raw.length; i++) {
      const row = (raw[i] || []).map((c) => String(c ?? '').trim())
      if (row.includes('排查项目') || row.includes('标准依据')) { headerIdx = i; break }
    }
    if (headerIdx < 0) return res.status(400).json({ success: false, error: '未识别到表头（需含「排查项目」「标准依据」）' })
    const header = (raw[headerIdx] || []).map((c) => String(c ?? '').trim())
    const idx = (name) => header.indexOf(name)
    const iCat = idx('排查项目')
    const iBasis = idx('标准依据')
    const iSource = idx('来源标准')
    if (iCat < 0 || iBasis < 0) return res.status(400).json({ success: false, error: '模板缺少「排查项目」或「标准依据」列' })

    const rows = []
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i] || []
      if (r.every((c) => !String(c ?? '').trim())) continue
      rows.push({
        category: iCat >= 0 ? String(r[iCat] ?? '').trim() : '',
        standard_basis: iBasis >= 0 ? String(r[iBasis] ?? '').trim() : '',
        source: iSource >= 0 ? String(r[iSource] ?? '').trim() : '',
      })
    }
    const { success, fail } = await svc.importLibrary(rows)
    res.json({
      success: true,
      data: { imported: success.length, failed: fail.length, failRows: fail },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 模板下载 ────────────────────────────────────────────────────────────────
router.get('/template', requireAdminOrSafety, (req, res) => {
  try {
    const buf = svc.generateLibraryTemplate()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="standard_basis_template.xlsx"')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 导出 ────────────────────────────────────────────────────────────────────
router.get('/export', requireAdminOrSafety, async (req, res) => {
  try {
    const rows = await svc.exportLibrary()
    const aoa = [['排查项目', '标准依据', '来源标准']]
    for (const r of rows) aoa.push([r.category, r.standard_basis, r.source])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    wb.SheetNames.push('问题依据库')
    wb.Sheets['问题依据库'] = ws
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="standard_basis_export.xlsx"')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 新增 ────────────────────────────────────────────────────────────────────
router.post('/', requireAdminOrSafety, async (req, res) => {
  try {
    const { category, standard_basis, source, sort_order } = req.body || {}
    const item = await svc.create({ category, standard_basis, source, sort_order })
    res.json({ success: true, data: item })
  } catch (e) {
    res.status(400).json({ success: false, error: e.message })
  }
})

// ─── 修改 / 删除（必须在 /:id 静态路径之后，避免与上面静态路径冲突）────────────
router.put('/:id', requireAdminOrSafety, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const item = await svc.update(id, req.body || {})
    res.json({ success: true, data: item })
  } catch (e) {
    res.status(400).json({ success: false, error: e.message })
  }
})

router.delete('/:id', requireAdminOrSafety, async (req, res) => {
  try {
    const id = Number(req.params.id)
    await svc.remove(id)
    res.json({ success: true, data: { id } })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
