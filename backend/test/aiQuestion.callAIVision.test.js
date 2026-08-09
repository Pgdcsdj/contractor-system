/**
 * callAIVision 单元测试
 *
 * 验证目标：
 *  1. 当 provider.supportsStructuredOutput 为 true 时，请求体必须包含
 *     response_format: { type: 'json_object' }（修复"图片题返回散文"缺陷的核心）
 *  2. 当 provider.supportsStructuredOutput 为 false 时，请求体不应包含 response_format
 *  3. 图片 / model / max_tokens 等字段正确透传
 *
 * 实现方式：
 *  - 在加载被测模块前，用「假 aiConfig」预填 require.cache，避免真实网络 / 配置依赖
 *  - 用 global.fetch 桩捕获请求体（request body）
 *  - 通过可变 state 控制 provider.supportsStructuredOutput，便于在单文件内切换用例
 *
 * 运行： node test/aiQuestion.callAIVision.test.js
 */
const assert = require('assert')
const path = require('path')

// ─── 1. 预填假 aiConfig（必须在 require aiQuestion 之前）─────────────────────
const aiConfigPath = require.resolve(
  path.join(__dirname, '..', 'src', 'ai', 'aiConfig.js')
)

// 可变状态：通过修改此处即可切换"是否支持结构化输出"
const state = {
  provider: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://fake.test/v1',
    supportsVision: true,
    supportsStructuredOutput: true, // ← 用例 1 支持 / 用例 2 会切到 false
  },
}

const fakeAiConfig = {
  getApiKey: () => 'test-key',
  getProvider: () => state.provider,
  getQuestionModel: () => 'fake-chat',
  getVisionModel: () => 'fake-vision',
  supportsVision: () => state.provider.supportsVision,
  supportsStructuredOutput: (p) =>
    !!(typeof p === 'string'
      ? p && state.provider.id === p
      : p && p.supportsStructuredOutput),
  loadConfig: () => ({ questionConfig: {} }),
}

require.cache[aiConfigPath] = {
  id: aiConfigPath,
  filename: aiConfigPath,
  loaded: true,
  exports: fakeAiConfig,
}

// ─── 2. fetch 桩：捕获请求体 ────────────────────────────────────────────────
let lastRequest = null

global.fetch = async (url, opts) => {
  lastRequest = {
    url,
    headers: opts && opts.headers,
    body: opts && opts.body ? JSON.parse(opts.body) : null,
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"questions":[]}' } }],
    }),
  }
}

// ─── 3. 加载被测模块 ────────────────────────────────────────────────────────
const { callAIVision } = require(
  path.join(__dirname, '..', 'src', 'ai', 'aiQuestion.js')
)

// 一张 1x1 PNG 的 magic number，用于测试多模态 content 拼接
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ─── 4. 用例 ────────────────────────────────────────────────────────────────
async function run() {
  // ── 用例 1：provider 支持结构化输出 → 必须带 response_format ──
  state.provider = { ...state.provider, supportsStructuredOutput: true }
  lastRequest = null
  await callAIVision({ textPrompt: '请出题', imageBuffers: [], maxTokens: 1234 })

  assert.ok(lastRequest, 'fetch 应被调用并捕获请求体')
  assert.ok(lastRequest.body, '请求体应存在')
  assert.deepStrictEqual(
    lastRequest.body.response_format,
    { type: 'json_object' },
    '支持结构化输出时，body.response_format 必须为 { type: "json_object" }'
  )
  assert.strictEqual(lastRequest.body.model, 'fake-vision', 'model 应使用 vision 模型')
  assert.strictEqual(lastRequest.body.max_tokens, 1234, 'max_tokens 应原样透传')
  console.log('✓ 用例1：支持 structured output 时 body 含 response_format')

  // ── 用例 2：provider 不支持结构化输出 → 不应带 response_format ──
  state.provider = { ...state.provider, supportsStructuredOutput: false }
  lastRequest = null
  await callAIVision({ textPrompt: '请出题' })

  assert.strictEqual(
    lastRequest.body.response_format,
    undefined,
    '不支持结构化输出时，body 不应包含 response_format'
  )
  console.log('✓ 用例2：不支持 structured output 时 body 不含 response_format')

  // ── 用例 3：恢复支持 + 传入图片 → response_format 保留，且 content 为数组 ──
  state.provider = { ...state.provider, supportsStructuredOutput: true }
  lastRequest = null
  await callAIVision({ textPrompt: '识别隐患', imageBuffers: [PNG_MAGIC] })

  assert.deepStrictEqual(
    lastRequest.body.response_format,
    { type: 'json_object' },
    '带图片且支持时，response_format 仍应存在'
  )
  const userMsg = (lastRequest.body.messages || []).find(
    (m) => m.role === 'user'
  )
  assert.ok(userMsg, '应存在 user 消息')
  assert.ok(Array.isArray(userMsg.content), '多模态 user content 应为数组')
  const imgPart = userMsg.content.find((p) => p.type === 'image_url')
  assert.ok(imgPart, 'user content 应包含 image_url 部分')
  assert.ok(
    /data:image\/png;base64,/.test(imgPart.image_url.url),
    'image_url 应为 base64 data URL'
  )
  console.log('✓ 用例3：带图片请求保留 response_format 且为合法多模态内容')

  console.log('\n✅ callAIVision response_format 单元测试全部通过')
}

run().catch((err) => {
  console.error('\n❌ 测试失败:', err && err.message ? err.message : err)
  process.exit(1)
})
