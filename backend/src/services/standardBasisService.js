/**
 * 问题依据库服务（标准依据条款）
 *
 * 匹配规则（已锁定：无 keyword，纯按排查项目分类相等匹配）：
 *   隐患的 hazard_investigation_item（排查项目）== 库里某行 category（全等，忽略前后空格/大小写）即命中，
 *   取该行的 standard_basis / source。
 *
 * 对外能力：
 *   loadBasisLibrary(pool)            预载全库（importService 批量导入时用）
 *   matchStandardBasis(lib, {category})  纯函数内存匹配
 *   matchStandardBasisDb(pool, {category}) 单条 DB 查询匹配
 *   listLibrary / getById / create / update / remove   CRUD
 *   importLibrary(rows)               UPSERT 导入（按 category 幂等）
 *   exportLibrary()                   导出数据
 *   generateLibraryTemplate()         下载模板（xlsx buffer）
 */

const XLSX = require('xlsx')
const { pool } = require('../db/db')

// 归一：去前后空格 + 小写（保留内部空格，避免过度归一）
function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
}

// ─── 加载 / 匹配 ────────────────────────────────────────────────────────────
async function loadBasisLibrary(p) {
  const [rows] = await p.execute(
    'SELECT id, category, standard_basis, source FROM t_standard_basis WHERE standard_basis <> ? ORDER BY sort_order, id',
    ['']
  )
  return rows || []
}

/**
 * 纯函数：在已加载的库里按 category 全等匹配
 * @param {Array} lib  loadBasisLibrary 的结果
 * @param {Object} arg { category }
 * @returns {Object}   { matched, standard_basis, source, method }
 */
function matchStandardBasis(lib, arg = {}) {
  const cat = norm(arg && arg.category)
  if (!cat || !Array.isArray(lib)) return { matched: false, standard_basis: '', source: '' }
  for (const r of lib) {
    if (norm(r.category) === cat) {
      return { matched: true, standard_basis: r.standard_basis || '', source: r.source || '' }
    }
  }
  return { matched: false, standard_basis: '', source: '' }
}

async function matchStandardBasisDb(p, arg = {}) {
  const cat = String((arg && arg.category) || '').trim()
  if (!cat) return { matched: false, standard_basis: '', source: '' }
  const [rows] = await p.execute(
    'SELECT id, category, standard_basis, source FROM t_standard_basis WHERE category = ? AND standard_basis <> ? LIMIT 1',
    [cat, '']
  )
  if (rows && rows.length) {
    const r = rows[0]
    return { matched: true, standard_basis: r.standard_basis || '', source: r.source || '' }
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
    where.push('(category LIKE ? OR standard_basis LIKE ? OR source LIKE ?)')
    const kw = `%${keyword.trim()}%`
    params.push(kw, kw, kw)
  }
  const [rows] = await pool.execute(
    `SELECT id, category, standard_basis, source, sort_order, created_at, updated_at
       FROM t_standard_basis
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sort_order, id
       LIMIT ${ps} OFFSET ${offset}`,
    params
  )
  const [cnt] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_standard_basis ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  )
  return { list: rows, total: cnt[0].total, page: p, pageSize: ps }
}

async function getById(id) {
  const [rows] = await pool.execute(
    'SELECT id, category, standard_basis, source, sort_order FROM t_standard_basis WHERE id = ?',
    [id]
  )
  return rows[0] || null
}

async function create({ category, standard_basis, source = '', sort_order = 0 }) {
  if (!category || !category.trim()) throw new Error('排查项目（category）不能为空')
  if (!standard_basis || !standard_basis.trim()) throw new Error('标准依据不能为空')
  const [res] = await pool.execute(
    `INSERT INTO t_standard_basis (category, standard_basis, source, sort_order)
     VALUES (?, ?, ?, ?)`,
    [category.trim(), standard_basis.trim(), (source || '').trim(), Number(sort_order) || 0]
  )
  return getById(res.insertId)
}

async function update(id, { category, standard_basis, source, sort_order }) {
  const fields = []
  const params = []
  if (category !== undefined) {
    if (!category.trim()) throw new Error('排查项目（category）不能为空')
    fields.push('category = ?'); params.push(category.trim())
  }
  if (standard_basis !== undefined) {
    if (!standard_basis.trim()) throw new Error('标准依据不能为空')
    fields.push('standard_basis = ?'); params.push(standard_basis.trim())
  }
  if (source !== undefined) { fields.push('source = ?'); params.push((source || '').trim()) }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(Number(sort_order) || 0) }
  if (!fields.length) throw new Error('未提供任何可更新字段')
  params.push(id)
  await pool.execute(`UPDATE t_standard_basis SET ${fields.join(', ')} WHERE id = ?`, params)
  return getById(id)
}

async function remove(id) {
  await pool.execute('DELETE FROM t_standard_basis WHERE id = ?', [id])
  return true
}

// ─── 导入（UPSERT，按 category 幂等）─────────────────────────────────────────
/**
 * @param {Array} rows  解析后的行对象数组，每行形如 { category, standard_basis, source }
 * @returns {Promise<{success:Array, fail:Array}>}
 */
async function importLibrary(rows) {
  const success = []
  const fail = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const category = String(r.category == null ? '' : r.category).trim()
    const basis = String(r.standard_basis == null ? '' : r.standard_basis).trim()
    if (!category) { fail.push({ row: i + 2, reason: '排查项目为空', raw: r }); continue }
    if (!basis) { fail.push({ row: i + 2, reason: '标准依据为空', raw: r }); continue }
    try {
      await pool.execute(
        `INSERT INTO t_standard_basis (category, standard_basis, source, sort_order)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE standard_basis = VALUES(standard_basis), source = VALUES(source), updated_at = NOW()`,
        [category, basis, String(r.source == null ? '' : r.source).trim()]
      )
      success.push({ category, standard_basis: basis })
    } catch (e) {
      fail.push({ row: i + 2, reason: e.message, raw: r })
    }
  }
  return { success, fail }
}

// ─── 导出 ────────────────────────────────────────────────────────────────────
async function exportLibrary() {
  const [rows] = await pool.execute(
    'SELECT category, standard_basis, source, sort_order FROM t_standard_basis ORDER BY sort_order, id'
  )
  return rows || []
}

// ─── 模板 ────────────────────────────────────────────────────────────────────
function generateLibraryTemplate() {
  const headers = ['排查项目', '标准依据', '来源标准']
  const sample = ['动火作业', '动火作业前应办理动火证，落实监护与防火措施', 'GB 30871-2022']
  const ws = XLSX.utils.aoa_to_sheet([headers, sample])
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('问题依据库模板')
  wb.Sheets['问题依据库模板'] = ws
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
