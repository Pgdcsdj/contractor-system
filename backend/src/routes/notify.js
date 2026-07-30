/**
 * 钉钉通知路由（Sprint 1，Tier 0）
 *
 * 仅作联调 / 触发入口；真实通知由隐患状态机在分派/验收/超期时自动调用
 * services/dingtalk/notify.js 的 sendHazardNotification，不经过本路由。
 *
 * POST /api/notify/test   手动发送一条测试消息（需管理员 JWT）
 * POST /api/notify/event  按事件类型发送（需管理员 JWT），用于联调各模板
 */

const express = require('express')
const { verifyAdminToken } = require('../services/adminAuth')
const { sendHazardNotification, sendGroupRobot } = require('../services/dingtalk/notify')

const router = express.Router()

// 复用管理员 JWT 鉴权（与 admin.js 同逻辑，避免重复定义）
function auth(req, res, next) {
  const header = req.headers['authorization']
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(header.slice(7))
  if (!payload) return res.status(401).json({ error: '登录已过期，请重新登录' })
  req.admin = payload
  next()
}

// ─── POST /api/notify/test ─────────────────────────────────────────────────────
router.post('/test', auth, async (req, res) => {
  try {
    const r = await sendGroupRobot({
      content:  req.body.content  || '✅ 隐患闭环系统钉钉通知测试成功',
      atMobiles: req.body.atMobiles || [],
      msgtype:  req.body.msgtype  || 'text',
      title:    req.body.title    || '测试',
    })
    res.json({ success: true, ...r })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /api/notify/event ────────────────────────────────────────────────────
router.post('/event', auth, async (req, res) => {
  const { event, payload } = req.body
  if (!event) return res.status(400).json({ error: '缺少 event 参数' })
  try {
    const r = await sendHazardNotification(event, payload || {})
    res.json({ success: true, ...r })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

module.exports = router
