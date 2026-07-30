/**
 * 题库分类管理路由（管理员）
 *
 * GET    /api/admin/categories       分类列表
 * POST   /api/admin/categories       新增分类
 * PUT    /api/admin/categories/:id   编辑分类
 * DELETE /api/admin/categories/:id   删除分类
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const token = authHeader.slice(7)
  const payload = verifyAdminToken(token)
  if (!payload) return res.status(401).json({ error: '登录已过期' })
  req.admin = payload
  next()
}

// ─── GET /api/admin/categories ────────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, sort_order, created_at FROM t_material_category ORDER BY sort_order ASC, id ASC'
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('[category] GET 列表异常:', err.message)
    res.status(500).json({ success: false, error: '获取分类列表失败' })
  }
})

// ─── POST /api/admin/categories ───────────────────────────────────────────────
router.post('/', adminAuth, async (req, res) => {
  try {
    const { name, sort_order } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: '请输入分类名称' })

    const [result] = await pool.execute(
      'INSERT INTO t_material_category (name, sort_order) VALUES (?, ?)',
      [name.trim(), sort_order ?? 99]
    )
    res.json({ success: true, message: '分类已创建', data: { id: result.insertId } })
  } catch (err) {
    console.error('[category] POST 新增异常:', err.message)
    res.status(500).json({ success: false, error: '创建分类失败' })
  }
})

// ─── PUT /api/admin/categories/:id ───────────────────────────────────────────
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { name, sort_order } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: '请输入分类名称' })

    await pool.execute(
      'UPDATE t_material_category SET name = ?, sort_order = ? WHERE id = ?',
      [name.trim(), sort_order ?? 99, id]
    )
    res.json({ success: true, message: '分类已更新' })
  } catch (err) {
    console.error('[category] PUT 编辑异常:', err.message)
    res.status(500).json({ success: false, error: '更新分类失败' })
  }
})

// ─── DELETE /api/admin/categories/:id ────────────────────────────────────────
// 说明：当前 t_material / t_question 均未建立 category_id 外键关联，
// 因此无法做“是否在使用”的校验，直接删除即可。
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params
    await pool.execute('DELETE FROM t_material_category WHERE id = ?', [id])
    res.json({ success: true, message: '分类已删除' })
  } catch (err) {
    console.error('[category] DELETE 删除异常:', err.message)
    res.status(500).json({ success: false, error: '删除分类失败' })
  }
})

module.exports = router
