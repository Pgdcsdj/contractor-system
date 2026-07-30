/**
 * 后端 routes/quiz.js 轻量校验（proxyquire mock pool + 极简 express.Router mock）
 *
 * 重点验证 review 分支（GET /:materialId/result）修复后的行为：
 *  - 返回的 mode 严格取自 t_record.mode（记录的作答模式）
 *  - 即便素材默认 mode 不同，也应优先返回 record.mode
 *  - 同时做 node --check 语法校验（material.js / quiz.js）
 */
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const proxyquire = require('proxyquire')

const ROUTE_FILE = path.resolve(__dirname, '../../../backend/src/routes/quiz.js')

// ── 语法校验 ──
function nodeCheck(file) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' })
    return true
  } catch (e) {
    return false
  }
}

// ── 极简 express.Router mock（仅覆盖本文件用到的 get/post）──
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
  }
}
const expressMock = { Router: () => makeRouter() }

// ── mock pool（可在各用例间切换返回行）──
let currentRecord = []
let currentMaterial = []
const pool = {
  execute: async (sql) => {
    if (sql.includes('FROM t_record')) return [currentRecord]
    if (sql.includes('FROM t_material')) return [currentMaterial]
    if (sql.includes('FROM t_question')) return [[]]
    return [[]]
  },
  query: async () => [[]],
}

// 一次性加载路由（pool 闭包共享，用例通过切换 current* 改变行为）
// 使用 noCallThru：只使用桩模块，避免去加载真实 express / db 等（环境不可解析）
const router = proxyquire.noCallThru()(ROUTE_FILE, {
  express: expressMock,
  '../db/db': { pool, '@global': true },
  '../services/recordService': {
    saveRecord: async () => ({ id: 1, hash: 'h', submittedAt: new Date() }),
    saveOfflineRecords: async () => ({ success: 0, fail: 0, errors: [] }),
    '@global': true,
  },
  '../services/aiGrading': { gradeShortAnswer: async () => null, '@global': true },
  '../services/authService': { verifyToken: () => ({ id: 7 }), '@global': true },
})

// 找到目标路由层并调用其 handler 链
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
      json(obj) { this.body = obj; resolve(res); return this },
    }
    let i = 0
    async function next(err) {
      if (err) { res.statusCode = 500; res.body = { error: String(err) }; resolve(res); return }
      if (i >= handlers.length) { resolve(res); return }
      const h = handlers[i++]
      try { await h(req, res, next) } catch (e) { res.statusCode = 500; res.body = { error: String(e) }; resolve(res) }
    }
    next()
  })
}

function makeReq(materialId) {
  return {
    params: { materialId: String(materialId) },
    query: {},
    headers: { authorization: 'Bearer tok' },
    user: { id: 7 },
  }
}

let pass = 0
let fail = 0
const failures = []
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; failures.push(name); console.log('  ✗', name) }
}

console.log('\n[backend] node --check 语法校验')
check('material.js 语法 OK', nodeCheck(path.resolve(__dirname, '../../../backend/src/routes/material.js')))
check('quiz.js 语法 OK', nodeCheck(ROUTE_FILE))

console.log('\n[backend] GET /:materialId/result 模式来源校验')
;(async () => {
  // 用例1：记录 mode='practice'，素材无 mode 列 → 应返回 record.mode
  currentRecord = [{ id: 1, score: 80, max_score: 100, answers: '[]', submitted_at: '2024-01-01', mode: 'practice', duration_sec: 30 }]
  currentMaterial = [{ pass_score: 60 }]
  let r = await invoke('/:materialId/result', 'get', makeReq(5))
  check("记录 mode='practice' → 返回 practice（来自 t_record.mode）", r.body && r.body.data && r.body.data.mode === 'practice')

  // 用例2（最强证据）：记录 mode='practice'，素材默认 mode='study' → 应优先返回 practice
  currentRecord = [{ id: 1, score: 80, max_score: 100, answers: '[]', submitted_at: '2024-01-01', mode: 'practice', duration_sec: 30 }]
  currentMaterial = [{ pass_score: 60, mode: 'study' }]
  r = await invoke('/:materialId/result', 'get', makeReq(5))
  check("记录 practice 优先于 素材 study → 返回 practice（非 material.mode）", r.body && r.body.data && r.body.data.mode === 'practice')

  // 用例3：记录 mode=null，素材 mode='study' → 回退到素材默认 study
  currentRecord = [{ id: 1, score: 0, max_score: 0, answers: '[]', submitted_at: '2024-01-01', mode: null, duration_sec: 0 }]
  currentMaterial = [{ pass_score: 60, mode: 'study' }]
  r = await invoke('/:materialId/result', 'get', makeReq(5))
  check("记录 mode 为空 → 回退素材默认 mode='study'", r.body && r.body.data && r.body.data.mode === 'study')

  console.log(`\n[backend] 结果：通过 ${pass} / 失败 ${fail}`)
  if (fail > 0) {
    console.log('失败项：', failures.join('; '))
    process.exit(1)
  }
  process.exit(0)
})()
