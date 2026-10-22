/**
 * 问题依据库路由（底层数据 = 安全违章库 t_violation，8 列）
 *
 * GET    /api/hazards/standard-basis          列表（?page&pageSize&keyword）
 * POST   /api/hazards/standard-basis          新增
 * PUT    /api/hazards/standard-basis/:id       修改
 * DELETE /api/hazards/standard-basis/:id       删除
 * POST   /api/hazards/standard-basis/match     单条匹配（body {category: 关键词}）
 * POST   /api/hazards/standard-basis/import    导入（xlsx，multipart file，8 列）
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

// ─── 单条匹配（录入隐患时自动匹配依据）────────────────────────────────────────
router.post('/match', requireAdminOrSafety, async (req, res) => {
  try {
    const { category } = req.body || {}
    const m = await svc.matchStandardBasisDb(pool, { category })
    res.json({ success: true, data: m })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 导入（8 列：违章编号/适用场所/违章分类/细分环节/检查对象/违章条款具体内容/检查依据/扣分风险等级）──
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
      if (row.includes('违章分类') || row.includes('违章条款具体内容') || row.includes('检查依据') || row.includes('标准依据')) { headerIdx = i; break }
    }
    if (headerIdx < 0) return res.status(400).json({ success: false, error: '未识别到表头（需含「违章分类」「违章条款具体内容」「检查依据」之一）' })
    const header = (raw[headerIdx] || []).map((c) => String(c ?? '').trim())
    const idx = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0)

    // 每个目标字段支持多个表头别名（兼容旧「排查项目/标准依据/来源标准」模板）
    const iCode = idx(['违章编号', '编号'])
    const iPlace = idx(['适用场所', '场所'])
    const iCat = idx(['违章分类', '排查项目', '分类'])
    const iSeg = idx(['细分环节'])
    const iObj = idx(['检查对象'])
    const iContent = idx(['违章条款具体内容', '标准依据', '条款内容'])
    const iBasis = idx(['检查依据', '来源标准', '依据'])
    const iDeduct = idx(['扣分风险等级', '风险等级'])
    if (iCat < 0 || iContent < 0) return res.status(400).json({ success: false, error: '模板缺少「违章分类」或「违章条款具体内容」列' })

    const rows = []
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i] || []
      if (r.every((c) => !String(c ?? '').trim())) continue
      rows.push({
        code: iCode >= 0 ? String(r[iCode] ?? '').trim() : '',
        place: iPlace >= 0 ? String(r[iPlace] ?? '').trim() : '',
        category: iCat >= 0 ? String(r[iCat] ?? '').trim() : '',
        sub_segment: iSeg >= 0 ? String(r[iSeg] ?? '').trim() : '',
        inspect_object: iObj >= 0 ? String(r[iObj] ?? '').trim() : '',
        standard_basis: iContent >= 0 ? String(r[iContent] ?? '').trim() : '',
        source: iBasis >= 0 ? String(r[iBasis] ?? '').trim() : '',
        deduct_level: iDeduct >= 0 ? String(r[iDeduct] ?? '').trim() : '',
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

// ─── 导出（8 列）──────────────────────────────────────────────────────────────
router.get('/export', requireAdminOrSafety, async (req, res) => {
  try {
    const rows = await svc.exportLibrary()
    const aoa = [['违章编号', '适用场所', '违章分类', '细分环节', '检查对象', '违章条款具体内容', '检查依据', '扣分风险等级']]
    for (const r of rows) aoa.push([r.code, r.place, r.category, r.sub_segment, r.inspect_object, r.content, r.basis, r.deduct_level])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    wb.SheetNames.push('安全违章依据库')
    wb.Sheets['安全违章依据库'] = ws
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
    const { category, standard_basis, source, place, sub_segment, inspect_object, deduct_level, code } = req.body || {}
    const item = await svc.create({ category, standard_basis, source, place, sub_segment, inspect_object, deduct_level, code })
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
