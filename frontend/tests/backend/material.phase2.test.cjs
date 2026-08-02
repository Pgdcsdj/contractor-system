/**
 * 后端 material.js 阶段 2（预览确认）端点测试
 *
 * 测试范围：
 * 1. POST /:id/preview-ai       — 预览生成题目
 * 2. POST /:id/confirm-questions — 确认保存题目
 * 3. POST /:id/cancel-ai         — 取消 AI 出题
 * 4. POST /upload?preview=true   — 预览模式上传
 *
 * 运行方式：
 *   node tests/backend/material.phase2.test.cjs
 *
 * 依赖：proxyquire（已安装）
 */
const path = require('path')
const proxyquire = require('proxyquire')

const ROUTE_FILE = path.resolve(__dirname, '../../../backend/src/routes/material.js')

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock 工厂
// ═══════════════════════════════════════════════════════════════════════════════

// ── 极简 express.Router mock ─────────────────────────────────────────────
function makeRouter() {
  const stack = []
  return {
    stack,
    get(p, ...handlers) {
      stack.push({ route: { path: p, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) } })
    },
    post(p, ...handlers) {
      stack.push({ route: { path: p, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) } })
    },
    put(p, ...handlers) {
      stack.push({ route: { path: p, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) } })
    },
    delete(p, ...handlers) {
      stack.push({ route: { path: p, methods: { delete: true }, stack: handlers.map((h) => ({ handle: h })) } })
    },
  }
}
const expressMock = { Router: () => makeRouter() }

// ── multer mock（内存存储，模拟 single('file') 中间件）─────────────────
const multerMock = () => ({
  single: () => (req, res, next) => {
    // 透传，让 handler 自行处理 req.file
    next()
  },
})
multerMock.memoryStorage = () => ({})

// ── mock pool（可切换返回值）───────────────────────────────────────────
let currentExecute = async () => [[]]  // 默认返回空
let currentQuery   = async () => [[]]
let currentConnection = null            // 事务用连接 mock

const pool = {
  execute: async (...args) => currentExecute(...args),
  query:   async (...args) => currentQuery(...args),
  getConnection: async () => {
    if (currentConnection) return currentConnection
    const conn = {
      beginTransaction: async () => {},
      execute: async (...args) => currentExecute(...args),
      commit:   async () => {},
      rollback: async () => {},
      release:  async () => {},
    }
    return conn
  },
}

// ── mock 辅助：设置 pool.execute 返回 ─────────────────────────────────
function mockExecute(fn) {
  currentExecute = fn
}
function mockQuery(fn) {
  currentQuery = fn
}
function resetPool() {
  currentExecute = async () => [[]]
  currentQuery   = async () => [[]]
  currentConnection = null
}

// ── Mock verifyAdminToken（始终有效）──────────────────────────────────
const mockAdminAuth = {
  verifyAdminToken: () => ({ id: 1, username: 'admin', role: 'admin' }),
}

// ── Mock cosUpload ──────────────────────────────────────────────────────
const mockCosUpload = {
  uploadFile: async (buffer, filename, prefix) => ({
    url: 'https://cos.example.com/materials/test.pdf',
    key: prefix + '/' + filename,
  }),
}

// ── Mock docParser ─────────────────────────────────────────────────────
const mockDocParser = {
  extractFromBuffer: async (buffer, ext) => ({ text: '模拟提取的文本内容', images: [] }),
}

// ── Mock aiQuestion ────────────────────────────────────────────────────
const mockAiQuestion = {
  generateQuestions: async (config) => ({
    questions: [
      {
        type: 'single',
        question: '安全生产方针是什么？',
        options: { A: '安全第一', B: '预防为主', C: '综合治理', D: '全部都是' },
        answer: 'D',
        explanation: '安全生产方针是"安全第一、预防为主、综合治理"',
      },
      {
        type: 'single',
        question: '消防通道宽度至少多少米？',
        options: { A: '1米', B: '2米', C: '3米', D: '4米' },
        answer: 'B',
        explanation: '消防通道宽度至少2米',
      },
    ],
    hasErrors: false,
    validationSummary: '2/2',
    repairAttempted: false,
  }),
  generateImageQuestions: async () => ({ questions: [] }),
}

// ═══════════════════════════════════════════════════════════════════════════════
//  加载被测模块
// ═══════════════════════════════════════════════════════════════════════════════

let router
function loadRouter() {
  resetPool()
  router = proxyquire.noCallThru()(ROUTE_FILE, {
    express: expressMock,
    multer: multerMock,
    '../db/db': { pool, '@global': true },
    '../services/adminAuth': mockAdminAuth,
    '../services/cosUpload': mockCosUpload,
    '../services/docParser': mockDocParser,
    '../ai/aiQuestion': mockAiQuestion,
    '../constants/quizCodes': { QUIZ_MODES: { STUDY: 'study', PRACTICE: 'practice', EXAM: 'exam' } },
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
//  测试辅助
// ═══════════════════════════════════════════════════════════════════════════════

// 找到路由层并调用其 handler 链
function invoke(routePath, method, req) {
  return new Promise((resolve) => {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === routePath && l.route.methods[method]
    )
    if (!layer) {
      resolve({ statusCode: 404, body: null })
      return
    }
    const handlers = layer.route.stack.map((s) => s.handle)
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this },
      json(obj) { this.body = obj; resolve(this); return this },
    }
    let i = 0
    async function next(err) {
      if (err) { res.statusCode = 500; res.body = { error: String(err) }; resolve(res); return }
      if (i >= handlers.length) { resolve(res); return }
      const h = handlers[i++]
      try { await h(req, res, next) } catch (e) { res.statusCode = 500; res.body = { error: String(e.message || e) }; resolve(res) }
    }
    next()
  })
}

function makeReq(params, body, query) {
  return {
    params: params || {},
    body: body || {},
    query: query || {},
    headers: { authorization: 'Bearer test-token' },
    admin: { id: 1, username: 'admin', role: 'admin' },
    file: body?.file || null,
  }
}

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
//  1. POST /:id/preview-ai 端点测试
// ═══════════════════════════════════════════════════════════════════════════════
async function testPreviewAi() {
  heading('1. POST /:id/preview-ai 端点')

  // ── 1a. 正常：有 content_text → 返回 questions ─────────────────────
  loadRouter()
  mockExecute(async (sql, params) => {
    if (sql.includes('FROM t_material')) {
      return [[{ id: 1, title: '测试素材', content_text: '这是一段测试内容', file_type: 'docx' }]]
    }
    return [[]]
  })

  let r = await invoke('/:id/preview-ai', 'post', makeReq({ id: '1' }, { count: 2, questionTypes: 'choice', difficulty: 3 }))
  check('有 content_text → 返回 success=true', r.body && r.body.success === true)
  check('  返回 questions 数组且长度>0', r.body && r.body.data && Array.isArray(r.body.data.questions) && r.body.data.questions.length > 0)
  check('  返回 hasErrors=false', r.body && r.body.data && r.body.data.hasErrors === false)

  // ── 1b. 空 content_text → 返回 400 ─────────────────────────────────
  loadRouter()
  mockExecute(async (sql) => {
    if (sql.includes('FROM t_material')) {
      return [[{ id: 2, title: '空内容', content_text: '', file_type: 'docx' }]]
    }
    return [[]]
  })

  r = await invoke('/:id/preview-ai', 'post', makeReq({ id: '2' }, { count: 2 }))
  check('空 content_text → 返回 400', r.statusCode === 400)
  check('  错误信息包含"素材内容为空"', r.body && r.body.error && r.body.error.includes('素材内容为空'))

  // ── 1c. 素材不存在 → 返回 404 ──────────────────────────────────────
  loadRouter()
  mockExecute(async (sql) => {
    if (sql.includes('FROM t_material')) {
      return [[]]  // 空结果
    }
    return [[]]
  })

  r = await invoke('/:id/preview-ai', 'post', makeReq({ id: '999' }, { count: 2 }))
  check('素材不存在 → 返回 404', r.statusCode === 404)
  check('  错误信息包含"素材不存在"', r.body && r.body.error && r.body.error.includes('素材不存在'))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. POST /:id/confirm-questions 端点测试
// ═══════════════════════════════════════════════════════════════════════════════
async function testConfirmQuestions() {
  heading('2. POST /:id/confirm-questions 端点')

  // ── 2a. 正常 questions 数组 → 事务提交成功 → aiStatus=2 ──────────
  loadRouter()
  let committed = false
  let released = false
  currentConnection = {
    beginTransaction: async () => {},
    execute: async (sql, params) => {
      if (sql.includes('UPDATE t_material')) {
        return [{}]
      }
      return [{}]
    },
    commit: async () => { committed = true },
    rollback: async () => {},
    release: async () => { released = true },
  }

  const normalQuestions = [
    { type: 'single', question: 'Q1', options: { A: 'a', B: 'b' }, answer: 'A', explanation: 'e1', score: 5 },
    { type: 'single', question: 'Q2', options: { A: 'a', B: 'b' }, answer: 'B', explanation: 'e2', score: 5 },
  ]

  let r = await invoke('/:id/confirm-questions', 'post', makeReq({ id: '1' }, { questions: normalQuestions }))
  check('正常 questions → 返回 success=true', r.body && r.body.success === true)
  check('  aiStatus=2（无错误）', r.body && r.body.data && r.body.data.aiStatus === 2)
  check('  questionCount=2', r.body && r.body.data && r.body.data.questionCount === 2)
  check('  事务已提交 (commit)', committed === true)
  check('  事务已释放 (release)', released === true)

  // ── 2b. 含 hasErrors 标记的 questions → aiStatus=3 ───────────────
  loadRouter()
  currentConnection = {
    beginTransaction: async () => {},
    execute: async (sql, params) => {
      if (sql.includes('UPDATE t_material')) {
        return [{}]
      }
      return [{}]
    },
    commit: async () => {},
    rollback: async () => {},
    release: async () => {},
  }

  const erroredQuestions = [
    { type: 'single', question: 'Q3', options: null, answer: '', explanation: '', score: 5 },
    { type: 'single', question: 'Q4', options: { A: 'a' }, answer: 'A', explanation: 'e', score: 5 },
  ]

  r = await invoke('/:id/confirm-questions', 'post', makeReq({ id: '1' }, { questions: erroredQuestions }))
  check('含 hasErrors 的 questions → aiStatus=3', r.body && r.body.data && r.body.data.aiStatus === 3)

  // ── 2c. 空数组 → 返回 400 ─────────────────────────────────────────
  loadRouter()
  r = await invoke('/:id/confirm-questions', 'post', makeReq({ id: '1' }, { questions: [] }))
  check('空 questions 数组 → 返回 400', r.statusCode === 400)
  check('  错误信息包含"题目列表不能为空"', r.body && r.body.error && r.body.error.includes('题目列表不能为空'))

  // ── 2d. questions 不是数组 → 返回 400 ─────────────────────────────
  loadRouter()
  r = await invoke('/:id/confirm-questions', 'post', makeReq({ id: '1' }, { questions: 'not-an-array' }))
  check('questions 不是数组 → 返回 400', r.statusCode === 400)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. POST /:id/cancel-ai 端点测试
// ═══════════════════════════════════════════════════════════════════════════════
async function testCancelAi() {
  heading('3. POST /:id/cancel-ai 端点')

  // ── 3a. 正常 → UPDATE 执行 → 返回 success ─────────────────────────
  loadRouter()
  let updateExecuted = false
  let updateIdChecked = false
  mockExecute(async (sql, params) => {
    if (sql.includes('UPDATE t_material')) {
      updateExecuted = true
      // SQL: UPDATE t_material SET ai_status = 0 WHERE id = ?
      // params: ['5'] (只有一个占位符 ?)
      updateIdChecked = String(params[0]) === '5'
      return [{}]
    }
    return [[]]
  })

  let r = await invoke('/:id/cancel-ai', 'post', makeReq({ id: '5' }))
  check('cancel-ai → 返回 success=true', r.body && r.body.success === true)
  check('  UPDATE 已执行', updateExecuted === true)
  check('  UPDATE 使用了正确的 id', updateIdChecked === true)

  // ── 3b. 取消失败 → 500 ──────────────────────────────────────────
  loadRouter()
  mockExecute(async () => { throw new Error('数据库错误') })

  r = await invoke('/:id/cancel-ai', 'post', makeReq({ id: '5' }))
  check('数据库错误 → 返回 500', r.statusCode === 500)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4. POST /upload?preview=true 端点测试
// ═══════════════════════════════════════════════════════════════════════════════
async function testUploadPreview() {
  heading('4. POST /upload?preview=true 端点')

  // ── 4a. 正常 upload?preview=true → 创建素材 + 提取文本 + 不触发 AI ──
  loadRouter()
  let insertId = 42
  let insertExecuted = false
  let updateContentText = false
  let extractCalled = false
  let aiCalled = false

  // 重设 mock
  mockExecute(async (sql, params) => {
    if (sql.includes('INSERT INTO t_material')) {
      insertExecuted = true
      return [{ insertId }]
    }
    if (sql.includes('UPDATE t_material SET content_text')) {
      updateContentText = true
      return [{}]
    }
    return [[]]
  })

  // 替换 uploadFile mock 记录调用
  const uploadFileMock = async (buffer, filename, prefix) => {
    return { url: 'https://cos.example.com/materials/test.pdf', key: prefix + '/' + filename }
  }

  // 替换 extractFromBuffer mock
  const extractFromBufferMock = async (buffer, ext) => {
    extractCalled = true
    return { text: '模拟提取的文本内容', images: [] }
  }

  // 替换 generateQuestions mock
  const generateQuestionsMock = async () => {
    aiCalled = true
    return { questions: [] }
  }

  // 重新加载路由带定制 mock
  router = proxyquire.noCallThru()(ROUTE_FILE, {
    express: expressMock,
    multer: multerMock,
    '../db/db': { pool, '@global': true },
    '../services/adminAuth': mockAdminAuth,
    '../services/cosUpload': { uploadFile: uploadFileMock, '@global': true },
    '../services/docParser': { extractFromBuffer: extractFromBufferMock, '@global': true },
    '../ai/aiQuestion': { generateQuestions: generateQuestionsMock, generateImageQuestions: async () => ({ questions: [] }), '@global': true },
    '../constants/quizCodes': { QUIZ_MODES: { STUDY: 'study', PRACTICE: 'practice', EXAM: 'exam' } },
  })

  const req = makeReq({}, {
    title: '测试预览上传',
    material_type: 'other',
    pass_score: 60,
    time_limit: 30,
    mode: 'exam',
    file: { buffer: Buffer.from('test'), originalname: 'test.pdf', size: 100, mimetype: 'application/pdf' },
  }, { preview: 'true' })

  let r = await invoke('/upload', 'post', req)
  check('upload?preview=true → 返回 success=true', r.body && r.body.success === true)
  check('  返回 data.preview=true', r.body && r.body.data && r.body.data.preview === true)
  check('  返回 data.materialId', r.body && r.body.data && r.body.data.materialId > 0)
  check('  INSERT 已执行', insertExecuted === true)
  check('  extractFromBuffer 已调用', extractCalled === true)
  check('  generateQuestions 未被调用（不触发 AI）', aiCalled === false)

  // ── 4b. 无文件上传 → 返回 400 ─────────────────────────────────────
  loadRouter()
  r = await invoke('/upload', 'post', makeReq({}, {}, { preview: 'true' }))
  check('无文件 → 返回 400', r.statusCode === 400)
  check('  错误信息包含"请上传文件"', r.body && r.body.error && r.body.error.includes('请上传文件'))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  汇总输出
// ═══════════════════════════════════════════════════════════════════════════════
;(async function main() {
  await testPreviewAi()
  await testConfirmQuestions()
  await testCancelAi()
  await testUploadPreview()

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  后端端点测试完成`)
  console.log(`  总测试: ${pass + fail}  |  通过: ${pass}  |  失败: ${fail}`)
  if (fail > 0) {
    console.log(`  失败项:`)
    failures.forEach(f => console.log(`    ✗ ${f}`))
    console.log(`  路由判定: Engineer（源码需修复）`)
    process.exit(1)
  } else {
    console.log(`  路由判定: 待定（结合前端测试结果）`)
    process.exit(0)
  }
})()
