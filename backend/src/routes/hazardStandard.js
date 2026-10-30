/**
 * 隐患排查标准路由（底层数据 = t_hazard_check_standard）
 *
 * GET    /api/hazards/hazard-standard          列表（?page&pageSize&keyword&area&category）
 * POST   /api/hazards/hazard-standard          新增
 * PUT    /api/hazards/hazard-standard/:id       修改
 * DELETE /api/hazards/hazard-standard/:id       删除
 * POST   /api/hazards/hazard-standard/match     单条匹配（body {category: 关键词}）
 * POST   /api/hazards/hazard-standard/import    导入（xlsx，multipart file）
 * GET    /api/hazards/hazard-standard/template  下载模板
 * GET    /api/hazards/hazard-standard/export     导出 xlsx
 *
 * 注意：/template /export /import /match 为静态路径，必须在 /:id（PUT/DELETE）之前定义。
 * 鉴权：管理员 / 安全员双角色（requireAdminOrSafety）。
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const multer = require('multer')
const XLSX = require('xlsx')
const svc = require('../services/hazardStandardService')

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
    const { page, pageSize, keyword, area, category, manageCategory } = req.query
    const result = await svc.listLibrary({ page, pageSize, keyword, area, category, manageCategory })
    res.json({ success: true, data: result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 筛选项（适用区域 / 排查项目 / 管理类别 去重列表，供前端下拉）──────────────────
router.get('/options', requireAdminOrSafety, async (req, res) => {
  try {
    const opts = await svc.getFilterOptions()
    res.json({ success: true, data: opts })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 单条匹配（录入隐患时自动匹配标准，预留）──────────────────────────────────
router.post('/match', requireAdminOrSafety, async (req, res) => {
  try {
    const { category } = req.body || {}
    const m = await svc.matchStandardDb(pool, { category })
    res.json({ success: true, data: m })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 导入（列：适用区域/排查项目/管理类别/检查内容/检查标准/责任岗位/排查频次/来源文件）──
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
      if (row.includes('检查内容') || row.includes('检查标准') || row.includes('检查项') || row.includes('排查内容')) { headerIdx = i; break }
    }
    if (headerIdx < 0) return res.status(400).json({ success: false, error: '未识别到表头（需含「检查内容」「检查标准」之一）' })
    const header = (raw[headerIdx] || []).map((c) => String(c ?? '').trim())
    const idx = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0)

    // 每个目标字段支持多个表头别名（兼容模板/手册不同命名）
    const iArea = idx(['适用区域', '区域', '场所'])
    const iCat = idx(['排查项目', '设备', '项目', '排查类别'])
    const iManage = idx(['管理类别', '类别'])
    const iItem = idx(['检查内容', '检查项', '排查内容'])
    const iStd = idx(['检查标准', '标准', '标准内容'])
    const iPost = idx(['责任岗位', '岗位'])
    const iFreq = idx(['排查频次', '频次'])
    const iSrc = idx(['来源文件', '来源'])
    if (iItem < 0 || iStd < 0) return res.status(400).json({ success: false, error: '模板缺少「检查内容」或「检查标准」列' })

    const rows = []
    // 手册同一文件内常于不同段落“重发表头”，这些行正文恰好是「检查内容/检查标准」等列名，
    // 导入时必须跳过，否则会作为脏数据入库。
    const HEADER_LABELS = new Set(['检查内容', '检查项', '排查内容', '检查标准', '标准', '标准内容'])
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i] || []
      if (r.every((c) => !String(c ?? '').trim())) continue
      const checkItem = iItem >= 0 ? String(r[iItem] ?? '').trim() : ''
      const checkStandard = iStd >= 0 ? String(r[iStd] ?? '').trim() : ''
      if (HEADER_LABELS.has(checkItem) || HEADER_LABELS.has(checkStandard)) continue
      rows.push({
        area: iArea >= 0 ? String(r[iArea] ?? '').trim() : '',
        category: iCat >= 0 ? String(r[iCat] ?? '').trim() : '',
        manage_category: iManage >= 0 ? String(r[iManage] ?? '').trim() : '',
        check_item: checkItem,
        check_standard: checkStandard,
        responsible_post: iPost >= 0 ? String(r[iPost] ?? '').trim() : '',
        frequency: iFreq >= 0 ? String(r[iFreq] ?? '').trim() : '',
        source_file: iSrc >= 0 ? String(r[iSrc] ?? '').trim() : '',
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
    res.setHeader('Content-Disposition', 'attachment; filename="hazard_standard_template.xlsx"')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 导出 ────────────────────────────────────────────────────────────────────
router.get('/export', requireAdminOrSafety, async (req, res) => {
  try {
    const rows = await svc.exportLibrary()
    const aoa = [['适用区域', '排查项目', '管理类别', '检查内容', '检查标准', '责任岗位', '排查频次', '来源文件']]
    for (const r of rows) aoa.push([r.area, r.category, r.manage_category, r.check_item, r.check_standard, r.responsible_post, r.frequency, r.source_file])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    wb.SheetNames.push('隐患排查标准')
    wb.Sheets['隐患排查标准'] = ws
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="hazard_standard_export.xlsx"')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── 新增 ────────────────────────────────────────────────────────────────────
router.post('/', requireAdminOrSafety, async (req, res) => {
  try {
    const { area, category, manage_category, check_item, check_standard, responsible_post, frequency, source_file } = req.body || {}
    const item = await svc.create({ area, category, manage_category, check_item, check_standard, responsible_post, frequency, source_file })
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
