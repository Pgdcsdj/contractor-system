/**
 * 账号管理路由（模块 B）
 *
 * 全部 requireRole('admin','superadmin') 守卫；越权统一 403。
 *
 * GET    /api/account                账号列表（筛选 + 分页）
 * POST   /api/account                创建账号（password=bcrypt(phone)，username=phone，role 默认 safety）
 * PUT    /api/account/:id            更新账号（姓名/电话/角色/单位/状态）
 * DELETE /api/account/:id            物理删除账号（不可删自己、不可删最后一个 superadmin）
 * PUT    /api/account/:id/reset-password  密码重置（重置为 bcrypt(phone)，安全员据此用新电话登录）[P1]
 *
 * 设计依据：系统架构设计 §3.4(b) / 主理人 8 项裁决 第 3/5 条。
 */

const express = require('express')
const bcrypt = require('bcrypt')
const { pool } = require('../db/db')
const { requireRole } = require('../services/permission')

const router = express.Router()

// ─── GET /api/account —— 账号列表 ─────────────────────────────────────────
router.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const {
    role = '',
    unit_id = '',
    status = '',
    keyword = '',
    page = 1,
    pageSize = 20,
  } = req.query

  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const offset = (safePage - 1) * safePageSize

  const where = []
  const params = []
  if (role) { where.push('role = ?'); params.push(role) }
  if (unit_id) { where.push('unit_id = ?'); params.push(Number(unit_id)) }
  if (status !== '') { where.push('status = ?'); params.push(Number(status)) }
  if (keyword) {
    where.push('(real_name LIKE ? OR username LIKE ? OR phone LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''

  try {
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM t_admin ${whereClause}`,
      params
    )
    const [rows] = await pool.query(
      `SELECT id, username, role, status, real_name, phone, unit_id, last_login, created_at
         FROM t_admin ${whereClause}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [...params, safePageSize, offset]
    )
    res.json({
      success: true,
      data: { total, list: rows, page: safePage, pageSize: safePageSize },
    })
  } catch (err) {
    console.error('[account list]', err.message)
    res.status(500).json({ success: false, error: '账号列表查询失败：' + err.message })
  }
})

// ─── POST /api/account —— 创建账号 ────────────────────────────────────────
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { real_name, phone, role = 'safety', unit_id = null, status = 1 } = req.body || {}
  if (!real_name || !String(real_name).trim()) {
    return res.status(400).json({ success: false, error: '请填写姓名' })
  }
  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ success: false, error: '请填写电话' })
  }

  const cleanRole = ['safety', 'admin'].includes(role) ? role : 'safety'
  // 越权保护：非 superadmin 不能创建 superadmin
  if (cleanRole === 'superadmin' && req.admin.role !== 'superadmin') {
    return res.status(403).json({ success: false, error: '无权创建超级管理员账号' })
  }

  const username = String(phone).trim() // 用户名 = 电话
  const tel = String(phone).trim()
  const safeUnit = unit_id ? Number(unit_id) : null

  try {
    // 防重：username（电话）唯一
    const [exist] = await pool.execute('SELECT id FROM t_admin WHERE username = ?', [username])
    if (exist.length) {
      return res.status(400).json({ success: false, error: '该电话已存在账号' })
    }
    const hashed = await bcrypt.hash(tel, 10)
    const [result] = await pool.execute(
      `INSERT INTO t_admin (username, password, role, status, real_name, phone, unit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, hashed, cleanRole, Number(status) === 0 ? 0 : 1, String(real_name).trim(), tel, safeUnit]
    )
    res.json({ success: true, data: { id: result.insertId } })
  } catch (err) {
    console.error('[account create]', err.message)
    res.status(500).json({ success: false, error: '创建账号失败：' + err.message })
  }
})

// ─── PUT /api/account/:id/reset-password —— 密码重置 [P1] ─────────────────
router.put('/:id/reset-password', requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id)
  const { phone } = req.body || {}
  if (!id) return res.status(400).json({ success: false, error: '无效账号ID' })
  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ success: false, error: '请提供新电话（重置后作为登录密码）' })
  }
  try {
    const [rows] = await pool.execute('SELECT id FROM t_admin WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '账号不存在' })
    const cleanPhone = String(phone).trim()
    const hashed = await bcrypt.hash(cleanPhone, 10)
    // 重置：password = bcrypt(phone)，且同步更新 username / phone（登录即用新电话）
    await pool.execute(
      'UPDATE t_admin SET phone = ?, username = ?, password = ? WHERE id = ?',
      [cleanPhone, cleanPhone, hashed, id]
    )
    res.json({ success: true, data: { id } })
  } catch (err) {
    console.error('[account reset-password]', err.message)
    res.status(500).json({ success: false, error: '密码重置失败：' + err.message })
  }
})

// ─── PUT /api/account/:id —— 更新账号 ─────────────────────────────────────
router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ success: false, error: '无效账号ID' })
  const { real_name, phone, role, unit_id, status } = req.body || {}

  try {
    const [rows] = await pool.execute('SELECT id, role, username FROM t_admin WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '账号不存在' })
    const target = rows[0]

    // 越权保护
    if (role !== undefined && role !== '') {
      if (role === 'superadmin' && req.admin.role !== 'superadmin') {
        return res.status(403).json({ success: false, error: '无权提权为超级管理员' })
      }
      // 不可修改自己的角色（防自锁）
      if (target.id === req.admin.id && role !== target.role) {
        return res.status(403).json({ success: false, error: '不能修改自己的角色' })
      }
    }
    // 不可禁用自己（防自锁）
    if (status !== undefined && Number(status) === 0 && target.id === req.admin.id) {
      return res.status(403).json({ success: false, error: '不能禁用自己的账号' })
    }

    const sets = []
    const params = []
    if (real_name !== undefined && real_name !== '') {
      sets.push('real_name = ?'); params.push(String(real_name).trim())
    }
    if (unit_id !== undefined) {
      sets.push('unit_id = ?'); params.push(unit_id ? Number(unit_id) : null)
    }
    if (status !== undefined) {
      sets.push('status = ?'); params.push(Number(status) === 0 ? 0 : 1)
    }
    if (role !== undefined && role !== '') {
      sets.push('role = ?'); params.push(role)
    }
    if (phone !== undefined && phone !== '') {
      // 电话变更 → 同步 username 与密码（bcrypt(phone)）
      const tel = String(phone).trim()
      sets.push('phone = ?'); params.push(tel)
      sets.push('username = ?'); params.push(tel)
      const hashed = await bcrypt.hash(tel, 10)
      sets.push('password = ?'); params.push(hashed)
    }

    if (!sets.length) return res.json({ success: true, data: { id } })
    params.push(id)
    await pool.execute(`UPDATE t_admin SET ${sets.join(', ')} WHERE id = ?`, params)
    res.json({ success: true, data: { id } })
  } catch (err) {
    console.error('[account update]', err.message)
    res.status(500).json({ success: false, error: '更新账号失败：' + err.message })
  }
})

// ─── DELETE /api/account/:id —— 物理删除账号 ─────────────────────────────
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ success: false, error: '无效账号ID' })
  try {
    // 不可删除自己
    if (id === req.admin.id) {
      return res.status(403).json({ success: false, error: '不能删除自己' })
    }
    const [rows] = await pool.execute('SELECT id, role FROM t_admin WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '账号不存在' })
    const target = rows[0]
    // 不可删除最后一个 superadmin
    if (target.role === 'superadmin') {
      const [[{ c }]] = await pool.execute("SELECT COUNT(*) AS c FROM t_admin WHERE role = 'superadmin'")
      if (c <= 1) {
        return res.status(403).json({ success: false, error: '不能删除最后一个超级管理员' })
      }
    }
    await pool.execute('DELETE FROM t_admin WHERE id = ?', [id])
    res.json({ success: true, data: { id } })
  } catch (err) {
    console.error('[account delete]', err.message)
    res.status(500).json({ success: false, error: '删除账号失败：' + err.message })
  }
})

module.exports = router
