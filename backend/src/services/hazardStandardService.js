/**
 * 隐患排查标准服务 —— 底层数据「隐患排查标准库」（t_hazard_check_standard）
 *
 * 与「安全违章依据库」(standardBasisService → t_violation) 并列，结构不同：
 *   排查手册 = 管理类别 / 检查内容 / 检查标准 / 责任岗位 / 排查频次 + 适用区域/排查项目
 *
 * 对外能力（与 standardBasis 命名对齐，便于前端一致调用）：
 *   listLibrary / getById / create / update / remove
 *   importLibrary(rows)      UPSERT 导入（按 code 幂等；code 由内容确定性生成）
 *   exportLibrary()          导出数据
 *   generateLibraryTemplate() 下载模板（xlsx buffer，列对齐导入表头）
 *   matchStandardDb(pool, {category})  单条 DB 模糊匹配（预留：隐患录入自动带标准）
 */

const XLSX = require('xlsx')
const { pool } = require('../db/db')
const crypto = require('crypto')

const SELECT_COLS = `
  id, code, area, category, manage_category, check_item,
  check_standard, responsible_post, frequency, source_file, sort_order,
  created_at, updated_at
`

// 确定性 code：内容相同 → code 相同 → UPSERT 幂等（避免重复导入产生副本）
function genContentCode(area, category, checkItem, checkStandard) {
  const raw = [area || '', category || '', checkItem || '', checkStandard || ''].join('')
  const h = crypto.createHash('md5').update(raw, 'utf8').digest('hex')
  return 'HS' + h.slice(0, 8)
}

// 手工新增行 code（不参与内容幂等）
function genManualCode() {
  return 'M' + Date.now() + '_' + Math.floor(Math.random() * 1000)
}

// 去除「数字序号 + 分隔符」前缀（如 "1. 检查…" / "2、检查…" / "（1）检查…"）。
// 关键：小数点后的数字不视为序号（如 "1.5米" 必须保留），故点号后须为非数字或仅空白。
const SEQ_PREFIX_RE = /^(?:[\s　]*\d+[.．](?![0-9])[\s　]*|[\s　]*\d+[、)）。][\s　]*|[\s　]*[（(]\d+[)）][\s　]*)/

function stripSeqPrefix(str) {
  if (str === null || str === undefined) return str
  return String(str).replace(SEQ_PREFIX_RE, '').trim()
}

// ─── 列表（支持 适用区域 / 排查项目 / 管理类别 过滤）────────────────────────────
async function listLibrary({ page = 1, pageSize = 50, keyword = '', area = '', category = '', manageCategory = '' } = {}) {
  const p = Number(page) || 1
  const ps = Math.min(Math.max(Number(pageSize) || 50, 1), 200)
  const offset = (p - 1) * ps
  const where = []
  const params = []
  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`
    where.push('(code LIKE ? OR area LIKE ? OR category LIKE ? OR manage_category LIKE ? OR check_item LIKE ? OR check_standard LIKE ? OR responsible_post LIKE ? OR frequency LIKE ? OR source_file LIKE ?)')
    params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw)
  }
  if (area && area.trim()) { where.push('area = ?'); params.push(area.trim()) }
  if (category && category.trim()) { where.push('category = ?'); params.push(category.trim()) }
  if (manageCategory && manageCategory.trim()) { where.push('manage_category = ?'); params.push(manageCategory.trim()) }
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM t_hazard_check_standard ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY area, category, id LIMIT ${ps} OFFSET ${offset}`,
    params
  )
  const [cnt] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_hazard_check_standard ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  )
  return { list: rows, total: cnt[0].total, page: p, pageSize: ps }
}

async function getById(id) {
  const [rows] = await pool.execute(`SELECT ${SELECT_COLS} FROM t_hazard_check_standard WHERE id = ?`, [id])
  return rows[0] || null
}

async function create(patch = {}) {
  const area = String(patch.area == null ? '' : patch.area).trim()
  const category = String(patch.category == null ? '' : patch.category).trim()
  const checkItem = stripSeqPrefix(patch.check_item == null ? (patch.checkItem == null ? '' : patch.checkItem) : patch.check_item)
  const checkStandard = stripSeqPrefix(patch.check_standard == null ? (patch.checkStandard == null ? '' : patch.checkStandard) : patch.check_standard)
  if (!checkItem) throw new Error('检查内容不能为空')
  if (!checkStandard) throw new Error('检查标准不能为空')
  const code = (patch.code && String(patch.code).trim()) ? String(patch.code).trim() : genManualCode()
  const [res] = await pool.execute(
    `INSERT INTO t_hazard_check_standard
       (code, area, category, manage_category, check_item, check_standard, responsible_post, frequency, source_file, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      code,
      area,
      category,
      String(patch.manage_category == null ? '' : patch.manage_category).trim(),
      checkItem,
      checkStandard,
      String(patch.responsible_post == null ? '' : patch.responsible_post).trim(),
      String(patch.frequency == null ? '' : patch.frequency).trim(),
      String(patch.source_file == null ? '' : patch.source_file).trim(),
    ]
  )
  return getById(res.insertId)
}

async function update(id, patch = {}) {
  const map = {
    code: 'code', area: 'area', category: 'category', manage_category: 'manage_category',
    check_item: 'check_item', check_standard: 'check_standard',
    responsible_post: 'responsible_post', frequency: 'frequency', source_file: 'source_file',
  }
  const fields = []
  const params = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue
    let v = String(patch[k]).trim()
    if (k === 'check_item' || k === 'check_standard') v = stripSeqPrefix(v)
    if (k === 'check_item' && !v) throw new Error('检查内容不能为空')
    if (k === 'check_standard' && !v) throw new Error('检查标准不能为空')
    fields.push(`${col} = ?`)
    params.push(v)
  }
  if (!fields.length) throw new Error('未提供任何可更新字段')
  params.push(id)
  await pool.execute(`UPDATE t_hazard_check_standard SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params)
  return getById(id)
}

async function remove(id) {
  await pool.execute('DELETE FROM t_hazard_check_standard WHERE id = ?', [id])
  return true
}

// ─── 导入（UPSERT，按 code 幂等；code 由内容确定性生成）──────────────────────
/**
 * @param {Array} rows  解析后的行对象（英文字段名，见 generateLibraryTemplate 表头映射）
 * @returns {Promise<{success:Array, fail:Array}>}
 */
async function importLibrary(rows) {
  const success = []
  const fail = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const area = String(r.area == null ? '' : r.area).trim()
    const category = String(r.category == null ? '' : r.category).trim()
    const checkItem = stripSeqPrefix(r.check_item == null ? (r.checkItem == null ? '' : r.checkItem) : r.check_item)
    const checkStandard = stripSeqPrefix(r.check_standard == null ? (r.checkStandard == null ? '' : r.checkStandard) : r.check_standard)
    const manageCategory = String(r.manage_category == null ? (r.manageCategory == null ? '' : r.manageCategory) : r.manage_category).trim()
    const responsiblePost = String(r.responsible_post == null ? (r.responsiblePost == null ? '' : r.responsiblePost) : r.responsible_post).trim()
    const frequency = String(r.frequency == null ? '' : r.frequency).trim()
    const sourceFile = String(r.source_file == null ? (r.sourceFile == null ? '' : r.sourceFile) : r.source_file).trim()

    if (!checkItem) { fail.push({ row: i + 2, reason: '检查内容为空', raw: r }); continue }
    if (!checkStandard) { fail.push({ row: i + 2, reason: '检查标准为空', raw: r }); continue }
    // 已有 code 优先（同一份预览二次导入稳定），否则按内容生成
    const code = (r.code && String(r.code).trim()) ? String(r.code).trim() : genContentCode(area, category, checkItem, checkStandard)
    try {
      await pool.execute(
        `INSERT INTO t_hazard_check_standard
           (code, area, category, manage_category, check_item, check_standard, responsible_post, frequency, source_file, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           area=VALUES(area), category=VALUES(category), manage_category=VALUES(manage_category),
           check_item=VALUES(check_item), check_standard=VALUES(check_standard),
           responsible_post=VALUES(responsible_post), frequency=VALUES(frequency),
           source_file=VALUES(source_file), updated_at=NOW()`,
        [code, area, category, manageCategory, checkItem, checkStandard, responsiblePost, frequency, sourceFile]
      )
      success.push({ code, area, category, checkItem: checkItem.slice(0, 30) })
    } catch (e) {
      fail.push({ row: i + 2, reason: e.message, raw: r })
    }
  }
  return { success, fail }
}

// ─── 导出 ────────────────────────────────────────────────────────────────────
async function exportLibrary() {
  const [rows] = await pool.execute(
    'SELECT code, area, category, manage_category, check_item, check_standard, responsible_post, frequency, source_file FROM t_hazard_check_standard ORDER BY area, category, id'
  )
  return rows || []
}

async function matchStandardDb(p, arg = {}) {
  const kw = String((arg && arg.category) || '').trim()
  if (!kw) return { matched: false, data: null }
  const like = `%${kw}%`
  const [rows] = await p.execute(
    `SELECT ${SELECT_COLS}
       FROM t_hazard_check_standard
       WHERE (area LIKE ? OR category LIKE ? OR manage_category LIKE ? OR check_item LIKE ? OR check_standard LIKE ? OR responsible_post LIKE ?)
       ORDER BY (CASE WHEN category LIKE ? THEN 0 ELSE 1 END), id
       LIMIT 5`,
    [like, like, like, like, like, like, like]
  )
  if (rows && rows.length) return { matched: true, data: rows }
  return { matched: false, data: null }
}

// ─── 筛选项（适用区域 / 排查项目 / 管理类别 去重列表，供前端下拉）──────────────────
async function getFilterOptions() {
  const [areas] = await pool.execute(
    "SELECT DISTINCT area FROM t_hazard_check_standard WHERE area IS NOT NULL AND area <> '' ORDER BY area"
  )
  const [cats] = await pool.execute(
    "SELECT DISTINCT category FROM t_hazard_check_standard WHERE category IS NOT NULL AND category <> '' ORDER BY category"
  )
  const [mans] = await pool.execute(
    "SELECT DISTINCT manage_category FROM t_hazard_check_standard WHERE manage_category IS NOT NULL AND manage_category <> '' ORDER BY manage_category"
  )
  return {
    areas: areas.map((r) => r.area),
    categories: cats.map((r) => r.category),
    manageCategories: mans.map((r) => r.manage_category),
  }
}

// ─── 模板 ────────────────────────────────────────────────────────────────────
function generateLibraryTemplate() {
  const headers = ['适用区域', '排查项目', '管理类别', '检查内容', '检查标准', '责任岗位', '排查频次', '来源文件']
  const sample = ['马10脱水井场', '空压机', '共性问题', '空压机运行声响', '运行平稳、无异常振动及漏油', '设备管理员', '1次/周', '马10中心站隐患排查手册']
  const ws = XLSX.utils.aoa_to_sheet([headers, sample])
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('隐患排查标准模板')
  wb.Sheets['隐患排查标准模板'] = ws
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  genContentCode,
  stripSeqPrefix,
  listLibrary,
  getById,
  create,
  update,
  remove,
  importLibrary,
  exportLibrary,
  getFilterOptions,
  matchStandardDb,
  generateLibraryTemplate,
}
