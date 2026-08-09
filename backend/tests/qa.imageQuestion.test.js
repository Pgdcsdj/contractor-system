/**
 * QA 独立验收测试 —— image_violation 图片出题改造
 *
 * 作者：QA 严过关（独立编写，未复用 src/ai/__test_image_question.js）
 * 运行：node --test backend/tests/qa.imageQuestion.test.js
 *
 * 设计要点（与工程师自测脚本的差异）：
 *   1. 使用 Node 内置 node:test + node:assert/strict，无任何 npm 依赖
 *   2. 通过 require.cache 预注入伪造的 aiConfig / db 模块，
 *      从而在「不落盘改配置、不连数据库、不发真实 HTTP」的前提下，
 *      连 callAIVision 内部的 fetch body 组装都能做白盒断言
 *   3. 覆盖真实 aiConfig 常量断言（模型号改造点）
 */

'use strict'

const { describe, it, before, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

// ─────────────────────────────────────────────────────────────────────────────
//  0. 先读真实 aiConfig（断言模型常量），再用伪造模块顶替，最后加载被测模块
// ─────────────────────────────────────────────────────────────────────────────

const AI_CONFIG_PATH = require.resolve('../src/ai/aiConfig')
const DB_PATH = require.resolve('../src/db/db')
const AI_QUESTION_PATH = require.resolve('../src/ai/aiQuestion')

// 真实 aiConfig（仅取常量，无副作用）
const realAiConfig = require('../src/ai/aiConfig')
const REAL_PROVIDERS = JSON.parse(JSON.stringify(realAiConfig.PROVIDERS))

/** 把任意 exports 对象伪装成已加载的模块塞进 require.cache */
function injectModule(absPath, exportsObj) {
  const m = new Module(absPath, null)
  m.filename = absPath
  m.path = path.dirname(absPath)
  m.loaded = true
  m.exports = exportsObj
  require.cache[absPath] = m
  return m
}

// ── 伪造 aiConfig：所有返回值可通过 cfgState 动态改写 ───────────────────────
const cfgState = {
  providerId: 'siliconflow',
  baseUrl: 'https://vision.test.invalid/v1',
  apiKey: 'sk-qa-fake-key',
  visionModel: 'THUDM/GLM-4.5V',
  questionModel: 'deepseek-ai/DeepSeek-V3.2',
  supportsVision: true,
  supportsStructuredOutput: false,
  temperature: 0.3,
}

const fakeAiConfig = {
  PROVIDERS: REAL_PROVIDERS,
  loadConfig: () => ({
    provider: cfgState.providerId,
    apiKeys: { [cfgState.providerId]: cfgState.apiKey },
    models: { question: 'chat', grading: 'chat' },
    questionConfig: { temperature: cfgState.temperature, maxTokens: 2000 },
  }),
  getProvider: () => ({
    id: cfgState.providerId,
    name: 'QA Fake Provider',
    baseUrl: cfgState.baseUrl,
    models: { chat: cfgState.questionModel, vision: cfgState.visionModel },
    supportsVision: cfgState.supportsVision,
    supportsStructuredOutput: cfgState.supportsStructuredOutput,
  }),
  getApiKey: () => cfgState.apiKey,
  getQuestionModel: () => cfgState.questionModel,
  getGradingModel: () => cfgState.questionModel,
  getVisionModel: () => cfgState.visionModel,
  supportsVision: () => cfgState.supportsVision,
  supportsStructuredOutput: (p) => {
    if (!p) return false
    if (typeof p === 'string') return false
    return !!p.supportsStructuredOutput
  },
}

// ── 伪造 db：记录 pool.execute 调用，可切换成抛错 ───────────────────────────
const dbState = { calls: [], shouldThrow: false }
const fakeDb = {
  pool: {
    execute: async (sql, params) => {
      dbState.calls.push({ sql, params })
      if (dbState.shouldThrow) throw new Error('QA 模拟：数据库不可用')
      return [{ affectedRows: 1, insertId: 1 }]
    },
  },
  testConnection: async () => true,
}

injectModule(AI_CONFIG_PATH, fakeAiConfig)
injectModule(DB_PATH, fakeDb)

// 确保被测模块在伪造依赖就位之后才加载
delete require.cache[AI_QUESTION_PATH]
const aiQuestion = require('../src/ai/aiQuestion')

const {
  generateImageQuestions,
  callAIVision,
  attachImagesByFilename,
  validateQuestions,
  logImageQuestionRun,
  __setTestHooks,
  __resetTestHooks,
} = aiQuestion

// ─────────────────────────────────────────────────────────────────────────────
//  测试夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 最小合法 PNG 头（0x89 0x50）*/
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
/** 最小合法 JPEG 头（0xFF 0xD8）*/
const JPG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const IMAGES = [
  { buffer: PNG_BUF, filename: 'violation_a.png', url: 'https://cos.test/a.png' },
  { buffer: JPG_BUF, filename: 'violation_b.jpg', url: 'https://cos.test/b.jpg' },
  { buffer: PNG_BUF, filename: 'violation_c.png', url: 'https://cos.test/c.png' },
]

function mkSingle(filenames, id = 1) {
  return {
    id,
    type: 'single',
    image_filenames: filenames,
    question: `第 ${id} 题：图中作业人员的行为违反了哪项规定？`,
    options: { A: '高处作业管理规定', B: '动火作业管理规定', C: '受限空间规定', D: '用电安全规定' },
    answer: 'A',
    explanation: '图中为高处作业未系安全带。',
  }
}

function mkJudgment(filenames, id = 2) {
  return {
    id,
    type: 'judgment',
    image_filenames: filenames,
    question: `第 ${id} 题：图中未系安全带作业违反保命条款。`,
    answer: '正确',
    explanation: '保命条款强制要求。',
  }
}

function mkFill(filenames, id = 3) {
  return {
    id,
    type: 'fill',
    image_filenames: filenames,
    question: `第 ${id} 题：氧气瓶与乙炔瓶间距不得小于______米。`,
    answer: '5',
    explanation: 'GB 9448 规定。',
  }
}

/** 生成一个可控的 callAIVision 桩，并记录每次调用参数 */
function visionStub(returnValues) {
  const calls = []
  const queue = Array.isArray(returnValues) ? returnValues.slice() : [returnValues]
  const fn = async (args) => {
    calls.push(args)
    const v = queue.length > 1 ? queue.shift() : queue[0]
    if (v instanceof Error) throw v
    return typeof v === 'string' ? v : JSON.stringify(v)
  }
  fn.calls = calls
  return fn
}

function repairStub(returnValue) {
  const calls = []
  const fn = async (raw, failed, params) => {
    calls.push({ raw, failed, params })
    if (returnValue instanceof Error) throw returnValue
    return typeof returnValue === 'string' ? returnValue : JSON.stringify(returnValue)
  }
  fn.calls = calls
  return fn
}

function logStub() {
  const calls = []
  const fn = async (rec) => { calls.push(rec) }
  fn.calls = calls
  return fn
}

/** 通用：装一套「不炸」的默认桩 */
function baseHooks(extra = {}) {
  const log = logStub()
  __setTestHooks(Object.assign({
    supportsVision: () => true,
    logRun: log,
    generateQuestions: async () => ({ questions: [] }),
    callAIForRepair: async () => '[]',
  }, extra))
  return log
}

afterEach(() => {
  __resetTestHooks()
  dbState.calls.length = 0
  dbState.shouldThrow = false
  cfgState.visionModel = 'THUDM/GLM-4.5V'
  cfgState.supportsVision = true
})

// ═════════════════════════════════════════════════════════════════════════════
//  1. aiConfig 模型号改造点
// ═════════════════════════════════════════════════════════════════════════════

describe('1. aiConfig 模型配置改造', () => {
  it('1.1 siliconflow vision 模型应为 THUDM/GLM-4.5V', () => {
    assert.equal(REAL_PROVIDERS.siliconflow.models.vision, 'THUDM/GLM-4.5V')
  })

  it('1.2 siliconflow chat 模型应为 deepseek-ai/DeepSeek-V3.2', () => {
    assert.equal(REAL_PROVIDERS.siliconflow.models.chat, 'deepseek-ai/DeepSeek-V3.2')
  })

  it('1.3 siliconflow 应声明 supportsVision', () => {
    assert.equal(REAL_PROVIDERS.siliconflow.supportsVision, true)
  })

  it('1.4 应保留 chatV3 回退别名，便于线上快速回滚', () => {
    assert.equal(REAL_PROVIDERS.siliconflow.models.chatV3, 'deepseek-ai/DeepSeek-V3')
  })

  it('1.5 已下架的 Qwen2-VL 不应再出现在任何 provider 配置里', () => {
    const dump = JSON.stringify(REAL_PROVIDERS)
    assert.ok(!/Qwen2-VL/i.test(dump), '配置中仍残留 Qwen2-VL')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  2. callAIVision：system + user 两条消息（白盒断言 fetch body）
// ═════════════════════════════════════════════════════════════════════════════

describe('2. callAIVision 消息组装', () => {
  let originalFetch
  let captured

  before(() => { originalFetch = global.fetch })

  beforeEach(() => {
    captured = null
    global.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body), headers: opts.headers }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '[]' } }] }),
      }
    }
  })

  afterEach(() => { global.fetch = originalFetch })

  it('2.1 传入 system 时，messages[0].role 必须是 system 且内容含「安全环保培训师」', async () => {
    await callAIVision({
      system: '你是一名安全环保培训师，擅长将施工现场违章照片转化为客观题。',
      textPrompt: '请出题',
      imageBuffers: [PNG_BUF],
    })

    assert.ok(captured, 'fetch 未被调用')
    const msgs = captured.body.messages
    assert.ok(Array.isArray(msgs), 'messages 不是数组')
    assert.equal(msgs.length, 2, `期望 system+user 两条消息，实际 ${msgs.length} 条`)
    assert.equal(msgs[0].role, 'system')
    assert.ok(
      String(msgs[0].content).includes('安全环保培训师'),
      'system 消息未包含「安全环保培训师」'
    )
    assert.equal(msgs[1].role, 'user')
  })

  it('2.2 user 消息为多模态数组：先 text 后 image_url，且 base64 data URL 的 MIME 正确', async () => {
    await callAIVision({
      system: 'sys',
      textPrompt: '看图出题',
      imageBuffers: [PNG_BUF, JPG_BUF],
    })

    const userContent = captured.body.messages[1].content
    assert.ok(Array.isArray(userContent), 'user.content 应为数组')
    assert.equal(userContent[0].type, 'text')
    assert.equal(userContent[0].text, '看图出题')
    assert.equal(userContent[1].type, 'image_url')
    assert.ok(userContent[1].image_url.url.startsWith('data:image/png;base64,'), 'PNG MIME 识别错误')
    assert.ok(userContent[2].image_url.url.startsWith('data:image/jpeg;base64,'), 'JPEG MIME 识别错误')
    assert.equal(userContent[1].image_url.detail, 'high')
  })

  it('2.3 不传 system 时，只应有一条 user 消息（向后兼容旧调用）', async () => {
    await callAIVision({ textPrompt: '只出题', imageBuffers: [PNG_BUF] })
    const msgs = captured.body.messages
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].role, 'user')
  })

  it('2.4 system 为空字符串/纯空白时不应生成空 system 消息', async () => {
    await callAIVision({ system: '   ', textPrompt: 'x', imageBuffers: [] })
    const msgs = captured.body.messages
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].role, 'user')
  })

  it('2.5 传入自定义 messages 时，图片应追加到最后一条 user 消息', async () => {
    await callAIVision({
      messages: [
        { role: 'system', content: '安全环保培训师' },
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '第二轮' },
      ],
      imageBuffers: [PNG_BUF],
    })

    const msgs = captured.body.messages
    assert.equal(msgs.length, 4)
    assert.equal(msgs[3].role, 'user')
    assert.ok(Array.isArray(msgs[3].content), '最后一条 user 未转成多模态数组')
    const imgParts = msgs[3].content.filter(p => p.type === 'image_url')
    assert.equal(imgParts.length, 1, '图片未挂到最后一条 user 消息')
    // 前面的 user 消息保持原样，不应被污染
    assert.equal(msgs[1].content, '第一轮')
  })

  it('2.6 请求应使用 vision 模型与正确的 endpoint/鉴权头', async () => {
    await callAIVision({ system: 's', textPrompt: 't', imageBuffers: [] })
    assert.equal(captured.body.model, 'THUDM/GLM-4.5V')
    assert.equal(captured.url, 'https://vision.test.invalid/v1/chat/completions')
    assert.equal(captured.headers.Authorization, 'Bearer sk-qa-fake-key')
    assert.equal(captured.body.max_tokens, 4000)
  })

  it('2.7 未配置 vision 模型时应抛出可读错误', async () => {
    cfgState.visionModel = null
    await assert.rejects(
      () => callAIVision({ textPrompt: 'x' }),
      /未配置Vision模型/
    )
  })

  it('2.8 上游返回非 2xx 时应抛出带状态码的错误', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: '限流' } }),
    })
    await assert.rejects(
      () => callAIVision({ textPrompt: 'x' }),
      /Vision API 错误 \[429\]/
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  3. generateImageQuestions 下发 system prompt
// ═════════════════════════════════════════════════════════════════════════════

describe('3. generateImageQuestions 下发 system prompt', () => {
  it('3.1 必须以 system 参数下发含「安全环保培训师」的角色设定', async () => {
    const vision = visionStub(JSON.stringify([
      mkSingle(['violation_a.png'], 1),
      mkJudgment(['violation_b.jpg'], 2),
    ]))
    baseHooks({ callAIVision: vision })

    await generateImageQuestions({
      content: '某项目高处作业未系安全带',
      images: IMAGES,
      count: 2,
      questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(vision.calls.length, 1, 'callAIVision 应被调用一次')
    const args = vision.calls[0]
    assert.equal(typeof args.system, 'string', '未传 system 参数')
    assert.ok(args.system.includes('安全环保培训师'), 'system 未包含「安全环保培训师」')
    assert.ok(args.system.includes('忽略原通报中的标注线框'), 'system 缺少「忽略标注线框」约束')
  })

  it('3.2 system 应拼接难度提示', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    baseHooks({ callAIVision: vision })

    await generateImageQuestions({ content: 'x', images: IMAGES, count: 1, difficulty: 5 })

    assert.ok(vision.calls[0].system.includes('难度等级 5/5'), 'system 未拼接难度提示')
  })

  it('3.3 user prompt 必须使用 image_filenames 规范并列出真实文件名清单', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    baseHooks({ callAIVision: vision })

    await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })

    const p = vision.calls[0].textPrompt
    assert.ok(p.includes('image_filenames'), 'prompt 未包含 image_filenames 字段约定')
    assert.ok(p.includes('禁止输出 image_index 字段'), 'prompt 未禁用 image_index')
    for (const img of IMAGES) {
      assert.ok(p.includes(img.filename), `prompt 未列出文件名 ${img.filename}`)
    }
  })

  it('3.4 imageBuffers 应与 images 同序同长', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    baseHooks({ callAIVision: vision })

    await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })

    const bufs = vision.calls[0].imageBuffers
    assert.equal(bufs.length, IMAGES.length)
    assert.ok(bufs[0].equals(PNG_BUF))
    assert.ok(bufs[1].equals(JPG_BUF))
  })

  it('3.5 Provider 不支持 Vision 时应直接抛错，不发起任何调用', async () => {
    const vision = visionStub('[]')
    baseHooks({ callAIVision: vision, supportsVision: () => false })

    await assert.rejects(
      () => generateImageQuestions({ content: 'x', images: IMAGES, count: 1 }),
      /不支持Vision模型/
    )
    assert.equal(vision.calls.length, 0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  4. attachImagesByFilename：文件名反查绑定
// ═════════════════════════════════════════════════════════════════════════════

describe('4. attachImagesByFilename 文件名反查', () => {
  it('4.1 文件名正确时应绑定到对应图片的 image_url（含乱序）', () => {
    const qs = [
      mkSingle(['violation_c.png'], 1),
      mkJudgment(['violation_a.png'], 2),
    ]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_url, 'https://cos.test/c.png')
    assert.equal(r.questions[0].image_index, 2)
    assert.equal(r.questions[0].image_degraded, false)
    assert.equal(r.questions[1].image_url, 'https://cos.test/a.png')
    assert.equal(r.questions[1].image_index, 0)
    assert.equal(r.degradedCount, 0)
    assert.equal(r.missCount, 0)
  })

  it('4.2 文件名归一化：大小写 / 目录前缀 / 中文引号包裹均应命中', () => {
    const qs = [
      mkSingle(['VIOLATION_B.JPG'], 1),
      mkSingle(['media/word/violation_c.png'], 2),
      mkSingle(['“violation_a.png”'], 3),
      mkSingle(['media\\word\\violation_b.jpg'], 4),
    ]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_url, 'https://cos.test/b.jpg', '大小写归一化失败')
    assert.equal(r.questions[1].image_url, 'https://cos.test/c.png', '目录前缀归一化失败')
    assert.equal(r.questions[2].image_url, 'https://cos.test/a.png', '中文引号剥离失败')
    assert.equal(r.questions[3].image_url, 'https://cos.test/b.jpg', '反斜杠路径归一化失败')
    assert.equal(r.degradedCount, 0)
  })

  it('4.3 单图题文件名错误 → 兜底绑定第一张图，且不算降级', () => {
    const qs = [mkSingle(['模型瞎编的图.png'], 1)]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_index, 0, '未兜底到第一张图')
    assert.equal(r.questions[0].image_url, 'https://cos.test/a.png')
    assert.equal(r.questions[0].image_degraded, false)
    assert.equal(r.degradedCount, 0)
    assert.equal(r.missCount, 1, '未命中次数应被统计')
  })

  it('4.4 模型未给任何文件名的单图题 → 同样兜底第一张图', () => {
    const q = mkSingle(undefined, 1)
    delete q.image_filenames
    const r = attachImagesByFilename([q], IMAGES)

    assert.equal(r.questions[0].image_index, 0)
    assert.equal(r.questions[0].image_url, 'https://cos.test/a.png')
    assert.equal(r.questions[0].image_degraded, false)
  })

  it('4.5 多图题文件名全错 → 降级为纯文字题（image_url=null）', () => {
    const qs = [mkSingle(['ghost1.png', 'ghost2.png'], 1)]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_url, null)
    assert.equal(r.questions[0].image_index, null)
    assert.deepEqual(r.questions[0].image_urls, [])
    assert.equal(r.questions[0].image_degraded, true)
    assert.equal(r.degradedCount, 1)
    assert.equal(r.missCount, 2)
  })

  it('4.6 多图题部分命中 → 剔除无效项，保留有效图', () => {
    const qs = [mkSingle(['ghost.png', 'violation_b.jpg'], 1)]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_url, 'https://cos.test/b.jpg')
    assert.deepEqual(r.questions[0].image_urls, ['https://cos.test/b.jpg'])
    assert.deepEqual(r.questions[0].image_filenames, ['violation_b.jpg'])
    assert.equal(r.questions[0].image_degraded, false)
    assert.equal(r.degradedCount, 0)
  })

  it('4.7 多图题多张命中 → image_urls 保留全部命中项，image_url 取第一张', () => {
    const qs = [mkSingle(['violation_b.jpg', 'violation_c.png'], 1)]
    const r = attachImagesByFilename(qs, IMAGES)

    assert.equal(r.questions[0].image_url, 'https://cos.test/b.jpg')
    assert.deepEqual(r.questions[0].image_urls, ['https://cos.test/b.jpg', 'https://cos.test/c.png'])
    assert.deepEqual(r.questions[0].image_indexes, [1, 2])
  })

  it('4.8 完全没有可用图片时 → 全部降级为纯文字题', () => {
    const qs = [mkSingle(['violation_a.png'], 1)]
    const r = attachImagesByFilename(qs, [])

    assert.equal(r.questions[0].image_url, null)
    assert.equal(r.questions[0].image_degraded, true)
    assert.equal(r.degradedCount, 1)
  })

  it('4.9 兼容模型返回旧字段名 images / image_filename', () => {
    const q1 = mkSingle(undefined, 1); delete q1.image_filenames; q1.images = ['violation_b.jpg']
    const q2 = mkSingle(undefined, 2); delete q2.image_filenames; q2.image_filename = 'violation_c.png'
    const r = attachImagesByFilename([q1, q2], IMAGES)

    assert.equal(r.questions[0].image_url, 'https://cos.test/b.jpg')
    assert.equal(r.questions[1].image_url, 'https://cos.test/c.png')
  })

  it('4.10 重复文件名去重，不产生重复绑定', () => {
    const qs = [mkSingle(['violation_b.jpg', 'violation_b.jpg'], 1)]
    const r = attachImagesByFilename(qs, IMAGES)
    assert.deepEqual(r.questions[0].image_indexes, [1])
    assert.equal(r.questions[0].image_urls.length, 1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  5. validateQuestions：判断题/填空题不再强制 options
// ═════════════════════════════════════════════════════════════════════════════

describe('5. validateQuestions 题型规则', () => {
  const ok = (qs, params) => validateQuestions(qs, params || {})

  it('5.1 判断题无 options 应通过校验', () => {
    const r = ok([mkJudgment(['violation_a.png'], 1)])
    assert.equal(r.results[0].ok, true, `判断题被误判：${r.results[0].errors.join('；')}`)
  })

  it('5.2 填空题无 options 应通过校验', () => {
    const r = ok([mkFill(['violation_a.png'], 1)])
    assert.equal(r.results[0].ok, true, `填空题被误判：${r.results[0].errors.join('；')}`)
  })

  it('5.3 简答题（short_answer / short_answer_image）无 options 应通过校验', () => {
    const base = { question: '请简述高处作业安全要求。', answer: '要点1;要点2', explanation: 'x' }
    const r = ok([
      { id: 1, type: 'short_answer', ...base },
      { id: 2, type: 'short_answer_image', ...base },
    ])
    assert.equal(r.results[0].ok, true)
    assert.equal(r.results[1].ok, true)
  })

  it('5.4 单选题缺 options 仍应判不合格（避免误放行）', () => {
    const q = mkSingle(['violation_a.png'], 1)
    delete q.options
    const r = ok([q])
    assert.equal(r.results[0].ok, false)
    assert.ok(r.results[0].errors.some(e => e.includes('options')))
  })

  it('5.5 需要选项的题型 options 少于 2 个应判不合格', () => {
    const q = mkSingle(['violation_a.png'], 1)
    q.options = { A: '只有一个' }
    q.answer = 'A'
    const r = ok([q])
    assert.equal(r.results[0].ok, false)
    assert.ok(r.results[0].errors.some(e => e.includes('至少需要 2 个选项')))
  })

  it('5.6 判断题 answer 非「正确/错误」应判不合格', () => {
    const q = mkJudgment(['violation_a.png'], 1)
    q.answer = 'A'
    const r = ok([q])
    assert.equal(r.results[0].ok, false)
    assert.ok(r.results[0].errors.some(e => e.includes('判断题 answer')))
  })

  it('5.7 多选题 answer 字母越界应判不合格', () => {
    const q = {
      id: 1, type: 'multiple',
      question: '图中存在哪些隐患？',
      options: { A: 'a', B: 'b', C: 'c' },
      answer: 'ABZ',
      explanation: 'x',
    }
    const r = ok([q])
    assert.equal(r.results[0].ok, false)
    assert.ok(r.results[0].errors.some(e => e.includes('"Z"')))
  })

  it('5.8 题目数量不符时应产出 countErrors 且整体 invalid', () => {
    const r = ok([mkSingle(['violation_a.png'], 1)], { count: 5 })
    assert.equal(r.valid, false)
    assert.ok(r.countErrors.length > 0)
    assert.equal(r.results[0].ok, true, '单题本身应合格，仅数量不足')
  })

  it('5.9 脏数据（null / 字符串 / 嵌套数组）不应抛异常，直接判不合格', () => {
    let r
    assert.doesNotThrow(() => { r = ok([null, 'garbage', [], mkFill(['violation_a.png'], 4)]) })
    assert.equal(r.results[0].ok, false)
    assert.equal(r.results[1].ok, false)
    assert.equal(r.results[2].ok, false)
    assert.equal(r.results[3].ok, true)
  })

  it('5.10 非数组入参应整体判不合格而不是崩溃', () => {
    const r = validateQuestions({ questions: [] }, {})
    assert.equal(r.valid, false)
    assert.equal(r.results[0].errors[0], '返回内容不是数组')
  })

  it('5.11 questionTypes 指定题型时，fill/judgment 应在期望集合内', () => {
    const r = ok(
      [mkJudgment(['violation_a.png'], 1), mkFill(['violation_b.jpg'], 2)],
      { questionTypes: '单选+多选+判断+填空' }
    )
    assert.equal(r.results[0].ok, true, r.results[0].errors.join('；'))
    assert.equal(r.results[1].ok, true, r.results[1].errors.join('；'))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  6. 两阶段流水线：无效 JSON → repair
// ═════════════════════════════════════════════════════════════════════════════

describe('6. 两阶段流水线（parseWithValidation + callAIForRepair）', () => {
  it('6.1 模型返回无效 JSON 时应进入 repair 阶段并采纳修复结果', async () => {
    const vision = visionStub('抱歉，我无法直接读取图片。以下是我的分析……（非 JSON）')
    const repair = repairStub(JSON.stringify([
      mkSingle(['violation_a.png'], 1),
      mkJudgment(['violation_b.jpg'], 2),
    ]))
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(repair.calls.length, 1, 'repair 未被调用')
    assert.equal(res.repairAttempted, true)
    assert.equal(res.fallbackUsed, false)
    assert.equal(res.questions.length, 2)
    assert.equal(res.questions[0].image_url, 'https://cos.test/a.png')
    // repair 应拿到原始响应和错误清单
    assert.ok(String(repair.calls[0].raw).includes('非 JSON'))
    assert.equal(repair.calls[0].params.detectedType, 'image_violation')
  })

  it('6.2 markdown ```json 包裹的返回应被清洗后正常解析，不进 repair', async () => {
    const payload = JSON.stringify([mkSingle(['violation_a.png'], 1), mkJudgment(['violation_b.jpg'], 2)])
    const vision = visionStub('```json\n' + payload + '\n```')
    const repair = repairStub('[]')
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(repair.calls.length, 0, 'markdown 包裹不应触发 repair')
    assert.equal(res.repairAttempted, false)
    assert.equal(res.questions.length, 2)
  })

  it('6.3 全部合法且数量匹配时不应触发 repair', async () => {
    const vision = visionStub(JSON.stringify([
      mkSingle(['violation_a.png'], 1),
      mkJudgment(['violation_b.jpg'], 2),
      mkFill(['violation_c.png'], 3),
    ]))
    const repair = repairStub('[]')
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 3, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(repair.calls.length, 0)
    assert.equal(res.repairAttempted, false)
    assert.equal(res.droppedCount, 0)
    assert.equal(res.hasErrors, false)
  })

  it('6.4 坏题应被丢弃，好题保留，droppedCount 正确', async () => {
    const bad = { id: 2, type: 'single', question: '缺选项的坏题', answer: 'A' }
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1), bad]))
    // repair 原样返回同样的坏数据 → 有效题数持平，不应变得更差
    const repair = repairStub(JSON.stringify([mkSingle(['violation_a.png'], 1), bad]))
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(res.questions.length, 1, '坏题未被丢弃')
    assert.equal(res.droppedCount, 1)
    assert.equal(res.hasErrors, true)
    assert.ok(/1\/2/.test(res.validationSummary), `validationSummary 异常: ${res.validationSummary}`)
  })

  it('6.5 repair 结果更差时应保留 Stage 1 的有效题', async () => {
    const good = mkSingle(['violation_a.png'], 1)
    const bad = { id: 2, type: 'single', question: '坏题', answer: 'A' }
    const vision = visionStub(JSON.stringify([good, bad]))
    const repair = repairStub('彻底崩坏的非 JSON 输出')
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(res.questions.length, 1, '未保留 Stage 1 有效题')
    assert.equal(res.questions[0].question, good.question)
    assert.equal(res.fallbackUsed, false)
  })

  it('6.6 repair 调用本身抛异常时不应打断整单', async () => {
    const good = mkSingle(['violation_a.png'], 1)
    const bad = { id: 2, type: 'single', question: '坏题', answer: 'A' }
    const vision = visionStub(JSON.stringify([good, bad]))
    const repair = repairStub(new Error('repair 上游 500'))
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(res.questions.length, 1)
    assert.equal(res.repairAttempted, true)
  })

  // 现状记录（非缺陷断言）：数量差 1 道也会触发一整轮 repair，
  // 意味着多一次 AI 调用的耗时与费用。留档供后续优化决策。
  it('6.8 每题都合格、仅数量少 1 道时，不应触发 repair（避免浪费一次 AI 调用）', async () => {
    const vision = visionStub(JSON.stringify([
      mkSingle(['violation_a.png'], 1),
      mkJudgment(['violation_b.jpg'], 2),
    ]))
    const repair = repairStub(JSON.stringify([
      mkSingle(['violation_a.png'], 1),
      mkJudgment(['violation_b.jpg'], 2),
    ]))
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 3, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(repair.calls.length, 0, '仅数量不足不应触发 repair')
    assert.equal(res.repairAttempted, false)
    assert.equal(res.questions.length, 2, '题目本身全部合格，最终仍应保留')
    assert.equal(res.droppedCount, 0)
  })

  it('6.7 顶层对象 {questions:[...]} 形态也应被正确解析', async () => {
    const vision = visionStub(JSON.stringify({
      questions: [mkSingle(['violation_a.png'], 1), mkJudgment(['violation_b.jpg'], 2)],
    }))
    const repair = repairStub('[]')
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 2, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(res.questions.length, 2)
    assert.equal(repair.calls.length, 0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  7. 全失败 → fallback 到 generateQuestions({docType:'policy_notice'})
// ═════════════════════════════════════════════════════════════════════════════

describe('7. 全部无效时的 fallback 降级', () => {
  const FB_QUESTIONS = [
    { id: 1, type: 'single', question: '文字题1', options: { A: 'a', B: 'b' }, answer: 'A', explanation: 'x' },
    { id: 2, type: 'judgment', question: '文字题2', answer: '正确', explanation: 'x' },
  ]

  it('7.1 图片题全废时应 fallback，且 fallbackUsed=true', async () => {
    const vision = visionStub('完全不是 JSON')
    const repair = repairStub('还是不是 JSON')
    const textGenCalls = []
    const textGen = async (args) => {
      textGenCalls.push(args)
      return { questions: JSON.parse(JSON.stringify(FB_QUESTIONS)), validationSummary: '2/2 题通过校验' }
    }
    baseHooks({ callAIVision: vision, callAIForRepair: repair, generateQuestions: textGen })

    const res = await generateImageQuestions({
      content: '违章通报原文', images: IMAGES, count: 2, difficulty: 4,
    })

    assert.equal(res.fallbackUsed, true, 'fallbackUsed 应为 true')
    assert.equal(textGenCalls.length, 1, 'generateQuestions 未被调用')
    assert.equal(textGenCalls[0].docType, 'policy_notice', 'fallback 未使用 policy_notice')
    assert.equal(textGenCalls[0].content, '违章通报原文')
    assert.equal(textGenCalls[0].difficulty, 4)
    assert.equal(res.questions.length, 2)
    assert.equal(res.hasErrors, true)
    assert.equal(res.metadata.docType, 'policy_notice')
  })

  it('7.2 fallback 出来的题必须全部与图片解绑', async () => {
    const vision = visionStub('not json')
    const repair = repairStub('not json')
    const textGen = async () => ({ questions: JSON.parse(JSON.stringify(FB_QUESTIONS)) })
    baseHooks({ callAIVision: vision, callAIForRepair: repair, generateQuestions: textGen })

    const res = await generateImageQuestions({ content: 'x', images: IMAGES, count: 2 })

    for (const q of res.questions) {
      assert.equal(q.image_url, null, '降级题不应绑定图片 URL')
      assert.equal(q.image_index, null)
      assert.deepEqual(q.image_urls, [])
      assert.equal(q.image_degraded, true)
    }
  })

  it('7.3 Vision 调用直接抛错时也应走 fallback，而不是整单失败', async () => {
    const vision = visionStub(new Error('Vision API 错误 [503]'))
    const textGen = async () => ({ questions: JSON.parse(JSON.stringify(FB_QUESTIONS)) })
    const log = baseHooks({ callAIVision: vision, generateQuestions: textGen })

    const res = await generateImageQuestions({ content: 'x', images: IMAGES, count: 2 })

    assert.equal(res.fallbackUsed, true)
    assert.equal(res.repairAttempted, false, 'Vision 无返回时不应触发 repair')
    assert.ok(String(log.calls[0].parseError).includes('Vision 调用失败'))
  })

  it('7.4 fallback 也拿不到题时应抛出聚合错误信息', async () => {
    const vision = visionStub('not json')
    const repair = repairStub('not json')
    const textGen = async () => ({ questions: [] })
    baseHooks({ callAIVision: vision, callAIForRepair: repair, generateQuestions: textGen })

    await assert.rejects(
      () => generateImageQuestions({ content: 'x', images: IMAGES, count: 2 }),
      /AI 图片出题失败/
    )
  })

  it('7.5 fallback 自身抛异常时错误信息应被收敛进最终异常', async () => {
    const vision = visionStub('not json')
    const repair = repairStub('not json')
    const textGen = async () => { throw new Error('文本模型也挂了') }
    baseHooks({ callAIVision: vision, callAIForRepair: repair, generateQuestions: textGen })

    await assert.rejects(
      () => generateImageQuestions({ content: 'x', images: IMAGES, count: 2 }),
      /文本模型也挂了/
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  8. t_ai_question_log 日志落库
// ═════════════════════════════════════════════════════════════════════════════

describe('8. 日志落库 t_ai_question_log', () => {
  it('8.1 主流程应把完整上下文交给日志函数', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    const log = baseHooks({ callAIVision: vision })

    await generateImageQuestions({
      content: 'x', images: IMAGES, count: 1, materialId: 88,
      questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(log.calls.length, 1)
    const rec = log.calls[0]
    assert.equal(rec.materialId, 88)
    assert.equal(rec.docType, 'image_violation')
    assert.equal(rec.provider, 'siliconflow')
    assert.equal(rec.visionModel, 'THUDM/GLM-4.5V')
    assert.equal(rec.textModel, 'deepseek-ai/DeepSeek-V3.2')
    assert.equal(rec.imageCount, 3)
    assert.equal(rec.questionCount, 1)
    assert.equal(rec.fallbackUsed, false)
    assert.ok(typeof rec.durationMs === 'number' && rec.durationMs >= 0)
    assert.ok(String(rec.rawResponse).includes('violation_a.png'))
  })

  it('8.2 repair 发生时原始响应与修复响应都应入日志', async () => {
    const vision = visionStub('STAGE1_GARBAGE')
    const repair = repairStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    const log = baseHooks({ callAIVision: vision, callAIForRepair: repair })

    await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })

    const raw = String(log.calls[0].rawResponse)
    assert.ok(raw.includes('STAGE1_GARBAGE'), '缺少 Stage1 原始响应')
    assert.ok(raw.includes('----- REPAIR RESPONSE -----'), '缺少修复响应分隔标记')
  })

  it('8.3 logImageQuestionRun 落库 SQL 的列与占位符应与 schema 对齐（11 个字段）', async () => {
    await logImageQuestionRun({
      materialId: 7, docType: 'image_violation', provider: 'siliconflow',
      visionModel: 'THUDM/GLM-4.5V', textModel: 'deepseek-ai/DeepSeek-V3.2',
      imageCount: 3, questionCount: 12, rawResponse: 'raw', parseError: '',
      fallbackUsed: true, durationMs: 1234,
    })

    assert.equal(dbState.calls.length, 1, 'pool.execute 未被调用')
    const { sql, params } = dbState.calls[0]
    assert.ok(sql.includes('INSERT INTO t_ai_question_log'))
    const cols = sql.match(/\(([^)]*)\)\s*VALUES/s)[1].split(',').map(s => s.trim())
    const placeholders = (sql.match(/VALUES\s*\(([^)]*)\)/s)[1].match(/\?/g) || []).length
    assert.equal(cols.length, 11, `列数应为 11，实际 ${cols.length}`)
    assert.equal(placeholders, 11, `占位符应为 11，实际 ${placeholders}`)
    assert.equal(params.length, 11)
    assert.deepEqual(cols, [
      'material_id', 'doc_type', 'provider', 'vision_model', 'text_model',
      'image_count', 'question_count', 'raw_response', 'parse_error',
      'fallback_used', 'duration_ms',
    ])
    assert.equal(params[9], 1, 'fallback_used 应写 1')
    assert.equal(params[10], 1234)
  })

  it('8.4 TINYINT 字段应做上限截断，避免超范围写入报错', async () => {
    await logImageQuestionRun({ imageCount: 300, questionCount: 999, durationMs: -5 })
    const { params } = dbState.calls[0]
    assert.equal(params[5], 255, 'image_count 未截断到 255')
    assert.equal(params[6], 255, 'question_count 未截断到 255')
    assert.equal(params[10], 0, 'duration_ms 负值未归零')
  })

  it('8.5 数据库不可用时日志写入失败不应冒泡影响出题主流程', async () => {
    dbState.shouldThrow = true
    await assert.doesNotReject(() => logImageQuestionRun({ materialId: 1 }))
  })

  it('8.6 日志写入失败不应导致 generateImageQuestions 失败', async () => {
    dbState.shouldThrow = true
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    // 注意：这里不注入 logRun，走真实 logImageQuestionRun → 伪造 db 抛错
    __setTestHooks({
      supportsVision: () => true,
      callAIVision: vision,
      callAIForRepair: async () => '[]',
      generateQuestions: async () => ({ questions: [] }),
    })

    const res = await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })
    assert.equal(res.questions.length, 1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  9. 边界与健壮性
// ═════════════════════════════════════════════════════════════════════════════

describe('9. 边界与健壮性', () => {
  it('9.1 小题量（count<=2）时 prompt 中的题型分布不应出现负数', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    baseHooks({ callAIVision: vision })

    await generateImageQuestions({ content: 'x', images: IMAGES, count: 2 })

    const p = vision.calls[0].textPrompt
    const negative = p.match(/[：:]\s*-\d+\s*道/g)
    assert.equal(negative, null, `prompt 出现负数题量：${negative && negative.join(', ')}`)
  })

  it('9.2 无图片输入时 prompt 应给出「无可用图片」提示而非空清单', async () => {
    const vision = visionStub(JSON.stringify([
      { id: 1, type: 'judgment', question: '纯文字判断题', answer: '正确', explanation: 'x' },
    ]))
    baseHooks({ callAIVision: vision })

    const res = await generateImageQuestions({ content: 'x', images: [], count: 1 })

    const p = vision.calls[0].textPrompt
    assert.ok(p.includes('（无可用图片，请勿输出 image_filenames）'), 'prompt 未给出无图提示')
    assert.equal(res.questions[0].image_url, null)
    assert.equal(res.questions[0].image_degraded, true)
  })

  it('9.3 模型返回数组中混入 null 时不应崩溃，坏元素被丢弃', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1), null, 'junk']))
    const repair = repairStub('[]')
    baseHooks({ callAIVision: vision, callAIForRepair: repair })

    const res = await generateImageQuestions({
      content: 'x', images: IMAGES, count: 3, questionTypes: '单选+多选+判断+填空',
    })

    assert.equal(res.questions.length, 1)
    assert.equal(res.droppedCount, 2)
  })

  it('9.4 生成的题目应补齐 id / type / theme 默认值', async () => {
    const q = mkSingle(['violation_a.png'], 1)
    delete q.id; delete q.theme
    const vision = visionStub(JSON.stringify([q]))
    baseHooks({ callAIVision: vision })

    const res = await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })

    assert.ok(res.questions[0].id)
    assert.equal(res.questions[0].type, 'single')
    assert.ok(res.questions[0].theme)
  })

  it('9.5 metadata 应完整回传给路由层（material.js 依赖字段）', async () => {
    const vision = visionStub(JSON.stringify([mkSingle(['violation_a.png'], 1)]))
    baseHooks({ callAIVision: vision })

    const res = await generateImageQuestions({ content: 'x', images: IMAGES, count: 1 })

    assert.ok('fallbackUsed' in res, '缺少 fallbackUsed')
    assert.ok('droppedCount' in res, '缺少 droppedCount')
    assert.ok('validationSummary' in res, '缺少 validationSummary')
    assert.equal(typeof res.metadata.durationMs, 'number')
    assert.equal(res.metadata.imageCount, 3)
    assert.equal(res.metadata.model, 'THUDM/GLM-4.5V')
  })
})
