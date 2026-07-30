'use strict'

/**
 * 钉钉 OAuth2 客户端（授权码模式，RFC 6749，无 SDK 依赖）
 * ───────────────────────────────────────────────────────────────────────────
 * 路径（来自架构设计 Q6）：
 *   1) authorizeUrl(state)            → 构造登录授权页 URL
 *   2) exchangeCode(code)             → 用 code 换 userAccessToken
 *   3) getUserInfo(userAccessToken)   → 取 unionId / 姓名
 */

const config = require('../config/memos.config')

const AUTH_ENDPOINT = 'https://login.dingtalk.com/oauth2/auth'
const TOKEN_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'
const USERINFO_ENDPOINT = 'https://api.dingtalk.com/v1.0/contact/users/me'

/** 构造钉钉授权页 URL（浏览器 302 跳转目标）。 */
function authorizeUrl(state) {
  const { clientId, redirectUri } = config.dingtalk
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state || '',
    response_type: 'code',
    prompt: 'consent',
    scope: 'openid',
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/**
 * 用授权码换 userAccessToken。
 * @returns {Promise<{userAccessToken: string}>}
 */
async function exchangeCode(code) {
  const { clientId, clientSecret } = config.dingtalk
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      code,
      refreshToken: '',
      grantType: 'authorization_code',
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`钉钉换 token 失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  const data = await resp.json().catch(() => ({}))
  if (!data || !data.userAccessToken) {
    throw new Error('钉钉未返回 userAccessToken')
  }
  return { userAccessToken: data.userAccessToken }
}

/**
 * 取当前钉钉用户信息（需权限点 Contact.User.Read）。
 * @returns {Promise<{unionId: string, name: string, avatar: ?string}>}
 */
async function getUserInfo(userAccessToken) {
  const resp = await fetch(USERINFO_ENDPOINT, {
    headers: { 'x-acs-dingtalk-access-token': userAccessToken },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`钉钉取用户信息失败 ${resp.status}: ${text.slice(0, 200)}`)
  }
  const data = await resp.json().catch(() => ({}))
  return {
    unionId: data.unionId || '',
    name: data.name || data.nickName || '',
    avatar: data.avatarUrl || null,
  }
}

module.exports = { authorizeUrl, exchangeCode, getUserInfo }
