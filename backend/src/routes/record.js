/**
 * 答题记录管理路由（管理员）
 *
 * GET  /api/record/list          查询记录列表（支持多维筛选）
 * GET  /api/record/export        导出 Excel
 * GET  /api/record/summary       今日完成率看板数据
 * GET  /api/record/incomplete    未答题人员列表（催促用）
 */

const express = require('express')
const { queryRecords }       = require('../services/recordService')
const { exportRecordsToExcel } = require('../services/exportExcel')
const { pool }               = require('../db/db')

const router = express.Router()

// ─── GET /api/record/list ───────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  const { userId, materialId, unit, dateFrom, dateTo, page, pageSize } = req.query

  const result = await queryRecords({ userId, materialId, unit, dateFrom, dateTo, page, pageSize })
  res.json({ success: true, data: result })
})

// ─── GET /api/record/export ─────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  const { userId, materialId, unit, dateFrom, dateTo } = req.query

  // 最多导出 5000 条（防内存溢出）
  const result = await queryRecords({ userId, materialId, unit, dateFrom, dateTo, pageSize: 5000 })
  const buffer = exportRecordsToExcel(result.list)

  const now      = new Date().toLocaleDateString('zh-CN').replace(/\//g, '')
  const filename = encodeURIComponent(`答题记录_${now}.xlsx`)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(buffer)
})

// ─── GET /api/record/summary ────────────────────────────────────────────────
// Dashboard 看板数据：返回前端 stats 所需的全部字段
router.get('/summary', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10)

  // 系统总人数（活跃）
  const [[{ totalUsers }]] = await pool.execute(
    'SELECT COUNT(*) AS totalUsers FROM t_user WHERE status = 1'
  )

  // 累计答题次数（不去重，代表"已完成答题"总次数）
  const [[{ totalCompleted }]] = await pool.execute(
    'SELECT COUNT(*) AS totalCompleted FROM t_record'
  )

  // 累计已发布培训数
  const [[{ totalTrainings }]] = await pool.execute(
    `SELECT COUNT(*) AS totalTrainings FROM t_material WHERE status = 3`
  )

  // 今日已答人数（去重）
  const [[{ todayCompleted }]] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS todayCompleted
     FROM t_record WHERE DATE(submitted_at) = ?`,
    [today]
  )

  // 今日通过人数（score >= 60 视为通过）
  const [[{ todayPassed }]] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS todayPassed
     FROM t_record WHERE DATE(submitted_at) = ? AND score >= 60`,
    [today]
  )

  // 今日应答总人数（有今日活跃培训的人员，简化为系统总人数）
  const todayTotal = totalUsers
  const todayIncomplete = todayTotal - todayCompleted

  res.json({
    success: true,
    data: {
      totalUsers,
      totalCompleted,
      totalTrainings,
      todayCompleted,
      todayPassed,
      todayTotal,
      todayIncomplete: todayIncomplete > 0 ? todayIncomplete : 0,
      completionRate: todayTotal > 0
        ? Math.round(todayCompleted / todayTotal * 100)
        : 0,
      passRate: todayCompleted > 0
        ? Math.round(todayPassed / todayCompleted * 100)
        : 0,
    },
  })
})

// ─── GET /api/record/incomplete ─────────────────────────────────────────────
// 今日未答题人员列表（Dashboard 催促用，不需要 materialId）
// 可选参数 materialId：指定则查该培训未完成者；不指定则查今日完全未答题者
router.get('/incomplete', async (req, res) => {
  const { materialId } = req.query

  let rows
  if (materialId) {
    // 指定培训：未完成该题库的所有活跃用户
    ;[rows] = await pool.execute(
      `SELECT u.id, u.name, u.unit, u.phone
       FROM t_user u
       WHERE u.status = 1
         AND NOT EXISTS (
           SELECT 1 FROM t_record r
           WHERE r.user_id = u.id AND r.material_id = ?
         )
       ORDER BY u.unit, u.name`,
      [materialId]
    )
  } else {
    // 不指定：查今日未答任何题的活跃用户
    const today = new Date().toISOString().slice(0, 10)
    ;[rows] = await pool.execute(
      `SELECT u.id, u.name, u.unit, u.phone
       FROM t_user u
       WHERE u.status = 1
         AND NOT EXISTS (
           SELECT 1 FROM t_record r
           WHERE r.user_id = u.id AND DATE(r.submitted_at) = ?
         )
       ORDER BY u.unit, u.name`,
      [today]
    )
  }

  res.json({ success: true, data: { total: rows.length, list: rows } })
})

module.exports = router
