'use strict'

/**
 * 钉钉通知设置路由（后台可配置开关 / 频次 / @范围）
 * ───────────────────────────────────────────────────────────────────────────
 * 挂载点：app.use('/api/notify-config', router)
 *   GET  /api/notify-config       读取当前配置 + 默认值（管理员）
 *   PUT  /api/notify-config       保存配置（管理员，校验 + 持久化 + 即时生效）
 *
 * 配置存 t_system_config（dingtalk_notify_config，JSON）。
 */

const express = require('express')
const { verifyAdminToken } = require('../services/adminAuth')
const {
  loadNotifyConfig,
  saveNotifyConfig,
  DEFAULT_DINGTALK_NOTIFY_CONFIG,
} = require('../services/notifyConfig')

const router = express.Router()

// 管理员鉴权（与 admin.js 同款）
function adminAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未授权，请先登录' })
  }
  try {
    const payload = verifyAdminToken(auth.slice(7))
    if (!payload) return res.status(401).json({ error: '登录已过期，请重新登录' })
    req.admin = payload
    next()
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
}

// ─── GET /api/notify-config ──────────────────────────────────────────────────
router.get('/', adminAuth, (req, res) => {
  try {
    res.json({
      success: true,
      data: loadNotifyConfig(),
      defaults: DEFAULT_DINGTALK_NOTIFY_CONFIG,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── PUT /api/notify-config ──────────────────────────────────────────────────
router.put('/', adminAuth, async (req, res) => {
  try {
    const saved = await saveNotifyConfig(req.body || {})
    res.json({ success: true, data: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

module.exports = router
