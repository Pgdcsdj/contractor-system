/**
 * 数据管理路由（模块 D）
 *
 * POST /api/data/backup        立即全量备份 t_hazard → backend/backups/*.xlsx
 * POST /api/data/export        按选中字段 + 类型(台账/周报/月报) 导出 Excel（直接返回附件）
 * GET  /api/data/backup-file   凭 token 直接下载（前端用 window.open 触发 webview 原生下载，规避 blob 在部分 webview 不触发的问题）
 * GET  /api/data/backups       列出历史备份文件（P2）
 *
 * 全部 requireRole('admin','superadmin') 守卫；越权统一 403。
 * 设计依据：系统架构设计 §3.4(d) / §8.6 / §8.7 / §8.8。
 */

const express = require('express')
const { requireRole } = require('../services/permission')
const { verifyAdminToken } = require('../services/adminAuth')
const backupService = require('../services/backupService')
const { pool } = require('../db/db')

const router = express.Router()

// ─── GET /api/data/investigation-items —— 隐患排查项目下拉枚举（取自已有数据）────────
router.get('/investigation-items', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT hazard_investigation_item AS item
         FROM t_hazard
        WHERE hazard_investigation_item IS NOT NULL
          AND TRIM(hazard_investigation_item) <> ''
        ORDER BY hazard_investigation_item ASC`
    )
    const list = rows.map((r) => r.item)
    res.json({ success: true, data: { list } })
  } catch (err) {
    console.error('[investigation-items]', err.message)
    res.status(500).json({ success: false, error: '获取排查项目失败：' + err.message })
  }
})

// ─── POST /api/data/backup —— 立即备份（直接返回 Excel 附件，不写入服务器）─────────────────────
router.post('/backup', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { buffer, filename, count } = await backupService.backupNow()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    res.setHeader('X-Backup-Count', String(count))
    res.send(buffer)
  } catch (err) {
    console.error('[data backup]', err.message)
    res.status(500).json({ success: false, error: '备份失败：' + err.message })
  }
})

// ─── GET /api/data/backup-file —— 凭 token 直接下载（webview 原生下载通道）────────
// 说明：部分手机 webview（尤其 iOS 微信/企业微信）对 blob + <a download> 支持不可靠，
// 用 GET + window.open 让浏览器原生下载最稳。token 取自 query，校验同 requireRole。
router.get('/backup-file', async (req, res) => {
  const token = req.query.token
  const payload = verifyAdminToken(token || '')
  if (!payload || (payload.role !== 'admin' && payload.role !== 'superadmin')) {
    return res.status(403).json({ success: false, error: '无权限或登录已失效' })
  }
  try {
    const { buffer, filename, count } = await backupService.backupNow()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    res.setHeader('X-Backup-Count', String(count))
    res.send(buffer)
  } catch (err) {
    console.error('[data backup-file]', err.message)
    res.status(500).json({ success: false, error: '备份失败：' + err.message })
  }
})

// ─── POST /api/data/export —— 导出 Excel 附件 ─────────────────────────────
router.post('/export', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { buffer, filename, count } = await backupService.exportReport(req.body || {})
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    res.send(buffer)
  } catch (err) {
    console.error('[data export]', err.message)
    res.status(500).json({ success: false, error: '导出失败：' + err.message })
  }
})

// ─── GET /api/data/backups —— 备份文件列表（P2）───────────────────────────
router.get('/backups', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const list = backupService.listBackups()
    res.json({ success: true, data: list })
  } catch (err) {
    console.error('[data backups]', err.message)
    res.status(500).json({ success: false, error: '获取备份列表失败：' + err.message })
  }
})

module.exports = router
