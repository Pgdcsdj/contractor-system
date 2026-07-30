/**
 * 整改单位 → 业务口 关联路由（Sprint 2 / 关联维护）
 *
 * GET  /api/rectify-unit-biz        返回全部关联（按 sort_order, id 排序）
 * POST /api/rectify-unit-biz        新增 / 更新关联（按 id 编辑，或按整改单位 upsert）
 * DELETE /api/rectify-unit-biz/:id  删除单条关联（仅删关联行，不删字典项）
 *
 * 鉴权：管理员 token（与 hazardLoop.js / hazardDict.js 同款内联 adminAuth）
 * 响应：{ success:true, data } / { success:false, error }
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')

const router = express.Router()

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

// ─── GET /api/rectify-unit-biz ────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM t_rectify_unit_biz ORDER BY sort_order, id'
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('[rectify-unit-biz]', err.message)
    res.status(500).json({ success: false, error: '关联查询失败：' + err.message })
  }
})

// ─── POST /api/rectify-unit-biz（支持按 id 编辑 / 按整改单位 upsert）────────
router.post('/', adminAuth, async (req, res) => {
  const {
    id,
    rectify_unit,
    business_dept = '',
    head_name = '',
    head_phone = '',
  } = req.body || {}
  if (!rectify_unit || !rectify_unit.trim()) {
    return res.status(400).json({ success: false, error: '整改单位不能为空' })
  }
  const ru = rectify_unit.trim()
  const biz = String(business_dept || '').trim()
  const head = String(head_name || '').trim()
  const phone = String(head_phone || '').trim()
  // 校验：head_name 非必填；若填了电话，简单校验 11 位手机号格式（非强制，留空允许）
  if (phone && !/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, error: '负责人电话格式不正确（应为 11 位手机号）' })
  }
  try {
    // 编辑分支：请求体带 id → 按 id 更新
    if (id !== undefined && id !== null && id !== '') {
      const [exist] = await pool.execute(
        'SELECT id FROM t_rectify_unit_biz WHERE id = ?',
        [id]
      )
      if (!exist.length) {
        return res.status(404).json({ success: false, error: '关联不存在' })
      }
      await pool.execute(
        'UPDATE t_rectify_unit_biz SET rectify_unit = ?, business_dept = ?, head_name = ?, head_phone = ? WHERE id = ?',
        [ru, biz, head, phone, id]
      )
      res.json({
        success: true,
        data: { id, rectify_unit: ru, business_dept: biz, head_name: head, head_phone: phone },
      })
      return
    }
    // 新增分支：按整改单位 upsert（带负责人信息）
    const [exist] = await pool.execute(
      'SELECT id FROM t_rectify_unit_biz WHERE rectify_unit = ?',
      [ru]
    )
    let result
    if (exist.length) {
      await pool.execute(
        'UPDATE t_rectify_unit_biz SET business_dept = ?, head_name = ?, head_phone = ? WHERE rectify_unit = ?',
        [biz, head, phone, ru]
      )
      result = { id: exist[0].id, rectify_unit: ru, business_dept: biz, head_name: head, head_phone: phone }
    } else {
      const [r] = await pool.execute(
        'INSERT INTO t_rectify_unit_biz (rectify_unit, business_dept, head_name, head_phone) VALUES (?, ?, ?, ?)',
        [ru, biz, head, phone]
      )
      result = { id: r.insertId, rectify_unit: ru, business_dept: biz, head_name: head, head_phone: phone }
    }
    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[rectify-unit-biz]', err.message)
    res.status(500).json({ success: false, error: '关联保存失败：' + err.message })
  }
})

// ─── DELETE /api/rectify-unit-biz/:id ─────────────────────────────────────
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const [r] = await pool.execute(
      'DELETE FROM t_rectify_unit_biz WHERE id = ?',
      [req.params.id]
    )
    res.json({ success: true, data: { deleted: r.affectedRows } })
  } catch (err) {
    console.error('[rectify-unit-biz]', err.message)
    res.status(500).json({ success: false, error: '关联删除失败：' + err.message })
  }
})

module.exports = router
