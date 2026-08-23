/**
 * 答题记录管理路由（管理员）
 *
 * GET  /api/record/list          查询记录列表（支持多维筛选）
 * GET  /api/record/export        导出 Excel
 * GET  /api/record/summary       今日完成率看板数据
 * GET  /api/record/incomplete    未答题人员列表（催促用）
 */

const express = require('express')
const { queryRecords, getRecordById, saveEssayGrades } = require('../services/recordService')
const { exportRecordsToExcel } = require('../services/exportExcel')
const { pool }               = require('../db/db')
const { verifyAdminToken }   = require('../services/adminAuth')
const { signRecord }         = require('../utils/hashHelper')

const router = express.Router()

// ─── JWT 鉴权中间件（与 admin.js 同款）─────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const token = authHeader.slice(7)
  const payload = verifyAdminToken(token)
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// 本地结构化错误响应（与 quiz.js sendError 同风格）
function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message })
}

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

// ─── GET /api/record/:id ─────────────────────────────────────────────────────
// 答题记录详情（含 answers 快照 + material 题目清单），供人工评分页使用
// ⚠️ 必须注册在 list/export/summary/incomplete 之后，避免 /:id 吞掉静态路径
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, '记录ID不合法')

    const rec = await getRecordById(id)
    if (!rec) return sendError(res, 404, '答题记录不存在')

    // answers 可能是 JSON 列解析对象或字符串
    let answers = rec.answers
    if (typeof answers === 'string') {
      try { answers = JSON.parse(answers) } catch { answers = [] }
    }
    if (!Array.isArray(answers)) answers = []

    // material 全部启用题目（含题干/参考答案/分值，供评分页展示）
    const [questions] = await pool.query(
      `SELECT id, type, question, answer, analysis, score, sort_order
       FROM t_question WHERE material_id = ? AND status = 1 ORDER BY sort_order`,
      [rec.material_id]
    )

    const maxScore = Number(rec.max_score) || 0
    const passed = maxScore > 0 && Math.round(Number(rec.score) / maxScore * 100) >= Number(rec.pass_score || 0)

    res.json({
      success: true,
      data: {
        record: {
          id: rec.id,
          userId: rec.user_id,
          userName: rec.user_name,
          unit: rec.unit,
          supervisingUnit: rec.supervising_unit,
          materialId: rec.material_id,
          materialTitle: rec.material_title,
          score: Number(rec.score),
          maxScore,
          passScore: Number(rec.pass_score || 0),
          passed,
          durationSec: rec.duration_sec,
          submittedAt: rec.submitted_at,
          isOffline: rec.is_offline,
          mode: rec.mode,
          essayGraded: rec.essay_graded || 0,
          gradedBy: rec.graded_by || null,
          gradedAt: rec.graded_at || null,
          answers,
        },
        material: { id: rec.material_id, title: rec.material_title, passScore: Number(rec.pass_score || 0) },
        questions,
      },
    })
  } catch (err) {
    sendError(res, 500, '服务器内部错误')
    console.error('[record.detail]', err)
  }
})

// ─── PATCH /api/record/:id/essay-grade ───────────────────────────────────────
// 人工给 essay 主观题打分并回写：重算总分、max_score 兜底为题库满分、重签 hash、判定及格
// 入参: { answers: [{ questionId, score, comment? }] }
router.patch('/:id/essay-grade', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, '记录ID不合法')
    const adminId = req.admin.id

    const rec = await getRecordById(id)
    if (!rec) return sendError(res, 404, '答题记录不存在')

    // 该 material 的 essay 题映射（questionId -> {score}）
    const [essayRows] = await pool.query(
      `SELECT id, score FROM t_question WHERE material_id = ? AND type = 'essay' AND status = 1`,
      [rec.material_id]
    )
    const qMap = new Map(essayRows.map(q => [Number(q.id), Number(q.score)]))

    // 入参校验
    const body = req.body || {}
    const grades = Array.isArray(body.answers) ? body.answers : null
    if (!grades || !grades.length) return sendError(res, 400, '评分数据不能为空')
    for (const g of grades) {
      const qid = Number(g.questionId)
      const sc  = Number(g.score)
      if (!Number.isInteger(qid) || !qMap.has(qid)) return sendError(res, 400, `题目 ${g.questionId} 不是本卷 essay 题或不存在`)
      if (!Number.isFinite(sc) || sc < 0 || sc > qMap.get(qid)) return sendError(res, 400, `题目 ${qid} 分值须在 0~${qMap.get(qid)} 之间`)
    }

    // 解析原始 answers
    let existing = rec.answers
    if (typeof existing === 'string') {
      try { existing = JSON.parse(existing) } catch { existing = [] }
    }
    if (!Array.isArray(existing)) existing = []

    const scoreById = new Map()
    for (const g of grades) scoreById.set(Number(g.questionId), g)

    const nowIso = new Date()
    let allGraded = true
    const merged = existing.map(item => {
      const qid = Number(item.questionId)
      if (!qMap.has(qid)) return item // 客观题：不动

      const g = scoreById.get(qid)
      if (g) {
        const maxQ = qMap.get(qid)
        const sc = Number(g.score)
        const isCorrect = sc >= Math.ceil(maxQ / 2)
        return {
          ...item,
          score: sc,
          isCorrect,
          comment: typeof g.comment === 'string' ? g.comment.slice(0, 500) : item.comment,
          manualGraded: true,
          gradedBy: adminId,
          gradedAt: nowIso,
          aiGrading: { manual: true, graded: true, note: '人工批改' },
        }
      }
      // 本轮未评分但已人工评过 → 保持；未评过 → 还有待评
      if (!item.manualGraded) allGraded = false
      return item
    })

    // 重算有效得分（与 submit L752 口径一致：仅 isCorrect 计分）
    let effectiveScore = 0
    for (const item of merged) {
      if (item.isCorrect) effectiveScore += Number(item.score) || 0
    }

    // max_score 兜底为 material 全部题分值之和（不完整提交如杜涛 40→100）
    const [[{ totalQScore }]] = await pool.execute(
      'SELECT COALESCE(SUM(score), 0) AS totalQScore FROM t_question WHERE material_id = ? AND status = 1',
      [rec.material_id]
    )
    const maxScore = Number(totalQScore) > 0 ? Number(totalQScore) : (Number(rec.max_score) || 0)

    const passScore = Number(rec.pass_score || 0)
    const passed = maxScore > 0 && Math.round(effectiveScore / maxScore * 100) >= passScore

    // 重签防篡改 hash（与 saveRecord 同规则）
    const hash = signRecord(rec.user_id, rec.material_id, effectiveScore, rec.submitted_at)

    const ok = await saveEssayGrades({
      recordId: id,
      answers: merged,
      score: effectiveScore,
      maxScore,
      essayGraded: allGraded ? 1 : 0,
      gradedBy: adminId,
      gradedAt: nowIso,
      hash,
    })
    if (!ok) return sendError(res, 404, '答题记录不存在或已被删除')

    console.log('[record.essay-grade]', JSON.stringify({
      recordId: id, userId: rec.user_id, materialId: rec.material_id,
      oldScore: rec.score, newScore: effectiveScore, adminId,
    }))

    res.json({
      success: true,
      data: { recordId: id, score: effectiveScore, maxScore, passScore, passed, essayGraded: allGraded ? 1 : 0 },
    })
  } catch (err) {
    sendError(res, 500, '服务器内部错误')
    console.error('[record.essay-grade]', err)
  }
})

module.exports = router
