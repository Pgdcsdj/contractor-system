/**
 * AI 评分服务
 *
 * 支持多选题自动评分 + 简答题 AI 评分
 *
 * 使用方式：
 *   const { gradeAnswer, gradeAll } = require('./aiGrading')
 *
 *   // 评分一道简答题
 *   const result = await gradeAnswer({
 *     question: { type: 'short_answer_image', question: '...', answer: '...' },
 *     employeeAnswer: '员工提交的答案'
 *   })
 *
 *   // 批量评分（选择题自动，填空题/简答走AI）
 *   const results = await gradeAll(questions, answers)
 */
const { getApiKey, getProvider, getGradingModel } = require('./aiConfig')

// ─── 多选题评分（精确匹配）────────────────────────────────────────────────

/**
 * 多选题评分
 * - 全对得满分
 * - 部分对：按正确比例给分
 * - 有错选：倒扣机制（可选，默认不给分）
 *
 * @param {string} correctAnswer  - 正确答案，如 "ABC"
 * @param {string} givenAnswer    - 员工答案，如 "AB"
 * @param {Object} options        - 选项表 {A: '描述', B: '描述', ...}
 * @param {Object} opts
 * @param {number} opts.fullScore - 满分，默认 4 分
 */
function gradeMultipleChoice(correctAnswer, givenAnswer, options, opts = {}) {
  const fullScore = opts.fullScore ?? 4
  const correctSet = new Set(correctAnswer.split('').sort())
  const givenSet = new Set(givenAnswer.split('').sort())

  const correctCount = [...correctSet].filter(k => givenSet.has(k)).length
  const wrongCount = [...givenSet].filter(k => !correctSet.has(k)).length

  if (wrongCount > 0) {
    // 有错选，不给分（严格模式）或按比例给分（宽松模式）
    return {
      score: 0,
      maxScore: fullScore,
      correctCount,
      wrongCount,
      isCorrect: false,
      detail: `错选了 ${wrongCount} 个选项（${[...givenSet].filter(k => !correctSet.has(k)).join(',')}），本题不得分`,
    }
  }

  if (correctCount === correctSet.size) {
    return {
      score: fullScore,
      maxScore: fullScore,
      correctCount,
      wrongCount: 0,
      isCorrect: true,
      detail: '全部正确',
    }
  }

  // 部分正确（漏选了）
  const ratio = correctCount / correctSet.size
  const score = Math.round(ratio * fullScore * 10) / 10
  return {
    score,
    maxScore: fullScore,
    correctCount,
    wrongCount: 0,
    isCorrect: false,
    detail: `漏选了 ${correctSet.size - correctCount} 个选项，得 ${score} 分`,
  }
}

// ─── 判断题评分 ─────────────────────────────────────────────────────────────

function gradeJudgment(correctAnswer, givenAnswer, opts = {}) {
  const fullScore = opts.fullScore ?? 2
  const isCorrect = correctAnswer === givenAnswer
  return {
    score: isCorrect ? fullScore : 0,
    maxScore: fullScore,
    isCorrect,
    detail: isCorrect ? '正确' : `错误（正确答案：${correctAnswer}）`,
  }
}

// ─── 简答题 AI 评分 ─────────────────────────────────────────────────────────

/**
 * 调用 AI 评分简答题
 *
 * @param {Object} params
 * @param {string} params.questionText      - 题目
 * @param {string} params.standardPoints    - 标准答案要点（分行）
 * @param {string} params.employeeAnswer    - 员工答案
 * @param {number} params.maxScore          - 满分，默认20
 * @param {number} params.pointsPerItem     - 每个要点几分，默认2
 *
 * @returns {Object} { score, maxScore, correctPoints, missingPoints, encouragement }
 */
async function gradeShortAnswer({ questionText, standardPoints, employeeAnswer, maxScore = 20, pointsPerItem = 2 }) {
  const provider = getProvider()
  const apiKey = getApiKey()
  const model = getGradingModel()

  const gradingPrompt = `你是石油石化行业安全培训AI评分专家。

## 评分任务
对比员工提交答案与标准答案要点，给出评分。

## 题目
${questionText}

## 员工答案
${employeeAnswer || '（未作答）'}

## 标准答案要点
${standardPoints}

## 评分规则
- 每个标准要点 ${pointsPerItem} 分，满分 ${maxScore} 分
- 员工答案中包含某要点关键词即算正确（允许用自己的话表述，意思对即可）
- 明显答非所问或空白不得分

## 输出要求
严格只输出JSON，不要任何其他文字：
{"score": 总分数字, "maxScore": ${maxScore}, "correctPoints": ["正确要点描述列表"], "missingPoints": ["缺失要点描述列表"], "wrongStatements": ["如有明显错误陈述，否则填空数组"], "encouragement": "10字以内总体点评"}`

  const body = { model, messages: [{ role: 'user', content: gradingPrompt }], temperature: 0.3, max_tokens: 600 }

  // R1 推理模型不需要 temperature
  if (model.includes('R1') || model.includes('reasoner')) {
    delete body.temperature
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(`AI 评分错误 [${response.status}]: ${err.error?.message || response.statusText}`)
  }

  const result = await response.json()
  let raw = result.choices?.[0]?.message?.content?.trim() || '{}'

  // 清洗 markdown
  if (raw.startsWith('```')) {
    const lines = raw.split('\n')
    raw = lines.slice(1, -1).join('\n')
  }

  let scoreData
  try {
    scoreData = JSON.parse(raw)
  } catch {
    // 解析失败，降级为按行数评分
    console.warn('[AI 评分] JSON解析失败，降级处理:', raw.slice(0, 100))
    const lines = (employeeAnswer || '').split(/[，,；;\n]/).filter(l => l.trim())
    const fallbackScore = Math.min(lines.length * pointsPerItem, maxScore)
    scoreData = {
      score: fallbackScore,
      maxScore,
      correctPoints: [],
      missingPoints: ['（解析失败，未能提取要点）'],
      wrongStatements: [],
      encouragement: '请查看标准答案参考',
    }
  }

  return {
    score: Number(scoreData.score) || 0,
    maxScore: Number(scoreData.maxScore) || maxScore,
    correctPoints: scoreData.correctPoints || [],
    missingPoints: scoreData.missingPoints || [],
    wrongStatements: scoreData.wrongStatements || [],
    encouragement: scoreData.encouragement || '',
    raw: raw.slice(0, 500),
  }
}

// ─── 综合评分 ───────────────────────────────────────────────────────────────

/**
 * 批量评分（选择题自动 + 简答题AI）
 *
 * @param {Array}  questions - 题目列表
 * @param {Array}  answers  - 员工答案列表 [{questionId, answer, files?}]
 *
 * @returns {Object} { results, totalScore, maxScore, summary }
 */
async function gradeAll(questions, answers) {
  const results = []
  let totalScore = 0
  let maxScore = 0

  const answerMap = {}
  answers.forEach(a => { answerMap[a.questionId] = a })

  for (const q of questions) {
    const employeeAnswer = answerMap[q.id]?.answer || ''
    let result = { questionId: q.id, type: q.type, score: 0, maxScore: 0, detail: '' }

    if (q.type === 'single' || q.type === 'judgment') {
      // 选择/判断题：精确匹配
      const correct = q.answer === employeeAnswer
      result.score = correct ? (q.type === 'single' ? 4 : 2) : 0
      result.maxScore = q.type === 'single' ? 4 : 2
      result.isCorrect = correct
      result.detail = correct ? '正确' : `错误（正确答案：${q.answer}）`

    } else if (q.type === 'multiple') {
      // 多选题：智能评分
      const mcResult = gradeMultipleChoice(q.answer, employeeAnswer, q.options)
      result.score = mcResult.score
      result.maxScore = mcResult.maxScore
      result.isCorrect = mcResult.isCorrect
      result.correctCount = mcResult.correctCount
      result.wrongCount = mcResult.wrongCount
      result.detail = mcResult.detail

    } else if (q.type === 'short_answer' || q.type === 'short_answer_image') {
      // 简答题：AI评分
      const config = require('./aiConfig').loadConfig()
      const gc = config.gradingConfig || {}
      const pts = gc.pointsPerItem ?? 2
      const mx = gc.maxScore ?? 20

      const aiResult = await gradeShortAnswer({
        questionText: q.question,
        standardPoints: q.answer,
        employeeAnswer,
        maxScore: mx,
        pointsPerItem: pts,
      })
      result.score = aiResult.score
      result.maxScore = aiResult.maxScore
      result.correctPoints = aiResult.correctPoints
      result.missingPoints = aiResult.missingPoints
      result.wrongStatements = aiResult.wrongStatements
      result.encouragement = aiResult.encouragement
      result.detail = `得分 ${aiResult.score}/${aiResult.maxScore}，${aiResult.encouragement}`
    }

    results.push(result)
    totalScore += result.score
    maxScore += result.maxScore
  }

  const passScore = Math.round(maxScore * 0.6)
  const summary = {
    totalScore,
    maxScore,
    passScore,
    passRate: Math.round((totalScore / maxScore) * 100),
    isPass: totalScore >= passScore,
    correctCount: results.filter(r => r.isCorrect).length,
    totalCount: results.length,
  }

  return { results, totalScore, maxScore, summary }
}

// ─── AI 评分结果展示（给员工端）──────────────────────────────────────────

/**
 * 生成员工端展示用的评分反馈
 */
function buildFeedback(question, gradeResult) {
  if (question.type === 'single' || question.type === 'judgment') {
    return {
      isCorrect: gradeResult.isCorrect,
      yourAnswer: gradeResult.yourAnswer || '(未作答)',
      correctAnswer: question.answer,
      explanation: question.explanation || '',
    }
  } else if (question.type === 'multiple') {
    return {
      isCorrect: gradeResult.isCorrect,
      yourAnswer: gradeResult.yourAnswer || '(未作答)',
      correctAnswer: question.answer,
      explanation: question.explanation || '',
      detail: gradeResult.detail,
    }
  } else if (question.type === 'short_answer' || question.type === 'short_answer_image') {
    return {
      score: gradeResult.score,
      maxScore: gradeResult.maxScore,
      correctPoints: gradeResult.correctPoints || [],
      missingPoints: gradeResult.missingPoints || [],
      encouragement: gradeResult.encouragement || '',
      explanation: question.explanation || '',
    }
  }
}

module.exports = {
  gradeMultipleChoice,
  gradeJudgment,
  gradeShortAnswer,
  gradeAll,
  buildFeedback,
}
