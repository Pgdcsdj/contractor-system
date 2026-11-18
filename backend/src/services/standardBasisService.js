/**
 * 问题依据库服务 —— 底层数据现为「安全违章库」（t_violation，895 条）。
 * 原 t_standard_basis 已停用（保留表，不再读取）。
 *
 * 列映射（t_violation → 对外字段，保持下游调用方无需改字段名）：
 *   category       ← 违章分类
 *   standard_basis ← 违章条款具体内容（content）
 *   source         ← 检查依据（basis）
 *   附加：code / place / sub_segment / inspect_object / deduct_level
 *
 * 匹配规则（v2026.11.18.3）：隐患排查项目 + 问题描述联合检索。
 *   全库 895 条载入内存，按 2~4 字字串 + IDF 抑制泛词 + 现场高频问题词加权打分，
 *   返回 top5 候选（含来源条款与命中词），不再因排查项目名对不上就判「未找到」。
 *
 * 对外能力（函数名与旧版一致，hazardLoop / importService / standardBasis 路由无需改动）：
 *   loadBasisLibrary(pool)
 *   matchStandardBasis(lib, {category})        纯函数内存模糊匹配
 *   matchStandardBasisDb(pool, {category})     单条 DB 模糊匹配
 *   listLibrary / getById / create / update / remove   CRUD
 *   importLibrary(rows)                         UPSERT 导入（按 code 幂等）
 *   exportLibrary()                            导出数据
 *   generateLibraryTemplate()                  下载模板（xlsx buffer，8 列）
 */

const XLSX = require('xlsx')
const { pool } = require('../db/db')

// 读取时统一别名，让下游调用方继续用 category / standard_basis / source
const SELECT_COLS = `
  id, code, place, category, sub_segment, inspect_object,
  content AS standard_basis, basis AS source, deduct_level
`

// 归一：NFKC + 小写 + 去标点空白；「标识/标志」视为同义词
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/标识/g, '标志')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

// 中文无分词：用 2~4 字字串做特征，配合全库 IDF 抑制「安全/生产/措施」等泛词
function textGrams(s) {
  const out = new Set()
  for (const n of [2, 3, 4]) {
    for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n))
  }
  return out
}

// 现场高频问题词：命中即加权，避免只按泛词排序
const SIGNAL_TERMS = [
  ['孔洞', 18], ['坠落风险', 20], ['作业平台', 18], ['操作平台', 18],
  ['安全警示标志', 15], ['静电接地', 15], ['防静电接地', 15],
  ['液位计', 15], ['盲盖', 15], ['装车', 12], ['护栏', 12], ['安全带', 12],
  ['高处作业', 12], ['动火作业', 12], ['受限空间', 12], ['吊装', 12],
  ['硫化氢', 10], ['防护罩', 10], ['临边', 10],
]
const MIN_SCORE = 3.5
const MAX_CANDIDATES = 5

function rowText(r) {
  return norm([r.category, r.sub_segment, r.inspect_object, r.standard_basis].join(' '))
}

function buildMatchIndex(lib) {
  const rows = Array.isArray(lib) ? lib : []
  const df = new Map()
  const grams = rows.map((r) => {
    const g = textGrams(rowText(r))
    for (const x of g) df.set(x, (df.get(x) || 0) + 1)
    return g
  })
  return { rows, grams, df, total: rows.length }
}

function idf(index, g) {
  return Math.log(1 + index.total / (index.df.get(g) || 1))
}

function scoreLibrary(index, arg = {}) {
  const category = norm(arg && arg.category)
  const description = norm(arg && arg.description)
  const input = norm([category, description].filter(Boolean).join(' '))
  if (!input) return { matched: false, standard_basis: '', source: '', candidates: [] }

  const inputGrams = [...textGrams(input)].filter((g) => index.df.has(g))
  const out = []
  index.rows.forEach((r, i) => {
    const rg = index.grams[i]
    const rtext = rowText(r)
    const matched = [...rg].filter((g) => inputGrams.includes(g))
    let base = 0
    for (const g of matched) base += idf(index, g) * (g.length >= 3 ? 1.4 : 1)
    const cat = norm(r.category)
    const sub = norm(r.sub_segment)
    const obj = norm(r.inspect_object)
    const place = norm(r.place)
    if (cat && input.includes(cat)) base += 8
    for (const t of String(obj || '').split(/\s+/).map(norm).filter((x) => x.length >= 2)) {
      if (input.includes(t)) base += 8
    }
    if (sub && input.includes(sub)) base += 8
    if (place && input.includes(place)) base += 2
    const terms = []
    for (const [term, w] of SIGNAL_TERMS) {
      if (input.includes(term) && rtext.includes(term)) { base += w; terms.push(term) }
    }
    let score = base / Math.sqrt(Math.max(8, rg.size))
    if (cat && category === cat) score += 20
    else if (cat && category && category.includes(cat)) score += 8
    out.push({
      score: Math.round(score * 100) / 100,
      code: r.code || '',
      category: r.category || '',
      sub_segment: r.sub_segment || '',
      inspect_object: r.inspect_object || '',
      standard_basis: r.standard_basis || '',
      source: r.source || '',
      matchedTerms: matched.slice().sort((a, b) => idf(index, b) - idf(index, a)).slice(0, 8),
      signalTerms: terms,
    })
  })
  out.sort((a, b) => b.score - a.score)
  // 同一条款在不同场所会重复入库（如 A1-305 / A8-013），候选里只留一条，给其它问题词让位
  const candidates = []
  const seenBasis = new Set()
  for (const x of out) {
    if (x.score < MIN_SCORE) break
    const key = norm(x.standard_basis)
    if (seenBasis.has(key)) continue
    seenBasis.add(key)
    candidates.push(x)
    if (candidates.length >= MAX_CANDIDATES) break
  }
  if (!candidates.length) {
    return { matched: false, standard_basis: '', source: '', candidates: [] }
  }
  const top = candidates[0]
  return {
    matched: true,
    standard_basis: top.standard_basis,
    source: top.source,
    code: top.code,
    category: top.category,
    score: top.score,
    matchedTerms: top.matchedTerms,
    signalTerms: top.signalTerms,
    candidates,
  }
}

// ─── 加载 / 匹配 ────────────────────────────────────────────────────────────
async function loadBasisLibrary(p) {
  const [rows] = await p.execute(
    `SELECT ${SELECT_COLS}
       FROM t_violation
       WHERE enabled = 1 AND content IS NOT NULL AND content <> ?
       ORDER BY category, id`,
    ['']
  )
  return rows || []
}

/** 纯函数：在已加载的库里匹配（导入 Excel 复用同一份 lib，避免重复查库） */
function matchStandardBasis(lib, arg = {}) {
  if (!Array.isArray(lib)) return { matched: false, standard_basis: '', source: '' }
  return scoreLibrary(buildMatchIndex(lib), arg)
}

let matchIndexCache = { at: 0, index: null }
async function getMatchIndex(p) {
  const now = Date.now()
  if (matchIndexCache.index && now - matchIndexCache.at < 60 * 1000) return matchIndexCache.index
  const lib = await loadBasisLibrary(p)
  const index = buildMatchIndex(lib)
  matchIndexCache = { at: now, index }
  return index
}

/** DB 版：库仅 895 条，整库载入内存打分；索引 60 秒缓存 */
async function matchStandardBasisDb(p, arg = {}) {
  const category = String((arg && arg.category) || '').trim()
  const description = String((arg && arg.description) || '').trim()
  if (!category && !description) return { matched: false, standard_basis: '', source: '' }
  return scoreLibrary(await getMatchIndex(p), { category, description })
}

// ─── 筛选项（适用场所 / 违章分类 / 扣分风险等级 去重列表）────────────────────────
async function getFilterOptions() {
  const [placeRows] = await pool.execute(
    `SELECT DISTINCT place FROM t_violation WHERE place IS NOT NULL AND place <> ? ORDER BY place`,
    ['']
  )
  const [catRows] = await pool.execute(
    `SELECT DISTINCT category FROM t_violation WHERE category IS NOT NULL AND category <> ? ORDER BY category`,
    ['']
  )
  const [dedRows] = await pool.execute(
    `SELECT DISTINCT deduct_level FROM t_violation WHERE deduct_level IS NOT NULL AND deduct_level <> ? ORDER BY deduct_level`,
    ['']
  )
  return {
    places: placeRows.map((r) => r.place),
    categories: catRows.map((r) => r.category),
    deductLevels: dedRows.map((r) => r.deduct_level),
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
async function listLibrary({ page = 1, pageSize = 50, keyword = '', place = '', category = '', deductLevel = '' } = {}) {
  const p = Number(page) || 1
  const ps = Math.min(Math.max(Number(pageSize) || 50, 1), 200)
  const offset = (p - 1) * ps
  const where = []
  const params = []
  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`
    where.push('(code LIKE ? OR place LIKE ? OR category LIKE ? OR sub_segment LIKE ? OR inspect_object LIKE ? OR content LIKE ? OR basis LIKE ? OR deduct_level LIKE ?)')
    params.push(kw, kw, kw, kw, kw, kw, kw, kw)
  }
  if (place && place.trim()) { where.push('place = ?'); params.push(place.trim()) }
  if (category && category.trim()) { where.push('category = ?'); params.push(category.trim()) }
  if (deductLevel && deductLevel.trim()) { where.push('deduct_level = ?'); params.push(deductLevel.trim()) }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM t_violation ${whereSql} ORDER BY category, id LIMIT ${ps} OFFSET ${offset}`,
    params
  )
  const [cnt] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_violation ${whereSql}`,
    params
  )
  return { list: rows, total: cnt[0].total, page: p, pageSize: ps }
}

async function getById(id) {
  const [rows] = await pool.execute(`SELECT ${SELECT_COLS} FROM t_violation WHERE id = ?`, [id])
  return rows[0] || null
}

// 生成手工新增行的唯一 code（uk_code 不可重复）
function genManualCode() {
  return 'M' + Date.now()
}

async function create(patch = {}) {
  const category = String(patch.category == null ? '' : patch.category).trim()
  const content = String(patch.standard_basis == null ? '' : patch.standard_basis).trim()
  const basis = String(patch.source == null ? '' : patch.source).trim()
  if (!category) throw new Error('违章分类不能为空')
  if (!content) throw new Error('违章条款具体内容不能为空')
  const code = (patch.code && String(patch.code).trim()) ? String(patch.code).trim() : genManualCode()
  const [res] = await pool.execute(
    `INSERT INTO t_violation (code, place, category, sub_segment, inspect_object, content, basis, deduct_level, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      code,
      String(patch.place == null ? '' : patch.place).trim(),
      category,
      String(patch.sub_segment == null ? '' : patch.sub_segment).trim(),
      String(patch.inspect_object == null ? '' : patch.inspect_object).trim(),
      content,
      basis,
      String(patch.deduct_level == null ? '' : patch.deduct_level).trim(),
    ]
  )
  return getById(res.insertId)
}

async function update(id, patch = {}) {
  // 字段映射：对外名 → 库列名
  const map = {
    code: 'code', place: 'place', category: 'category', sub_segment: 'sub_segment',
    inspect_object: 'inspect_object', standard_basis: 'content', source: 'basis', deduct_level: 'deduct_level',
  }
  const fields = []
  const params = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue
    const v = String(patch[k]).trim()
    if (k === 'category' && !v) throw new Error('违章分类不能为空')
    if (k === 'standard_basis' && !v) throw new Error('违章条款具体内容不能为空')
    fields.push(`${col} = ?`)
    params.push(v)
  }
  if (!fields.length) throw new Error('未提供任何可更新字段')
  params.push(id)
  await pool.execute(`UPDATE t_violation SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params)
  return getById(id)
}

async function remove(id) {
  await pool.execute('DELETE FROM t_violation WHERE id = ?', [id])
  return true
}

// ─── 导入（UPSERT，按 code 幂等）───────────────────────────────────────────────
/**
 * @param {Array} rows  解析后的行对象，字段见 generateLibraryTemplate 表头
 * @returns {Promise<{success:Array, fail:Array}>}
 */
async function importLibrary(rows) {
  const success = []
  const fail = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const category = String(r.category == null ? '' : r.category).trim()
    const content = String(r.standard_basis == null ? (r.content == null ? '' : r.content) : r.standard_basis).trim()
    const basis = String(r.source == null ? (r.basis == null ? '' : r.basis) : r.source).trim()
    if (!category) { fail.push({ row: i + 2, reason: '违章分类为空', raw: r }); continue }
    if (!content) { fail.push({ row: i + 2, reason: '违章条款具体内容为空', raw: r }); continue }
    const code = (r.code && String(r.code).trim()) ? String(r.code).trim() : 'M' + Date.now() + '_' + i
    try {
      await pool.execute(
        `INSERT INTO t_violation (code, place, category, sub_segment, inspect_object, content, basis, deduct_level, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           place=VALUES(place), category=VALUES(category), sub_segment=VALUES(sub_segment),
           inspect_object=VALUES(inspect_object), content=VALUES(content), basis=VALUES(basis),
           deduct_level=VALUES(deduct_level), updated_at=NOW()`,
        [
          code,
          String(r.place == null ? '' : r.place).trim(),
          category,
          String(r.sub_segment == null ? '' : r.sub_segment).trim(),
          String(r.inspect_object == null ? '' : r.inspect_object).trim(),
          content,
          basis,
          String(r.deduct_level == null ? '' : r.deduct_level).trim(),
        ]
      )
      success.push({ category, code })
    } catch (e) {
      fail.push({ row: i + 2, reason: e.message, raw: r })
    }
  }
  return { success, fail }
}

// ─── 导出 ────────────────────────────────────────────────────────────────────
async function exportLibrary() {
  const [rows] = await pool.execute(
    'SELECT code, place, category, sub_segment, inspect_object, content, basis, deduct_level FROM t_violation ORDER BY category, id'
  )
  return rows || []
}

// ─── 模板 ────────────────────────────────────────────────────────────────────
function generateLibraryTemplate() {
  const headers = ['违章编号', '适用场所', '违章分类', '细分环节', '检查对象', '违章条款具体内容', '检查依据', '扣分风险等级']
  const sample = ['A1-001', '陆上油气场站', '直接作业安全', '动火作业', '作业人员', '动火作业前应办理动火许可证，落实监护与防火措施', 'GB 30871-2022', '扣2分/高风险']
  const ws = XLSX.utils.aoa_to_sheet([headers, sample])
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('安全检查依据模板')
  wb.Sheets['安全检查依据模板'] = ws
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  norm,
  loadBasisLibrary,
  matchStandardBasis,
  matchStandardBasisDb,
  getFilterOptions,
  listLibrary,
  getById,
  create,
  update,
  remove,
  importLibrary,
  exportLibrary,
  generateLibraryTemplate,
}
