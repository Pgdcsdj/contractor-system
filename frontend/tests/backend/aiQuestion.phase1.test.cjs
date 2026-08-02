/**
 * aiQuestion 阶段 1 回归测试
 *
 * 测试范围：
 * 1. validateQuestions 函数
 * 2. supportsStructuredOutput 函数（aiConfig 导出）
 * 3. parseWithValidation 函数
 * 4. 两阶段流水线集成测试（mock fetch）
 *
 * 运行方式：
 *   node tests/backend/aiQuestion.phase1.test.cjs
 *
 * 依赖：proxyquire（已安装）
 */
const path = require('path')
const proxyquire = require('proxyquire')

// ─── 路径常量 ────────────────────────────────────────────────────────────────
const BACKEND_AI_DIR = path.resolve(__dirname, '../../../backend/src/ai')
const AI_QUESTION_PATH = path.join(BACKEND_AI_DIR, 'aiQuestion.js')
const AI_CONFIG_PATH   = path.join(BACKEND_AI_DIR, 'aiConfig.js')

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock 定义
// ═══════════════════════════════════════════════════════════════════════════════

// ── aiConfig mock（供 aiQuestion 使用）────────────────────────────────
const mockProvider = {
  id: 'siliconflow',
  name: '硅基流动 (SiliconFlow)',
  baseUrl: 'https://api.siliconflow.cn/v1',
  supportsStructuredOutput: false,
  models: { chat: 'deepseek-ai/DeepSeek-V3' },
}

const mockAiConfig = {
  getProvider:       () => ({ ...mockProvider }),
  getApiKey:         () => 'mock-api-key-for-testing',
  getQuestionModel:  () => 'deepseek-ai/DeepSeek-V3',
  getVisionModel:    () => null,
  supportsVision:    () => false,
  supportsStructuredOutput: (provider) => {
    if (!provider) return false
    if (typeof provider === 'string') {
      return ['moonshot', 'deepseek', 'openai'].includes(provider)
    }
    return !!provider.supportsStructuredOutput
  },
  loadConfig: () => ({
    provider: 'siliconflow',
    questionConfig: { temperature: 0.3 },
    apiKeys: { siliconflow: 'mock-key' },
  }),
}

// ── Mock fs / path 让 proxyquire.noCallThru 可用 ────────────────────────
const mockFs = {
  existsSync:   () => false,
  mkdirSync:    () => {},
  writeFileSync:() => {},
  readFileSync: () => '{}',
}

// ═══════════════════════════════════════════════════════════════════════════════
//  加载被测模块
// ═══════════════════════════════════════════════════════════════════════════════

/** aiQuestion 模块（含 validateQuestions / parseWithValidation / generateQuestions 等） */
const aiQuestion = proxyquire.noCallThru()(AI_QUESTION_PATH, {
  './aiConfig': mockAiConfig,
  'fs':         mockFs,
  'path':       path,
})

/** aiConfig 模块（含 supportsStructuredOutput / PROVIDERS 等） */
const aiConfig = proxyquire.noCallThru()(AI_CONFIG_PATH, {
  'fs':   mockFs,
  'path': path,
})

// ─── 提取待测函数 ────────────────────────────────────────────────────────────
const { validateQuestions, parseWithValidation } = aiQuestion
const { supportsStructuredOutput } = aiConfig

// ═══════════════════════════════════════════════════════════════════════════════
//  测试辅助
// ═══════════════════════════════════════════════════════════════════════════════

let pass = 0
let fail = 0
const failures = []

function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; failures.push(name); console.log('  ✗', name) }
}

function heading(title) {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(70)}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. validateQuestions 函数测试
// ═══════════════════════════════════════════════════════════════════════════════
;(function testValidateQuestions() {
  heading('1. validateQuestions 函数')

  // ── 1.1 正常 3 道单选题 ───────────────────────────────────────────────
  const validQ = [
    { id: 1, type: 'single',  question: '安全生产方针是什么？',  options: { A: '安全第一', B: '预防为主', C: '综合治理', D: '全部都是' }, answer: 'D', explanation: 'test' },
    { id: 2, type: 'single',  question: '消防通道宽度至少？',    options: { A: '1米', B: '2米', C: '3米', D: '4米' }, answer: 'B', explanation: 'test' },
    { id: 3, type: 'single',  question: '安全带挂点高度？',      options: { A: '1.5米', B: '2米', C: '2.5米', D: '3米' }, answer: 'A', explanation: 'test' },
  ]
  let r = validateQuestions(validQ, { count: 3 })
  check('正常 3 道单选题 → valid=true',       r.valid === true)
  check('  每道题 ok',                        r.results.every(rr => rr.ok))

  // ── 1.2 多选题 answer 含不在 options 中的字母 ─────────────────────────
  r = validateQuestions([
    { id: 1, type: 'multiple', question: '哪些是安全色？', options: { A: '红色', B: '蓝色', C: '黄色' }, answer: 'ABCX', explanation: '安全色有红蓝黄绿' }
  ])
  check('多选题 answer 含不在 options 的字母 → 该题 ok=false',   !r.results[0].ok)
  check('  errors 包含「不在 options keys」',                    r.results[0].errors.some(e => e.includes('不在 options keys')))

  // ── 1.3 空数组 + count=3 → valid=false（数量不匹配）───────────────
  r = validateQuestions([], { count: 3 })
  check('空数组 + count=3 → valid=false（数量不符）',  r.valid === false)
  check('  空数组 results 为空',                     r.results.length === 0)
  check('  有 countErrors',                          r.countErrors.length > 0)

  // ── 1.3b 空数组 无 count → valid=true（无题=无错误）─────────────
  r = validateQuestions([])
  check('空数组 无 count → valid=true（空数组不触发校验错误）',  r.valid === true)

  // ── 1.4 缺 question 字段 ────────────────────────────────────────────
  r = validateQuestions([{ type: 'single', options: { A: 'a', B: 'b' }, answer: 'A' }])
  check('缺 question → 该题 ok=false',         !r.results[0].ok)
  check('  errors 含「缺少 question」',          r.results[0].errors.some(e => e.includes('question')))

  // ── 1.5 缺 options 字段 ─────────────────────────────────────────────
  r = validateQuestions([{ type: 'single', question: 'test', answer: 'A' }])
  check('缺 options → 该题 ok=false',          !r.results[0].ok)
  check('  errors 含「缺少 options」',           r.results[0].errors.some(e => e.includes('options')))

  // ── 1.6 缺 answer 字段 ─────────────────────────────────────────────
  r = validateQuestions([{ type: 'single', question: 'test', options: { A: 'a', B: 'b' } }])
  check('缺 answer → 该题 ok=false',           !r.results[0].ok)
  check('  errors 含「缺少 answer」',            r.results[0].errors.some(e => e.includes('answer')))

  // ── 1.7 判断题 answer "正确" → ok ─────────────────────────────────
  r = validateQuestions([{ type: 'judgment', question: 'test', options: { A: '正确', B: '错误' }, answer: '正确' }])
  check('判断题 answer="正确" → ok',           r.results[0].ok === true)

  // ── 1.8 判断题 answer "错误" → ok ─────────────────────────────────
  r = validateQuestions([{ type: 'judgment', question: 'test', options: { A: '正确', B: '错误' }, answer: '错误' }])
  check('判断题 answer="错误" → ok',           r.results[0].ok === true)

  // ── 1.9 判断题 answer 非法值 → false ───────────────────────────────
  r = validateQuestions([{ type: 'judgment', question: 'test', options: { A: '正确', B: '错误' }, answer: '对' }])
  check('判断题 answer="对"（非"正确"/"错误"）→ false',  !r.results[0].ok)

  // ── 1.10 单题 answer 不在 options 中 ───────────────────────────────
  r = validateQuestions([{ type: 'single', question: 'test', options: { A: 'a', B: 'b' }, answer: 'C' }])
  check('单选题 answer="C" 不在 options 中 → false',  !r.results[0].ok)
})()

// ═══════════════════════════════════════════════════════════════════════════════
//  2. supportsStructuredOutput 函数测试
// ═══════════════════════════════════════════════════════════════════════════════
;(function testSupportsStructuredOutput() {
  heading('2. supportsStructuredOutput 函数')

  // 直接传 provider ID 字符串
  check('moonshot → true',      supportsStructuredOutput('moonshot') === true)
  check('siliconflow → false', supportsStructuredOutput('siliconflow') === false)
  check('openai → true',       supportsStructuredOutput('openai') === true)
  check('deepseek → true',     supportsStructuredOutput('deepseek') === true)
  check('groq → false',       supportsStructuredOutput('groq') === false)

  // 传 provider 对象
  check('{supportsStructuredOutput: true} 对象 → true',  supportsStructuredOutput({ supportsStructuredOutput: true }) === true)
  check('{supportsStructuredOutput: false} 对象 → false', supportsStructuredOutput({ supportsStructuredOutput: false }) === false)

  // 边界
  check('null → false',     supportsStructuredOutput(null) === false)
  check('undefined → false', supportsStructuredOutput(undefined) === false)
  check('不存在 provider → false', supportsStructuredOutput('nonexistent') === false)
})()

// ═══════════════════════════════════════════════════════════════════════════════
//  3. parseWithValidation 函数测试
// ═══════════════════════════════════════════════════════════════════════════════
;(function testParseWithValidation() {
  heading('3. parseWithValidation 函数')

  // ── 3.1 正常 JSON 数组 ──────────────────────────────────────────────
  const arrJson = JSON.stringify([
    { question: 'Q1', options: { A: 'a', B: 'b' }, answer: 'A', type: 'single', explanation: 'e' },
    { question: 'Q2', options: { A: 'a', B: 'b' }, answer: 'B', type: 'single', explanation: 'e' },
  ])
  let r = parseWithValidation(arrJson, { count: 2 })
  check('正常 JSON 数组 → parsed=true',        r.parsed === true)
  check('  解析出 2 道题',                     r.questions.length === 2)
  check('  validation 通过',                   r.validation.valid === true)

  // ── 3.2 {questions: [...]} 对象格式 ─────────────────────────────────
  const objJson = JSON.stringify({
    questions: [
      { question: 'Q1', options: { A: 'a', B: 'b' }, answer: 'A', type: 'single', explanation: 'e' },
    ],
  })
  r = parseWithValidation(objJson)
  check('{questions: [...]} 对象 → 正确提取 1 道题',  r.questions.length === 1)
  check('  parsed=true',                          r.parsed === true)

  // ── 3.3 非法 JSON → 降级 ──────────────────────────────────────────
  r = parseWithValidation('这不是 JSON', { count: 3 })
  check('非法 JSON → parsed=false',             r.parsed === false)
  check('  降级为空数组',                       Array.isArray(r.questions) && r.questions.length === 0)
  check('  validation.valid=false',             r.validation.valid === false)

  // ── 3.4 {data: [...]} 格式 ─────────────────────────────────────────
  const dataJson = JSON.stringify({
    data: [
      { question: 'DQ1', options: { A: 'a', B: 'b' }, answer: 'A', type: 'single', explanation: 'e' },
    ],
  })
  r = parseWithValidation(dataJson)
  check('{data: [...]} 对象 → 正确提取 1 道题',  r.questions.length === 1)

  // ── 3.5 单对象包装 ─────────────────────────────────────────────────
  const singleObjJson = JSON.stringify({ question: 'SQ1', options: { A: 'a', B: 'b' }, answer: 'A', type: 'single', explanation: 'e' })
  r = parseWithValidation(singleObjJson)
  check('单对象（非数组）→ 包装为 1 道题数组',   r.questions.length === 1)
})()

// ═══════════════════════════════════════════════════════════════════════════════
//  4. 两阶段流水线集成测试（mock fetch）
// ═══════════════════════════════════════════════════════════════════════════════
;(async function testTwoStagePipeline() {
  heading('4. 两阶段流水线集成测试')

  // ── 通用测试内容（触发 policy_notice 分类）───────────────────────────
  const testContent = '管理制度 安全操作规程：第一条 所有作业人员必须佩戴安全帽。第二条 高处作业必须系挂安全带。第三条 动火作业前必须办理动火许可证。'

  // ── 构造 fetch mock ─────────────────────────────────────────────────
  let fetchResponses = []   // 数组元素为 { choices: [{ message: { content: ... } }] }
  let fetchCallCount = 0

  // 保存原始 fetch
  const originalFetch = global.fetch

  global.fetch = async (url, options) => {
    fetchCallCount++
    const resp = fetchResponses[fetchCallCount - 1]
    if (!resp) {
      throw new Error(`fetch 被调用了 ${fetchCallCount} 次，但只预设了 ${fetchResponses.length} 个响应`)
    }
    return {
      ok: true,
      json: async () => resp,
    }
  }

  function resetFetch() {
    fetchCallCount = 0
    fetchResponses = []
  }

  // ── 辅助：创建单个 AI 响应对象 ─────────────────────────────────────
  function makeAIResponse(content) {
    return { choices: [{ message: { content, reasoning_content: null } }] }
  }

  // ── 4.1 Stage 1 成功 ──────────────────────────────────────────────
  heading('4.1 Stage 1 成功（validation 通过）')
  resetFetch()
  fetchResponses = [
    makeAIResponse(JSON.stringify([
      { question: '作业人员必须佩戴什么防护用品？', options: { A: '安全帽', B: '手套', C: '护目镜', D: '耳塞' }, answer: 'A', type: 'single', explanation: '根据第一条' },
      { question: '高处作业必须执行什么措施？',     options: { A: '系挂安全带', B: '搭设脚手架', C: '设置警戒区', D: '专人监护' }, answer: 'A', type: 'single', explanation: '根据第二条' },
      { question: '动火作业前必须做什么？',         options: { A: '办理动火许可证', B: '填写作业票', C: '通知安全员', D: '准备灭火器' }, answer: 'A', type: 'single', explanation: '根据第三条' },
    ])),
  ]

  try {
    const result = await aiQuestion.generateQuestions({
      content: testContent,
      count: 3,
      docType: 'policy_notice',
      difficulty: 3,
    })
    check('Stage 1 成功 → hasErrors=false',                  result.hasErrors === false)
    check('  返回 3 道题',                                     result.questions.length === 3)
    check('  repairAttempted=false',                           result.repairAttempted === false)
    check('  validationSummary 形如 "3/3"',                    /^3\/3/.test(result.validationSummary))
  } catch (e) {
    check(`Stage 1 成功测试抛出异常: ${e.message}`, false)
  }

  // ── 4.2 Stage 1 失败 + Stage 2 成功 ─────────────────────────────
  heading('4.2 Stage 1 失败 + Stage 2 成功')
  resetFetch()
  // Stage 1 返回：缺 answer 的题目（校验不通过）
  fetchResponses = [
    makeAIResponse(JSON.stringify([
      { question: '作业人员必须佩戴什么？', options: { A: '安全帽', B: '手套' }, answer: 'A', type: 'single', explanation: '根据第一条' },
      { question: '以下说法哪些正确？',     options: { A: '必须戴安全帽', B: '必须系安全带', C: '必须办动火证' }, answer: 'ABC', type: 'multiple', explanation: '多条' },
    ])),
    // Stage 2 修复后返回：完整有效题目（多一道）
    makeAIResponse(JSON.stringify([
      { question: '作业人员必须佩戴什么防护用品？', options: { A: '安全帽', B: '手套', C: '护目镜', D: '耳塞' }, answer: 'A', type: 'single', explanation: '根据第一条' },
      { question: '以下说法哪些正确？',             options: { A: '必须戴安全帽', B: '必须系安全带', C: '必须办动火证', D: '以上都不对' }, answer: 'ABC', type: 'multiple', explanation: '多条' },
      { question: '安全管理制度的核心是什么？',      options: { A: '预防为主', B: '安全第一', C: '综合治理', D: '全员参与' }, answer: 'A', type: 'single', explanation: '核心' },
    ])),
  ]

  try {
    const result = await aiQuestion.generateQuestions({
      content: testContent,
      count: 3,
      docType: 'policy_notice',
      difficulty: 3,
    })
    check('Stage 1 失败→2 成功 → hasErrors=false',           result.hasErrors === false)
    check('  repairAttempted=true',                            result.repairAttempted === true)
    check('  返回 3 道题',                                     result.questions.length === 3)
    check('  fetch 被调用了 2 次',                             fetchCallCount === 2)
  } catch (e) {
    check(`Stage 1 失败+Stage 2 成功测试异常: ${e.message}`, false)
  }

  // ── 4.3 两阶段都失败 ──────────────────────────────────────────────
  heading('4.3 两阶段都失败（降级）')
  resetFetch()
  // Stage 1: 返回有问题的题目（缺 options 等导致校验失败）
  fetchResponses = [
    makeAIResponse(JSON.stringify([
      { question: '作业必须戴什么？', options: { A: 'a' }, answer: 'A', type: 'single', explanation: 'test' },
      { question: '如下哪些正确？',   options: { A: 'a', B: 'b' }, type: 'multiple', explanation: 'test' },  // 缺 answer
    ])),
    // Stage 2: 仍然返回有问题的题目
    makeAIResponse(JSON.stringify([
      { question: '作业必须戴什么？', options: { A: 'a' }, answer: 'A', type: 'single', explanation: 'test' },
      { question: '如下哪些正确？',   answer: 'A', type: 'multiple', explanation: 'test' },  // 缺 options
    ])),
  ]

  try {
    const result = await aiQuestion.generateQuestions({
      content: testContent,
      count: 3,
      docType: 'policy_notice',
      difficulty: 3,
    })
    check('两阶段都失败 → hasErrors=true',                    result.hasErrors === true)
    check('  repairAttempted=true',                            result.repairAttempted === true)
    check('  返回题目非空（降级保留）',                         result.questions.length > 0)
    check('  fetch 被调用了 2 次',                             fetchCallCount === 2)
  } catch (e) {
    check(`两阶段都失败测试异常: ${e.message}`, false)
  }

  // ── 恢复原始 fetch ─────────────────────────────────────────────────
  global.fetch = originalFetch
})()

// ═══════════════════════════════════════════════════════════════════════════════
//  输出汇总
// ═══════════════════════════════════════════════════════════════════════════════
;(function summary() {
  // 等待异步测试完成
  setTimeout(() => {
    console.log(`\n${'═'.repeat(70)}`)
    console.log(`  总测试数: ${pass + fail}  |  通过: ${pass}  |  失败: ${fail}`)
    if (fail > 0) {
      console.log(`  失败项:`)
      failures.forEach(f => console.log(`    ✗ ${f}`))
      console.log(`  路由判定: Engineer（源码需修复）`)
      process.exit(1)
    } else {
      console.log(`  路由判定: NoOne（全部通过）`)
      process.exit(0)
    }
  }, 500)
})()
