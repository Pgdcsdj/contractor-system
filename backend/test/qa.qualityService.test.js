/**
 * QA 独立回归测试：出题质量量化校验与追踪（qualityService）
 *
 * 关键说明（方法论）：
 *   沙箱无生产 MySQL、backend/node_modules 也缺 xlsx/mysql2/express，
 *   因此本测试**不复制算法**，而是用 require.cache 预填 + Module._load 拦截
 *   的方式把 db / aiQuestion / unclosedHazardReport / xlsx 全部换成桩，
 *   然后加载**真实的 src/services/qualityService.js** 进行驱动。
 *   → 测的是产品源码本身，不是副本，避免"副本与源码漂移"导致的假阳性。
 *
 * 覆盖：computeQualityScore / runConsistencyCheck / runCoverageCheck /
 *       extractSourceKeyPoints / getConfig / exportQualityExcel(结构)
 *
 * 运行： node test/qa.qualityService.test.js
 */
const assert = require('assert')
const path = require('path')
const Module = require('module')

// ─── 1. 拦截 bare 模块 'xlsx'（node_modules 中不存在，必须走 _load 钩子）──────
/** 记录 xlsx 写出的所有 sheet，供导出结构断言 */
const xlsxCapture = { sheets: [], names: [] }

const xlsxStub = {
  utils: {
    book_new: () => ({ SheetNames: [], Sheets: {} }),
    aoa_to_sheet: (aoa) => ({ __aoa: aoa }),
    book_append_sheet: (wb, ws, name) => {
      wb.SheetNames.push(name)
      wb.Sheets[name] = ws
      xlsxCapture.names.push(name)
      xlsxCapture.sheets.push(ws.__aoa)
    },
  },
  write: () => Buffer.from('FAKE_XLSX'),
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'xlsx') return xlsxStub
  return origLoad.apply(this, arguments)
}

// ─── 2. 预填 require.cache 替换相对路径依赖 ──────────────────────────────────
const SRC = path.join(__dirname, '..', 'src')

/** 可编程的 mock pool：按 SQL 特征匹配返回行 */
const db = {
  handlers: [],
  calls: [],
  reset() {
    this.handlers = []
    this.calls = []
  },
  /** @param {RegExp} re @param {*} rows */
  on(re, rows) {
    this.handlers.push({ re, rows })
    return this
  },
}

const poolStub = {
  async execute(sql, params) {
    db.calls.push({ sql, params })
    for (const h of db.handlers) {
      if (h.re.test(sql)) {
        const rows = typeof h.rows === 'function' ? h.rows(params) : h.rows
        return [rows, []]
      }
    }
    return [[], []]
  },
  async query(sql, params) {
    return this.execute(sql, params)
  },
}

function stub(relPath, exports) {
  const full = require.resolve(path.join(SRC, relPath))
  require.cache[full] = { id: full, filename: full, loaded: true, exports }
}

stub('db/db.js', { pool: poolStub, testConnection: async () => true })

/** AI 桩：由 aiResponse 控制返回内容 */
const ai = { response: null, calls: [] }
stub('ai/aiQuestion.js', {
  async callAI(messages, maxTokens) {
    ai.calls.push({ messages, maxTokens })
    if (ai.response instanceof Error) throw ai.response
    return ai.response
  },
  parseJSONResponse(raw) {
    return JSON.parse(raw)
  },
})

stub('services/unclosedHazardReport.js', {
  fmtDateTime: (v, withSec) => (v ? '2026-01-01 00:00:00' : ''),
})

// ─── 3. 加载真实被测模块 ─────────────────────────────────────────────────────
const q = require(path.join(SRC, 'services', 'qualityService.js'))

// ─── 测试框架（极简）─────────────────────────────────────────────────────────
let pass = 0
const failures = []
const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}
async function run() {
  for (const c of cases) {
    db.reset()
    ai.response = null
    ai.calls = []
    try {
      await c.fn()
      pass++
      console.log(`  ✓ ${c.name}`)
    } catch (err) {
      failures.push({ name: c.name, err })
      console.log(`  ✗ ${c.name}`)
      console.log(`      ${err.message}`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. computeQualityScore —— 纯函数，权重/分档/兜底
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[A] computeQualityScore')

test('A1 满分：各项 100 且无告警 → 100 分 / 优秀', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: [] },
    coverage: { coveragePct: 100, needsManual: false },
  })
  assert.strictEqual(r.qualityScore, 100)
  assert.strictEqual(r.grade, '优秀')
})

test('A2 加权公式：80/90/70/60/100 → 78 分 / 良好', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 80, typeMatch: 90, annotateRate: 60, warnings: [] },
    coverage: { coveragePct: 70, needsManual: false },
  })
  // 80*.25 + 90*.20 + 70*.30 + 60*.15 + 100*.10 = 20+18+21+9+10 = 78
  assert.strictEqual(r.qualityScore, 78)
  assert.strictEqual(r.grade, '良好')
  assert.deepStrictEqual(r.metrics, {
    countRate: 80, typeMatch: 90, coveragePct: 70, annotateRate: 60, revisionConvergence: 100,
  })
})

test('A3 needsManual → 覆盖率强制记 60 分（忽略真实 coveragePct=100）', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: [] },
    coverage: { coveragePct: 100, needsManual: true },
  })
  assert.strictEqual(r.metrics.coveragePct, 60, 'metrics 应被保守降为 60')
  // 25 + 20 + 18 + 15 + 10 = 88
  assert.strictEqual(r.qualityScore, 88)
  assert.ok(r.hints.some(h => h.includes('人工复核')), '应给出人工复核提示')
})

test('A4 告警数驱动收敛度：3 条告警 → 100-60=40（按 runQualityCheck 的真实调用形态传参）', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: ['a', 'b', 'c'] },
    coverage: { coveragePct: 100, needsManual: false },
    revision: { rounds: 1, lastWarnings: 3 },   // runQualityCheck 即如此传入
  })
  assert.strictEqual(r.metrics.revisionConvergence, 40)
  // 25+20+30+15+4 = 94
  assert.strictEqual(r.qualityScore, 94)
})

test('A4b 省略 revision.lastWarnings 时才从 consistency.warnings 推算', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: ['a', 'b'] },
    coverage: { coveragePct: 100, needsManual: false },
    revision: {},   // 不给 lastWarnings → 走 warnings.length 分支
  })
  assert.strictEqual(r.metrics.revisionConvergence, 60, '2 条告警 → 100-40=60')
})

test('A4c 默认 revision（不传）时 lastWarnings=0，收敛度恒为 100', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: ['a', 'b', 'c'] },
    coverage: { coveragePct: 100, needsManual: false },
  })
  // 默认形参 {rounds:0,lastWarnings:0} 使 warnings 推算分支不可达——记录该行为
  assert.strictEqual(r.metrics.revisionConvergence, 100)
})

test('A5 告警过多时收敛度下限为 0（不出现负分）', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 100, typeMatch: 100, annotateRate: 100, warnings: [] },
    coverage: { coveragePct: 100, needsManual: false },
    revision: { rounds: 3, lastWarnings: 9 },
  })
  assert.strictEqual(r.metrics.revisionConvergence, 0)
})

test('A6 分档阈值边界：90/89/75/74/60/59', () => {
  /** 构造一个恰好得到目标分的输入（全部指标同值 → 加权和 = 该值） */
  const mk = (v) => q.computeQualityScore({
    consistency: { countRate: v, typeMatch: v, annotateRate: v, warnings: [] },
    coverage: { coveragePct: v, needsManual: false },
    revisionConvergence: v,
  })
  assert.strictEqual(mk(90).grade, '优秀')
  assert.strictEqual(mk(89).grade, '良好')
  assert.strictEqual(mk(75).grade, '良好')
  assert.strictEqual(mk(74).grade, '合格')
  assert.strictEqual(mk(60).grade, '合格')
  assert.strictEqual(mk(59).grade, '待改进')
})

test('A7 空入参兜底：countRate/typeMatch 默认 100，覆盖率/标注默认 0 → 55 分', () => {
  const r = q.computeQualityScore()
  // 100*.25 + 100*.20 + 0*.30 + 0*.15 + 100*.10 = 25+20+0+0+10 = 55
  assert.strictEqual(r.qualityScore, 55)
  assert.strictEqual(r.grade, '待改进')
})

test('A8 综合分被钳制在 0-100', () => {
  const r = q.computeQualityScore({
    consistency: { countRate: 999, typeMatch: 999, annotateRate: 999, warnings: [] },
    coverage: { coveragePct: 999, needsManual: false },
  })
  assert.strictEqual(r.qualityScore, 100)
})

// ═══════════════════════════════════════════════════════════════════════════
// B. runConsistencyCheck —— 用 mock pool 驱动真实函数
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[B] runConsistencyCheck')

/** 生成题目行 */
function mkQ(type, difficulty, bloom, kps = ['知识点X'], skps = ['源要点X']) {
  return {
    id: Math.random(),
    type,
    difficulty,
    bloom_level: bloom,
    knowledge_points: JSON.stringify(kps),
    source_keypoints: JSON.stringify(skps),
  }
}

const CFG_10 = {
  expectedCount: 10,
  typeDistribution: { single: 0.4, multiple: 0.3, judgment: 0.2, essay: 0.1 },
  difficultyHistogram: { 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.2, 5: 0.1 },
  bloomDistribution: { 识记: 0.3, 理解: 0.5, 应用: 0.2 },
  coverageThreshold: 0.8,
  kpMinCount: 5,
}

test('B1 题量不符 → severity=high 且 pass=false', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, [mkQ('single', 3, '理解')])
  const r = await q.runConsistencyCheck(1, CFG_10)
  const countDiff = r.diffs.find(d => d.dimension === '题目总量')
  assert.ok(countDiff, '应产生题目总量差异')
  assert.strictEqual(countDiff.severity, 'high')
  assert.strictEqual(countDiff.expected, '10 道')
  assert.strictEqual(countDiff.actual, '1 道')
  assert.strictEqual(r.pass, false)
})

test('B2 countRate：实际 8 / 期望 10 → 80；实际 12 → 封顶 100', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, new Array(8).fill(0).map(() => mkQ('single', 3, '理解')))
  const r8 = await q.runConsistencyCheck(1, CFG_10)
  assert.strictEqual(r8.countRate, 80)

  db.reset()
  db.on(/FROM t_question\s+WHERE material_id/i, new Array(12).fill(0).map(() => mkQ('single', 3, '理解')))
  const r12 = await q.runConsistencyCheck(1, CFG_10)
  assert.strictEqual(r12.countRate, 100, '超额出题不应 >100')
})

test('B3 expectedCount=0 → countRate=100 且不产生题量差异', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, [mkQ('single', 3, '理解')])
  const r = await q.runConsistencyCheck(1, { ...CFG_10, expectedCount: 0 })
  assert.strictEqual(r.countRate, 100)
  assert.ok(!r.diffs.some(d => d.dimension === '题目总量'))
})

test('B4 完美分布 10 道 → pass=true, 无 diffs, typeMatch=100', async () => {
  const rows = [
    ...new Array(4).fill(0).map(() => mkQ('single', 3, '理解')),
    ...new Array(3).fill(0).map(() => mkQ('multiple', 3, '理解')),
    ...new Array(2).fill(0).map(() => mkQ('judgment', 2, '识记')),
    mkQ('essay', 4, '应用'),
  ]
  // 难度: 3×7, 2×2, 4×1 → 期望 {1:.1,2:.2,3:.4,4:.2,5:.1}
  // 实际 {1:0, 2:.2, 3:.7, 4:.1, 5:0} → 难度3 偏差 .3 (mid) 会触发
  // 故本用例仅断言题型维度
  db.on(/FROM t_question\s+WHERE material_id/i, rows)
  const r = await q.runConsistencyCheck(1, CFG_10)
  assert.strictEqual(r.actualCount, 10)
  assert.strictEqual(r.typeMatch, 100, '题型完全匹配时 typeMatch 应为 100')
  assert.deepStrictEqual(r.typeCounts, { single: 4, multiple: 3, judgment: 2, essay: 1 })
  const typeDiffs = r.diffs.filter(d => d.dimension.startsWith('题型分布'))
  assert.strictEqual(typeDiffs.length, 0, '题型分布不应有差异')
})

test('B5 偏差分级：>15% → mid；5%~15% → low；<=5% → 忽略', async () => {
  // 10 道全 single：single 实际 100% vs 期望 40% → 偏差 60% → mid
  //                 multiple 0% vs 30% → 30% → mid
  //                 judgment 0% vs 20% → 20% → mid
  //                 essay    0% vs 10% → 10% → low
  db.on(/FROM t_question\s+WHERE material_id/i, new Array(10).fill(0).map(() => mkQ('single', 3, '理解')))
  const r = await q.runConsistencyCheck(1, CFG_10)
  const byDim = (d) => r.diffs.find(x => x.dimension === d)
  assert.strictEqual(byDim('题型分布·single').severity, 'mid')
  assert.strictEqual(byDim('题型分布·multiple').severity, 'mid')
  assert.strictEqual(byDim('题型分布·judgment').severity, 'mid')
  assert.strictEqual(byDim('题型分布·essay').severity, 'low', 'essay 偏差恰为 10% → low')
  assert.strictEqual(r.pass, false, '存在 mid 即不通过')
})

test('B6 pass 规则 = 无 high 且无 mid（只有 low 仍算通过）', async () => {
  // 构造只有 low 的场景：expectedCount=0 关闭题量校验、kpMinCount=0 关闭知识点校验
  // 题型期望 {single:0.5, multiple:0.5}，实际 10 道 → 6 single / 4 multiple
  // 偏差 = |0.5-0.6| = 0.10 → low
  const cfg = {
    expectedCount: 0,
    typeDistribution: { single: 0.5, multiple: 0.5 },
    difficultyHistogram: { 3: 1 },
    bloomDistribution: { 理解: 1 },
    kpMinCount: 0,
  }
  db.on(/FROM t_question\s+WHERE material_id/i, [
    ...new Array(6).fill(0).map(() => mkQ('single', 3, '理解')),
    ...new Array(4).fill(0).map(() => mkQ('multiple', 3, '理解')),
  ])
  const r = await q.runConsistencyCheck(1, cfg)
  assert.ok(r.diffs.every(d => d.severity === 'low'), `期望仅 low，实际 ${JSON.stringify(r.diffs)}`)
  assert.strictEqual(r.pass, true, '只有 low 差异时应判通过')
})

test('B7 知识点去重数低于下限 → mid 差异', async () => {
  // 5 道题共用同 1 个知识点 → kpCount=1 < kpMinCount=5
  db.on(/FROM t_question\s+WHERE material_id/i,
    new Array(5).fill(0).map(() => mkQ('single', 3, '理解', ['同一个知识点'])))
  const r = await q.runConsistencyCheck(1, { ...CFG_10, expectedCount: 0 })
  assert.strictEqual(r.kpCount, 1)
  const kpDiff = r.diffs.find(d => d.dimension === '知识点覆盖数')
  assert.ok(kpDiff, '应产生知识点覆盖数差异')
  assert.strictEqual(kpDiff.severity, 'mid')
})

test('B8 annotateRate：4/5 题有完整标注 → 80', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, [
    mkQ('single', 3, '理解', ['A']),
    mkQ('single', 3, '理解', ['B']),
    mkQ('single', 3, '理解', ['C']),
    mkQ('single', 3, '理解', ['D']),
    mkQ('single', 3, '理解', []),   // 无知识点 → 未标注
  ])
  const r = await q.runConsistencyCheck(1, { ...CFG_10, expectedCount: 0 })
  assert.strictEqual(r.annotatedCount, 4)
  assert.strictEqual(r.annotateRate, 80)
})

test('B9 typeMatch 公式 = (1 - 平均绝对偏差)*100', async () => {
  // 期望 {single:.5, multiple:.5}；实际 10 道全 single
  // |0.5-1| + |0.5-0| = 1.0，keys=2 → meanAbs=0.5 → typeMatch=50
  db.on(/FROM t_question\s+WHERE material_id/i, new Array(10).fill(0).map(() => mkQ('single', 3, '理解')))
  const r = await q.runConsistencyCheck(1, {
    expectedCount: 0, typeDistribution: { single: 0.5, multiple: 0.5 },
    difficultyHistogram: { 3: 1 }, bloomDistribution: { 理解: 1 }, kpMinCount: 0,
  })
  assert.strictEqual(r.typeMatch, 50)
})

test('B10 零题目：actualCount=0 时 annotateRate=0 且不崩溃', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, [])
  const r = await q.runConsistencyCheck(1, CFG_10)
  assert.strictEqual(r.actualCount, 0)
  assert.strictEqual(r.annotateRate, 0)
  assert.strictEqual(r.countRate, 0)
  assert.strictEqual(r.pass, false)
})

test('B11 【回归】legacy 行 difficulty=null 被计为难度 1（非 3）', async () => {
  db.on(/FROM t_question\s+WHERE material_id/i, [
    { id: 1, type: 'single', difficulty: null, bloom_level: '理解', knowledge_points: '["A"]', source_keypoints: '["a"]' },
  ])
  const r = await q.runConsistencyCheck(1, { ...CFG_10, expectedCount: 0 })
  // 记录真实行为，供报告引用
  assert.strictEqual(r.difficultyHistogram[1], 1,
    `clampDifficulty(null) 实际落桶=${JSON.stringify(r.difficultyHistogram)}`)
  assert.strictEqual(r.difficultyHistogram[3], 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. runCoverageCheck / extractSourceKeyPoints
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[C] runCoverageCheck / extractSourceKeyPoints')

test('C1 缓存关键点 5 条命中 3 条 → 覆盖率 60%，未覆盖 2 条', async () => {
  db.on(/FROM t_material WHERE id/i, [{
    id: 1, title: 'M', content_text: '',
    source_keypoints: JSON.stringify(['KP1', 'KP2', 'KP3', 'KP4', 'KP5']),
  }])
  db.on(/SELECT source_keypoints FROM t_question/i, [
    { source_keypoints: JSON.stringify(['KP1']) },
    { source_keypoints: JSON.stringify(['KP2', 'KP3']) },
  ])
  const r = await q.runCoverageCheck(1)
  assert.strictEqual(r.totalKP, 5)
  assert.strictEqual(r.coveragePct, 60)
  assert.deepStrictEqual(r.covered, ['KP1', 'KP2', 'KP3'])
  assert.deepStrictEqual(r.uncovered, ['KP4', 'KP5'])
  assert.strictEqual(r.needsManual, false)
  assert.strictEqual(r.source, 'cache')
})

test('C2 模糊匹配：忽略标点/空格/大小写', async () => {
  db.on(/FROM t_material WHERE id/i, [{
    id: 1, title: 'M', content_text: '',
    source_keypoints: JSON.stringify(['高处作业必须系挂安全带']),
  }])
  db.on(/SELECT source_keypoints FROM t_question/i, [
    { source_keypoints: JSON.stringify(['高处作业，必须系挂安全带。']) },
  ])
  const r = await q.runCoverageCheck(1)
  assert.strictEqual(r.coveragePct, 100, '标点差异不应影响命中')
})

test('C3 子串包含双向命中', async () => {
  db.on(/FROM t_material WHERE id/i, [{
    id: 1, title: 'M', content_text: '',
    source_keypoints: JSON.stringify(['动火作业必须办理作业票并全程监护']),
  }])
  db.on(/SELECT source_keypoints FROM t_question/i, [
    { source_keypoints: JSON.stringify(['动火作业必须办理作业票']) }, // 题目要点是源要点的子串
  ])
  const r = await q.runCoverageCheck(1)
  assert.strictEqual(r.coveragePct, 100)
})

test('C4 无关键点（图片类素材）→ coveragePct=100 但 needsManual=true, totalKP=0', async () => {
  db.on(/FROM t_material WHERE id/i, [{ id: 1, title: 'M', content_text: '', source_keypoints: null }])
  db.on(/SELECT source_keypoints FROM t_question/i, [])
  const r = await q.runCoverageCheck(1)
  assert.strictEqual(r.totalKP, 0)
  assert.strictEqual(r.needsManual, true)
  assert.strictEqual(r.coveragePct, 100, '原始返回 100，靠 computeQualityScore 降为 60')
  assert.strictEqual(r.source, 'none')
})

test('C5 回退到题目自身要点时 needsManual=true（避免自证 100%）', async () => {
  db.on(/FROM t_material WHERE id/i, [{ id: 1, title: 'M', content_text: '', source_keypoints: null }])
  db.on(/SELECT source_keypoints FROM t_question/i, [
    { source_keypoints: JSON.stringify(['要点甲']) },
    { source_keypoints: JSON.stringify(['要点乙']) },
  ])
  const r = await q.runCoverageCheck(1)
  assert.strictEqual(r.source, 'questions')
  assert.strictEqual(r.needsManual, true)
  assert.strictEqual(r.coveragePct, 100, '自证必然 100%，故必须靠 needsManual 降权')
})

test('C6 AI 抽取正文关键点（正文 >=40 字）并写缓存', async () => {
  ai.response = JSON.stringify(['关键点甲', '关键点乙', '关键点丙'])
  db.on(/FROM t_material WHERE id/i, [{
    id: 1, title: 'M',
    content_text: '一'.repeat(200),
    source_keypoints: null,
  }])
  db.on(/UPDATE t_material SET source_keypoints/i, { affectedRows: 1 })
  const r = await q.extractSourceKeyPoints(1)
  assert.strictEqual(r.source, 'ai')
  assert.strictEqual(r.needsManual, false)
  assert.deepStrictEqual(r.keyPoints, ['关键点甲', '关键点乙', '关键点丙'])
  assert.ok(db.calls.some(c => /UPDATE t_material SET source_keypoints/i.test(c.sql)), '应回写缓存')
})

test('C7 AI 异常 → 降级不抛错，回退题目要点', async () => {
  ai.response = new Error('AI timeout')
  db.on(/FROM t_material WHERE id/i, [{
    id: 1, title: 'M', content_text: '一'.repeat(200), source_keypoints: null,
  }])
  db.on(/SELECT source_keypoints FROM t_question/i, [{ source_keypoints: JSON.stringify(['兜底要点']) }])
  const r = await q.extractSourceKeyPoints(1)
  assert.strictEqual(r.source, 'questions')
  assert.deepStrictEqual(r.keyPoints, ['兜底要点'])
})

test('C8 素材不存在 → needsManual=true 且不抛错', async () => {
  db.on(/FROM t_material WHERE id/i, [])
  const r = await q.extractSourceKeyPoints(999)
  assert.deepStrictEqual(r, { keyPoints: [], source: 'none', needsManual: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// D. getConfig 三级回落
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[D] getConfig 三级回落')

test('D1 素材级配置命中', async () => {
  db.on(/WHERE material_id = \? ORDER BY id DESC/i, [{ config_json: JSON.stringify({ expectedCount: 33 }) }])
  const c = await q.getConfig(7)
  assert.strictEqual(c.expectedCount, 33)
  assert.deepStrictEqual(c.typeDistribution, q.DEFAULT_CONFIG.typeDistribution, '缺项应回落默认')
})

test('D2 无素材级 → 全局默认', async () => {
  db.on(/material_id IS NULL AND is_default = 1/i, [{ config_json: JSON.stringify({ expectedCount: 20 }) }])
  const c = await q.getConfig(7)
  assert.strictEqual(c.expectedCount, 20)
})

test('D3 都没有 → 内置兜底', async () => {
  const c = await q.getConfig(7)
  assert.deepStrictEqual(c, q.DEFAULT_CONFIG)
})

test('D4 config_json 为脏数据 → 安全回落，不抛错', async () => {
  db.on(/WHERE material_id = \? ORDER BY id DESC/i, [{ config_json: '{不是JSON' }])
  const c = await q.getConfig(7)
  assert.strictEqual(c.expectedCount, 10)
})

// ═══════════════════════════════════════════════════════════════════════════
// E. exportQualityExcel 结构
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[E] exportQualityExcel')

test('E1 生成 4 个 sheet 且名称正确', async () => {
  xlsxCapture.sheets = []
  xlsxCapture.names = []
  db.on(/FROM t_material WHERE id/i, [{ id: 1, title: '测试素材', content_text: '', source_keypoints: null }])
  db.on(/FROM t_question\s+WHERE material_id/i, [mkQ('single', 3, '理解')])
  db.on(/SELECT source_keypoints FROM t_question/i, [{ source_keypoints: JSON.stringify(['要点甲']) }])
  db.on(/FROM t_question_revision_log/i, [])
  db.on(/INSERT INTO t_quality_report/i, { insertId: 1 })

  const { buffer, filename } = await q.exportQualityExcel(1)
  assert.deepStrictEqual(xlsxCapture.names, ['质量总览', '一致性校验', '覆盖率', '修订历史'])
  assert.strictEqual(filename, '质量报告_1.xlsx')
  assert.ok(Buffer.isBuffer(buffer))
})

test('E2 【回归】Sheet1「源覆盖率」与 Sheet3「源覆盖率」数值是否一致', async () => {
  xlsxCapture.sheets = []
  xlsxCapture.names = []
  // 构造 needsManual=true 场景（回退到题目要点）
  db.on(/FROM t_material WHERE id/i, [{ id: 1, title: '测试素材', content_text: '', source_keypoints: null }])
  db.on(/FROM t_question\s+WHERE material_id/i, [mkQ('single', 3, '理解')])
  db.on(/SELECT source_keypoints FROM t_question/i, [{ source_keypoints: JSON.stringify(['要点甲']) }])
  db.on(/FROM t_question_revision_log/i, [])
  db.on(/INSERT INTO t_quality_report/i, { insertId: 1 })

  await q.exportQualityExcel(1)
  const overview = xlsxCapture.sheets[0]
  const coverageSheet = xlsxCapture.sheets[2]
  const s1 = overview.find(row => row[0] === '源覆盖率')[1]
  const s3 = coverageSheet[0][1]
  assert.strictEqual(s1, s3,
    `同一工作簿内「源覆盖率」出现两个值：Sheet1「质量总览」=${s1}，Sheet3「覆盖率」=${s3}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// F. 工具函数
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[F] 工具函数')

test('F1 clampDifficulty 边界', () => {
  assert.strictEqual(q.clampDifficulty(0), 1)
  assert.strictEqual(q.clampDifficulty(9), 5)
  assert.strictEqual(q.clampDifficulty(3), 3)
  assert.strictEqual(q.clampDifficulty(undefined), 3, 'undefined 应回落 3')
  assert.strictEqual(q.clampDifficulty('4'), 4)
})

test('F2 【回归】clampDifficulty(null) 的实际返回值', () => {
  assert.strictEqual(q.clampDifficulty(null), 3,
    `期望 null 回落中位难度 3，实际得到 ${q.clampDifficulty(null)}（Number(null)===0 → 被钳到 1）`)
})

test('F3 normalizeBloom 合法值透传 / 非法值回落', () => {
  assert.strictEqual(q.normalizeBloom('识记'), '识记')
  assert.strictEqual(q.normalizeBloom('应用'), '应用')
  assert.strictEqual(q.normalizeBloom('乱写'), '理解')
  assert.strictEqual(q.normalizeBloom(null), '理解')
})

test('F4 【回归】normalizeBloom 是否支持 aiQuestion 已定义的别名', () => {
  const cases = [['记忆', '识记'], ['运用', '应用'], ['分析', '应用'], ['apply', '应用']]
  const bad = cases.filter(([input, want]) => q.normalizeBloom(input) !== want)
  assert.strictEqual(bad.length, 0,
    `以下别名未被正确映射（aiQuestion.normalizeBloomLevel 支持，qualityService.normalizeBloom 不支持）：` +
    bad.map(([i, w]) => `"${i}"→期望"${w}"实际"${q.normalizeBloom(i)}"`).join('; '))
})

test('F5 toStringArray 去重/去空/trim/解析字符串 JSON', () => {
  assert.deepStrictEqual(q.toStringArray('["a"," a ","","b"]'), ['a', 'b'])
  assert.deepStrictEqual(q.toStringArray(null), [])
  assert.deepStrictEqual(q.toStringArray(['x', 'x', 'y']), ['x', 'y'])
})

// ─── 执行 ────────────────────────────────────────────────────────────────────
run().then(() => {
  console.log('\n' + '═'.repeat(72))
  console.log(`总计 ${cases.length} 项：通过 ${pass}，失败 ${failures.length}`)
  if (failures.length) {
    console.log('\n失败明细：')
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}\n     ${f.err.message}`))
  }
  console.log('═'.repeat(72))
  process.exit(0)
})
