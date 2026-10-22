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

// 本路由全部为管理端统计/导出接口，统一鉴权（此前 summary/incomplete/list/export 裸奔，
// 未登录即可拉取全员姓名+手机，属数据泄露风险）
router.use(adminAuth)

// ─── JWT 鉴权中间件（与 admin.js 同款）─────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  let token = null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else if (req.query && req.query.token) {
    // 兼容浏览器新窗口直链下载（window.open 无法携带 Authorization 头），
    // 与 /api/data/backup-file 的 token 直链模式保持一致
    token = String(req.query.token)
  }
  if (!token) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
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
  // keyword/passed 必须透传（此前漏接导致页面"及格/不及格"筛选完全失效，export 路由早已补接）
  const { userId, materialId, unit, dateFrom, dateTo, keyword, passed, page, pageSize } = req.query

  const result = await queryRecords({ userId, materialId, unit, dateFrom, dateTo, keyword, passed, page, pageSize })
  res.json({ success: true, data: result })
})

// ─── GET /api/record/export ─────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  const { userId, materialId, unit, dateFrom, dateTo, keyword, passed } = req.query

  // 与页面筛选完全同口径导出（含 keyword/passed）；allowLarge 放开 pageSize 钳制，最多 5000 条（防内存溢出）
  const result = await queryRecords({ userId, materialId, unit, dateFrom, dateTo, keyword, passed, pageSize: 5000, allowLarge: true })
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
  // 日期口径统一走 DB 的 CURDATE()（DB 会话时区为北京时间）。
  // 修复：原用 new Date().toISOString() 取 UTC 日期，北京 0:00~8:00 期间会算成"昨天"，
  // 导致早班时段看板"今日完成/未完成"整体错位一天。

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
     FROM t_record WHERE DATE(submitted_at) = CURDATE()`
  )

  // 今日通过人数（score >= 60 视为通过）
  const [[{ todayPassed }]] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS todayPassed
     FROM t_record WHERE DATE(submitted_at) = CURDATE() AND score >= 60`
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
    // 不指定：查今日未答任何题的活跃用户（CURDATE() = DB 北京日期）
    ;[rows] = await pool.execute(
      `SELECT u.id, u.name, u.unit, u.phone
       FROM t_user u
       WHERE u.status = 1
         AND NOT EXISTS (
           SELECT 1 FROM t_record r
           WHERE r.user_id = u.id AND DATE(r.submitted_at) = CURDATE()
         )
       ORDER BY u.unit, u.name`
    )
  }

  res.json({ success: true, data: { total: rows.length, list: rows } })
})

// ─── GET /api/record/completed ──────────────────────────────────────────────
// 今日已答题人员列表（Dashboard 展示用）：按人汇总答题次数与最近提交时间
router.get('/completed', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.unit, u.phone,
              COUNT(*) AS record_count,
              MAX(r.submitted_at) AS last_submit
         FROM t_record r
         JOIN t_user u ON u.id = r.user_id
        WHERE DATE(r.submitted_at) = CURDATE()
        GROUP BY u.id, u.name, u.unit, u.phone
        ORDER BY last_submit DESC`
    )
    res.json({ success: true, data: { total: rows.length, list: rows } })
  } catch (err) {
    console.error('[record completed]', err.message)
    res.status(500).json({ success: false, error: '查询失败：' + err.message })
  }
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

// ─── GET /api/record/:id/detail ───────────────────────────────────────────
// 答题逐题明细：管理员点击成绩后查看具体作答情况（题干/选项/用户答案/正确答案/配图/解析/对错/分值）
// 以用户实际作答顺序(answers 快照)为准，从题库补全 options/image_url/answer/analysis，组装成可直接渲染的明细数组
// ⚠️ 注册在静态路由(export/summary/completed)之后、/:id 之后均可——Express 按路径段数区分，/123/detail 不会被 /:id 吞
router.get('/:id/detail', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, '记录ID不合法')

    const rec = await getRecordById(id)
    if (!rec) return sendError(res, 404, '答题记录不存在')

    // answers 快照（提交时存档：{questionId, answer, isCorrect, score, analysis}）
    let answers = rec.answers
    if (typeof answers === 'string') {
      try { answers = JSON.parse(answers) } catch { answers = [] }
    }
    if (!Array.isArray(answers)) answers = []

    // 该题库全部启用题目（含选项/配图/正确答案/解析），用于匹配补全展示信息
    const [questions] = await pool.query(
      `SELECT id, type, question, options, answer, analysis, score, image_url, sort_order
       FROM t_question WHERE material_id = ? AND status = 1`,
      [rec.material_id]
    )
    const qMap = new Map(questions.map(q => [Number(q.id), q]))

    // 合并明细：顺序 = 用户实际作答顺序（exam 即为本次卷面；study/practice 为全量）
    const detail = answers.map((a, idx) => {
      const q = qMap.get(Number(a.questionId)) || {}
      let options = null
      if (q.options) {
        try { options = typeof q.options === 'string' ? JSON.parse(q.options) : q.options } catch { options = null }
      }
      return {
        index: idx + 1,
        questionId: Number(a.questionId),
        type: q.type || '',
        question: q.question || '',
        imageUrl: q.image_url || null,
        options,                                       // {A:'..',B:'..'} 或 null（判断题）
        userAnswer: a.answer == null ? '' : String(a.answer),
        correctAnswer: q.answer == null ? '' : String(q.answer),
        isCorrect: !!a.isCorrect,
        score: Number(a.score) || 0,
        maxScore: Number(q.score) || 0,
        analysis: q.analysis || a.analysis || '',
        comment: a.comment || null,                   // 人工批改评语（essay 题）
      }
    })

    const maxScore = Number(rec.max_score) || 0
    const passed = maxScore > 0 && Math.round(Number(rec.score) / maxScore * 100) >= Number(rec.pass_score || 0)

    res.json({
      success: true,
      data: {
        record: {
          id: rec.id,
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
          mode: rec.mode,
          isOffline: rec.is_offline,
          essayGraded: rec.essay_graded || 0,
        },
        totalCorrect: detail.filter(d => d.isCorrect).length,
        totalCount: detail.length,
        detail,
      },
    })
  } catch (err) {
    sendError(res, 500, '服务器内部错误')
    console.error('[record.detail]', err)
  }
})

module.exports = router
