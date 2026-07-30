/**
 * 登录认证服务
 * - JWT 签发与验证
 * - 二维码 Token 登录
 * - 手动登录（姓名 + 身份证后四位）
 */

const jwt  = require('jsonwebtoken')
const { pool } = require('../db/db')

const JWT_SECRET  = process.env.JWT_SECRET  || 'tnb-training-jwt-secret-2026'
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h'

/**
 * 签发用户 JWT Token
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, unit: user.unit },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  )
}

/**
 * 验证并解析 JWT Token
 * @returns {{ id, name, unit } | null}
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

/**
 * 二维码 Token 登录
 * @param {string} qrToken  扫码得到的 Token
 */
async function loginByQr(qrToken) {
  const [rows] = await pool.execute(
    'SELECT id, name, id_card, unit, status FROM t_user WHERE qr_token = ? LIMIT 1',
    [qrToken]
  )

  if (!rows.length)           throw new Error('二维码无效，请联系管理员更新人员信息')
  if (rows[0].status === 0)   throw new Error('账号已被禁用，请联系管理员')

  const user = rows[0]
  const token = signToken(user)

  return { token, user: { id: user.id, name: user.name, unit: user.unit } }
}

/**
 * 手动登录（姓名 + 身份证后四位）
 * @param {string} name     姓名
 * @param {string} last4    身份证后四位
 */
async function loginByManual(name, last4) {
  if (!name || !last4) throw new Error('请输入姓名和身份证后四位')
  if (!/^\d{4}$/.test(last4)) throw new Error('身份证后四位格式不正确')

  const [rows] = await pool.execute(
    `SELECT id, name, id_card, unit, status
     FROM t_user
     WHERE name = ? AND RIGHT(id_card, 4) = ?
     LIMIT 1`,
    [name.trim(), last4]
  )

  if (!rows.length)          throw new Error('姓名或身份证后四位不正确')
  if (rows[0].status === 0)  throw new Error('账号已被禁用，请联系管理员')

  const user = rows[0]
  const token = signToken(user)

  return { token, user: { id: user.id, name: user.name, unit: user.unit } }
}

module.exports = { signToken, verifyToken, loginByQr, loginByManual }
