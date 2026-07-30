'use strict'

/**
 * Memos REST 客户端封装
 * ───────────────────────────────────────────────────────────────────────────
 * 仅用 Node 18+ 内置 fetch，不引入 axios。
 * 所有「内部」调用走 http://127.0.0.1:5230（宿主 localhost，绝不暴露公网）。
 *
 * 鉴权三要素（见设计）：
 *  - access token：响应体 JWT（15min），前端内存持有，走 Authorization: Bearer
 *  - refresh：memos_refresh HttpOnly cookie（30d）
 *  - PAT：long-lived Bearer，用于服务账号建账号 / 写联动日志
 */

const config = require('../config/memos.config')

/** 从 Set-Cookie 头中提取指定 cookie 的值。 */
function extractCookieValue(setCookieHeader, name) {
  if (!setCookieHeader) return null
  // 可能为数组（多 Set-Cookie）或字符串
  const items = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]
  for (const item of items) {
    const idx = item.indexOf(`${name}=`)
    if (idx === -1) continue
    const start = idx + name.length + 1
    let end = item.indexOf(';', start)
    if (end === -1) end = item.length
    return item.slice(start, end)
  }
  return null
}

/**
 * 以安全员账号用户名 + 密码登录 Memos，取回 refresh JWT（memos_refresh）。
 * 该 JWT 将被桥接层以父域 cookie 形式重设给浏览器。
 * @returns {Promise<{accessToken: ?string, refreshToken: string}>}
 */
async function signInAsSafetyOfficer() {
  const { safetyUsername, safetyPassword, baseUrl } = config.memos
  if (!safetyUsername || !safetyPassword) {
    throw new Error('安全员账号未配置（MEMOS_SAFETY_USERNAME / MEMOS_SAFETY_PASSWORD）')
  }
  const resp = await fetch(`${baseUrl}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      passwordCredentials: { username: safetyUsername, password: safetyPassword },
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Memos 登录失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  const data = await resp.json().catch(() => ({}))
  const accessToken = data && data.accessToken ? data.accessToken : null
  const refreshToken = extractCookieValue(resp.headers.get('set-cookie'), 'memos_refresh')
  if (!refreshToken) {
    throw new Error('Memos 登录未返回 memos_refresh cookie')
  }
  return { accessToken, refreshToken }
}

/**
 * 以 owner PAT 创建用户（安全员账号）。
 * @returns {Promise<object>} Memos 返回的用户对象
 */
async function createUser(username, password, role = 'USER') {
  const { ownerPat, baseUrl } = config.memos
  if (!ownerPat) throw new Error('owner PAT 未配置（MEMOS_OWNER_PAT）')
  const resp = await fetch(`${baseUrl}/api/v1/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerPat}`,
    },
    body: JSON.stringify({ username, password, role }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const err = new Error(`创建用户失败 ${resp.status}: ${text.slice(0, 200)}`)
    if (/exist/i.test(text) || resp.status === 400) err.code = 'USER_EXISTS'
    throw err
  }
  return resp.json().catch(() => ({ username, name: username }))
}

/**
 * 确保安全员账号存在：已存在则视为成功（返回 {username}），否则创建。
 * 需要 owner PAT。
 */
async function getOrCreateSafetyOfficer(displayName) {
  const { safetyUsername } = config.memos
  if (!safetyUsername) throw new Error('安全员账号未配置（MEMOS_SAFETY_USERNAME）')
  if (!config.memos.ownerConfigured) {
    throw new Error('owner PAT 未配置，无法自动创建安全员账号（MEMOS_OWNER_PAT）')
  }
  try {
    return await createUser(safetyUsername, config.memos.safetyPassword || randomPassword(), 'USER')
  } catch (err) {
    if (err.code === 'USER_EXISTS') {
      return { username: safetyUsername, name: displayName || safetyUsername, alreadyExists: true }
    }
    throw err
  }
}

/**
 * 为用户创建 Personal Access Token。
 * 优先使用传入 token（如安全员登录后的 accessToken），否则回退 owner PAT。
 * @returns {Promise<{token: string}>}
 */
async function createPersonalAccessToken(userId, description, expiresAt = null, token = null) {
  const authToken = token || config.memos.ownerPat
  if (!authToken) throw new Error('创建 PAT 需要 token 或 owner PAT')
  const resp = await fetch(
    `${config.memos.baseUrl}/api/v1/users/${encodeURIComponent(userId)}/personalAccessTokens`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ description, expiresAt }),
    }
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`创建 PAT 失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  const data = await resp.json().catch(() => ({}))
  const pat = data && (data.token || data.accessToken)
  if (!pat) throw new Error('Memos 未返回 PAT token')
  return { token: pat }
}

/**
 * 以安全员 PAT 写入一条工作日志（联动日志）。
 * @param {string} content    Markdown 内容
 * @param {string} visibility PRIVATE | PROTECTED | PUBLIC
 * @param {string[]} tags     标签数组（如 ['隐患','安全员']）
 * @returns {Promise<object>}
 */
async function createMemoAsSafety(content, visibility = 'PRIVATE', tags = []) {
  const { safetyPat, baseUrl } = config.memos
  if (!safetyPat) {
    throw new Error('安全员 PAT 未配置（MEMOS_SAFETY_PAT），跳过写日志')
  }
  const resp = await fetch(`${baseUrl}/api/v1/memos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${safetyPat}`,
    },
    body: JSON.stringify({ content, visibility, tags }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`写 Memos 日志失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  return resp.json().catch(() => ({}))
}

/** 列出某用户的 memo（owner PAT 或该用户 PAT）。 */
async function listMemos(userId, token) {
  const authToken = token || config.memos.ownerPat
  if (!authToken) throw new Error('查询 memo 需要 token 或 owner PAT')
  const url = userId
    ? `${config.memos.baseUrl}/api/v1/memos?creator=${encodeURIComponent(userId)}`
    : `${config.memos.baseUrl}/api/v1/memos`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`查询 memo 失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  const data = await resp.json().catch(() => ({}))
  return Array.isArray(data) ? data : data.memos || []
}

/** 生成随机强密码（provision 脚本备用）。 */
function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$'
  let out = ''
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

module.exports = {
  signInAsSafetyOfficer,
  createUser,
  getOrCreateSafetyOfficer,
  createPersonalAccessToken,
  createMemoAsSafety,
  listMemos,
  randomPassword,
  extractCookieValue,
}
