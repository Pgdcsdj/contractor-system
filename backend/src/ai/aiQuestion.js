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

/**
 * 质量标注要求（所有题型通用）
 *
 * 追加到每个出题 Prompt 的尾部，要求模型在生成题目的同时产出 4 个标注字段，
 * 供「出题质量量化校验」模块做一致性校验、覆盖率统计与质量打分。
 *
 * 该段落是纯增量要求：即使模型忽略这些字段，normalizeQuestions() 也会补齐
 * 安全默认值，不会影响既有出题链路。
 */
const ANNOTATION_REQUIREMENT = `
## 质量标注要求（每道题都必须附带，不可省略）
除题目本身字段外，每道题的 JSON 对象还必须额外包含以下 4 个标注字段：

1. "difficulty"：整数 1-5，该题的实际难度
   - 1-2 = 基础识记（原文关键词、条款复现）
   - 3   = 中等理解（概念辨析、条款匹配）
   - 4-5 = 深入应用（综合分析、多条款交叉、场景决策）

2. "bloom_level"：字符串，只能取以下三个值之一（严格使用中文）
   - "识记"：考察记住原文事实、数字、条款名称
   - "理解"：考察解释含义、辨析概念、判断正误
   - "应用"：考察在具体场景中运用规定解决问题

3. "knowledge_points"：字符串数组，该题考察的知识点标签，2-4 个
   - 用简短名词短语，如 ["高处作业防护", "安全带使用规范"]
   - 不要使用整句话，不要重复题干原文

4. "source_keypoints"：字符串数组，该题在源文档中的直接依据，1-3 条
   - 必须是源文档中真实出现的原文片段或条款要点的凝练
   - 每条不超过 40 字，不得编造源文档中不存在的内容

示例（在原有字段基础上追加）：
  "difficulty": 3,
  "bloom_level": "理解",
  "knowledge_points": ["动火作业审批", "作业票管理"],
  "source_keypoints": ["特级动火作业须由厂级安全部门审批"]
`

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
${ANNOTATION_REQUIREMENT}
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
${ANNOTATION_REQUIREMENT}
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

## 每道题的图片标注说明（非常重要）
每道题必须包含 "image_filenames" 字段，值为该题涉及图片的【文件名数组】。
文件名必须与下方清单**逐字一致**，不得编造、改写、翻译或用序号代替：
${vars.imageFileInfo || vars.imageIndexInfo || '（无可用图片，请勿输出 image_filenames）'}

规则：
- 只涉及一张图片时：{"image_filenames": ["清单中的文件名"]}
- 涉及多张图片时：{"image_filenames": ["文件名1", "文件名2"]}
- 禁止输出 image_index 字段，禁止输出清单之外的文件名

## JSON格式（严格，数组最外层）
[
  {
    "id": 1,
    "type": "single",
    "image_filenames": ["image1.png"],
    "question": "根据图片场景，一名作业人员在未搭设脚手架的情况下直接攀爬钢结构立柱进行焊接。该行为最直接违反了以下哪项？",
    "options": {"A": "《高处作业安全管理规定》...","B": "《焊接安全规程》...","C": "《劳动防护用品管理制度》...","D": "《钢结构施工规范》..."},
    "answer": "A",
    "explanation": "图片核心违章是未使用合规作业平台进行高处焊接..."
  },
  {
    "id": 2,
    "type": "multiple",
    "image_filenames": ["image1.png"],
    "question": "根据图片，该作业面存在哪些隐患或违章？",
    "options": {"A": "...","B": "...","C": "...","D": "...","E": "..."},
    "answer": "ABC",
    "explanation": "D、E在图中无法判断或未体现..."
  },
  {
    "id": 3,
    "type": "judgment",
    "image_filenames": ["image2.png"],
    "question": "图中作业人员未系安全带进行5米高度作业，直接违反了'严禁高处作业不系安全带'的保命条款。",
    "answer": "正确",
    "explanation": "该保命条款为各行业通用强制性规定..."
  },
  {
    "id": 4,
    "type": "fill",
    "image_filenames": ["image3.png"],
    "question": "图中氧气瓶与乙炔瓶并排放置，两者间距不足______米，不符合国标要求。",
    "answer": "5",
    "explanation": "GB 9448规定两者间距不小于5米..."
  }
]
${ANNOTATION_REQUIREMENT}
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

  // Moonshot / Kimi 系列模型对 temperature 敏感，仅允许固定值 0.6（API 强制，否则 400）。
  // 同时关闭思考，避免 reasoning_content 兜底成散文导致解析失败。
  const isMoonshot = provider.id === 'moonshot' || /moonshot/i.test(provider.name || '')
  const isKimiModel = /kimi/i.test(model)
  if (isMoonshot || isKimiModel) {
    body.temperature = 0.6
    body.thinking = { type: 'disabled' }
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

  // Moonshot/Kimi 是推理模型，默认先输出思维链(reasoning_content)，
  // 会耗尽 token 且让 content 为空 → extractContentFromResult 回退到散文导致解析失败。
  // 关闭思考让其直接输出 JSON（文字出题同样受益）。
  if (provider && provider.id === 'moonshot') {
    body.thinking = { type: 'disabled' }
  }

  // SiliconFlow 的 DeepSeek-R1 是推理模型，不需要 temperature
  if (model.includes('R1') || model.includes('reasoner')) {
    delete body.temperature
  }

  // Moonshot / Kimi 系列模型对 temperature 敏感，仅允许固定值 0.6（API 强制，否则 400）。
  const isMoonshot = provider.id === 'moonshot' || /moonshot/i.test(provider.name || '')
  const isKimiModel = /kimi/i.test(model)
  if (isMoonshot || isKimiModel) {
    body.temperature = 0.6
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

/** 无需 options 选项的题型（判断/填空/简答） */
const OPTIONLESS_TYPES = ['judgment', 'fill', 'short_answer', 'short_answer_image']

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
    // 防御：模型偶发返回 null / 字符串 / 嵌套数组，直接判不合格，避免抛异常打断整单
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      return { index, ok: false, errors: [`题 ${index + 1} 不是有效的题目对象`] }
    }

    const errors = []
    const qtype = q.type || ''
    // 判断题 / 填空题 / 简答题天然没有选项，不应因缺少 options 被判为不合格
    const optionless = OPTIONLESS_TYPES.includes(qtype)

    // 1. 必须有 question 字符串且非空
    if (!q.question || typeof q.question !== 'string' || q.question.trim() === '') {
      errors.push(`题 ${index + 1} 缺少 question 字段或为空`)
    }

    // 2. 选项校验（仅对需要选项的题型）
    const hasOptionsObj = !!q.options && typeof q.options === 'object' && !Array.isArray(q.options)
    const optionKeys = hasOptionsObj ? Object.keys(q.options) : []

    if (!optionless) {
      if (!hasOptionsObj) {
        errors.push(`题 ${index + 1} 缺少有效的 options 对象`)
      } else if (optionKeys.length < 2) {
        errors.push(`题 ${index + 1} options 至少需要 2 个选项，当前 ${optionKeys.length} 个`)
      }
    }

    // 3. 必须有 answer 且非空（答案可能是数字/布尔，统一转字符串判断）
    const answerStr = q.answer === undefined || q.answer === null ? '' : String(q.answer).trim()
    if (answerStr === '') {
      errors.push(`题 ${index + 1} 缺少 answer 字段或为空`)
    } else if (qtype === 'multiple' || qtype === 'multi' || qtype === 'multiple_image') {
      // 4a. 多选题：answer 每个字母都要在 options keys 中
      const letters = answerStr.split('').filter(c => /[A-Za-z]/.test(c))
      if (letters.length === 0) {
        errors.push(`题 ${index + 1} 多选题 answer "${answerStr}" 不含有效选项字母`)
      } else if (optionKeys.length > 0) {
        for (const letter of letters) {
          if (!optionKeys.includes(letter.toUpperCase()) && !optionKeys.includes(letter)) {
            errors.push(`题 ${index + 1} 多选题 answer 中的 "${letter}" 不在 options keys [${optionKeys.join(',')}] 中`)
          }
        }
      }
    } else if (qtype === 'judgment') {
      // 4b. 判断题：answer 应为 "正确" 或 "错误"
      if (answerStr !== '正确' && answerStr !== '错误' && answerStr !== 'true' && answerStr !== 'false') {
        errors.push(`题 ${index + 1} 判断题 answer 应为 "正确" 或 "错误"，当前 "${answerStr}"`)
      }
    } else if (qtype === 'fill' || qtype === 'short_answer' || qtype === 'short_answer_image') {
      // 4c. 填空题/简答题：answer 非空即可（上面已校验）
    } else if (optionKeys.length > 0) {
      // 4d. 单选题/默认：answer 必须是 options 中的某一个 key
      if (!optionKeys.includes(answerStr)) {
        errors.push(`题 ${index + 1} answer "${answerStr}" 不在 options keys [${optionKeys.join(',')}] 中`)
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

// ─── 质量标注字段归一化 ─────────────────────────────────────────────────────

/** Bloom 认知层级（三级） */
const BLOOM_LEVELS = ['识记', '理解', '应用']

/** Bloom 常见别名 → 标准值 */
const BLOOM_ALIAS = {
  记忆: '识记', 识记: '识记', 记住: '识记', remember: '识记', knowledge: '识记',
  理解: '理解', 领会: '理解', understand: '理解', comprehension: '理解',
  应用: '应用', 运用: '应用', apply: '应用', application: '应用',
  分析: '应用', 综合: '应用', 评价: '应用', analyze: '应用', evaluate: '应用', create: '应用',
}

/**
 * 归一化难度为 1-5 的整数
 * @param {*} v - 原始值
 * @param {number} fallback - 兜底值
 * @returns {number} 1-5
 */
function normalizeDifficulty(v, fallback = 3) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(5, Math.max(1, Math.round(n)))
}

/**
 * 归一化 Bloom 层级为三级枚举之一
 * @param {*} v - 原始值
 * @param {string} fallback - 兜底值
 * @returns {string} '识记' | '理解' | '应用'
 */
function normalizeBloomLevel(v, fallback = '理解') {
  if (!v) return fallback
  const s = String(v).trim()
  if (BLOOM_LEVELS.includes(s)) return s
  const hit = BLOOM_ALIAS[s] || BLOOM_ALIAS[s.toLowerCase()]
  if (hit) return hit
  // 模糊包含：如 "理解层次" / "Bloom-应用"
  for (const lv of BLOOM_LEVELS) {
    if (s.includes(lv)) return lv
  }
  return fallback
}

/**
 * 归一化为去重后的非空字符串数组
 * @param {*} v - 原始值（数组 / 逗号分隔字符串 / 其他）
 * @param {number} maxLen - 单项最大长度
 * @returns {string[]}
 */
function normalizeTagArray(v, maxLen = 100) {
  let arr = []
  if (Array.isArray(v)) {
    arr = v
  } else if (typeof v === 'string' && v.trim()) {
    arr = v.split(/[,，;；\n]/)
  } else {
    return []
  }
  const out = []
  for (const item of arr) {
    if (item === null || item === undefined) continue
    const s = String(typeof item === 'object' ? JSON.stringify(item) : item).trim()
    if (!s) continue
    const cut = s.length > maxLen ? s.slice(0, maxLen) : s
    if (!out.includes(cut)) out.push(cut)
  }
  return out
}

/**
 * 补充题目缺失字段，并兼容 options 的数组/对象两种格式
 */
function normalizeQuestions(questions, detectedType) {
  return questions.map((q, i) => {
    // 防御：非对象元素原样返回，交给 validateQuestions 判不合格后丢弃
    if (!q || typeof q !== 'object' || Array.isArray(q)) return q

    if (!q.id) q.id = i + 1
    if (!q.type) q.type = detectedType === 'video_report' ? 'multiple_image' : 'single'
    if (!q.theme) q.theme = '安全培训'

    // ── 质量标注字段：缺失时补安全默认值，保证下游落库与统计不为 null ──
    q.difficulty = normalizeDifficulty(q.difficulty, 3)
    q.bloom_level = normalizeBloomLevel(q.bloom_level ?? q.bloomLevel, '理解')
    q.knowledge_points = normalizeTagArray(q.knowledge_points ?? q.knowledgePoints, 100)
    q.source_keypoints = normalizeTagArray(q.source_keypoints ?? q.sourceKeypoints, 200)

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
    // 小题量（total<=2）时按 填空→多选→单选 的优先级退让，
    // 保证各题型非负且 scCount + mcCount + judgeCount + fillCount === total
    const t = Math.max(1, Number(total) || 1)
    let scCount = Math.max(1, Math.round(t * 0.3))
    let mcCount = Math.max(1, Math.round(t * 0.3))
    let fillCount = Math.max(1, Math.round(t * 0.1))
    while (scCount + mcCount + fillCount > t) {
      if (fillCount > 0) fillCount--
      else if (mcCount > 1) mcCount--
      else if (scCount > 1) scCount--
      else if (mcCount > 0) mcCount--  // t===1：放弃多选保底，确保总和精确等于 total
      else break
    }
    const judgeCount = Math.max(0, t - scCount - mcCount - fillCount)
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
 * 构建 Vision 用户消息的 content 数组（文字 + 图片 base64）
 * @param {string} textPrompt        文字提示
 * @param {Array<Buffer>} imageBuffers 图片 Buffer 数组
 * @returns {Array<Object>} OpenAI 兼容的多模态 content 数组
 */
function buildVisionContent(textPrompt, imageBuffers = []) {
  const content = []
  if (textPrompt && String(textPrompt).trim() !== '') {
    content.push({ type: 'text', text: String(textPrompt) })
  }

  for (const buffer of imageBuffers) {
    if (!buffer || typeof buffer.toString !== 'function') continue
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

  return content
}

/**
 * 调用支持Vision的AI API（发送图片base64），OpenAI 兼容格式
 *
 * 支持三种调用姿势（向后兼容）：
 *  1. 旧版：callAIVision({ textPrompt, imageBuffers })                 → 单条 user 消息
 *  2. 带系统提示：callAIVision({ system, textPrompt, imageBuffers })   → system + user 两条消息
 *  3. 完全自定义：callAIVision({ messages, imageBuffers })             → 直接使用 messages，
 *     若同时传 imageBuffers，则把图片追加到最后一条 user 消息里
 *
 * @param {Object} params
 * @param {string} [params.textPrompt='']   用户文字提示
 * @param {string} [params.system='']       系统提示词（system message）
 * @param {Array}  [params.imageBuffers=[]] 图片 Buffer 数组
 * @param {Array}  [params.messages=null]   自定义消息数组（优先级最高）
 * @param {number} [params.maxTokens=4000]  最大 token 数
 * @returns {Promise<string>} 模型返回的文本
 */
async function callAIVision({ textPrompt = '', system = '', imageBuffers = [], messages = null, maxTokens = 4000 }) {
  const provider = getProvider()
  const apiKey = getApiKey()
  const model = getVisionModel()

  if (!model) {
    throw new Error('当前AI Provider未配置Vision模型，请在后台设置支持图片理解的模型（如 THUDM/GLM-4.5V 或 GPT-4o）')
  }

  const buffers = Array.isArray(imageBuffers) ? imageBuffers.filter(Boolean) : []
  let finalMessages = []

  if (Array.isArray(messages) && messages.length > 0) {
    // 姿势 3：使用调用方给定的 messages，必要时把图片挂到最后一条 user 消息
    finalMessages = messages.map(m => ({ ...m }))
    if (buffers.length > 0) {
      let lastUserIdx = -1
      for (let i = finalMessages.length - 1; i >= 0; i--) {
        if (finalMessages[i].role === 'user') { lastUserIdx = i; break }
      }
      if (lastUserIdx === -1) {
        finalMessages.push({ role: 'user', content: buildVisionContent('', buffers) })
      } else {
        const existing = finalMessages[lastUserIdx].content
        const parts = Array.isArray(existing)
          ? existing.slice()
          : buildVisionContent(typeof existing === 'string' ? existing : '', [])
        finalMessages[lastUserIdx] = {
          ...finalMessages[lastUserIdx],
          content: parts.concat(buildVisionContent('', buffers)),
        }
      }
    }
  } else {
    // 姿势 1 / 2：system（可选）+ 单条多模态 user 消息
    if (system && String(system).trim() !== '') {
      finalMessages.push({ role: 'system', content: String(system) })
    }
    finalMessages.push({ role: 'user', content: buildVisionContent(textPrompt, buffers) })
  }

  const body = {
    model,
    messages: finalMessages,
    max_tokens: maxTokens,
  }

  // 结构化输出：当 provider 支持 response_format 时强制要求 JSON 数组。
  // 否则视觉模型（如 GLM-4.5V / GPT-4o）可能返回散文，导致 JSON.parse 失败、
  // 图片题出题直接失败。仅在不支持时才省略，避免部分厂商报错。
  if (supportsStructuredOutput(provider)) {
    body.response_format = { type: 'json_object' }
  }

  // Moonshot/Kimi 推理模型默认先输出思维链(reasoning_content)，图片题多图场景下
  // token 会被思考耗尽、最终 content 为空，extractContentFromResult 回退到散文→解析失败。
  // 显式关闭思考，直接输出 JSON。
  if (provider && provider.id === 'moonshot') {
    body.thinking = { type: 'disabled' }
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

// ─── 图片题：文件名反查与绑定 ───────────────────────────────────────────────

/**
 * 归一化文件名，便于反查匹配：
 * 去目录、去首尾空白、统一小写、去掉常见的中文引号/尖括号包裹
 * @param {*} name
 * @returns {string}
 */
function normalizeFilenameKey(name) {
  if (name === undefined || name === null) return ''
  let s = String(name).trim()
  if (s === '') return ''
  s = s.replace(/\\/g, '/')
  const segs = s.split('/')
  s = segs[segs.length - 1]
  s = s.replace(/^["'“”‘’《〈<\[(]+/, '').replace(/["'“”‘’》〉>\])]+$/, '')
  return s.trim().toLowerCase()
}

/**
 * 从题目对象中提取模型声明的图片文件名列表（兼容多种字段名）
 * @param {Object} q
 * @returns {string[]}
 */
function extractDeclaredFilenames(q) {
  const candidates = [
    q.image_filenames, q.imageFilenames, q.image_files,
    q.images, q.image_filename, q.filename, q.image,
  ]

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const names = c
        .map(item => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') return item.filename || item.name || item.url || ''
          return ''
        })
        .filter(s => String(s).trim() !== '')
      if (names.length > 0) return names
    } else if (typeof c === 'string' && c.trim() !== '') {
      return [c.trim()]
    }
  }
  return []
}

/**
 * 按文件名把题目和真实图片绑定起来，填充 image_url / image_index。
 *
 * 降级策略（与方案 A 一致）：
 *  - 单图题（模型只给了 0~1 个文件名）反查失败 → 默认绑定第一张图
 *  - 多图题（模型给了多个文件名）→ 去掉不存在的文件名，至少保留一张有效图
 *  - 一张都匹配不上且没有可用图片 → 降级为纯文字题（image_url = null）
 *
 * @param {Array} questions 题目数组
 * @param {Array} images    图片数组 [{buffer, filename, url}]
 * @returns {{ questions: Array, degradedCount: number, missCount: number }}
 */
function attachImagesByFilename(questions, images = []) {
  // 建立 文件名 → 下标 索引
  const indexByName = new Map()
  images.forEach((img, idx) => {
    const key = normalizeFilenameKey(img && (img.filename || img.name))
    if (key && !indexByName.has(key)) indexByName.set(key, idx)
  })

  let degradedCount = 0
  let missCount = 0

  const bound = questions.map(q => {
    const declared = extractDeclaredFilenames(q)
    const matched = []

    for (const name of declared) {
      const key = normalizeFilenameKey(name)
      if (!key) continue

      let idx = indexByName.has(key) ? indexByName.get(key) : -1
      if (idx < 0) {
        // 二次模糊匹配：允许模型少写/多写扩展名或前缀
        idx = images.findIndex(img => {
          const k = normalizeFilenameKey(img && (img.filename || img.name))
          return !!k && (k === key || k.includes(key) || key.includes(k))
        })
      }
      if (idx >= 0 && !matched.includes(idx)) matched.push(idx)
      else if (idx < 0) missCount++
    }

    const isMultiImage = declared.length > 1
    let finalIdx = matched.slice()

    if (finalIdx.length === 0) {
      if (!isMultiImage && images.length > 0) {
        // 单图题反查失败 → 兜底绑定第一张图
        finalIdx = [0]
      } else {
        // 多图题全部找不到 / 完全没有图片 → 降级为纯文字题
        finalIdx = []
      }
    }

    if (finalIdx.length === 0) {
      degradedCount++
      q.image_index = null
      q.image_url = null
      q.image_urls = []
      q.image_filenames = []
      q.image_degraded = true
      return q
    }

    const primary = images[finalIdx[0]] || {}
    q.image_index = finalIdx[0]
    q.image_indexes = finalIdx
    q.image_url = primary.url || primary.image_url || null
    q.image_urls = finalIdx.map(i => (images[i] && (images[i].url || images[i].image_url)) || null).filter(Boolean)
    q.image_filenames = finalIdx.map(i => (images[i] && (images[i].filename || images[i].name)) || '').filter(Boolean)
    q.image_degraded = false
    return q
  })

  return { questions: bound, degradedCount, missCount }
}

// ─── 图片题日志落库 ─────────────────────────────────────────────────────────

/** 单字段长度上限，避免超长文本撑爆日志表 */
const LOG_RAW_MAX_LEN = 60000
const LOG_ERR_MAX_LEN = 4000

/** TINYINT UNSIGNED 上限 */
function clampTinyInt(n) {
  const v = Number(n) || 0
  if (v < 0) return 0
  return v > 255 ? 255 : Math.floor(v)
}

/**
 * 写入 AI 出题日志表 t_ai_question_log。
 * 写日志失败绝不影响主流程（内部已 try/catch）。
 *
 * @param {Object} record
 * @returns {Promise<void>}
 */
async function logImageQuestionRun(record = {}) {
  try {
    // 延迟加载，避免测试/无数据库环境下模块加载即创建连接池
    const { pool } = require('../db/db')

    const rawResponse = String(record.rawResponse || '').slice(0, LOG_RAW_MAX_LEN)
    const parseError = String(record.parseError || '').slice(0, LOG_ERR_MAX_LEN)

    await pool.execute(
      `INSERT INTO t_ai_question_log
        (material_id, doc_type, provider, vision_model, text_model,
         image_count, question_count, raw_response, parse_error, fallback_used, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(record.materialId) || 0,
        String(record.docType || 'image_violation').slice(0, 30),
        String(record.provider || '').slice(0, 30),
        String(record.visionModel || '').slice(0, 80),
        String(record.textModel || '').slice(0, 80),
        clampTinyInt(record.imageCount),
        clampTinyInt(record.questionCount),
        rawResponse,
        parseError,
        record.fallbackUsed ? 1 : 0,
        Math.max(0, Number(record.durationMs) || 0),
      ]
    )
  } catch (err) {
    console.warn('[AI图片出题] 日志写入失败（已忽略，不影响出题）:', err.message)
  }
}

// ─── 测试注入钩子（仅供本地测试脚本使用，生产环境全部为 null）─────────────

const __hooks = {
  callAIVision: null,
  callAIForRepair: null,
  generateQuestions: null,
  supportsVision: null,
  logRun: null,
}

/**
 * 注入测试桩（不传的字段保持原值）
 * @param {Object} hooks
 */
function __setTestHooks(hooks = {}) {
  for (const key of Object.keys(hooks)) {
    if (key in __hooks) __hooks[key] = hooks[key]
  }
}

/** 清空所有测试桩 */
function __resetTestHooks() {
  for (const key of Object.keys(__hooks)) __hooks[key] = null
}

/** 安全取值：内部 getter 抛错时返回兜底值 */
function safeGet(fn, fallback = '') {
  try {
    const v = fn()
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

/**
 * 生成图片违章识别题（主入口，两阶段流水线 + 文件名反查 + 降级 + 日志）
 *
 * 处理流程：
 *  1. 组装 system（角色设定 + 难度）与 user（通报文字 + 图片清单 + JSON 规范）提示词
 *  2. 调用 Vision 模型（system + user 两条消息）
 *  3. Stage 1：parseWithValidation 解析 + 质量校验
 *  4. Stage 2：校验不过则调用 callAIForRepair 修复一轮，取有效题更多的一方
 *  5. 丢弃仍不合格的题目（droppedCount），按 image_filenames 反查绑定图片
 *  6. 若一道有效题都没有 → 降级为纯文字题（generateQuestions / policy_notice）
 *  7. 全流程耗时、原始返回、错误信息写入 t_ai_question_log
 *
 * @param {Object} params
 * @param {string} params.content            通报文字内容
 * @param {Array}  params.images             图片数组 [{buffer, filename, url}]
 * @param {number} [params.count=15]         出题数量
 * @param {number} [params.difficulty=3]     难度 1-5
 * @param {string} [params.questionTypes]    期望题型，如 '单选+多选+判断+填空'
 * @param {number} [params.materialId=0]     素材ID（仅用于日志）
 *
 * @returns {Promise<Object>} { questions, fallbackUsed, droppedCount, repairAttempted, hasErrors, validationSummary, metadata }
 */
async function generateImageQuestions({
  content = '',
  images = [],
  count = 15,
  difficulty = 3,
  questionTypes = null,
  materialId = 0,
}) {
  const startedAt = Date.now()

  const visionSupportedFn = __hooks.supportsVision || supportsVision
  if (!visionSupportedFn()) {
    throw new Error('当前AI配置不支持Vision模型，无法生成图片题。请先在后台配置支持图片理解的模型。')
  }

  const visionFn = __hooks.callAIVision || callAIVision
  const repairFn = __hooks.callAIForRepair || callAIForRepair
  const textGenFn = __hooks.generateQuestions || generateQuestions
  const logFn = __hooks.logRun || logImageQuestionRun

  const visionModel = safeGet(getVisionModel, '')
  const textModel = safeGet(getQuestionModel, '')
  const providerId = safeGet(() => getProvider().id, '')

  const distribution = calcDistribution('image_violation', count)

  // ── 1. 组装提示词（按批次，避免单次塞入过多图片导致模型思考 token 耗尽 / 请求体过大）──
  const VISION_BATCH_SIZE = 10
  const batches = []
  if (images.length === 0) {
    // 无图场景：仍走一次 vision（无图），让模型基于通报文字出题
    batches.push([])
  } else {
    for (let i = 0; i < images.length; i += VISION_BATCH_SIZE) {
      batches.push(images.slice(i, i + VISION_BATCH_SIZE))
    }
  }
  // 将目标题数尽量均匀分配到各批次
  const batchCounts = []
  if (batches.length === 0) {
    batchCounts.push(count)
  } else {
    const per = Math.floor(count / batches.length)
    let rem = count % batches.length
    for (let b = 0; b < batches.length; b++) {
      batchCounts.push(Math.max(1, per + (rem > 0 ? 1 : 0)))
      if (rem > 0) rem--
    }
  }

  const promptDef = PROMPTS.image_violation
  const systemContent = promptDef.system + buildDifficultyPrompt(difficulty)

  console.log(`[AI图片出题] 图片${images.length}张，分${batches.length}批（每批≤${VISION_BATCH_SIZE}），目标${count}道，难度=${difficulty}/5，Vision模型=${visionModel}`)

  // ── 2. 逐批调用 Vision + 解析 + 校验 + 修复 + 保留有效题 ──
  const parseErrors = []
  let raw = ''
  let repairRaw = ''
  let repairAttempted = false
  let fallbackUsed = false
  let droppedCount = 0
  let degradedCount = 0
  let questions = []
  let validationSummary = '未生成有效题目'
  let totalKept = 0
  let totalParsed = 0

  for (let bi = 0; bi < batches.length; bi++) {
    const batchImgs = batches[bi]
    const batchCount = batchCounts[bi]
    const dist = calcDistribution('image_violation', batchCount)

    const imageInfoLines = batchImgs.length > 0
      ? ['以下是本批与通报相关的违章现场图片（顺序与本次随消息发送的图片一致）：']
      : ['（本次未提供图片）']
    const imageFileInfoLines = []
    batchImgs.forEach((img, i) => {
      const name = (img && (img.filename || img.name)) || `image_${i + 1}`
      imageInfoLines.push(`${i + 1}. ${name}`)
      imageFileInfoLines.push(`  - "${name}"`)
    })
    const userContent = promptDef.user({
      content,
      imageInfo: imageInfoLines.join('\n'),
      imageFileInfo: imageFileInfoLines.join('\n'),
      count: batchCount,
      ...dist,
    })

    let batchRaw = ''
    try {
      batchRaw = await visionFn({
        system: systemContent,
        textPrompt: userContent,
        imageBuffers: batchImgs.map(img => img && img.buffer).filter(Boolean),
        maxTokens: 6000,
      })
    } catch (err) {
      parseErrors.push(`批次${bi + 1} Vision 调用失败：${err.message}`)
      console.error(`[AI图片出题] 批次${bi + 1} Vision 调用失败:`, err.message)
      continue
    }
    if (!batchRaw || String(batchRaw).trim() === '') continue
    raw += (raw ? '\n\n' : '') + `[BATCH ${bi + 1} / ${batches.length}]\n` + batchRaw

    // 解析 + 校验 + 最多一轮修复
    const stage1 = parseWithValidation(batchRaw, { count: batchCount, questionTypes })
    let picked = stage1
    const hasInvalidQuestion = stage1.validation.results.some(r => !r.ok)
    const parsedNothing = stage1.questions.length === 0
    if (hasInvalidQuestion || parsedNothing) {
      const failed = stage1.validation.results.filter(r => !r.ok)
      const stage1Errs = failed.reduce((acc, r) => acc.concat(r.errors), [])
        .concat(stage1.validation.countErrors || [])
      parseErrors.push(`批次${bi + 1} Stage1 校验未通过：${stage1Errs.join('；')}`)
      repairAttempted = true
      try {
        const bRepair = await repairFn(batchRaw, failed, {
          count: batchCount, questionTypes, difficulty, content, detectedType: 'image_violation',
        })
        repairRaw += (repairRaw ? '\n\n' : '') + `[BATCH ${bi + 1} REPAIR]\n` + bRepair
        const stage2 = parseWithValidation(bRepair, { count: batchCount, questionTypes })
        const okCount = res => res.validation.results.filter(r => r.ok).length
        if (okCount(stage2) >= okCount(stage1)) picked = stage2
      } catch (repairErr) {
        parseErrors.push(`批次${bi + 1} Stage2 修复异常：${repairErr.message}`)
      }
    }

    // 丢弃仍不合格的题目，保留有效题并按文件名绑定本批图片
    const kept = picked.questions.filter((q, i) => picked.validation.results[i] && picked.validation.results[i].ok)
    droppedCount += picked.questions.length - kept.length
    totalParsed += picked.questions.length
    totalKept += kept.length
    if (kept.length > 0) {
      const attachResult = attachImagesByFilename(kept, batchImgs)
      degradedCount += attachResult.degradedCount
      const batchQuestions = attachResult.questions
      batchQuestions.forEach((q, i) => {
        if (!q.id) q.id = questions.length + i + 1
        if (!q.type) q.type = 'single'
        if (!q.theme) q.theme = '违章图片识别'
      })
      questions = questions.concat(batchQuestions)
      if (attachResult.missCount > 0 || attachResult.degradedCount > 0) {
        console.warn(`[AI图片出题] 批次${bi + 1} 文件名反查：${attachResult.missCount} 个未命中，${attachResult.degradedCount} 道降级纯文字`)
      }
    }
  }

  if (totalParsed > 0) {
    validationSummary = `${totalKept}/${totalParsed} 题通过校验`
  }

  // ── 6. 一道有效题都没有 → 降级为纯文字题 ────────────────────
  if (questions.length === 0) {
    console.warn('[AI图片出题] 未产出任何有效图片题，降级为纯文字出题（基于通报文字）')
    try {
      const fb = await textGenFn({
        content,
        count,
        docType: 'policy_notice',
        difficulty,
      })
      const fbQuestions = (fb && fb.questions) || []
      if (fbQuestions.length > 0) {
        fallbackUsed = true
        questions = fbQuestions.map((q, i) => {
          if (!q.id) q.id = i + 1
          if (!q.theme) q.theme = '违章通报（文字题）'
          q.image_index = null
          q.image_url = null
          q.image_urls = []
          q.image_filenames = []
          q.image_degraded = true
          return q
        })
        validationSummary = (fb && fb.validationSummary) || `${questions.length} 道纯文字题（降级）`
      } else {
        parseErrors.push('降级出题未产出题目')
      }
    } catch (fbErr) {
      parseErrors.push(`降级出题失败：${fbErr.message}`)
      console.error('[AI图片出题] 降级出题失败:', fbErr.message)
    }
  }

  // ── 7. 日志落库（失败不影响主流程）────────────────────────
  const durationMs = Date.now() - startedAt
  const rawForLog = repairRaw
    ? `${raw}\n\n----- REPAIR RESPONSE -----\n${repairRaw}`
    : raw

  await logFn({
    materialId,
    docType: 'image_violation',
    provider: providerId,
    visionModel,
    textModel,
    imageCount: images.length,
    questionCount: questions.length,
    rawResponse: rawForLog,
    parseError: parseErrors.join(' | '),
    fallbackUsed,
    durationMs,
  })

  if (questions.length === 0) {
    throw new Error(`AI 图片出题失败，且纯文字降级也未产出题目：${parseErrors.join(' | ') || '未知原因'}`)
  }

  console.log(
    `[AI图片出题] 完成: ${questions.length} 道题，丢弃=${droppedCount}，降级为文字题=${fallbackUsed}，耗时=${durationMs}ms`
  )

  return {
    questions,
    fallbackUsed,
    droppedCount,
    repairAttempted,
    hasErrors: fallbackUsed || droppedCount > 0,
    validationSummary,
    metadata: {
      docType: fallbackUsed ? 'policy_notice' : 'image_violation',
      count: questions.length,
      model: visionModel,
      textModel,
      provider: providerId,
      distribution,
      difficulty,
      imageCount: images.length,
      fallbackUsed,
      droppedCount,
      degradedCount,
      durationMs,
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
  // 图片题相关工具（供路由/测试使用）
  attachImagesByFilename,
  logImageQuestionRun,
  // 质量标注字段归一化（供 material 路由 / qualityService 复用）
  BLOOM_LEVELS,
  normalizeDifficulty,
  normalizeBloomLevel,
  normalizeTagArray,
  normalizeQuestions,
  __setTestHooks,
  __resetTestHooks,
}
