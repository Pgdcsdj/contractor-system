/**
 * 承包商安全活动 · 公共服务层
 *
 * 关键设计：管理员上传的「标准表」格式每期不同 → 系统不写死列名，
 * 而是在创建期次时解析出 columns_json = { columns, headerRowIndex, templateRows }：
 *   - columns        标准表列头（动态列定义）
 *   - templateRows   标准表原始数据行（下发问题库，用于识别「未修改行」）
 * 承包商回填上传时，按 columns 定位表头，逐行读取；跳过全空行、跳过与
 * templateRows 完全一致的行（即各队上传完整清单但只填了几行的情况）。
 * 汇总时按 columns 列序把全部单位的明细 UNION 成一张表。
 */
const xlsx = require('xlsx')

// ─── 单元格/表头清洗 ───────────────────────────────────────────────────────
function cleanCell(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return fmtDT(v).slice(0, 10)
  return String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 日期统一展示（避免 mysql2 Date → JSON UTC 字符串导致的 8 小时偏移）。
 * Date 对象按 Node 本地时区取墙上时间（与 mysql2 timezone=local 的解释一致）；
 * 已是 'YYYY-MM-DD HH:mm:ss' 的字符串直接截断；ISO 串按本地时区还原。
 */
function fmtDT(v, withSec = true) {
  if (!v) return ''
  const p = (n) => String(n).padStart(2, '0')
  const fromDate = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${withSec ? ':' + p(d.getSeconds()) : ''}`
  if (v instanceof Date) return fromDate(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, withSec ? 19 : 16)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, withSec ? 19 : 16)
  return fromDate(d)
}
function cleanHeader(v) {
  return cleanCell(v).replace(/\s/g, '')
}

/** 探测表头行：前 12 行里找「文本列最多 + 含表头关键词」的一行 */
function detectHeaderRow(aoa) {
  const limit = Math.min(aoa.length, 12)
  let best = -1
  let bestScore = 0
  for (let i = 0; i < limit; i++) {
    const row = (aoa[i] || []).map(cleanHeader).filter(Boolean)
    if (row.length < 2) continue
    const joined = row.join('|')
    let score = row.length
    if (/序号|编号|序/.test(joined)) score += 5
    if (/问题|描述|内容|单位|时间|责任|专业|要素|整改|验收|程度|排查/.test(joined)) score += 3
    if (row.every((c) => /^\d+$/.test(c))) score -= 8
    if (score > bestScore) { bestScore = score; best = i }
  }
  return best
}

/** 列名去重（同名追加序号），返回 [{ key, label }] */
function normalizeColumns(rawHeaders) {
  const used = {}
  return rawHeaders.map((h, i) => {
    let label = cleanHeader(h) || `列${i + 1}`
    if (used[label]) { used[label] += 1; label = `${label}(${used[label]})` }
    else used[label] = 1
    return { key: label, label }
  })
}

/**
 * 解析管理员上传的标准表
 * @returns {{ columns: string[], headerRowIndex: number, templateRows: string[][] }}
 */
function parseStandardWorkbook(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new Error('标准表没有可读取的工作表')
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
  if (!aoa.length) throw new Error('标准表为空')

  const headerRowIndex = detectHeaderRow(aoa)
  if (headerRowIndex < 0) throw new Error('未能识别标准表表头行，请检查文件格式')

  const raw = aoa[headerRowIndex] || []
  // 去掉尾部空列
  let last = raw.length - 1
  while (last >= 0 && !cleanHeader(raw[last])) last -= 1
  const headers = raw.slice(0, last + 1)
  if (headers.length < 2) throw new Error('标准表列数不足（至少需要 2 列）')
  const columns = normalizeColumns(headers).map((c) => c.key)

  const templateRows = []
  for (let i = headerRowIndex + 1; i < aoa.length; i++) {
    const arr = []
    for (let j = 0; j < columns.length; j++) arr.push(cleanCell((aoa[i] || [])[j]))
    if (arr.some(Boolean)) templateRows.push(arr)
  }
  return { columns, headerRowIndex, templateRows }
}

/** 把一行数组规整成固定长度字符串数组 */
function normalizeRow(arr, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(cleanCell((arr || [])[i]))
  return out
}

/**
 * 解析承包商回填的 Excel
 * @param {Buffer} buffer
 * @param {{ columns, headerRowIndex, templateRows }} def 标准表定义
 * @returns {{ rows: object[], skipped: number, headerMatched: boolean }}
 */
function parseFilledWorkbook(buffer, def) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new Error('上传文件没有可读取的工作表')
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })

  const columns = def.columns || []
  const n = columns.length
  // 定位表头行：优先按列名全匹配，退化为关键词探测
  let headerIdx = -1
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = (aoa[i] || []).map(cleanHeader)
    const hit = columns.filter((c) => row.includes(c)).length
    if (hit >= Math.max(2, Math.ceil(n * 0.6))) { headerIdx = i; break }
  }
  const headerMatched = headerIdx >= 0
  if (headerIdx < 0) headerIdx = detectHeaderRow(aoa)
  if (headerIdx < 0) throw new Error('未能定位填报表头，请下载系统模板后填写再上传')

  // 若上传表的列名与标准表一致（只是顺序不同），建立列映射；否则按位置取
  const upHeaders = (aoa[headerIdx] || []).map(cleanHeader)
  const colMap = columns.map((c, idx) => {
    const at = upHeaders.indexOf(c)
    return at >= 0 ? at : idx
  })

  const tplSet = new Set((def.templateRows || []).map((r) => normalizeRow(r, n).join('\u0001')))
  const rows = []
  let skipped = 0
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const raw = aoa[i] || []
    const arr = colMap.map((at) => cleanCell(raw[at]))
    if (!arr.some(Boolean)) { skipped += 1; continue }
    // 与标准表原始问题库完全一致 = 该队没填这一行 → 跳过
    if (tplSet.has(arr.join('\u0001'))) { skipped += 1; continue }
    // 表头重复行（各队复制粘贴时会带）→ 跳过
    if (columns.filter((c, idx) => arr[idx] === c).length >= Math.max(2, Math.ceil(n * 0.6))) { skipped += 1; continue }
    const obj = {}
    columns.forEach((c, idx) => { obj[c] = arr[idx] })
    rows.push(obj)
  }
  return { rows, skipped, headerMatched }
}

/** 生成「下发标准表」（表头 + 原始问题库行），供承包商对照填写 */
function buildTemplateWorkbook(def, title) {
  const aoa = []
  if (title) aoa.push([title])
  aoa.push(def.columns)
  ;(def.templateRows || []).forEach((r) => aoa.push(r))
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  ws['!cols'] = def.columns.map((c) => ({ wch: Math.min(46, Math.max(12, c.length * 2 + 8)) }))
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '排查填报')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/** 生成「空白填报模板」（仅表头），供在线/线下少量填报 */
function buildBlankWorkbook(def, title) {
  return buildTemplateWorkbook({ columns: def.columns, templateRows: [] }, title)
}

/**
 * 汇总导出：所有单位明细 UNION 成一张表，追加系统列
 * @param {Array} rows [{ unit_name, grid_l2, uploader_name, submitted_at, source, row_json }]
 */
function buildSummaryWorkbook(def, rows, periodTitle) {
  const columns = def.columns || []
  const sysCols = ['填报单位', '二级板块', '上报人', '上报时间', '来源']
  const header = [...sysCols, ...columns]
  const aoa = []
  if (periodTitle) aoa.push([`${periodTitle} · 类比排查汇总表`])
  aoa.push(header)
  rows.forEach((r) => {
    let obj = {}
    try { obj = typeof r.row_json === 'string' ? JSON.parse(r.row_json || '{}') : (r.row_json || {}) } catch (e) { obj = {} }
    aoa.push([
      r.unit_name || '', r.grid_l2 || '', r.uploader_name || '',
      fmtDT(r.submitted_at),
      r.source === 'import' ? '表格回填' : (r.source === 'online' ? '在线补录' : '表单录入'),
      ...columns.map((c) => cleanCell(obj[c])),
    ])
  })
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  ws['!cols'] = header.map((c) => ({ wch: Math.min(50, Math.max(12, String(c).length * 2 + 8)) }))
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '汇总')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/** 导出周一/周三结构化表单汇总（把 form_json 拉平为列） */
function buildFormSummaryWorkbook(records, periodType, periodTitle) {
  const fields = periodType === 'monday'
    ? [
      ['activity_time', '活动时间'], ['location', '活动地点'], ['activity_name', '活动名称'],
      ['host', '主持人'], ['main_content', '会议主要内容'], ['attendees', '参加人员'],
      ['hse_meeting', '周一HSE例会'], ['training', '培训学习情况'], ['hazard_check', '隐患排查情况'],
      ['drill', '应急演练情况'], ['next_plan', '下步重点工作安排'], ['remark', '备注'],
    ]
    : [
      ['host', '主持人'], ['study_time', '学习时间'], ['location', '学习地点'],
      ['study_content', '学习内容'], ['study_detail', '学习具体内容'], ['attendees', '参加人员'], ['remark', '备注'],
    ]
  const header = ['填报单位', '二级板块', '网格层级', '上报人', '联系电话', '上报时间', '附件数', ...fields.map((f) => f[1])]
  const aoa = []
  if (periodTitle) aoa.push([`${periodTitle} · 活动记录汇总`])
  aoa.push(header)
  records.forEach((r) => {
    let f = {}
    try { f = typeof r.form_json === 'string' ? JSON.parse(r.form_json || '{}') : (r.form_json || {}) } catch (e) { f = {} }
    aoa.push([
      r.unit_name || '', r.grid_l2 || '', r.grid_level || '', r.uploader_name || '',
      r.uploader_phone || '', fmtDT(r.submitted_at),
      r.file_count || 0,
      ...fields.map(([k]) => cleanCell(f[k])),
    ])
  })
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  ws['!cols'] = header.map((c) => ({ wch: c.length > 8 ? 40 : 16 }))
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '活动记录')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  fmtDT, cleanCell, detectHeaderRow, normalizeColumns,
  parseStandardWorkbook, parseFilledWorkbook,
  buildTemplateWorkbook, buildBlankWorkbook,
  buildSummaryWorkbook, buildFormSummaryWorkbook,
}
