'use strict'

/**
 * 钉钉 OAuth 桥接路由（→ Memos 个人工作日志）
 * ───────────────────────────────────────────────────────────────────────────
 * 挂载点：app.use('/api/dingtalk', router)  （nginx 将 /api/ 透传到后端 :3000）
 *
 * 路由：
 *   GET /api/dingtalk/login    发起钉钉授权（302 → login.dingtalk.com）
 *   GET /api/dingtalk/callback 钉钉回调：换 token → 取用户 → 以安全员登录 Memos
 *                              → 同父域重设 memos_refresh cookie → 302 到 log 子域
 *   GET /api/dingtalk/enter    兜底：重发 cookie 直接进入工作日志
 *
 * 关键机制：Express 透传 Memos 下发的 memos_refresh JWT，
 * 以父域 cookie（Domain=.choiceeffect.store）重设，使 log 子域能收到登录态。
 */

const express = require('express')
const crypto = require('crypto')

const config = require('../config/memos.config')
const dingtalkClient = require('../services/dingtalkClient')
const memosClient = require('../services/memosClient')
const safetyOfficerSync = require('../services/safetyOfficerSync')

const router = express.Router()

/** 解析 Cookie 头（不依赖 cookie-parser 中间件）。 */
function parseCookies(req) {
  const header = req.headers.cookie
  const out = {}
  if (!header) return out
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=')
    if (idx === -1) return
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  })
  return out
}

/** 构造 memos_refresh 父域 cookie（Set-Cookie 值）。 */
function refreshCookieValue(token) {
  return `memos_refresh=${token}; Domain=${config.cookieDomain}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`
}

/** 构造 state cookie（防 CSRF，5 分钟有效）。 */
function stateCookieValue(state) {
  return `dingtalk_state=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=300`
}

/** 渲染一个简洁的中文提示页（用于未配置 / 异常时的浏览器导航降级）。 */
function renderNotice(res, message) {
  res.status(200).type('html').send(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
      `<title>个人工作日志</title></head>` +
      `<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;` +
      `background:#0f1724;color:#e8edf2;display:flex;align-items:center;justify-content:center;` +
      `height:100vh;margin:0"><div style="text-align:center;max-width:480px;padding:24px">` +
      `<h2 style="font-weight:700">个人工作日志</h2>` +
      `<p style="color:#cbd5e1;line-height:1.7;margin-top:12px">${message}</p>` +
      `<p style="margin-top:20px"><a href="/" style="color:#5ba0e0;text-decoration:none">← 返回首页</a></p>` +
      `</div></body></html>`
  )
}

// ─── GET /api/dingtalk/login ────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (!config.dingtalk.configured) {
    return renderNotice(
      res,
      '钉钉登录未配置：请在服务器 /root/.env 中设置 DINGTALK_CLIENT_ID、DINGTALK_CLIENT_SECRET、DINGTALK_REDIRECT_URI 后重启后端。'
    )
  }
  const state = crypto.randomBytes(16).toString('hex')
  res.setHeader('Set-Cookie', stateCookieValue(state))
  res.redirect(302, dingtalkClient.authorizeUrl(state))
})

// ─── GET /api/dingtalk/callback ─────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state } = req.query
  try {
    if (!config.dingtalk.configured) {
      return renderNotice(res, '钉钉登录未配置，无法完成桥接。')
    }
    if (!code) {
      return renderNotice(res, '钉钉授权失败：缺少授权码 code。')
    }
    // state 校验（防 CSRF）
    const cookies = parseCookies(req)
    if (state && cookies.dingtalk_state && state !== cookies.dingtalk_state) {
      return renderNotice(res, '钉钉授权校验失败（state 不匹配）。')
    }

    // 1) 换 userAccessToken
    const { userAccessToken } = await dingtalkClient.exchangeCode(code)
    // 2) 取钉钉用户
    const dingUser = await dingtalkClient.getUserInfo(userAccessToken)
    // 3) 解析安全员账号（确保存在）
    await safetyOfficerSync.resolveMemosUser(dingUser.unionId, dingUser.name)
    // 4) 以安全员身份登录 Memos，拿回 refresh JWT
    const { refreshToken } = await memosClient.signInAsSafetyOfficer()
    // 5) 同父域重设 cookie，并跳转工作日志子域
    res.setHeader('Set-Cookie', refreshCookieValue(refreshToken))
    return res.redirect(302, config.memos.publicUrl)
  } catch (err) {
    console.error('[dingtalk callback]', err.message)
    // 兜底：跳工作日志登录页，由用户手动登录
    return res.redirect(302, `${config.memos.publicUrl}/auth/signin?redirect=${encodeURIComponent('/')}`)
  }
})

// ─── GET /api/dingtalk/enter （兜底：重发 cookie 直接进入）────────────────────
router.get('/enter', async (req, res) => {
  try {
    if (!config.memos.safetyConfigured) {
      return renderNotice(res, '安全员账号未配置（MEMOS_SAFETY_USERNAME / MEMOS_SAFETY_PASSWORD），无法进入工作日志。')
    }
    const { refreshToken } = await memosClient.signInAsSafetyOfficer()
    res.setHeader('Set-Cookie', refreshCookieValue(refreshToken))
    return res.redirect(302, config.memos.publicUrl)
  } catch (err) {
    console.error('[dingtalk enter]', err.message)
    return res.redirect(302, `${config.memos.publicUrl}/auth/signin`)
  }
})

module.exports = router
