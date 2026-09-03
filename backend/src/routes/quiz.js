/**
 * 答题路由（P0 重构）
 *
 * GET  /api/quiz/list                员工端：获取待答题目组列表（含配置下发）
 * GET  /api/quiz/:materialId         员工端：获取题目详情（按 mode 决定是否下发答案/解析）
 * GET  /api/quiz/:materialId/result  员工端：获取该题库的答题回顾（含逐题对错 + 解析）
 * POST /api/quiz/:materialId/submit  提交答题（服务端评分，支持 mode/attemptNo）
 * POST /api/quiz/offline-batch       离线批量上传
 *
 * 设计要点：
 *  - 所有 handler 均包 try/catch，未捕获异常会导致 Node 进程崩溃（历史上 502 的根因之一）。
 *  - GET /:materialId 不再笼统 404，按「不存在 / 未发布 / 无启用题目」返回结构化错误码。
 *  - 不再引用 t_question.image_url（线上表无此列，引用即崩溃），统一置 imageUrl=null。
 */

const express = require('express')
const { pool } = require('../db/db')
const { saveRecord, saveOfflineRecords } = require('../services/recordService')
const { gradeShortAnswer } = require('../services/aiGrading')
const { ERROR_CODES, QUIZ_MODES } = require('../constants/quizCodes')

const router = express.Router()

const { verifyToken } = require('../services/authService')

/**
 * JWT 鉴权中间件（员工端）
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: '未登录' })
  }
  const payload = verifyToken(authHeader.slice(7))
  if (!payload) return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Token 已过期，请重新登录' })
  req.user = payload
  next()
}

/**
 * 统一结构化错误响应
 * @param {object} res      express response
 * @param {string} code     ERROR_CODES 中的错误码
 * @param {object} [extra]  附加字段（如 data）
 */
function sendError(res, code, extra) {
  const def = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR
  return res.status(def.http).json({ code, error: def.message, ...extra })
}

/**
 * options 可能是 JSON 字符串，统一解析为对象；解析失败返回空对象
 */
function parseOptions(opts) {
  if (typeof opts === 'string') {
    try { return JSON.parse(opts) } catch { return {} }
  }
  return opts || {}
}

/**
 * 把任意写法的答案拆成选项 token 数组（与前端 utils/answerJudge.js 同源）。
 * 兼容多选题答案的常见写法：
 *   "AB"（字母连写）/ "A,B" / "A，B"（中文逗号）/ "A、B" / "A B" / "A/B" / "A;B" / ['A','B']
 * 修复前用 split('') 逐字符切分，分隔符 ',' 会被当成答案字符混入，
 * 导致 "A,C" 与 "AC" 判定不相等（多选题误判为错）。
 * @param {*} raw 标准答案或用户答案（字符串 / 数字 / 数组）
 * @returns {string[]} 大写 token 数组
 */
function splitAnswerTokens(raw) {
  if (raw == null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const part of list.map(v => String(v ?? '')).join(',').toUpperCase().split(/[^A-Z0-9]+/)) {
    if (!part) continue
    // 字母连写（如 "AC"）逐字符展开为 A、C，保证与 "A,C" 写法等价；
    // 纯数字视为选项下标，保持整体（"12" 代表第 12 个选项，不是第 1、2 个）
    if (/^[A-Z]+$/.test(part) && part.length > 1) out.push(...part.split(''))
    else out.push(part)
  }
  return out
}

/**
 * 客观题评分：规范化后精确比较
 *  - single/judgment：去空格、转大写后相等
 *  - multiple：拆分为选项集合后排序比较（忽略顺序 / 分隔符 / 大小写 / 重复项）
 *    例：标准答案 "AB" 与用户答案 "A,B"、"BA"、"b,a" 均判定为正确。
 * @returns {boolean}
 */
function normalizeAnswer(type, std, user) {
  if (type === 'multiple' || type === 'multi') {
    const sa = [...new Set(splitAnswerTokens(std))].sort().join(',')
    const ua = [...new Set(splitAnswerTokens(user))].sort().join(',')
    return sa.length > 0 && sa === ua
  }
  const s = String(std ?? '').toUpperCase().replace(/\s/g, '')
  const u = String(user ?? '').toUpperCase().replace(/\s/g, '')
  return s === u
}

// ─── GET /api/quiz/wrong-questions ──────────────────────────────────────────
// 员工端：获取当前用户的错题库（学习/练习/考试中答错的题，答对已移出）
// 注：必须注册在 /:materialId 之前，否则 'wrong-questions' 会被 :materialId 吞掉。
router.get('/wrong-questions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const [rows] = await pool.execute(
      `SELECT w.id, w.material_id, w.question_id, w.wrong_times, w.last_wrong_at, w.starred,
              m.title AS material_title,
              q.type, q.question, q.options, q.answer, q.analysis, q.score
       FROM t_wrong_question w
       JOIN t_material m ON m.id = w.material_id
       JOIN t_question q  ON q.id = w.question_id
       WHERE w.user_id = ?
       ORDER BY w.starred DESC, w.last_wrong_at DESC`,
      [userId]
    )
    const list = rows.map(r => ({
      id:            r.id,
      materialId:    r.material_id,
      materialTitle: r.material_title,
      questionId:    r.question_id,
      type:          r.type,
      question:      r.question,
      options:       parseOptions(r.options),
      correctAnswer: r.answer,
      analysis:      r.analysis,
      score:         r.score,
      wrongTimes:    r.wrong_times,
      lastWrongAt:   r.last_wrong_at,
      starred:       !!r.starred,
    }))
    res.json({ success: true, data: list })
  } catch (err) {
    console.error('[wrong-questions]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── DELETE /api/quiz/wrong-questions/:id ───────────────────────────────────
// 员工端：将某道错题移出错题库（标记为已掌握）
router.delete('/wrong-questions/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id
    await pool.execute(
      'DELETE FROM t_wrong_question WHERE id = ? AND user_id = ?',
      [id, userId]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('[wrong-questions.delete]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── PATCH /api/quiz/wrong-questions/:id/star ──────────────────────────────
// 员工端：切换某道错题的「重点标记」状态（1=置顶优先复习）
router.patch('/wrong-questions/:id/star', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id
    const starred = req.body?.starred ? 1 : 0
    await pool.execute(
      'UPDATE t_wrong_question SET starred = ? WHERE id = ? AND user_id = ?',
      [starred, id, userId]
    )
    res.json({ success: true, data: { starred } })
  } catch (err) {
    console.error('[wrong-questions.star]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── GET /api/quiz/wrong-practice ──────────────────────────────────────────
// 员工端：错题库练习专用。返回当前用户错题库题目（practice 模式，带答案+解析）。
// 支持筛选：?type=single|multiple|judgment  &  ?materialId=NN  &  ?minWrong=N（错≥N次）
// 注意：必须在 /:materialId 之前注册，否则 'wrong-practice' 会被动态段吞掉。
router.get('/wrong-practice', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { type, materialId, minWrong } = req.query

    let sql = `
      SELECT w.id, w.material_id, w.question_id, w.wrong_times, w.starred,
              m.title AS material_title,
              q.id AS qid, q.material_id AS q_material_id, q.type, q.question, q.options, q.answer, q.analysis, q.score
       FROM t_wrong_question w
       JOIN t_material m ON m.id = w.material_id
       JOIN t_question q  ON q.id = w.question_id
       WHERE w.user_id = ?`
    const params = [userId]
    if (type && ['single', 'multiple', 'judgment'].includes(type)) {
      sql += ' AND q.type = ?'
      params.push(type)
    }
    if (materialId && /^\d+$/.test(String(materialId))) {
      sql += ' AND w.material_id = ?'
      params.push(Number(materialId))
    }
    if (minWrong && /^\d+$/.test(String(minWrong)) && Number(minWrong) > 0) {
      sql += ' AND w.wrong_times >= ?'
      params.push(Number(minWrong))
    }
    sql += ' ORDER BY w.starred DESC, w.last_wrong_at DESC'

    const [rows] = await pool.execute(sql, params)
    const questions = rows.map(r => ({
      id:            r.qid,
      type:          r.type,
      question:      r.question,
      options:       parseOptions(r.options),
      score:         r.score,
      materialId:    r.q_material_id,
      correctAnswer: r.answer,
      analysis:      r.analysis,
    }))
    res.json({
      success: true,
      data: {
        materialId: 'wrong',
        title: '错题练习',
        mode: QUIZ_MODES.PRACTICE,
        timeLimit: 0,
        passScore: 60,
        totalScore: questions.reduce((s, q) => s + (q.score || 0), 0),
        questions,
      },
    })
  } catch (err) {
    console.error('[wrong-practice]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── POST /api/quiz/wrong-practice/submit ──────────────────────────────────
// 员工端：提交错题练习。判分后形成闭环：答对→从错题库移除；答错→累加错误次数。
// 不写入正式成绩记录（t_record），仅用于错题复习。
// 注意：必须在 /:materialId/submit 之前注册。
router.post('/wrong-practice/submit', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { answers, mode = QUIZ_MODES.PRACTICE } = req.body
    if (!Array.isArray(answers) || !answers.length) {
      return sendError(res, 'EMPTY_ANSWERS')
    }

    const qids = [...new Set(answers.map(a => a.questionId).filter(Boolean))]
    const placeholders = qids.map(() => '?').join(',')
    const [questions] = await pool.execute(
      `SELECT id, material_id, type, question, options, answer, analysis, score FROM t_question WHERE id IN (${placeholders})`,
      qids
    )
    const qMap = {}
    questions.forEach(q => { qMap[q.id] = q })

    let totalScore = 0
    let maxScore = 0
    const graded = []
    for (const qa of answers) {
      const q = qMap[qa.questionId]
      if (!q) continue
      maxScore += q.score
      const isCorrect = normalizeAnswer(q.type, q.answer, qa.answer)
      const earned = isCorrect ? q.score : 0
      if (isCorrect) totalScore += earned
      graded.push({
        questionId: q.id,
        type: q.type,
        question: q.question,
        options: parseOptions(q.options),
        correctAnswer: q.answer,
        userAnswer: qa.answer,
        isCorrect,
        score: earned,
        analysis: q.analysis,
      })
    }

    // 闭环：答对移除，答错累加（批量，避免逐题 await 的 N+1 性能悬崖）
    const correctQids = []
    const wrongRows = []
    for (const item of graded) {
      const q = qMap[item.questionId]
      if (!q) continue
      if (item.isCorrect) {
        correctQids.push(item.questionId)
      } else {
        wrongRows.push([userId, q.material_id, item.questionId, mode])
      }
    }
    if (correctQids.length) {
      const ph = correctQids.map(() => '?').join(',')
      await pool.execute(
        `DELETE FROM t_wrong_question WHERE user_id = ? AND question_id IN (${ph})`,
        [userId, ...correctQids]
      )
    }
    if (wrongRows.length) {
      const valPh = wrongRows.map(() => '(?,?,?,?,1,NOW())').join(',')
      const params = []
      for (const r of wrongRows) params.push(...r)
      await pool.execute(
        `INSERT INTO t_wrong_question (user_id, material_id, question_id, mode, wrong_times, last_wrong_at)
         VALUES ${valPh}
         ON DUPLICATE KEY UPDATE wrong_times = wrong_times + 1, last_wrong_at = NOW(), mode = VALUES(mode)`,
        params
      )
    }

    res.json({
      success: true,
      data: {
        score: totalScore,
        maxScore,
        passScore: 60,
        passRate: maxScore > 0 ? Math.round(totalScore / maxScore * 100) : 0,
        passed: maxScore > 0 ? Math.round(totalScore / maxScore * 100) >= 60 : false,
        mode,
        gradedList: graded,
      },
    })
  } catch (err) {
    console.error('[wrong-practice.submit]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── GET /api/quiz/list ─────────────────────────────────────────────────────
// 获取员工"培训"列表（已发布 + 目标人群匹配，含完成状态/分数 + 配置字段下发）
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const [users] = await pool.execute('SELECT id, unit, position FROM t_user WHERE id = ?', [userId])
    const userUnit = users.length > 0 ? (users[0].unit || '') : ''
    const userPosition = users.length > 0 ? (users[0].position || '') : ''

    // 下发 time_limit / pass_score / category / mode / attempt_limit / ai_grading
    const [materials] = await pool.execute(
      `SELECT
         m.id, m.title, m.question_cnt, m.created_at,
         m.time_limit, m.pass_score, m.category_id, m.mode, m.attempt_limit, m.ai_grading,
         c.name AS category_name,
         IF(r.id IS NOT NULL, 1, 0) AS completed,
         r.score, r.max_score
       FROM t_material m
       LEFT JOIN t_material_category c ON m.category_id = c.id
       LEFT JOIN t_record r ON r.material_id = m.id AND r.user_id = ?
       WHERE m.status = 3
         AND (
           m.target_type = 'all'
           OR (m.target_type = 'unit' AND JSON_CONTAINS(m.target_value, ?))
           OR (m.target_type = 'specific' AND JSON_CONTAINS(m.target_value, CAST(? AS JSON)))
           OR (m.target_type = 'position' AND JSON_CONTAINS(m.target_value, ?))
         )
       ORDER BY completed ASC, m.created_at DESC`,
      [userId, JSON.stringify(userUnit), JSON.stringify(userId), JSON.stringify(userPosition)]
    )

    res.json({ success: true, data: materials })
  } catch (err) {
    console.error('[quiz.list]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── 断点续做进度（服务端持久化，绑定用户，跨设备/重登可用）─────────────────
// 进度唯一键 (user_id, scope, material_id, mode)。trainingId='wrong' 视为
// scope='wrong'、material_id=0（错题练习跨题库）；其余为 scope='material'。
// 必须在 /:materialId 路由之前注册，否则 'progress' 会被动态段吞掉。
function parseProgressTarget(materialIdParam) {
  if (String(materialIdParam) === 'wrong') {
    return { scope: 'wrong', materialId: 0 }
  }
  const n = Number(materialIdParam)
  if (!Number.isInteger(n) || n <= 0) return null
  return { scope: 'material', materialId: n }
}

// GET /api/quiz/progress  → 列出当前用户所有未完成进度（供列表页"继续作答"）
router.get('/progress', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const [rows] = await pool.execute(
      `SELECT scope, material_id, mode, current_index, elapsed_sec, updated_at,
              JSON_LENGTH(answers) AS answer_cnt
       FROM t_quiz_progress
       WHERE user_id = ? AND JSON_LENGTH(answers) > 0
       ORDER BY updated_at DESC`,
      [userId]
    )
    const list = rows.map(r => ({
      scope:       r.scope,
      materialId:  r.scope === 'wrong' ? 'wrong' : r.material_id,
      mode:        r.mode,
      currentIndex: r.current_index,
      elapsedSec:  r.elapsed_sec,
      answerCount: r.answer_cnt || 0,
      updatedAt:   r.updated_at,
    }))
    res.json({ success: true, data: list })
  } catch (err) {
    console.error('[quiz.progress.list]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// GET /api/quiz/progress/:materialId?mode=...  → 读取单条进度
router.get('/progress/:materialId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const target = parseProgressTarget(req.params.materialId)
    if (!target) return sendError(res, 'INVALID_PARAM')
    const mode = req.query.mode
    if (!mode || !Object.values(QUIZ_MODES).includes(mode)) {
      return res.status(400).json({ success: false, error: '缺少或非法 mode' })
    }
    const [rows] = await pool.execute(
      `SELECT answers, current_index, elapsed_sec, updated_at
       FROM t_quiz_progress
       WHERE user_id = ? AND scope = ? AND material_id = ? AND mode = ?`,
      [userId, target.scope, target.materialId, mode]
    )
    if (!rows.length) return res.json({ success: true, data: null })
    const r = rows[0]
    let answers = {}
    try {
      answers = (typeof r.answers === 'string') ? JSON.parse(r.answers) : (r.answers || {})
    } catch { answers = {} }
    res.json({
      success: true,
      data: {
        answers,
        currentIndex: r.current_index || 0,
        elapsedSec:   r.elapsed_sec || 0,
        updatedAt:    r.updated_at,
      },
    })
  } catch (err) {
    console.error('[quiz.progress.get]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// PUT /api/quiz/progress/:materialId  → 保存/覆盖进度（mode 取 body 或 query）
router.put('/progress/:materialId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const target = parseProgressTarget(req.params.materialId)
    if (!target) return sendError(res, 'INVALID_PARAM')
    const mode = req.body?.mode || req.query?.mode
    if (!mode || !Object.values(QUIZ_MODES).includes(mode)) {
      return res.status(400).json({ success: false, error: '缺少或非法 mode' })
    }
    const body = req.body || {}
    const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {}
    const currentIndex = Number.isFinite(Number(body.currentIndex)) ? Number(body.currentIndex) : 0
    const elapsedSec = Number.isFinite(Number(body.elapsedSec)) ? Number(body.elapsedSec) : 0
    await pool.execute(
      `INSERT INTO t_quiz_progress (user_id, scope, material_id, mode, answers, current_index, elapsed_sec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         answers = VALUES(answers),
         current_index = VALUES(current_index),
         elapsed_sec = VALUES(elapsed_sec),
         updated_at = NOW()`,
      [userId, target.scope, target.materialId, mode, JSON.stringify(answers), currentIndex, elapsedSec]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('[quiz.progress.put]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// DELETE /api/quiz/progress/:materialId?mode=...  → 清除进度（提交成功后）
router.delete('/progress/:materialId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const target = parseProgressTarget(req.params.materialId)
    if (!target) return sendError(res, 'INVALID_PARAM')
    const mode = req.query.mode || req.body?.mode
    if (!mode || !Object.values(QUIZ_MODES).includes(mode)) {
      return res.status(400).json({ success: false, error: '缺少或非法 mode' })
    }
    await pool.execute(
      `DELETE FROM t_quiz_progress WHERE user_id = ? AND scope = ? AND material_id = ? AND mode = ?`,
      [userId, target.scope, target.materialId, mode]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('[quiz.progress.delete]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── GET /api/quiz/:materialId/result ───────────────────────────────────────
// 获取当前用户该题库的答题回顾（逐题对错 + 正确答案 + 解析）
router.get('/:materialId/result', authMiddleware, async (req, res) => {
  try {
    const { materialId } = req.params
    const userId = req.user.id

    const [[record]] = await pool.execute(
      `SELECT id, score, max_score, answers, submitted_at, mode, duration_sec
       FROM t_record
       WHERE user_id = ? AND material_id = ?
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [userId, materialId]
    )

    if (!record) return sendError(res, 'NO_RECORD')

    const [[material]] = await pool.execute(
      `SELECT pass_score, mode,
              exam_single_score, exam_multiple_score, exam_judgment_score
       FROM t_material WHERE id = ?`,
      [materialId]
    )
    const passScore = material ? material.pass_score : 60
    // 模式严格取自本记录的实际作答模式（t_record.mode），回退到素材默认模式，
    // 不能回退到 m.material.mode，否则回顾页徽章/重新答题会错配到默认模式。
    const mode = record.mode || (material ? material.mode : QUIZ_MODES.EXAM)
    // 各题型每题分数覆盖（与抽题下发/交卷判分口径一致；仅考试模式生效）
    const scoreCfg = material ? {
      single:   Number(material.exam_single_score)   || 0,
      multiple: Number(material.exam_multiple_score) || 0,
      judgment: Number(material.exam_judgment_score) || 0,
    } : {}
    const scoreOf = (q) => (mode === QUIZ_MODES.EXAM && scoreCfg[q.type] > 0 ? scoreCfg[q.type] : q.score)

    const [questions] = await pool.execute(
      `SELECT id, type, question, options, answer, analysis, score, sort_order
       FROM t_question
       WHERE material_id = ? AND status = 1
       ORDER BY sort_order ASC`,
      [materialId]
    )

    let userAnswers = []
    try {
      userAnswers = typeof record.answers === 'string'
        ? JSON.parse(record.answers)
        : record.answers
    } catch { userAnswers = [] }

    const answerMap = {}
    for (const a of userAnswers) answerMap[a.questionId] = a

    const reviewList = questions.map(q => {
      const userAns = answerMap[q.id] || {}
      return {
        id:           q.id,
        type:         q.type,
        question:     q.question,
        imageUrl:     null,
        options:      parseOptions(q.options),
        correctAnswer: q.answer,
        userAnswer:   userAns.answer ?? null,
        isCorrect:    userAns.isCorrect ?? false,
        score:        scoreOf(q),
        earnedScore:  userAns.score ?? 0,
        analysis:     q.analysis,
        aiGrading:    userAns.aiGrading ?? null,
      }
    })

    const score = record.score
    const maxScore = record.max_score

    res.json({
      success: true,
      data: {
        score,
        maxScore,
        passScore,
        passRate: maxScore > 0 ? Math.round(score / maxScore * 100) : 0,
        passed:  maxScore > 0 ? Math.round(score / maxScore * 100) >= passScore : false,
        mode,
        submittedAt: record.submitted_at,
        durationSec: record.duration_sec,
        reviewList,
      },
    })
  } catch (err) {
    console.error('[quiz.result]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── GET /api/quiz/:materialId ───────────────────────────────────────────────
// 获取题目列表（题目内容 + 选项；按 mode 决定是否下发正确答案/解析）
// 注意：不再拦截已完成，允许重新作答。
router.get('/:materialId', authMiddleware, async (req, res) => {
  try {
    const { materialId } = req.params
    // mode 来自 query；无效值回退到 exam（不揭示答案）
    const reqMode = req.query.mode
    const mode = (reqMode && QUIZ_MODES[String(reqMode).toUpperCase()])
      ? QUIZ_MODES[String(reqMode).toUpperCase()]
      : QUIZ_MODES.EXAM
    const reveal = mode !== QUIZ_MODES.EXAM // study/practice 下发答案 + 解析

    // 1) 题库存在性 & 发布态
    const [[material]] = await pool.execute(
      `SELECT id, title, status, time_limit, pass_score, mode, attempt_limit, shuffle, category_id, ai_grading,
              exam_single_num, exam_multiple_num, exam_judgment_num,
              exam_single_score, exam_multiple_score, exam_judgment_score
       FROM t_material WHERE id = ?`,
      [materialId]
    )
    if (!material) return sendError(res, 'MATERIAL_NOT_FOUND')
    if (material.status !== 3) return sendError(res, 'NOT_PUBLISHED')

    // 2) 启用题目（status = 1）
    const [questions] = await pool.execute(
      `SELECT id, type, question, options, answer, analysis, score, sort_order
       FROM t_question
       WHERE material_id = ? AND status = 1
       ORDER BY sort_order ASC`,
      [materialId]
    )
    if (!questions.length) return sendError(res, 'NO_ENABLED_QUESTIONS')

    // 3) 考试模式：按题库配置的题型抽题数随机抽取（配置全 0 或缺省则取全部）
    //    学习/练习模式返回全量，便于系统学习。
    let finalQuestions = questions
    if (mode === QUIZ_MODES.EXAM) {
      const cfg = {
        single:   Number(material.exam_single_num)   || 0,
        multiple: Number(material.exam_multiple_num) || 0,
        judgment: Number(material.exam_judgment_num) || 0,
      }
      const hasCfg = cfg.single > 0 || cfg.multiple > 0 || cfg.judgment > 0
      if (hasCfg) {
        const byType = { single: [], multiple: [], judgment: [] }
        for (const q of questions) {
          if (byType[q.type]) byType[q.type].push(q)
        }
        // Fisher-Yates 洗牌：原地无偏随机（替代 sort(() => Math.random() - 0.5)，
        // 后者比较器不满足传递性，分布有偏，且 V8 上时间复杂度更差）
        const shuffle = (arr) => {
          const a = [...arr]
          for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[a[i], a[j]] = [a[j], a[i]]
          }
          return a
        }
        const pick = (arr, n) => {
          if (!arr.length) return []
          // n<=0 表示该题型全抽（0 = 全抽，既有语义）
          return n > 0 ? shuffle(arr).slice(0, Math.min(n, arr.length)) : arr
        }
        // 题型分桶随机抽题后再整体洗牌，避免同题型块状连续分布
        finalQuestions = shuffle([
          ...pick(byType.single,   cfg.single),
          ...pick(byType.multiple, cfg.multiple),
          ...pick(byType.judgment, cfg.judgment),
        ])
        // 各题型每题分数覆盖（0 = 沿用题目自身分值；仅考试模式生效）
        const scoreCfg = {
          single:   Number(material.exam_single_score)   || 0,
          multiple: Number(material.exam_multiple_score) || 0,
          judgment: Number(material.exam_judgment_score) || 0,
        }
        for (const q of finalQuestions) {
          if (scoreCfg[q.type] > 0) q.score = scoreCfg[q.type]
        }
        // 抽题后题量可能少于题库总量，更新下发总量提示
        console.log(`[quiz.detail] exam 抽题：配置(${cfg.single}/${cfg.multiple}/${cfg.judgment}) 实际抽 ${finalQuestions.length}/${questions.length}`)
      }
    }

    const parsed = finalQuestions.map(q => {
      const item = {
        id:        q.id,
        type:      q.type,
        question:  q.question,
        imageUrl:  null, // 线上 t_question 无 image_url 列，统一置 null
        options:   parseOptions(q.options),
        score:     q.score,
        sortOrder: q.sort_order,
      }
      // 仅学习/练习模式下发答案与解析（考试模式交卷后由 /result 提供）
      if (reveal) {
        item.correctAnswer = q.answer
        item.analysis = q.analysis
      }
      return item
    })

    res.json({
      success: true,
      data: {
        materialId:  Number(materialId),
        title:       material.title,
        mode:        material.mode || QUIZ_MODES.EXAM,
        timeLimit:   material.time_limit,
        passScore:   material.pass_score,
        attemptLimit: material.attempt_limit,
        shuffle:     material.shuffle,
        categoryId:  material.category_id,
        aiGrading:   material.ai_grading,
        totalScore:  parsed.reduce((sum, q) => sum + q.score, 0),
        questions:   parsed,
      },
    })
  } catch (err) {
    console.error('[quiz.detail]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── POST /api/quiz/:materialId/submit ──────────────────────────────────────
// 提交答题（服务器评分）- 支持重复提交，覆盖旧记录
router.post('/:materialId/submit', authMiddleware, async (req, res) => {
  try {
    const { materialId } = req.params
    const userId = req.user.id
    const {
      mode = QUIZ_MODES.EXAM,
      attemptNo = 1,
      answers,
      durationSec = 0,
      isOffline = false,
    } = req.body

    if (!Array.isArray(answers) || !answers.length) {
      return sendError(res, 'EMPTY_ANSWERS')
    }

    const [[material]] = await pool.execute(
      `SELECT id, pass_score, ai_grading, attempt_limit, mode,
              exam_single_score, exam_multiple_score, exam_judgment_score
       FROM t_material WHERE id = ?`,
      [materialId]
    )
    if (!material) return sendError(res, 'MATERIAL_NOT_FOUND')
    const passScore = material.pass_score
    const aiGradingOn = material.ai_grading === 1
    // 各题型每题分数覆盖（与 GET /:materialId 抽题下发口径严格一致；0 = 用题目自身分值）
    const scoreCfg = {
      single:   Number(material.exam_single_score)   || 0,
      multiple: Number(material.exam_multiple_score) || 0,
      judgment: Number(material.exam_judgment_score) || 0,
    }
    const scoreOf = (q) => (scoreCfg[q.type] > 0 ? scoreCfg[q.type] : q.score)

    // 考试次数限制（轻量拦截：基于已有记录数；P0 采用覆盖式提交，仅做提示性拦截）
    if (material.attempt_limit > 0 && mode === QUIZ_MODES.EXAM) {
      const [[{ cnt }]] = await pool.execute(
        'SELECT COUNT(*) AS cnt FROM t_record WHERE user_id = ? AND material_id = ?',
        [userId, materialId]
      )
      if (cnt >= material.attempt_limit) {
        return res.status(409).json({
          code: 'ATTEMPT_LIMIT_EXCEEDED',
          error: '考试次数已用尽',
          data: { remainingAttempts: 0 },
        })
      }
    }

    const [questions] = await pool.execute(
      'SELECT id, type, answer, analysis, score FROM t_question WHERE material_id = ? AND status = 1',
      [materialId]
    )
    const qMap = {}
    questions.forEach(q => { qMap[q.id] = q })

    let totalScore = 0
    let maxScore = 0
    const graded = []

    for (const qa of answers) {
      const q = qMap[qa.questionId]
      if (!q) continue

      maxScore += scoreOf(q)
      let isCorrect = false
      let earned = 0
      let aiGrading = null

      if (q.type === 'essay') {
        if (aiGradingOn) {
          try {
            const r = await gradeShortAnswer({
              question: q.question,
              reference: q.answer,
              userAnswer: String(qa.answer ?? ''),
              maxScore: scoreOf(q),
            })
            if (r && typeof r.score === 'number') {
              aiGrading = r
              earned = Math.max(0, Math.min(scoreOf(q), r.score))
              isCorrect = earned >= Math.ceil(scoreOf(q) / 2)
            }
          } catch (e) {
            console.error('[aiGrading]', e)
          }
        }
        // AI 未开启 / 未配置 / 调用失败 → 记 0 分并提示人工批改
        if (!aiGrading) {
          isCorrect = false
          earned = 0
          aiGrading = { manual: true, note: '需人工批改' }
        }
      } else {
        isCorrect = normalizeAnswer(q.type, q.answer, qa.answer)
        earned = isCorrect ? scoreOf(q) : 0
      }

      if (isCorrect) totalScore += earned

      const item = {
        questionId: q.id,
        answer:     qa.answer,
        isCorrect,
        score:      earned,
        analysis:   q.analysis,
      }
      if (aiGrading) item.aiGrading = aiGrading
      graded.push(item)
    }

    // ── 错题本写入：答错 upsert（累计 +1），答对移出（视为已掌握）──
    // 批量处理：避免「逐题 await pool.execute」导致大题量（上千题）时提交耗时
    // 随题量线性增长（N+1 查询），手机端极易顶破前端 15s 超时 → 误入离线队列 → 错题不落库。
    // 改为 2 条批量 SQL：答对一次性 DELETE；答错一次性多值 INSERT ... ON DUPLICATE KEY UPDATE。
    const correctQids = []
    const wrongRows = []
    for (const item of graded) {
      if (item.isCorrect) {
        correctQids.push(item.questionId)
      } else {
        wrongRows.push([userId, Number(materialId), item.questionId, mode])
      }
    }
    if (correctQids.length) {
      const ph = correctQids.map(() => '?').join(',')
      await pool.execute(
        `DELETE FROM t_wrong_question WHERE user_id = ? AND question_id IN (${ph})`,
        [userId, ...correctQids]
      )
    }
    if (wrongRows.length) {
      const valPh = wrongRows.map(() => '(?,?,?,?,1,NOW())').join(',')
      const params = []
      for (const r of wrongRows) params.push(...r)
      await pool.execute(
        `INSERT INTO t_wrong_question (user_id, material_id, question_id, mode, wrong_times, last_wrong_at)
         VALUES ${valPh}
         ON DUPLICATE KEY UPDATE wrong_times = wrong_times + 1, last_wrong_at = NOW(), mode = VALUES(mode)`,
        params
      )
    }

    // 覆盖式写入（先删后插）
    await pool.execute(
      'DELETE FROM t_record WHERE user_id = ? AND material_id = ?',
      [userId, materialId]
    )
    const record = await saveRecord({
      userId,
      materialId: Number(materialId),
      answers:    graded,
      score:      totalScore,
      maxScore,
      durationSec,
      isOffline,
      mode,
      attemptNo: Number(attemptNo) || 1,
    })

    res.json({
      success: true,
      data: {
        recordId:  record.id,
        score:     totalScore,
        maxScore,
        passScore,
        passRate:  maxScore > 0 ? Math.round(totalScore / maxScore * 100) : 0,
        passed:    maxScore > 0 ? Math.round(totalScore / maxScore * 100) >= passScore : false,
        mode,
        // 注：gradedList 仅在「错题练习」提交后由 ResultPage 内联展示时使用；
        // 普通提交的成绩回顾统一走 GET /:materialId/result，故此处不再下发整卷 gradedList，
        // 避免大题量（上千题）响应体膨胀导致手机端接收超时。
      },
    })
  } catch (err) {
    console.error('[quiz.submit]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

// ─── POST /api/quiz/offline-batch ────────────────────────────────────────────
router.post('/offline-batch', authMiddleware, async (req, res) => {
  try {
    const { records } = req.body
    const userId = req.user.id

    if (!Array.isArray(records) || !records.length) {
      return sendError(res, 'EMPTY_ANSWERS')
    }

    const safeRecords = records.map(r => ({ ...r, userId }))
    const result = await saveOfflineRecords(safeRecords)

    res.json({
      success: true,
      message: `上传完成：成功 ${result.success} 条 / 失败 ${result.fail} 条`,
      data:    result,
    })
  } catch (err) {
    console.error('[quiz.offline-batch]', err)
    sendError(res, 'INTERNAL_ERROR')
  }
})

module.exports = router
