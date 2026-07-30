/**
 * 承包商单位管理路由（Sprint 1 / S1-3）
 *
 * GET    /api/contractor-units          单位列表（搜索/分页，默认仅显示在册）
 * GET    /api/contractor-units/:id      单位详情
 * POST   /api/contractor-units          新增单位
 * PUT    /api/contractor-units/:id      编辑单位
 * DELETE /api/contractor-units/:id      软退场（is_active=0，保留历史关联）
 * POST   /api/contractor-units/import   Excel 批量导入（需 .xlsx）
 */

const express = require('express')
const multer  = require('multer')
const { pool } = require('../db/db')
const { importContractorUnits } = require('../services/importContractorUnit')
const { verifyAdminToken }      = require('../services/adminAuth')

const router = express.Router()

// ─── JWT 鉴权中间件（与 admin.js / material.js 一致）─────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── Excel 上传（仅 .xlsx，5MB，存内存）──────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ]
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.xlsx')) {
      cb(null, true)
    } else {
      cb(new Error('只支持 .xlsx 格式文件'))
    }
  },
})

// ─── GET /api/contractor-units ───────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  const {
    keyword = '',
    supervising = '',
    page = 1,
    pageSize = 20,
    includeInactive = '0',
  } = req.query

  const safePage     = Math.max(1, Number(page)     || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const safeOffset   = (safePage - 1) * safePageSize

  const params = []
  let where = 'WHERE 1=1'
  if (includeInactive !== '1') where += ' AND is_active = 1'
  if (keyword) {
    where += ' AND (unit_name LIKE ? OR supervising_unit LIKE ? OR contact_name LIKE ? OR safety_officer_name LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (supervising) {
    where += ' AND supervising_unit = ?'
    params.push(supervising)
  }

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_contractor_unit ${where}`,
    params
  )
  const [rows] = await pool.query(
    `SELECT id, unit_name, supervising_unit, contact_name, contact_phone,
            safety_officer_name, safety_officer_phone, is_active, created_at, updated_at
     FROM t_contractor_unit ${where}
     ORDER BY created_at DESC
     LIMIT ${safePageSize} OFFSET ${safeOffset}`,
    params
  )

  res.json({ success: true, data: { total, list: rows, page: safePage, pageSize: safePageSize } })
})

// ─── GET /api/contractor-units/:id ──────────────────────────────────────────
router.get('/:id', adminAuth, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM t_contractor_unit WHERE id = ?', [req.params.id])
  if (!rows.length) return res.status(404).json({ error: '单位不存在' })
  res.json({ success: true, data: rows[0] })
})

// ─── POST /api/contractor-units ─────────────────────────────────────────────
router.post('/', adminAuth, async (req, res) => {
  const {
    unit_name,
    supervising_unit = '',
    contact_name = '',
    contact_phone = '',
    safety_officer_name = '',
    safety_officer_phone = '',
  } = req.body

  if (!unit_name || !unit_name.trim()) {
    return res.status(400).json({ error: '请输入承包商单位名称' })
  }

  const [existing] = await pool.execute(
    'SELECT id FROM t_contractor_unit WHERE unit_name = ?',
    [unit_name.trim()]
  )
  if (existing.length) {
    return res.status(400).json({ error: '该单位名称已存在' })
  }

  const [result] = await pool.execute(
    `INSERT INTO t_contractor_unit
       (unit_name, supervising_unit, contact_name, contact_phone, safety_officer_name, safety_officer_phone, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [unit_name.trim(), supervising_unit.trim(), contact_name.trim(),
     contact_phone.trim(), safety_officer_name.trim(), safety_officer_phone.trim()]
  )

  res.json({ success: true, message: '单位已添加', data: { id: result.insertId } })
})

// ─── PUT /api/contractor-units/:id ──────────────────────────────────────────
router.put('/:id', adminAuth, async (req, res) => {
  const { id } = req.params
  const [existing] = await pool.execute('SELECT id FROM t_contractor_unit WHERE id = ?', [id])
  if (!existing.length) return res.status(404).json({ error: '单位不存在' })

  const {
    unit_name, supervising_unit, contact_name, contact_phone,
    safety_officer_name, safety_officer_phone, is_active,
  } = req.body

  const updates = []
  const params = []
  if (unit_name !== undefined)            { updates.push('unit_name = ?');            params.push(unit_name.trim()) }
  if (supervising_unit !== undefined)     { updates.push('supervising_unit = ?');     params.push(supervising_unit.trim()) }
  if (contact_name !== undefined)         { updates.push('contact_name = ?');         params.push(contact_name.trim()) }
  if (contact_phone !== undefined)        { updates.push('contact_phone = ?');        params.push(contact_phone.trim()) }
  if (safety_officer_name !== undefined)  { updates.push('safety_officer_name = ?');  params.push(safety_officer_name.trim()) }
  if (safety_officer_phone !== undefined) { updates.push('safety_officer_phone = ?'); params.push(safety_officer_phone.trim()) }
  if (is_active !== undefined)            { updates.push('is_active = ?');            params.push(Number(is_active)) }

  if (!updates.length) return res.status(400).json({ error: '请提供要修改的字段' })

  await pool.execute(
    `UPDATE t_contractor_unit SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...params, id]
  )
  res.json({ success: true, message: '单位信息已更新' })
})

// ─── DELETE /api/contractor-units/:id（软退场）───────────────────────────────
router.delete('/:id', adminAuth, async (req, res) => {
  const { id } = req.params
  const [r] = await pool.execute(
    'UPDATE t_contractor_unit SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [id]
  )
  if (!r.affectedRows) return res.status(404).json({ error: '单位不存在' })
  res.json({ success: true, message: '单位已置为退场（保留历史关联）' })
})

// ─── POST /api/contractor-units/import ──────────────────────────────────────
router.post('/import', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 .xlsx 文件' })

  try {
    const result = await importContractorUnits(req.file.buffer, req.admin.id, req.file.originalname)
    res.json({
      success: true,
      message: `导入完成：成功 ${result.success} 条 / 失败 ${result.fail} 条`,
      data: {
        total:   result.total,
        success: result.success,
        fail:    result.fail,
        failPreview: result.failList.slice(0, 10),
      },
    })
  } catch (err) {
    console.error('[importContractorUnits error]', err.message)
    res.status(400).json({ error: err.message })
  }
})

module.exports = router
