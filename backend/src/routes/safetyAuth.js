/**
 * 安全员登录路由（模块 A）
 *
 * POST /api/safety/login  （公开，无需鉴权）
 *   入参: { real_name: string, phone: string }
 *   定位: WHERE real_name=? AND phone=? AND role='safety'（主理人裁决1：按 姓名+电话 双人组定位，不按 username）
 *   校验: bcrypt.compare(phone, password)  —— 密码入库 bcrypt(phone)
 *   成功: 复用 adminAuth.signAdminToken 签发 JWT（payload {id,username,role:'safety'}）
 *   出参: { success, token, role:'safety', real_name, unit_id, id }
 *   错误: 401 { error:'姓名或电话错误' } / 423 { error:'账号已被禁用' }（status=0）
 *
 * 设计依据：系统架构设计 §3.4(a) / §1.2；主理人 8 项裁决 第 1 条。
 */

const express = require('express')
const bcrypt = require('bcrypt')
const { pool } = require('../db/db')
const { signAdminToken } = require('../services/adminAuth')

const router = express.Router()

// ─── POST /api/safety/login ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { real_name, phone } = req.body || {}
  if (!real_name || !phone) {
    return res.status(400).json({ success: false, error: '请输入姓名和电话' })
  }
  const name = String(real_name).trim()
  const tel = String(phone).trim()

  try {
    // 1) 按 (real_name + phone + role='safety') 双人组定位账号（不按 username）
    const [rows] = await pool.execute(
      `SELECT id, username, password, role, status, real_name, unit_id
         FROM t_admin
        WHERE real_name = ? AND phone = ? AND role = 'safety'
        LIMIT 1`,
      [name, tel]
    )

    // 2) 账号不存在 → 401（姓名或电话错误）
    if (!rows.length) {
      return res.status(401).json({ success: false, error: '姓名或电话错误' })
    }
    const admin = rows[0]

    // 3) 已禁用 → 423（status=0）
    if (admin.status === 0) {
      return res.status(423).json({ success: false, error: '账号已被禁用，请联系管理员' })
    }

    // 4) 校验密码（bcrypt(phone) 存储）
    const valid = await bcrypt.compare(tel, admin.password)
    if (!valid) {
      return res.status(401).json({ success: false, error: '姓名或电话错误' })
    }

    // 5) 更新最后登录时间（fire-and-forget）
    pool.execute('UPDATE t_admin SET last_login = NOW() WHERE id = ?', [admin.id])
      .catch((e) => console.error('[safetyAuth] 更新登录时间失败:', e.message))

    // 6) 复用同一套 JWT 签发（role='safety'）
    const token = signAdminToken({ id: admin.id, username: admin.username, role: 'safety' })

    res.json({
      success: true,
      token,
      role: 'safety',
      real_name: admin.real_name || '',
      unit_id: admin.unit_id != null ? Number(admin.unit_id) : null,
      id: admin.id,
    })
  } catch (err) {
    console.error('[safety login]', err.message)
    res.status(500).json({ success: false, error: '登录失败：' + err.message })
  }
})

module.exports = router
