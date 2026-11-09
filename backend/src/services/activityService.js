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
/**
 * 日期样式文本归一化：把各队五花八门的日期写法统一成 YYYY-MM-DD。
 *
 * 背景：承包商回填的表格里，「整改（计划）完成时间」这类日期列，
 * 一部分是 Excel 真正的日期单元格（SheetJS 按单元格格式输出成 11/9/26），
 * 一部分是手打文本（2026.11.8），导出后会混在一列里，很难看也很难排序。
 *
 * 只识别「整格就是一个日期」的情况，命中才转换，否则原样返回：
 *   A) 年前置：2026.11.8 / 2026-11-8 / 2026/11/8 / 2026年11月8日（允许尾部 00:00:00）
 *   B) Excel 美式：11/9/26、11/9/2026（只认斜杠，避免把条款号 2.5.10 误判成日期）
 */
function normDateText(s) {
  if (!s || typeof s !== 'string') return s
  const t = s.trim()
  // 太长的肯定不是纯日期，先挡掉，省得白跑正则
  if (t.length > 24) return s

  let y, m, d
  let mm = t.match(/^(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?(?:\s+00:00(?::00)?)?$/)
  if (mm) {
    y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3])
  } else {
    mm = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
    if (!mm) return s
    let a = Number(mm[1]); let b = Number(mm[2]); const yy = Number(mm[3])
    // 11/9/26 这类默认「月/日/年」；若第一段 >12 说明是「日/月/年」写法
    if (a > 12 && b <= 12) { const tmp = a; a = b; b = tmp }
    m = a; d = b
    y = yy < 100 ? (yy <= 79 ? 2000 + yy : 1900 + yy) : yy
  }
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || y < 1900 || y > 2999) return s
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}`
}

function cleanCell(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return fmtDT(v).slice(0, 10)
  const s = String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normDateText(s)
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

// ─── 「按上传的原表格式」汇总导出 ───────────────────────────────────────────
/**
 * 背景：管理端上传的标准表通常是一张带红头标题、填报单位行、合并单元格、
 * 边框字体列宽的正式表格。原来的汇总导出另起炉灶（标题+5 个系统列+数据），
 * 和原表对不上，导出来还得再排版一次。
 *
 * 这里的做法：直接拿**上传的那张标准表**当模板，只把表头以下的数据行换掉，
 * 其余（工作表名、标题、填报单位行、表头换行、边框、字体、列宽、行高、
 * 合并单元格、冻结）一概不动，因此导出件与上传件版式完全一致。
 * 用 adm-zip 改 sheet XML 而不是 SheetJS 重写工作簿 —— 社区版 SheetJS
 * 写出时会丢掉全部样式（实测 styles.xml 从 2570 字节缩到 1114 字节）。
 */
function colLetter(n) {
  let s = ''
  let x = n + 1
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26) }
  return s
}
function escXml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
/** 从一行 <row> 里抽 { 列字母: 样式号 s } */
function rowCellStyles(rowXml) {
  const map = {}
  const re = /<c\b[^>]*\sr="([A-Z]+)\d+"([^>]*)/g
  let m
  while ((m = re.exec(rowXml || ''))) {
    const s = /\bs="(\d+)"/.exec(m[2] || '')
    if (s) map[m[1]] = s[1]
  }
  return map
}

/**
 * @param {Buffer} templateBuffer 管理员上传的标准表原文件
 * @param {{columns:string[],headerRowIndex:number}} def
 * @param {Array} rows 汇总行（含 row_json）
 * @returns {Buffer} 与上传件同版式的 xlsx
 */
function buildSummaryFromTemplate(templateBuffer, def, rows) {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(templateBuffer)
  const entry = zip.getEntries()
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))[0]
  if (!entry) throw new Error('标准表缺少工作表')
  let xml = zip.readAsText(entry)

  const columns = def.columns || []
  const n = columns.length
  if (!n) throw new Error('标准表未解析出列定义')
  const headerNo = Number(def.headerRowIndex || 0) + 1   // 1-based Excel 行号

  // 拆出所有 <row> 块
  const rowRe = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g
  const blocks = []
  let m
  while ((m = rowRe.exec(xml))) {
    const rNo = Number((/\br="(\d+)"/.exec(m[0]) || [])[1])
    if (rNo) blocks.push({ r: rNo, xml: m[0] })
  }
  const headRows = blocks.filter((b) => b.r <= headerNo)
  if (!headRows.length) throw new Error('标准表结构异常：未找到表头行')

  // 样式样板：表头下面那一行（标准表里通常是带边框的空白行）
  const protoRow = blocks.find((b) => b.r === headerNo + 1) || blocks.find((b) => b.r > headerNo)
  const headerRow = blocks.find((b) => b.r === headerNo)
  const protoStyles = rowCellStyles(protoRow && protoRow.xml)
  const headStyles = rowCellStyles(headerRow && headerRow.xml)
  const protoOpen = protoRow ? (protoRow.xml.match(/<row\b([^>]*)>/) || [])[1] || '' : ''
  const rowHt = (/\bht="([^"]+)"/.exec(protoOpen) || [])[1]
  const rowCustomH = /\bcustomHeight="1"/.test(protoOpen)

  // 数据行（序号列若存在则整表重排序，避免各队都从 1 开始）
  const seqIdx = columns.findIndex((c) => /^序号/.test(c))
  const bodyRows = rows.map((r) => {
    let obj = {}
    try { obj = typeof r.row_json === 'string' ? JSON.parse(r.row_json || '{}') : (r.row_json || {}) } catch (e) { obj = {} }
    return columns.map((c) => cleanCell(obj[c]))
  })
    // 只有序号、其余全空的行是各队上传时留下的空行，不进汇总表
    .filter((arr) => arr.some((v, i) => i !== seqIdx && v))
  if (seqIdx >= 0 && bodyRows.length && bodyRows.every((arr) => /^\d*$/.test(arr[seqIdx] || ''))) {
    bodyRows.forEach((arr, i) => { arr[seqIdx] = String(i + 1) })
  }

  let body = ''
  let lastRowNo = headerNo
  bodyRows.forEach((arr, i) => {
    const rNo = headerNo + 1 + i
    lastRowNo = rNo
    let cells = ''
    for (let c = 0; c < n; c++) {
      const letter = colLetter(c)
      const st = protoStyles[letter] || headStyles[letter]
      const ref = `${letter}${rNo}`
      const v = arr[c] || ''
      cells += v === ''
        ? `<c r="${ref}"${st ? ` s="${st}"` : ''}/>`
        : `<c r="${ref}"${st ? ` s="${st}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`
    }
    const attrs = [`r="${rNo}"`, `spans="1:${n}"`]
    if (rowHt) attrs.push(`ht="${rowHt}"`)
    if (rowCustomH) attrs.push('customHeight="1"')
    body += `<row ${attrs.join(' ')}>${cells}</row>`
  })

  const sheetData = `<sheetData>${headRows.map((b) => b.xml).join('')}${body}</sheetData>`
  xml = xml.replace(/<sheetData\b[^>]*\/>|<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, () => sheetData)
  // dimension 同步，避免 Excel 打开时选区异常
  xml = xml.replace(/<dimension\b[^>]*\/>/, () => `<dimension ref="A1:${colLetter(n - 1)}${lastRowNo}"/>`)

  // 用自建 zip 写出（adm-zip 对本类源包写回会破坏中央目录，见 buildZip 注释）
  const parts = []
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const name = e.entryName
    parts.push({ name, data: name === entry.entryName ? Buffer.from(xml, 'utf8') : e.getData() })
  }
  // [Content_Types].xml 放最前面，兼容性最好
  parts.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0))
  return buildZip(parts)
}
/**
 * 兜底：拿不到原表文件时，按「原列序 + 原表头」拼一张无样式的表（不再插系统列）
 */
function buildPlainSummaryWorkbook(def, rows, periodTitle) {
  const columns = def.columns || []
  const aoa = []
  if (periodTitle) aoa.push([periodTitle])
  aoa.push(columns)
  const seqIdx = columns.findIndex((c) => /^序号/.test(c))
  let seq = 0
  rows.forEach((r) => {
    let obj = {}
    try { obj = typeof r.row_json === 'string' ? JSON.parse(r.row_json || '{}') : (r.row_json || {}) } catch (e) { obj = {} }
    const arr = columns.map((c) => cleanCell(obj[c]))
    if (!arr.some((v, ci) => ci !== seqIdx && v)) return   // 只有序号的空行跳过
    seq += 1
    if (seqIdx >= 0) arr[seqIdx] = String(seq)
    aoa.push(arr)
  })
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  ws['!cols'] = columns.map((c) => ({ wch: Math.min(46, Math.max(10, String(c).length * 2 + 6)) }))
  const wb = xlsx.utils.book_new()
  const sheetName = '隐患排查'
  xlsx.utils.book_append_sheet(wb, ws, sheetName)
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

// ─── 最小 ZIP 写入器 ───────────────────────────────────────────────────────
// 为什么不直接用 adm-zip 写回：实测对「带 data descriptor 的源包」（WPS/Excel
// 导出的表常见 flag 0x808）adm-zip 写出的中央目录偏移是错的，unzip 报
// "invalid zip file with overlapped components"，SheetJS 报 Bad compressed size。
// 所以只用 adm-zip 读取解压，写出由下面这套最小实现负责（deflate + 正确偏移）。
const zlib = require('zlib')
let _crcTable = null
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      _crcTable[i] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
/** @param {{name:string,data:Buffer}[]} entries */
function buildZip(entries) {
  const localParts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = e.data
    const comp = zlib.deflateRawSync(raw)
    const crc = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)          // UTF-8 文件名
    lh.writeUInt16LE(8, 8)              // deflate
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0x21, 12)          // 1980-01-01
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    localParts.push(lh, nameBuf, comp)
    central.push({ nameBuf, crc, csize: comp.length, usize: raw.length, offset })
    offset += 30 + nameBuf.length + comp.length
  }
  const cdStart = offset
  for (const c of central) {
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(c.crc, 16)
    ch.writeUInt32LE(c.csize, 20)
    ch.writeUInt32LE(c.usize, 24)
    ch.writeUInt16LE(c.nameBuf.length, 28)
    ch.writeUInt32LE(0, 30)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(c.offset, 42)
    localParts.push(ch, c.nameBuf)
    offset += 46 + c.nameBuf.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(offset - cdStart, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  localParts.push(eocd)
  return Buffer.concat(localParts)
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

/** 按模板生成「月度安全活动完成情况统计」工作簿（两个 sheet：周一安全活动 / 周三培训）
 *  block = { periods: [{ id, date }], rows: [{ seq_no, unit_name, team_name, well_no, cells:[bool], reported, missing }] }
 */
function buildMonthlyStatWorkbook(month, monday, wednesday) {
  const wb = xlsx.utils.book_new()
  const buildSheet = (sheetName, block) => {
    const dates = (block.periods || []).map((p) => {
      const d = String(p.date || '').slice(0, 10)
      const [, mm, dd] = d.split('-')
      return `${Number(mm)}/${Number(dd)}`
    })
    const header = ['序号', '单位名称', '队别', '井号', ...dates, '已报', '缺少']
    const aoa = [[`${month} 月度安全活动完成情况统计 · ${sheetName}`], header]
    ;(block.rows || []).forEach((r) => {
      aoa.push([
        r.seq_no || '', r.unit_name || '', r.team_name || '', r.well_no || '',
        ...(r.cells || []).map((ok) => (ok ? '√' : '')),
        r.reported || 0, r.missing || 0,
      ])
    })
    const ws = xlsx.utils.aoa_to_sheet(aoa)
    ws['!cols'] = header.map((c, i) => ({ wch: i === 1 ? 34 : (i === 2 || i === 3 ? 16 : 8) }))
    xlsx.utils.book_append_sheet(wb, ws, sheetName)
  }
  buildSheet('周一安全活动', monday || {})
  buildSheet('周三培训', wednesday || {})
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  fmtDT, cleanCell, normDateText, detectHeaderRow, normalizeColumns,
  parseStandardWorkbook, parseFilledWorkbook,
  buildTemplateWorkbook, buildBlankWorkbook,
  buildSummaryWorkbook, buildSummaryFromTemplate, buildPlainSummaryWorkbook,
  buildFormSummaryWorkbook, buildMonthlyStatWorkbook,
}
