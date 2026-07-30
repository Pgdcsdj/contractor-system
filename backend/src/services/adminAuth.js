/**
 * 管理员认证服务
 * - 管理员账号密码登录（bcrypt 校验）
 * - JWT 签发
 */

const bcrypt = require('bcrypt')
const jwt    = require('jsonwebtoken')
const { pool } = require('../db/db')

const JWT_SECRET  = process.env.JWT_SECRET  || 'tnb-training-jwt-secret-2026'
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h'

/**
 * 签发管理员 JWT
 */
function signAdminToken(admin) {
  return jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  )
}

/**
 * 验证管理员密码
 * @param {string} plainPassword  明文密码
 * @param {string} hashedPassword bcrypt hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword)
}

/**
 * 管理员登录
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{token, user}>}
 */
async function adminLogin(username, password) {
  if (!username || !password) {
    throw new Error('请输入账号和密码')
  }

  const [rows] = await pool.execute(
    'SELECT id, username, password, role, status FROM t_admin WHERE username = ? LIMIT 1',
    [username.trim()]
  )

  if (!rows.length) {
    throw new Error('账号或密码错误')
  }

  const admin = rows[0]

  if (admin.status === 0) {
    throw new Error('账号已被禁用，请联系超级管理员')
  }

  const valid = await verifyPassword(password, admin.password)
  if (!valid) {
    throw new Error('账号或密码错误')
  }

  // 更新最后登录时间
  pool.execute('UPDATE t_admin SET last_login = NOW() WHERE id = ?', [admin.id])
    .catch(err => console.error('[AdminAuth] 更新登录时间失败:', err.message))

  const token = signAdminToken(admin)

  return {
    token,
    user: {
      id: admin.id,
      username: admin.username,
      role: admin.role,
    },
  }
}

/**
 * 验证管理员 JWT（供中间件使用）
 * @param {string} token
 * @returns {{ id, username, role } | null}
 */
function verifyAdminToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

module.exports = { adminLogin, verifyAdminToken, signAdminToken }
