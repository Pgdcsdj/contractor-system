/**
 * 数据备份与导出服务（模块 D 后端）
 *
 * - backupNow()     全量导出 t_hazard（deleted_at IS NULL）→ backend/backups/hazard_backup_YYYYMMDD_HHMMSS.xlsx
 * - exportReport()  按选中字段 / 时间范围 / 类型（ledger|weekly|monthly）生成 Excel（含汇总行），返回 buffer
 * - listBackups()   列出 backups 目录下的备份文件
 * - pruneBackups()  删除超过保留天数的备份文件
 *
 * 导出字段白名单与中文列头严格对齐设计 §8.7；文件名格式对齐 §8.6。
 * 统计口径（§8.8）：周/月报按 created_at（录入时间）归集"新增数"，并附闭环数 / 超期数 / 责任单位排名。
 */

const fs   = require('fs')
const path = require('path')
const XLSX = require('xlsx')
const { pool } = require('../db/db')

const BACKUPS_DIR = path.resolve(__dirname, '../../backups')

// 导出字段白名单：字段编码 → 中文列头（设计 §8.7，顺序即导出列顺序）
const EXPORT_FIELDS = {
  hazard_code:       '隐患编号',
  unit_name:         '责任单位',
  hazard_level:      '隐患等级',
  description:       '隐患描述',
  location:          '场所站点',
  responsible_person: '整改责任人',
  responsible_phone: '责任人电话',
  status:            '状态',
  recorder_name:     '录入人',
  recorder_unit_name: '录入人单位',
  plan_finish_time:  '计划完成时间',
  created_at:        '录入时间',
  closed_at:         '闭环时间',
  is_overdue:        '是否超期',
  business_dept:     '业务部门',
  rectify_unit:      '整改单位',
  hazard_investigation_item: '隐患排查项目',
}

// 状态中文映射
const STATUS_LABEL = {
  reported: '已上报',
  assigned: '已分派',
  rectifying: '整改中',
  verifying: '待验收',
  closed: '已闭环',
}

// ─── 工具 ─────────────────────────────────────────────────────────────────
function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true })
  }
}

function pad2(n) { return String(n).padStart(2, '0') }

function ts() {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

// Date / 字符串 → 'YYYY-MM-DD HH:mm:ss'
function fmtDateTime(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`
  const s = String(v)
  return s.replace('T', ' ').slice(0, 19)
}

// 单元格取值（含状态/超期/日期转换）
function cellValue(code, row) {
  const v = row[code]
  if (code === 'status') return STATUS_LABEL[v] || v || ''
  if (code === 'is_overdue') return v ? '是' : '否'
  if (code === 'plan_finish_time' || code === 'created_at' || code === 'closed_at') return fmtDateTime(v)
  if (v == null) return ''
  return v
}

// 校验并过滤前端传入的字段，返回按白名单顺序排列的有效字段数组
function resolveFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  const valid = list.filter((f) => Object.prototype.hasOwnProperty.call(EXPORT_FIELDS, f))
  // 至少保留一个；无有效字段时回退到全部白名单
  return valid.length ? valid : Object.keys(EXPORT_FIELDS)
}

// 构建 AOA 数据（含表头）
function buildAOA(rows, fields) {
  const headers = fields.map((f) => EXPORT_FIELDS[f])
  const data = [headers]
  for (const row of rows) {
    data.push(fields.map((f) => cellValue(f, row)))
  }
  return data
}

// ─── backupNow：全量备份 ───────────────────────────────────────────────────
async function backupNow() {
  ensureBackupsDir()
  const [rows] = await pool.query(
    `SELECT hazard_code, unit_name, hazard_level, description, location, hazard_investigation_item,
            responsible_person, responsible_phone, status, recorder_name, recorder_unit_name,
            plan_finish_time, created_at, closed_at,
            CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END AS is_overdue
       FROM t_hazard
      WHERE deleted_at IS NULL
      ORDER BY id DESC`
  )

  // 照片 URL 作为文本列（设计 §8.7：照片以 URL 文本列呈现）
  let photoMap = {}
  if (rows.length) {
    const ids = rows.map((r) => r.id).filter(Boolean)
    if (ids.length) {
      const [photos] = await pool.query(
        'SELECT hazard_id, photo_url FROM t_hazard_photo WHERE hazard_id IN (?)',
        [ids]
      )
      photos.forEach((p) => {
        if (!photoMap[p.hazard_id]) photoMap[p.hazard_id] = []
        if (p.photo_url) photoMap[p.hazard_id].push(p.photo_url)
      })
    }
  }

  const backupCols = [
    { key: 'hazard_code', header: '隐患编号' },
    { key: 'unit_name', header: '责任单位' },
    { key: 'hazard_level', header: '隐患等级' },
    { key: 'description', header: '隐患描述' },
    { key: 'location', header: '场所站点' },
    { key: 'hazard_investigation_item', header: '隐患排查项目' },
    { key: 'responsible_person', header: '整改责任人' },
    { key: 'responsible_phone', header: '责任人电话' },
    { key: 'status', header: '状态', map: (v) => STATUS_LABEL[v] || v },
    { key: 'recorder_name', header: '录入人' },
    { key: 'recorder_unit_name', header: '录入人单位' },
    { key: 'plan_finish_time', header: '计划完成时间', date: true },
    { key: 'created_at', header: '录入时间', date: true },
    { key: 'closed_at', header: '闭环时间', date: true },
    { key: 'is_overdue', header: '是否超期', map: (v) => (v ? '是' : '否') },
    { key: 'photo_urls', header: '照片URL' },
  ]
  const headerRow = backupCols.map((c) => c.header)
  const data = [headerRow]
  for (const r of rows) {
    const photoUrls = (photoMap[r.id] || []).join('\n')
    data.push(backupCols.map((c) => {
      if (c.key === 'photo_urls') return photoUrls
      if (c.map) return c.map(r[c.key])
      if (c.date) return fmtDateTime(r[c.key])
      return r[c.key] == null ? '' : r[c.key]
    }))
  }

  const filename = `hazard_backup_${ts()}.xlsx`
  const filepath = path.join(BACKUPS_DIR, filename)
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('隐患备份')
  wb.Sheets['隐患备份'] = XLSX.utils.aoa_to_sheet(data)
  XLSX.writeFile(wb, filepath)

  return { filename, count: rows.length, filepath }
}

// ─── exportReport：选字段 / 周报 / 月报导出 ─────────────────────────────────
async function exportReport(opts = {}) {
  const type = ['ledger', 'weekly', 'monthly'].includes(opts.type) ? opts.type : 'ledger'
  const fields = resolveFields(opts.fields)
  const where = ['deleted_at IS NULL']
  const params = []

  // ── 时间范围（全部类型统一）──
  const range = opts.range || {}
  if (!range.all) {
    if (range.start) {
      where.push('created_at >= ?')
      params.push(String(range.start) + ' 00:00:00')
    }
    if (range.end) {
      where.push('created_at <= ?')
      params.push(String(range.end) + ' 23:59:59')
    }
  }

  // ── 筛选条件 ──
  const filters = opts.filters || {}
  const TEXT_FILTERS = ['rectify_unit', 'location'] // 模糊匹配
  const EXACT_FILTERS = ['status', 'business_dept', 'hazard_level', 'hazard_investigation_item'] // 精确匹配
  for (const k of TEXT_FILTERS) {
    const v = filters[k]
    if (v != null && String(v).trim() !== '') {
      where.push(`${k} LIKE ?`)
      params.push('%' + String(v).trim() + '%')
    }
  }
  for (const k of EXACT_FILTERS) {
    const v = filters[k]
    if (v != null && String(v).trim() !== '') {
      where.push(`${k} = ?`)
      params.push(String(v).trim())
    }
  }

  // 选择列：白名单字段 + is_overdue 计算（status/unit_name 已在白名单内，足以支撑汇总）
  const selectList = Object.keys(EXPORT_FIELDS).map((code) =>
    code === 'is_overdue'
      ? `CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END AS is_overdue`
      : code
  ).join(', ')

  const [rows] = await pool.query(
    `SELECT ${selectList} FROM t_hazard WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    params
  )

  const aoa = buildAOA(rows, fields)

  // 周/月报：末尾追加汇总行（设计 §8.8）
  if (type !== 'ledger') {
    const newCount = rows.length
    const closedCount = rows.filter((r) => r.status === 'closed').length
    const overdueCount = rows.filter((r) => r.is_overdue === 1).length
    const unitRank = {}
    rows.forEach((r) => {
      const u = r.unit_name || '未标注'
      unitRank[u] = (unitRank[u] || 0) + 1
    })
    const ranked = Object.entries(unitRank).sort((a, b) => b[1] - a[1]).slice(0, 10)

    const blank = new Array(fields.length).fill('')
    const withLabel = (label, val) => {
      const row = new Array(fields.length).fill('')
      row[0] = label
      row[1] = val
      return row
    }
    aoa.push(blank)
    aoa.push(withLabel('新增隐患数', newCount))
    aoa.push(withLabel('闭环隐患数', closedCount))
    aoa.push(withLabel('超期隐患数', overdueCount))
    ranked.forEach(([u, c], i) => aoa.push(withLabel(`责任单位排名${i + 1}`, `${u}：${c} 条`)))
  }

  const wb = XLSX.utils.book_new()
  const sheetName = type === 'ledger' ? '隐患台账' : type === 'weekly' ? '隐患周报' : '隐患月报'
  wb.SheetNames.push(sheetName)
  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(aoa)
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  // 文件名（设计 §8.6）
  let filename
  const fmt = (s) => {
    if (!s) return ts()
    const d = new Date(String(s).replace(' ', 'T'))
    return isNaN(d.getTime()) ? String(s).replace(/[^0-9]/g, '').slice(0, 8) : `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  }
  if (type === 'ledger') {
    filename = `隐患台账_${ts()}.xlsx`
  } else if (type === 'weekly') {
    filename = `隐患周报_${fmt(range.start)}_${fmt(range.end)}.xlsx`
  } else {
    const d = range.start ? new Date(String(range.start).replace(' ', 'T')) : new Date()
    const ym = isNaN(d.getTime()) ? ts() : `${d.getFullYear()}${pad2(d.getMonth() + 1)}`
    filename = `隐患月报_${ym}.xlsx`
  }

  return { buffer, filename, count: rows.length }
}

// ─── listBackups：列出备份文件 ─────────────────────────────────────────────
function listBackups() {
  ensureBackupsDir()
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.xlsx'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f))
        return { filename: f, size: stat.size, created_at: fmtDateTime(stat.mtime) }
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    return files
  } catch {
    return []
  }
}

// ─── pruneBackups：清理超过保留天数的备份（P2）─────────────────────────────
function pruneBackups(retentionDays = 30) {
  ensureBackupsDir()
  const cutoff = Date.now() - Number(retentionDays) * 86400000
  let removed = 0
  try {
    const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.xlsx'))
    for (const f of files) {
      const fp = path.join(BACKUPS_DIR, f)
      const stat = fs.statSync(fp)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp)
        removed++
      }
    }
  } catch (e) {
    console.error('[backup] 清理备份失败（已忽略）:', e.message)
  }
  return removed
}

module.exports = { backupNow, exportReport, listBackups, pruneBackups }
