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
 * 约定：身份证末位为 X 时，密码按 0 处理（例如后四位 273X → 密码 2730）
 * @param {string} name     姓名
 * @param {string} last4    身份证后四位
 */
async function loginByManual(name, last4) {
  if (!name || !last4) throw new Error('请输入姓名和身份证后四位')
  const raw = String(last4).toUpperCase()
  if (!/^[0-9X]{4}$/.test(raw)) throw new Error('身份证后四位格式不正确')

  // 归一：末位 X 视为 0（系统约定）
  const inputLast4 = raw.replace(/X$/, '0')

  const [rows] = await pool.execute(
    `SELECT id, name, id_card, unit, status
     FROM t_user
     WHERE name = ? AND SUBSTRING(RIGHT(id_card, 4), 1, 3) = ?
     LIMIT 1`,
    [name.trim(), inputLast4.slice(0, 3)]
  )

  if (!rows.length)          throw new Error('姓名或身份证后四位不正确')
  if (rows[0].status === 0)  throw new Error('账号已被禁用，请联系管理员')

  const user = rows[0]
  // 校验归一后的后四位（末位 X 视为 0）
  const storedLast4 = String(user.id_card).toUpperCase().slice(-4).replace(/X$/, '0')
  if (storedLast4 !== inputLast4) throw new Error('姓名或身份证后四位不正确')

  const token = signToken(user)
  return { token, user: { id: user.id, name: user.name, unit: user.unit } }
}

module.exports = { signToken, verifyToken, loginByQr, loginByManual }
