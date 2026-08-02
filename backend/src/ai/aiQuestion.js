/**
 * AI 出题服务
 *
 * 核心逻辑：
 * - 自动识别文件类型（视频督查通报 / 制度通知 / 其他）
 * - 视频督查通报 → 打包多图 + 多选题 + 简答题
 * - 制度/通知文件 → 单选题 + 多选题 + 判断题
 * - 支持批量图片打包
 * - 两阶段流水线（生成 → 校验 → 修复 → 返回）
 * - 结构化输出（response_format）支持
 * - 难度控制（1-5）
 *
 * 使用方式：
 *   const { generateQuestions } = require('./aiQuestion')
 *   const questions = await generateQuestions({ content, images: [...] })
 */
const { getApiKey, getProvider, getQuestionModel, getVisionModel, supportsVision, supportsStructuredOutput } = require('./aiConfig')

// ─── Prompt 模板 ────────────────────────────────────────────────────────────

const PROMPTS = {
  // ── 视频督查通报（带图片违章场景）─────────────────────────────
  video_report: {
    system: `你是一名石油石化行业资深安全督查专家，擅长从视频督查通报中提炼培训题目。
你生成的题目必须：
1. 严格基于通报原文中的违章事实，不得凭空编造
2. 题目语言简洁准确，选项无歧义
3. 多选题选项中包含真实违章和干扰项，干扰项要有一定迷惑性
4. 简答题考察理解与应用，每题附评分要点
5. 绝对严格输出JSON数组，不要任何其他文字`,
    user: (vars) => `## 任务
根据以下安全督查通报内容和相关图片信息，生成题目。

## 文件类型
【视频督查通报】— 包含真实违章现场图片，适合出图片识别题和多选题。

## 通报文字内容
${vars.content}

## 图片信息
${vars.imageInfo}

## 出题要求
生成 ${vars.count} 道题，题型分布：
- 打包多图多选题：${vars.mcCount} 道
  → 格式：type="multiple_image"，images字段列出涉及的图片文件名
  → 每题images数组包含1-3张图片，题目描述图片中的违章行为
  → 选项包含所有真实违章（正确项）+ 1-2个干扰项
  → 正确答案格式：把图片中所有违章对应的字母连起来，如"ABC"

- 主观简答题：${vars.shortCount} 道
  → 格式：type="short_answer_image"，images字段同上
  → 考察对规程的理解和实际应用能力
  → 必须附带 ai_scoring_prompt 字段（用于AI评分，给出标准答案要点和评分规则）

## JSON格式（严格，数组最外层）
[
  {
    "id": 1,
    "type": "multiple_image",
    "theme": "违章主题",
    "question": "题目描述（描述图片中违章场景）",
    "images": ["图片文件名"],
    "options": {"A": "选项A","B": "选项B","C": "选项C","D": "选项D"},
    "answer": "正确答案字母组合，如"ABC"",
    "correct_letters_desc": {"A":"A项违章说明","B":"B项违章说明",...},
    "explanation": "解析",
    "grading_hint": "评分说明"
  },
  {
    "id": N,
    "type": "short_answer_image",
    "theme": "违章主题",
    "question": "简答题题目",
    "images": ["图片文件名"],
    "answer": "参考答案要点（分行）",
    "explanation": "参考答案（评分要点）",
    "grading_hint": "踩点给分说明",
    "ai_scoring_prompt": "评分用的提示词，包含标准答案和评分规则"
  }
]

## 输出要求
严格只输出JSON数组，不要任何其他文字说明。`,
  },

  // ── 制度/通知文件（纯文字）────────────────────────────────────
  policy_notice: {
    system: `你是一名石油石化行业安全培训专家，擅长从制度和通知文件中生成培训题库。
你生成的题目必须：
1. 严格基于文件原文中的条款，不得超出原文范围
2. 题目聚焦关键规定、禁止行为、责任要求
3. 选项设置有区分度，干扰项有一定迷惑性但明显错误
4. 严格输出JSON数组，不要任何其他文字`,
    user: (vars) => `## 任务
根据以下制度/通知文件内容，生成安全培训题库。

## 文件类型
【制度/通知】— 纯文字文件，适合出单选题、多选题、判断题。

## 文件内容
${vars.content}

## 出题要求
生成 ${vars.count} 道题，题型分布：
- 单选题：${vars.scCount} 道（A/B/C/D四选一，标注1个正确答案）
- 多选题：${vars.mcCount} 道（2-4个正确选项，标注所有正确选项）
- 判断题：${vars.judgeCount} 道（"正确"或"错误"，考察对条款的记忆）

## JSON格式（严格，数组最外层）
[
  {
    "id": 1,
    "type": "single",
    "question": "题目",
    "options": {"A": "选项A","B": "选项B","C": "选项C","D": "选项D"},
    "answer": "B",
    "explanation": "解析（引用具体条款）",
    "regulation_reference": "依据的条款名称"
  },
  {
    "id": 2,
    "type": "multiple",
    "question": "题目",
    "options": {"A": "选项A","B": "选项B","C": "选项C","D": "选项D"},
    "answer": "ABD",
    "explanation": "解析",
    "regulation_reference": "依据的条款名称"
  },
  {
    "id": 3,
    "type": "judgment",
    "question": "题目",
    "answer": "正确",  // 或 "错误"
    "explanation": "解析"
  }
]

## 输出要求
严格只输出JSON数组，不要任何其他文字说明。`,
  },

  // ── 违章图片识别（带图片的违章通报）───────────────────────────
  image_violation: {
    system: `你是一名安全环保培训师，擅长将施工现场违章照片转化为"看图识隐患"的客观题。
你生成的题目必须：
1. 严格基于通报文字和图片中的真实违章场景，不得凭空编造
2. 忽略原通报中的标注线框（红圈、箭头等），只看场景本身
3. 题目语言简洁准确，选项无歧义，干扰项有迷惑性但明显错误
4. 多选题选项中包含真实违章和合理但图中不存在的干扰项
5. 绝对严格输出JSON数组，不要任何其他文字`,
    user: (vars) => `## 任务
根据以下违章通报文字和相关现场图片，生成"看图识隐患"培训题库。

## 文件类型
【违章图片通报】— 包含真实违章现场照片，适合出图片识别题。

## 通报文字内容
${vars.content}

## 图片信息
${vars.imageInfo}

## 出题要求
生成 ${vars.count} 道题，题型分布：
- 单选题：${vars.scCount} 道
  → 主要考查匹配违反的标准/制度条款，设置相似条款干扰
  → 也可以考查"图中哪一项属于《重大事故隐患判定标准》中的情形"
- 多选题：${vars.mcCount} 道
  → 至少1道为"从图片中找出全部存在的隐患/违章行为"（选项包含图中真实隐患+2个合理但图中不存在的干扰项）
  → 至少1道为"若发生事故，以下哪些人员履职不力"
  → 至少1道为"该场景暴露出的可能管理原因"
- 判断题：${vars.judgeCount} 道
  → 至少1道与安全生产禁令、保命条款或国家重大隐患清单直接相关
  → 其余可判断图片中某一具体操作是否正确
- 填空题：${vars.fillCount} 道
  → 结合图片场景，补充关键安全参数（如安全距离、浓度限值等）

## 每道题的image_index说明
每张图片有一个编号（从0开始），请在每道题中标注使用哪张图片：
${vars.imageIndexInfo}

## JSON格式（严格，数组最外层）
[
  {
    "id": 1,
    "type": "single",
    "image_index": 0,
    "question": "根据图片场景，一名作业人员在未搭设脚手架的情况下直接攀爬钢结构立柱进行焊接。该行为最直接违反了以下哪项？",
    "options": {"A": "《高处作业安全管理规定》...","B": "《焊接安全规程》...","C": "《劳动防护用品管理制度》...","D": "《钢结构施工规范》..."},
    "answer": "A",
    "explanation": "图片核心违章是未使用合规作业平台进行高处焊接..."
  },
  {
    "id": 2,
    "type": "multiple",
    "image_index": 0,
    "question": "根据图片，该作业面存在哪些隐患或违章？",
    "options": {"A": "...","B": "...","C": "...","D": "...","E": "..."},
    "answer": "ABC",
    "explanation": "D、E在图中无法判断或未体现..."
  },
  {
    "id": 3,
    "type": "judgment",
    "image_index": 1,
    "question": "图中作业人员未系安全带进行5米高度作业，直接违反了'严禁高处作业不系安全带'的保命条款。",
    "answer": "正确",
    "explanation": "该保命条款为各行业通用强制性规定..."
  },
  {
    "id": 4,
    "type": "fill",
    "image_index": 2,
    "question": "图中氧气瓶与乙炔瓶并排放置，两者间距不足______米，不符合国标要求。",
    "answer": "5",
    "explanation": "GB 9448规定两者间距不小于5米..."
  }
]

## 输出要求
严格只输出JSON数组，不要任何其他文字说明。`,
  },
}

/**
 * 难度描述模板
 */
function buildDifficultyPrompt(difficulty) {
  const level = Math.min(5, Math.max(1, Number(difficulty) || 3))
  return [
    '',
    `难度等级 ${level}/5：`,
    `1-2（基础）：考察原文中的直接内容、关键词复现、条款识记`,
    `3（应用）：考察概念理解、场景匹配、合规判断`,
    `4-5（深入）：考察综合分析、多条款交叉、最优方案选择`,
    `当前难度：${level}/5 — ${level <= 2 ? '请生成基础难度题目' : level <= 3 ? '请生成中等应用难度题目' : '请生成深入综合分析难度题目'}`,
  ].join('\n')
}

// ─── 文档类型自动识别 ───────────────────────────────────────────────────────

const TYPE_KEYWORDS = {
  video_report: ['视频督查', '督查通报', '现场视频', '视频监控', '违章视频', '监督检查'],
  policy_notice: ['管理制度', '操作规程', '作业指导书', '安全规定', '管理办法', '工作通知', '会议纪要', '红头文件'],
}

/**
 * 自动识别文档类型
 */
function classifyDocument(content, imageCount = 0) {
  const text = content.toLowerCase()
  let scores = { video_report: 0, policy_notice: 0 }

  for (const kw of TYPE_KEYWORDS.video_report) {
    if (text.includes(kw)) scores.video_report += 2
  }
  for (const kw of TYPE_KEYWORDS.policy_notice) {
    if (text.includes(kw)) scores.policy_notice += 1
  }

  // 有图片时倾向于视频督查类型
  if (imageCount >= 2) scores.video_report += 3

  return scores.video_report > scores.policy_notice ? 'video_report' : 'policy_notice'
}

// ─── 调用 AI API ────────────────────────────────────────────────────────────

/**
 * 调用 AI API 生成题目（基础版）
 */
async function callAI(messages, maxTokens = 4096) {
  const provider = getProvider()
  const apiKey = getApiKey()
  const model = getQuestionModel()

  const config = require('./aiConfig').loadConfig()
  const qc = config.questionConfig || {}

  const body = {
    model,
    messages,
    temperature: qc.temperature ?? 0.3,
    max_tokens: maxTokens,
  }

  // SiliconFlow 的 DeepSeek-R1 是推理模型，不需要 temperature
  if (model.includes('R1') || model.includes('reasoner')) {
    delete body.temperature
  }

  // Moonshot / Kimi 系列模型对 temperature 敏感，仅允许固定值 1。
  const isMoonshot = provider.id === 'moonshot' || /moonshot/i.test(provider.name || '')
  const isKimiModel = /kimi/i.test(model)
  if (isMoonshot || isKimiModel) {
    body.temperature = 1
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
    throw new Error(`AI API 错误 [${response.status}]: ${err.error?.message || response.statusText}`)
  }

  const result = await response.json()
  return extractContentFromResult(result)
}

/**
 * 调用 AI API（带结构化输出 response_format）
 */
async function callAIStructured(messages, maxTokens = 4096) {
  const provider = getProvider()
  const apiKey = getApiKey()
  const model = getQuestionModel()

  const config = require('./aiConfig').loadConfig()
  const qc = config.questionConfig || {}

  const body = {
    model,
    messages,
    temperature: qc.temperature ?? 0.3,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }

  // SiliconFlow 的 DeepSeek-R1 是推理模型，不需要 temperature
  if (model.includes('R1') || model.includes('reasoner')) {
    delete body.temperature
  }

  // Moonshot / Kimi 系列模型对 temperature 敏感
  const isMoonshot = provider.id === 'moonshot' || /moonshot/i.test(provider.name || '')
  const isKimiModel = /kimi/i.test(model)
  if (isMoonshot || isKimiModel) {
    body.temperature = 1
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
    throw new Error(`AI API 错误 [${response.status}]: ${err.error?.message || response.statusText}`)
  }

  const result = await response.json()
  return extractContentFromResult(result)
}

/**
 * 从 API 响应中提取文本内容
 * 处理 Moonshot reasoning_content 情况：若 content 为空且 reasoning_content 存在，用其作为内容
 */
function extractContentFromResult(result) {
  const message = result.choices?.[0]?.message
  if (!message) return ''

  let content = message.content
  // Moonshot/Kimi 等模型可能返回 reasoning_content 而非 content
  if ((!content || content.trim() === '') && message.reasoning_content) {
    content = message.reasoning_content
  }

  return (content || '').trim()
}

/**
 * 清洗 AI 返回的 JSON（处理 markdown 包裹等），并增强容错。
 * 若 JSON.parse 失败，尝试从文本中提取第一个 [ ... ] 数组再次解析；
 * 仍失败则抛出携带原始响应前 200 字符的明确错误，便于后续排查。
 */
function parseJSONResponse(raw) {
  let text = raw.trim()
  if (text.startsWith('```json')) {
    const lines = text.split('\n')
    text = lines.slice(1, -1).join('\n')
  } else if (text.startsWith('```')) {
    const lines = text.split('\n')
    text = lines.slice(1, -1).join('\n')
  }
  text = text.trim()

  try {
    return JSON.parse(text)
  } catch (firstErr) {
    // 兜底：从文本中提取第一个 [ ... ] 数组再尝试解析（兼容夹杂说明文字的返回）
    const arrMatch = text.match(/\[[\s\S]*\]/)
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0])
      } catch (arrErr) {
        throw new Error(
          `AI 返回内容无法解析为 JSON：${firstErr.message}；提取数组后仍失败：${arrErr.message}；原始响应前 200 字符：${raw.slice(0, 200)}`
        )
      }
    }
    throw new Error(
      `AI 返回内容无法解析为 JSON：${firstErr.message}；原始响应前 200 字符：${raw.slice(0, 200)}`
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  两阶段流水线：质量门禁 + 修复
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 质量门禁：校验题目数组的完整性和正确性
 *
 * @param {Array} questions - 待校验的题目数组
 * @param {Object} params - 校验参数
 * @param {number} params.count - 期望的题目数量
 * @param {string} [params.questionTypes] - 期望的题型（如 '单选题' / '单选+多选+判断+简答'）
 * @returns {{ valid: boolean, results: Array<{ index: number, ok: boolean, errors: string[] }> }}
 */
function validateQuestions(questions, { count, questionTypes } = {}) {
  if (!Array.isArray(questions)) {
    return {
      valid: false,
      results: [{ index: -1, ok: false, errors: ['返回内容不是数组'] }],
    }
  }

  // 解析期望的题型列表
  const expectedTypes = parseExpectedTypes(questionTypes || '')

  const results = questions.map((q, index) => {
    const errors = []

    // 1. 必须有 question 字符串且非空
    if (!q.question || typeof q.question !== 'string' || q.question.trim() === '') {
      errors.push(`题 ${index + 1} 缺少 question 字段或为空`)
    }

    // 2. 必须有 options 对象且至少有 2 个 key
    if (!q.options || typeof q.options !== 'object' || Array.isArray(q.options)) {
      errors.push(`题 ${index + 1} 缺少有效的 options 对象`)
    } else {
      const optionKeys = Object.keys(q.options)
      if (optionKeys.length < 2) {
        errors.push(`题 ${index + 1} options 至少需要 2 个选项，当前 ${optionKeys.length} 个`)
      }

      // 3. 必须有 answer 字符串且非空
      if (!q.answer || typeof q.answer !== 'string' || q.answer.trim() === '') {
        errors.push(`题 ${index + 1} 缺少 answer 字段或为空`)
      } else {
        // 4. answer 必须在 options 的 keys 中
        const answerStr = q.answer.trim()
        const qtype = q.type || ''

        if (qtype === 'multiple' || qtype === 'multi' || qtype === 'multiple_image') {
          // 多选题：answer 每个字母都在 options keys 中
          const letters = answerStr.split('').filter(c => /[A-Za-z]/.test(c))
          if (letters.length === 0) {
            errors.push(`题 ${index + 1} 多选题 answer "${answerStr}" 不含有效选项字母`)
          } else {
            for (const letter of letters) {
              if (!optionKeys.includes(letter.toUpperCase()) && !optionKeys.includes(letter)) {
                errors.push(`题 ${index + 1} 多选题 answer 中的 "${letter}" 不在 options keys [${optionKeys.join(',')}] 中`)
              }
            }
          }
        } else if (qtype === 'judgment') {
          // 判断题：answer 应为 "正确" 或 "错误"
          if (answerStr !== '正确' && answerStr !== '错误' && answerStr !== 'true' && answerStr !== 'false') {
            errors.push(`题 ${index + 1} 判断题 answer 应为 "正确" 或 "错误"，当前 "${answerStr}"`)
          }
        } else if (qtype === 'fill') {
          // 填空题：answer 非空即可（已在上层校验）
        } else {
          // 单选题/默认：answer 必须是 options 中的某一个 key
          if (!optionKeys.includes(answerStr)) {
            errors.push(`题 ${index + 1} answer "${answerStr}" 不在 options keys [${optionKeys.join(',')}] 中`)
          }
        }
      }
    }

    // 5. 有 explanation 字符串
    if (!q.explanation || typeof q.explanation !== 'string' || q.explanation.trim() === '') {
      // explanation 为可选增强，不强制报错，仅记录
    }

    // 6. 题型匹配（若 questionTypes 指明了）
    if (expectedTypes.length > 0 && q.type) {
      if (!expectedTypes.includes(q.type)) {
        errors.push(`题 ${index + 1} 类型 "${q.type}" 不在期望类型 [${expectedTypes.join(',')}] 中`)
      }
    }

    return { index, ok: errors.length === 0, errors }
  })

  const valid = results.every(r => r.ok)

  // count 校验：仅当 count > 0 时检查数量是否符合
  const countErrors = []
  if (count > 0 && questions.length !== count) {
    countErrors.push(`期望 ${count} 道题，实际生成 ${questions.length} 道`)
  }

  return {
    valid: valid && countErrors.length === 0,
    results,
    countErrors,
  }
}

/**
 * 解析 questionTypes 字符串为期望的题型数组
 */
function parseExpectedTypes(qt) {
  if (!qt) return []
  const t = qt || ''
  const parts = t.split('+').map(s => s.trim())
  const typeMap = {
    '单选题': 'single',
    '单选': 'single',
    '多选题': 'multiple',
    '多选': 'multiple',
    '判断题': 'judgment',
    '判断': 'judgment',
    '简答题': 'short_answer',
    '简答': 'short_answer',
    '填空题': 'fill',
    '填空': 'fill',
  }
  const result = []
  for (const p of parts) {
    if (typeMap[p]) result.push(typeMap[p])
  }
  return result
}

/**
 * 解析 + 校验：解析 AI 返回的 JSON，并进行质量校验
 *
 * @param {string} raw - AI 返回的原始文本
 * @param {Object} params - 校验参数（传递给 validateQuestions）
 * @returns {{ questions: Array, parsed: boolean, validation: Object }}
 */
function parseWithValidation(raw, params = {}) {
  let questions = []
  let parsed = false

  try {
    // 尝试 JSON.parse（结构化输出得到的直接就是有效 JSON）
    const parsedObj = JSON.parse(raw)

    // 处理 response_format: json_object 的情况——最外层可能是 { questions: [...] } 或直接数组
    if (Array.isArray(parsedObj)) {
      questions = parsedObj
    } else if (parsedObj && typeof parsedObj === 'object') {
      // 可能是 { questions: [...] } 或 { data: [...] } 格式
      if (Array.isArray(parsedObj.questions)) {
        questions = parsedObj.questions
      } else if (Array.isArray(parsedObj.data)) {
        questions = parsedObj.data
      } else {
        // 顶层是单对象且非题目数组（如 AI 偶发返回异常结构 / 整段文本）：
        // 不盲目包装成 1 道题，否则会把垃圾内容当成题目入库。
        questions = []
      }
    }
    parsed = true
  } catch {
    // 用原有的解析方式兜底
    try {
      questions = parseJSONResponse(raw)
    } catch {
      questions = []
    }
  }

  // 确保是数组
  if (!Array.isArray(questions)) {
    questions = [questions]
  }

  // 补充缺失字段
  questions = normalizeQuestions(questions)

  // 质量校验
  const validation = validateQuestions(questions, params)

  return { questions, parsed, validation }
}

/**
 * 将 options 统一规范为对象格式 { "A": "文本", "B": "文本" }
 * 兼容模型把 options 返回成数组的情况：
 *   ["A. 12家", "B. 20家"]  ->  { "A": "12家", "B": "20家" }
 * 也兼容数组里每项本身就是对象的情况。
 * @param {*} options
 * @returns {Object}
 */
function normalizeOptions(options) {
  if (!options) return {}
  if (!Array.isArray(options)) return options // 已是对象，原样返回
  const obj = {}
  for (const item of options) {
    if (typeof item === 'string') {
      const m = item.trim().match(/^([A-Za-z])[.、:：)\s]\s*(.*)$/)
      if (m) {
        obj[m[1].toUpperCase()] = m[2].trim()
      } else {
        // 无字母前缀，按顺序用 A/B/C... 兜底
        obj[String.fromCharCode(65 + Object.keys(obj).length)] = item.trim()
      }
    } else if (item && typeof item === 'object') {
      Object.assign(obj, item)
    }
  }
  return obj
}

/**
 * 补充题目缺失字段，并兼容 options 的数组/对象两种格式
 */
function normalizeQuestions(questions, detectedType) {
  return questions.map((q, i) => {
    if (!q.id) q.id = i + 1
    if (!q.type) q.type = detectedType === 'video_report' ? 'multiple_image' : 'single'
    if (!q.theme) q.theme = '安全培训'

    // options 兼容数组/对象两种格式（模型可能返回 ["A. xxx"] 或 {"A":"xxx"}）
    if (q.options) {
      q.options = normalizeOptions(q.options)
    }

    // 若 answer 是选项整段文本（而非字母），映射回对应字母
    if (q.options && typeof q.options === 'object' && !Array.isArray(q.options) && q.answer) {
      const keys = Object.keys(q.options)
      const a = String(q.answer).trim()
      if (keys.includes(a) || keys.includes(a.toUpperCase())) {
        q.answer = a.toUpperCase()
      } else {
        const hit = keys.find(k => String(q.options[k] || '').trim() === a)
        if (hit) q.answer = hit
      }
    }

    return q
  })
}

/**
 * 阶段 2 修复：将原始响应和校验错误发送给 LLM，要求修正
 *
 * @param {string} originalRaw - 原始 AI 响应文本
 * @param {Array} failedResults - 校验失败的结果数组（validateQuestions 返回的 results 中 ok=false 的项）
 * @param {Object} params - 生成参数（用于构建修复 prompt）
 * @returns {Promise<string>} 修复后的 AI 响应文本
 */
async function callAIForRepair(originalRaw, failedResults, params) {
  const { count, questionTypes, difficulty, content, detectedType } = params

  // 构建错误描述
  const errorLines = failedResults.map(r => {
    return `题 ${r.index + 1}：${r.errors.join('；')}`
  })

  const repairPrompt = `## 修复任务
以下 AI 生成的题目 JSON 存在格式或内容错误，请修正后重新输出完整的 JSON 数组。

## 原始内容
\`\`\`json
${originalRaw}
\`\`\`

## 校验错误
${errorLines.join('\n')}

## 修复要求
1. 保持题目数量 ${count} 道不变
2. 每题必须包含：question（字符串）、options（对象，至少2个选项）、answer（在选项keys中）、explanation（字符串）
3. 单选题 answer 为单个字母如 "A"
4. 多选题 answer 为多个字母如 "ABC"
5. 判断题 answer 为 "正确" 或 "错误"
6. 保持原有题目的主题和内容不变，仅修正格式错误
7. 严格输出 JSON 数组格式，不要其他文字说明`

  const systemMsg = `你是一名 JSON 格式修复专家。你的任务是修正 JSON 格式错误，保持题目内容不变。
严格输出 JSON 数组，不要任何其他文字。${buildDifficultyPrompt(difficulty || 3)}`

  // 修复调用降级为普通 callAI（不带 response_format，因为原始调用已失败）
  const raw = await callAI([
    { role: 'system', content: systemMsg },
    { role: 'user', content: repairPrompt },
  ], 3000)

  return raw
}

// ─── 主函数 ─────────────────────────────────────────────────────────────────

/**
 * 生成题目（两阶段流水线）
 *
 * @param {Object} params
 * @param {string}  params.content           - 文档文字内容（必需）
 * @param {Array}   params.images            - 图片信息 [{filename, localPath, description}]
 * @param {number}  params.count             - 出题数量（默认10）
 * @param {string}  params.docType           - 文档类型（auto/ video_report / policy_notice）
 * @param {string}  params.questionTypes     - 可选：强制指定题型，如 '单选题' 或 '单选+多选+判断+简答'
 * @param {Object}  params.overrideImages    - 手动指定图片-违章映射 {filename: description}
 * @param {number}  params.difficulty        - 难度等级 1-5（默认 3）
 *
 * @returns {Object} { questions, metadata, hasErrors, repairAttempted, validationSummary }
 */
async function generateQuestions({
  content,
  images = [],
  count = 10,
  docType = 'auto',
  questionTypes = null,
  overrideImages = {},
  difficulty = 3,
}) {
  // 1. 识别文档类型
  const detectedType = docType === 'auto'
    ? classifyDocument(content, images.length)
    : docType

  // 2. 构建图片信息文本
  const imageInfo = buildImageInfo(images, overrideImages)

  // 3. 确定题型数量
  const distribution = questionTypes
    ? parseQuestionTypes(questionTypes, count)
    : calcDistribution(detectedType, count)

  // 4. 构造 Prompt（system + user）
  const promptDef = PROMPTS[detectedType]
  const systemContent = promptDef.system + buildDifficultyPrompt(difficulty)

  const userContent = promptDef.user({
    content,
    imageInfo,
    count,
    ...distribution,
  })

  // 5. 调用 AI（Stage 1：生成）
  const provider = getProvider()
  const useStructured = supportsStructuredOutput(provider)

  console.log(`[AI 出题] 类型=${detectedType}，出题${count}道，难度=${difficulty}/5，结构化=${useStructured}`)

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ]

  let raw
  try {
    if (useStructured) {
      raw = await callAIStructured(messages)
    } else {
      raw = await callAI(messages)
    }
  } catch (err) {
    console.error(`[AI 出题] Stage 1 调用失败:`, err.message)
    throw err
  }

  // 6. Stage 1：解析 + 校验
  let { questions, validation } = parseWithValidation(raw, { count, questionTypes })
  let repairAttempted = false

  if (!validation.valid) {
    // 6b. Stage 2：修复
    console.log(`[AI 出题] Stage 1 校验未通过，进入 Stage 2 修复`)

    const failedResults = validation.results.filter(r => !r.ok)
    repairAttempted = true

    try {
      const repairRaw = await callAIForRepair(raw, failedResults, {
        count,
        questionTypes,
        difficulty,
        content,
        detectedType,
      })

      // 再次解析 + 校验
      const repairResult = parseWithValidation(repairRaw, { count, questionTypes })
      if (repairResult.validation.valid) {
        questions = repairResult.questions
        validation = repairResult.validation
        console.log(`[AI 出题] Stage 2 修复成功`)
      } else {
        console.log(`[AI 出题] Stage 2 修复仍失败，使用原始结果（降级）`)
        // 降级：原始结果 + 标记 hasErrors
      }
    } catch (repairErr) {
      console.error(`[AI 出题] Stage 2 修复异常:`, repairErr.message)
      // 降级：使用原始结果
    }
  }

  // 7. 补充字段 + 日志
  questions = normalizeQuestions(questions, detectedType)

  // 构建校验摘要
  const totalChecks = validation.results.length
  const passedChecks = validation.results.filter(r => r.ok).length
  const validationSummary = `${passedChecks}/${totalChecks} 题通过校验`

  const hasErrors = !validation.valid || questions.length === 0

  console.log(`[AI 出题] 完成: ${questions.length} 道题, ${validationSummary}, 修复=${repairAttempted}, 降级=${hasErrors}`)

  return {
    questions,
    hasErrors,
    repairAttempted,
    validationSummary,
    metadata: {
      docType: detectedType,
      count: questions.length,
      model: getQuestionModel(),
      distribution,
      difficulty,
      usedStructuredOutput: useStructured,
    },
  }
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

function buildImageInfo(images, override) {
  if (images.length === 0) return '（无图片，纯文字内容）'

  const lines = ['以下是与通报相关的违章现场图片：']
  images.forEach((img, i) => {
    const name = img.filename || img.name || `图片${i + 1}`
    const desc = override[name] || img.description || ''
    lines.push(`${i + 1}. ${name}${desc ? ' — ' + desc : ''}`)
  })
  return lines.join('\n')
}

function calcDistribution(docType, total) {
  if (docType === 'video_report') {
    // 视频督查通报：多选 + 简答
    const mcCount = Math.max(1, Math.round(total * 0.4))
    const shortCount = total - mcCount
    return { scCount: 0, mcCount, judgeCount: 0, shortCount, fillCount: 0 }
  } else if (docType === 'image_violation') {
    // 违章图片识别：单选 + 多选 + 判断 + 填空
    const scCount = Math.max(1, Math.round(total * 0.3))
    const mcCount = Math.max(1, Math.round(total * 0.3))
    const fillCount = Math.max(1, Math.round(total * 0.1))
    const judgeCount = total - scCount - mcCount - fillCount
    return { scCount, mcCount, judgeCount, shortCount: 0, fillCount }
  } else {
    // 制度通知：单选 + 多选 + 判断
    const scCount = Math.round(total * 0.5)
    const mcCount = Math.round(total * 0.3)
    const judgeCount = total - scCount - mcCount
    return { scCount, mcCount, judgeCount, shortCount: 0, fillCount: 0 }
  }
}

/**
 * 根据 questionTypes 字符串解析题型分布
 * @param {string} qt  如 '单选题' 或 '单选+多选+判断+简答'
 * @param {number} total 总题数
 */
function parseQuestionTypes(qt, total) {
  const t = qt || ''
  const parts = t.split('+').map(s => s.trim())
  const hasSingle = parts.includes('单选题') || parts.includes('单选')
  const hasMulti  = parts.includes('多选题')  || parts.includes('多选')
  const hasJudge  = parts.includes('判断题')  || parts.includes('判断')
  const hasShort  = parts.includes('简答题')  || parts.includes('简答')

  const nonShortCount = [hasSingle, hasMulti, hasJudge].filter(Boolean).length
  const shortCount = hasShort ? Math.max(1, Math.round(total * 0.2)) : 0
  const mainCount = total - shortCount

  let scCount = 0, mcCount = 0, judgeCount = 0
  if (nonShortCount === 0) {
    scCount = mainCount
  } else if (nonShortCount === 1) {
    if (hasSingle) scCount = mainCount
    else if (hasMulti) mcCount = mainCount
    else if (hasJudge) judgeCount = mainCount
  } else {
    if (hasSingle) scCount = Math.round(mainCount * 0.5)
    if (hasMulti)  mcCount = Math.round(mainCount * 0.3)
    if (hasJudge)  judgeCount = mainCount - scCount - mcCount
  }

  return { scCount, mcCount, judgeCount, shortCount }
}

/**
 * 保存题目到 JSON 文件（开发调试用）
 */
async function saveToFile(questions, outPath) {
  const fs = require('fs')
  const dir = require('path').dirname(outPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(questions, null, 2), 'utf-8')
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Vision 多模态图片出题（新增）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 调用支持Vision的AI API（发送图片base64）
 * OpenAI兼容格式
 */
async function callAIVision({ textPrompt, imageBuffers, maxTokens = 4000 }) {
  const provider = getProvider()
  const apiKey = getApiKey()
  const model = getVisionModel()

  if (!model) {
    throw new Error('当前AI Provider未配置Vision模型，请在后台设置支持图片理解的模型（如Qwen2-VL或GPT-4o）')
  }

  // 构建消息内容：文字 + 图片
  const content = [{ type: 'text', text: textPrompt }]

  for (const buffer of imageBuffers) {
    const base64 = buffer.toString('base64')
    const mime = detectMimeFromBuffer(buffer)
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${mime};base64,${base64}`,
        detail: 'high',
      },
    })
  }

  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: maxTokens,
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
    throw new Error(`Vision API 错误 [${response.status}]: ${err.error?.message || response.statusText}`)
  }

  const result = await response.json()
  return extractContentFromResult(result)
}

/**
 * 检测图片MIME类型（简单版）
 */
function detectMimeFromBuffer(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
  return 'image/jpeg'
}

/**
 * 生成图片违章识别题（主入口）
 *
 * @param {Object} params
 * @param {string} params.content     通报文字内容
 * @param {Array}  params.images      图片buffer数组 [{buffer, filename}]
 * @param {number} params.count       出题数量（默认15）
 *
 * @returns {Object} { questions, metadata }
 */
async function generateImageQuestions({ content, images = [], count = 15 }) {
  if (!supportsVision()) {
    throw new Error('当前AI配置不支持Vision模型，无法生成图片题。请先在后台配置支持图片理解的模型。')
  }

  const distribution = calcDistribution('image_violation', count)

  // 构建图片信息描述
  const imageInfoLines = ['以下是与通报相关的违章现场图片：']
  const imageIndexInfoLines = []
  images.forEach((img, i) => {
    imageInfoLines.push(`${i + 1}. ${img.filename}`)
    imageIndexInfoLines.push(`  image_index=${i} → ${img.filename}`)
  })

  const promptDef = PROMPTS.image_violation
  const userContent = promptDef.user({
    content,
    imageInfo: imageInfoLines.join('\n'),
    imageIndexInfo: imageIndexInfoLines.join('\n'),
    count,
    ...distribution,
  })

  console.log(`[AI图片出题] 图片${images.length}张，出题${count}道，使用Vision模型=${getVisionModel()}`)

  // 调用Vision API（发送文字+所有图片）
  const raw = await callAIVision({
    textPrompt: userContent,
    imageBuffers: images.map(img => img.buffer),
    maxTokens: 4000,
  })

  // 解析结果
  let questions = parseJSONResponse(raw)
  if (!Array.isArray(questions)) questions = [questions]

  // 补充字段 + 图片URL占位（后续由调用方替换为COS URL）
  questions.forEach((q, i) => {
    if (!q.id) q.id = i + 1
    if (!q.type) q.type = 'single'
    if (!q.theme) q.theme = '违章图片识别'
    // image_index 标识使用第几张图片
    if (q.image_index === undefined) q.image_index = 0
    // 确保image_index在有效范围内
    if (q.image_index >= images.length) q.image_index = 0
  })

  console.log(`[AI图片出题] 成功生成 ${questions.length} 道题`)

  return {
    questions,
    metadata: {
      docType: 'image_violation',
      count: questions.length,
      model: getVisionModel(),
      distribution,
      imageCount: images.length,
    },
  }
}

module.exports = {
  generateQuestions,
  generateImageQuestions,
  classifyDocument,
  saveToFile,
  callAI,
  callAIVision,
  parseJSONResponse,
  // 新增导出
  validateQuestions,
  parseWithValidation,
  callAIForRepair,
}
