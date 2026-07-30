/**
 * 隐患字典路由（Sprint 2 / P1-1）
 *
 * GET /api/hazard-dict?type=level   返回种子字典（等级），供下拉使用
 *
 * 鉴权：管理员 token（与 hazard.js / contractorUnit.js 同款内联 adminAuth）
 */

const express = require('express')
const multer  = require('multer')
const xlsx   = require('xlsx')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const { DICT_TYPES, VALID_TYPES } = require('../constants/hazardStates')

const router = express.Router()

// ─── 位置字典导入：multer 内存存储 ─────────────────────────────────────
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      /\.(xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    cb(ok ? null : new Error('只支持 .xlsx / .xls 文件'), ok)
  },
})

// ─── JWT 鉴权中间件（与既有路由约定一致）─────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── GET /api/hazard-dict?type=level ────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  const { type } = req.query

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }

  try {
    const [rows] = await pool.execute(
      `SELECT id, type, code, name, parent_code, default_level, sort_order
         FROM t_hazard_dict
        WHERE type = ? AND enabled = 1
        ORDER BY sort_order ASC, id ASC`,
      [type]
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    res.status(500).json({ success: false, error: '字典查询失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict ──────────────────────────────────────────────────
// body: { type, code, name, parent_code?, default_level?, sort_order? }
router.post('/', adminAuth, async (req, res) => {
  const {
    type,
    code,
    name,
    parent_code = '',
    default_level = '',
    sort_order = 0,
  } = req.body || {}

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!code || !String(code).trim() || !name || !String(name).trim()) {
    return res.status(400).json({ success: false, error: '编码(code)与名称(name)均不能为空' })
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO t_hazard_dict (type, code, name, parent_code, default_level, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        type,
        String(code).trim(),
        String(name).trim(),
        String(parent_code || ''),
        String(default_level || ''),
        Number(sort_order) || 0,
      ]
    )
    res.json({ success: true, data: { id: result.insertId } })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    if (err.errno === 1062) {
      return res.status(409).json({ success: false, error: '该编码已存在' })
    }
    res.status(500).json({ success: false, error: '字典创建失败：' + err.message })
  }
})

// ─── PATCH /api/hazard-dict/:id ─────────────────────────────────────────────
// body: { type, name?, parent_code?, default_level?, sort_order?, enabled? }
// 动态拼接 UPDATE，仅更新传入字段；WHERE id=? AND type=?（type 必带以校验）
router.patch('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const type = req.body?.type || req.query?.type
  const { name, parent_code, default_level, sort_order, enabled } = req.body || {}

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: '无效的字典 ID' })
  }

  const sets = []
  const values = []
  if (name !== undefined) { sets.push('name = ?'); values.push(String(name).trim()) }
  if (parent_code !== undefined) { sets.push('parent_code = ?'); values.push(String(parent_code || '')) }
  if (default_level !== undefined) { sets.push('default_level = ?'); values.push(String(default_level || '')) }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); values.push(Number(sort_order) || 0) }
  if (enabled !== undefined) { sets.push('enabled = ?'); values.push(enabled ? 1 : 0) }

  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: '没有可更新的字段' })
  }

  try {
    const [result] = await pool.execute(
      `UPDATE t_hazard_dict SET ${sets.join(', ')} WHERE id = ? AND type = ?`,
      [...values, id, type]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '未找到对应的字典项' })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    if (err.errno === 1062) {
      return res.status(409).json({ success: false, error: '该编码已存在' })
    }
    res.status(500).json({ success: false, error: '字典更新失败：' + err.message })
  }
})

// ─── DELETE /api/hazard-dict/:id ────────────────────────────────────────────
// body 或 query 带 { type }
router.delete('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const type = req.body?.type || req.query?.type

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: '无效的字典 ID' })
  }

  try {
    const [result] = await pool.execute(
      `DELETE FROM t_hazard_dict WHERE id = ? AND type = ?`,
      [id, type]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '未找到对应的字典项' })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    res.status(500).json({ success: false, error: '字典删除失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict/import-locations —— 导入位置主数据（生产场站/施工点）──
// body: file(.xlsx), replace?(bool)
// 读「生产场站」sheet 第 2 列（跳过表头行）→ INSERT IGNORE 入 center_station（code=name, sort_order=行号）
// 读「施工点」sheet 第 2 列 → well_site；facility 无对应 sheet 不处理。
// 幂等：INSERT IGNORE 防重复；replace=true 时先清空对应 type 再导入。
router.post('/import-locations', adminAuth, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx 文件' })
  }
  const replace = req.body?.replace === 'true' || req.body?.replace === true
  try {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheetNames = wb.SheetNames || []

    const missing = ['生产场站', '施工点'].filter((s) => !sheetNames.includes(s))
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `缺少「${missing.join('」/「')}」sheet 或文件为空`,
      })
    }

    /**
     * 读取某个 sheet 的第 2 列（index 1），跳过表头行，INSERT IGNORE 入指定字典 type。
     * @returns {Promise<{received:number, inserted:number, skipped:number}>}
     */
    async function importSheet(sheetName, type) {
      const ws = wb.Sheets[sheetName]
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' })
      // 跳过表头行（第 1 行），从第 2 行起取第 2 列（index 1）
      const dataRows = rows.slice(1)
      const names = []
      dataRows.forEach((row, i) => {
        const v = row && row[1] != null ? String(row[1]).trim() : ''
        if (v) names.push({ name: v, sortOrder: i + 1 })
      })
      if (replace) {
        await pool.execute('DELETE FROM t_hazard_dict WHERE type = ?', [type])
      }
      let inserted = 0
      for (const n of names) {
        const [r] = await pool.execute(
          `INSERT IGNORE INTO t_hazard_dict (type, code, name, sort_order, enabled) VALUES (?, ?, ?, ?, 1)`,
          [type, n.name, n.name, n.sortOrder]
        )
        if (r.affectedRows > 0) inserted++
      }
      return { received: names.length, inserted, skipped: names.length - inserted }
    }

    const center = await importSheet('生产场站', 'center_station')
    const well = await importSheet('施工点', 'well_site')

    res.json({
      success: true,
      message: `导入完成：生产场站 ${center.inserted} 条、施工点 ${well.inserted} 条`,
      data: {
        sheets: ['生产场站', '施工点'],
        center_station: center,
        well_site: well,
      },
    })
  } catch (err) {
    console.error('[hazard-dict import-locations]', err.message)
    res.status(500).json({ success: false, error: '位置导入失败：' + err.message })
  }
})

module.exports = router
