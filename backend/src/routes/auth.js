/**
 * 登录路由
 *
 * POST /api/auth/qr-login        扫码登录（Token来自二维码）
 * POST /api/auth/manual-login    手动登录（姓名 + 身份证后四位）
 * POST /api/auth/register        临时注册（未录入人员自助注册）
 * GET  /api/auth/me              获取当前登录用户信息（需JWT）
 */

const express = require('express')
const { loginByQr, loginByManual, verifyToken, signToken } = require('../services/authService')
const { pool } = require('../db/db')

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先扫码或手动登录' })
  }
  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) {
    return res.status(401).json({ error: 'Token 已过期，请重新登录' })
  }
  req.user = payload
  next()
}

// ─── POST /api/auth/qr-login ─────────────────────────────────────────────────
router.post('/qr-login', async (req, res) => {
  const { token: qrToken } = req.body

  if (!qrToken) {
    return res.status(400).json({ error: '缺少二维码 Token' })
  }

  try {
    const result = await loginByQr(qrToken)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// ─── POST /api/auth/manual-login ────────────────────────────────────────────
router.post('/manual-login', async (req, res) => {
  const { name, last4 } = req.body

  try {
    const result = await loginByManual(name, last4)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// ─── POST /api/auth/register ──────────────────────────────────────────────────
// 临时注册：未录入系统的人员自助注册
router.post('/register', async (req, res) => {
  const { name, id_card, unit, supervising_unit = '', phone = '' } = req.body

  if (!name || !name.trim())   return res.status(400).json({ error: '请输入姓名' })
  if (!id_card || !id_card.trim()) return res.status(400).json({ error: '请输入身份证号' })

  const trimmedName = name.trim()
  const trimmedId   = id_card.trim()

  // 检查是否已注册
  const [existing] = await pool.execute(
    'SELECT id, name, id_card, unit, status FROM t_user WHERE id_card = ? LIMIT 1',
    [trimmedId]
  )

  if (existing.length > 0) {
    // 已存在 → 返回提示
    const user = existing[0]
    if (user.status === 0) return res.status(403).json({ error: '账号已被禁用，请联系管理员' })
    const token = signToken(user)
    return res.json({
      success: true,
      message: '欢迎回来',
      token,
      user: { id: user.id, name: user.name, unit: user.unit },
    })
  }

  // 新用户 → 注册
  // 生成简单的 qr_token（用 SHA-256 截断）
  const crypto = require('crypto')
  const qrToken = crypto.createHash('sha256').update(trimmedId).digest('hex').slice(0, 16)

  const [result] = await pool.execute(
    `INSERT INTO t_user (name, id_card, unit, supervising_unit, phone, qr_token, status)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [trimmedName, trimmedId, unit || '', supervising_unit, phone, qrToken]
  )

  const token = signToken({ id: result.insertId, name: trimmedName, unit: unit || '' })

  res.json({
    success: true,
    message: '注册成功',
    token,
    user: { id: result.insertId, name: trimmedName, unit: unit || '' },
  })
})

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user })
})

// 导出鉴权中间件，供其他路由复用
router.authMiddleware = authMiddleware

module.exports = router
