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
 * 匹配规则（关键词模糊）：隐患排查项目 / 问题描述 作为关键词，
 *   在 category/sub_segment/inspect_object/content/basis/code 中 LIKE 搜索，
 *   优先返回 category 命中的行（对齐原「按排查项目匹配」语义）。
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

// 归一：去前后空格 + 小写（仅用于内存模糊匹配比较）
function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
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

// 行内任意字段是否包含关键词
function kwHit(row, k) {
  return [row.category, row.sub_segment, row.inspect_object, row.standard_basis, row.source, row.code, row.place, row.deduct_level]
    .some((f) => norm(f).includes(k))
}

/**
 * 纯函数：在已加载的库里按关键词模糊匹配（category 命中优先）
 * @returns {Object} { matched, standard_basis, source, code, category }
 */
function matchStandardBasis(lib, arg = {}) {
  const kw = (arg && arg.category) || ''
  if (!kw || !Array.isArray(lib)) return { matched: false, standard_basis: '', source: '' }
  const k = norm(kw)
  let hit = lib.find((r) => norm(r.category).includes(k)) // 违章分类优先
  if (!hit) hit = lib.find((r) => kwHit(r, k))
  if (hit) {
    return { matched: true, standard_basis: hit.standard_basis || '', source: hit.source || '', code: hit.code, category: hit.category }
  }
  return { matched: false, standard_basis: '', source: '' }
}

async function matchStandardBasisDb(p, arg = {}) {
  const kw = String((arg && arg.category) || '').trim()
  if (!kw) return { matched: false, standard_basis: '', source: '' }
  const like = `%${kw}%`
  const [rows] = await p.execute(
    `SELECT ${SELECT_COLS}
       FROM t_violation
       WHERE enabled = 1
         AND (category LIKE ? OR sub_segment LIKE ? OR inspect_object LIKE ?
              OR content LIKE ? OR basis LIKE ? OR code LIKE ?)
       ORDER BY (CASE WHEN category LIKE ? THEN 0 ELSE 1 END), id
       LIMIT 1`,
    [like, like, like, like, like, like, like]
  )
  if (rows && rows.length) {
    const r = rows[0]
    return { matched: true, standard_basis: r.standard_basis || '', source: r.source || '', code: r.code, category: r.category }
  }
  return { matched: false, standard_basis: '', source: '' }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
async function listLibrary({ page = 1, pageSize = 50, keyword = '' } = {}) {
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
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM t_violation ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, id LIMIT ${ps} OFFSET ${offset}`,
    params
  )
  const [cnt] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_violation ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
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
  wb.SheetNames.push('安全违章依据库模板')
  wb.Sheets['安全违章依据库模板'] = ws
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  norm,
  loadBasisLibrary,
  matchStandardBasis,
  matchStandardBasisDb,
  listLibrary,
  getById,
  create,
  update,
  remove,
  importLibrary,
  exportLibrary,
  generateLibraryTemplate,
}
