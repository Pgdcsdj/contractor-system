/**
 * AI 出题与评分路由
 *
 * 路由清单：
 *   POST /api/ai/generate      生成题目
 *   POST /api/ai/grade         批量评分
 *   POST /api/ai/grade-one     单题评分（简答题）
 *   GET  /api/ai/config        获取AI配置
 *   PUT  /api/ai/config        更新AI配置（管理员）
 *   POST /api/ai/test          测试API连接
 */
const express = require('express')
const router = express.Router()
const { verifyAdminToken } = require('../services/adminAuth')

// 管理员 JWT 鉴权中间件（与 notify.js 一致；adminAuth.js 仅导出 adminLogin/verifyAdminToken）
function adminAuth(req, res, next) {
  const header = req.headers['authorization']
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(header.slice(7))
  if (!payload) return res.status(401).json({ error: '登录已过期，请重新登录' })
  req.admin = payload
  next()
}

const { generateQuestions } = require('../ai/aiQuestion')
const { gradeAll, gradeShortAnswer } = require('../ai/aiGrading')
const {
  getConfigSummary,
  updateConfig,
  testConnection,
  listProviders,
} = require('../ai/aiConfig')

// ─── 统一响应格式 ──────────────────────────────────────────────────────────

function ok(res, data) {
  res.json({ success: true, data })
}

function fail(res, status, message, detail) {
  res.status(status).json({ success: false, error: message, detail })
}

// ─── 参数校验 ───────────────────────────────────────────────────────────────

function validateGenerate(body) {
  if (!body.content || typeof body.content !== 'string') {
    return '缺少必需参数 content（文档文字内容）'
  }
  if (body.content.trim().length < 10) {
    return 'content 内容过短，至少需要10个字符'
  }
  if (body.count !== undefined && (body.count < 1 || body.count > 50)) {
    return 'count 必须在 1~50 之间'
  }
  return null
}

function validateGrade(body) {
  if (!Array.isArray(body.questions)) return '缺少参数 questions（题目列表）'
  if (!Array.isArray(body.answers)) return '缺少参数 answers（员工答案列表）'
  return null
}

// ─── 路由实现 ───────────────────────────────────────────────────────────────

/**
 * POST /api/ai/generate
 * 生成题目
 *
 * Body:
 *   content    {string}  必填，文档文字内容
 *   images     {Array}   可选，图片信息 [{filename, description}]
 *   count      {number}  可选，出题数量，默认10
 *   docType    {string}  可选，文档类型：auto / video_report / policy_notice
 */
router.post('/generate', async (req, res) => {
  const err = validateGenerate(req.body)
  if (err) return fail(res, 400, err)

  const { content, images = [], count = 10, docType = 'auto' } = req.body

  try {
    const result = await generateQuestions({ content, images, count, docType })
    ok(res, result)
  } catch (e) {
    console.error('[路由 /generate]', e.message)
    fail(res, 500, '出题失败', e.message)
  }
})

/**
 * POST /api/ai/grade
 * 批量评分（选择题自动 + 简答题AI）
 *
 * Body:
 *   questions  {Array}  题目列表（完整题目对象，含答案）
 *   answers    {Array}  员工答案 [{questionId, answer}]
 */
router.post('/grade', async (req, res) => {
  const err = validateGrade(req.body)
  if (err) return fail(res, 400, err)

  const { questions, answers } = req.body

  try {
    const result = await gradeAll(questions, answers)
    ok(res, result)
  } catch (e) {
    console.error('[路由 /grade]', e.message)
    fail(res, 500, '评分失败', e.message)
  }
})

/**
 * POST /api/ai/grade-one
 * 单题评分（仅用于简答题，AI逐题评分避免超时）
 *
 * Body:
 *   question       {Object}  题目对象
 *   employeeAnswer {string}  员工答案
 */
router.post('/grade-one', async (req, res) => {
  const { question, employeeAnswer } = req.body

  if (!question || !question.type) {
    return fail(res, 400, '缺少 question 参数')
  }

  const isShortAnswer =
    question.type === 'short_answer' || question.type === 'short_answer_image'

  if (!isShortAnswer) {
    return fail(res, 400, 'grade-one 仅支持简答题（short_answer / short_answer_image）')
  }

  try {
    const result = await gradeShortAnswer({
      questionText: question.question,
      standardPoints: question.answer,
      employeeAnswer: employeeAnswer || '',
    })
    ok(res, result)
  } catch (e) {
    console.error('[路由 /grade-one]', e.message)
    fail(res, 500, '单题评分失败', e.message)
  }
})

/**
 * GET /api/ai/config
 * 获取当前AI配置（管理员用，隐藏完整Key）
 */
router.get('/config', adminAuth, (req, res) => {
  try {
    const summary = getConfigSummary()
    const providers = listProviders()
    ok(res, { ...summary, availableProviders: providers })
  } catch (e) {
    console.error('[路由 /config GET]', e.message)
    fail(res, 500, '获取配置失败', e.message)
  }
})

/**
 * PUT /api/ai/config
 * 更新AI配置（管理员用）
 *
 * Body 支持部分更新：
 *   provider        {string}  切换Provider：deepseek / siliconflow / groq
 *   apiKeys         {Object}  更新API Keys
 *   models          {Object}  更新模型配置 {question, grading}
 *   questionConfig  {Object}  出题参数
 *   gradingConfig   {Object}  评分参数
 */
router.put('/config', adminAuth, (req, res) => {
  const ALLOWED_FIELDS = ['provider', 'apiKeys', 'models', 'questionConfig', 'gradingConfig']
  const updates = {}

  for (const field of ALLOWED_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field]
    }
  }

  if (Object.keys(updates).length === 0) {
    return fail(res, 400, '未提供有效配置字段')
  }

  // 敏感字段黑名单（禁止前端修改的字段）
  const BLOCKED = ['secret', 'password', 'token']
  for (const key of Object.keys(updates)) {
    for (const block of BLOCKED) {
      if (key.toLowerCase().includes(block)) {
        return fail(res, 403, `禁止修改敏感字段: ${key}`)
      }
    }
  }

  try {
    const newConfig = updateConfig(updates)
    ok(res, { message: '配置已更新', config: getConfigSummary() })
  } catch (e) {
    console.error('[路由 /config PUT]', e.message)
    fail(res, 500, '更新配置失败', e.message)
  }
})

/**
 * POST /api/ai/test
 * 测试指定 Provider + API Key 的连接
 *
 * Body:
 *   providerId  {string}  Provider ID：deepseek / siliconflow / groq
 *   apiKey      {string}  API Key
 */
router.post('/test', async (req, res) => {
  const { providerId, apiKey } = req.body

  if (!providerId || !apiKey) {
    return fail(res, 400, '缺少 providerId 或 apiKey')
  }
  if (!['deepseek', 'siliconflow', 'groq', 'moonshot'].includes(providerId)) {
    return fail(res, 400, '无效的 providerId：仅支持 deepseek / siliconflow / groq / moonshot')
  }

  try {
    const result = await testConnection(providerId, apiKey)
    ok(res, result)
  } catch (e) {
    console.error('[路由 /test]', e.message)
    fail(res, 500, '连接测试失败', e.message)
  }
})

module.exports = router
