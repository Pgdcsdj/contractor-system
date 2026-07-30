/**
 * 数据管理路由（模块 D）
 *
 * POST /api/data/backup        立即全量备份 t_hazard → backend/backups/*.xlsx
 * POST /api/data/export        按选中字段 + 类型(台账/周报/月报) 导出 Excel（直接返回附件）
 * GET  /api/data/backups       列出历史备份文件（P2）
 *
 * 全部 requireRole('admin','superadmin') 守卫；越权统一 403。
 * 设计依据：系统架构设计 §3.4(d) / §8.6 / §8.7 / §8.8。
 */

const express = require('express')
const { requireRole } = require('../services/permission')
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

// ─── POST /api/data/backup —— 立即备份 ───────────────────────────────────
router.post('/backup', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await backupService.backupNow()
    res.json({ success: true, data: { filename: result.filename, count: result.count } })
  } catch (err) {
    console.error('[data backup]', err.message)
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
