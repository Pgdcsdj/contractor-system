/**
 * 从 xlsx buffer 提取内嵌图片，并解析其所属的 Excel 行（纯函数，零 IO、可单测）。
 *
 * 背景：视频督查类 Excel 内嵌大量现场截图，导入系统后需作为「隐患证据」提取、压缩、
 *       上传 COS、按行关联到 t_hazard_photo。本模块只负责「buffer → 带行锚点的图片清单」，
 *       不做任何网络 / 数据库 IO，便于单测与复用。
 *
 * 架构师设计 §3.2（高见远）：
 *   - 双路径锚点解析：Path B（WPS「嵌入单元格图片」DISPIMG，优先）/ Path A（Excel 浮动图片 drawing anchor）。
 *   - resolveSheetPaths 必须经 xl/_rels/workbook.xml.rels 解析，不得假设 sheet1.xml 即第 1 个 sheet。
 *   - matchImagesToRows 实现「向上就近」归属 + orphan 池 + MAX_PHOTO_PER_ROW 截断。
 *
 * 依赖（均为现有依赖，零新增）：adm-zip（解 zip 条目）、xml2js（解析 drawing/cellimages/.rels）。
 *
 * ⚠ 命名空间兼容性（关键）：不同生成器对 spreadsheetDrawing 命名空间的写法不同：
 *   - Excel / WPS 通常用前缀：<xdr:wsDr xmlns:xdr="...spreadsheetDrawing">
 *   - openpyxl 用默认命名空间：<wsDr xmlns="...spreadsheetDrawing">（子元素无前缀）
 *   二者都合法。本模块通过 stripNs() 在解析后剥离所有命名空间前缀，统一用「无前缀」元素名
 *   与属性名（r:embed → embed, r:id → id, etc:cellImages → cellImages），从而同时兼容两种写法。
 */

const AdmZip = require('adm-zip')
const xml2js = require('xml2js')

/** 单行最多关联截图数（超出部分进 orphan 并告警） */
const MAX_PHOTO_PER_ROW = 6

/**
 * 递归剥离命名空间前缀（元素名与属性名），使解析结果前缀无关。
 * xml2js 默认保留前缀；本函数把 `xdr:from` → `from`、`r:embed` → `embed`、`etc:cellImages` → `cellImages`，
 * 同时把属性对象下 `r:id` → `id`、`xmlns:a` → `xmlns`（冗余忽略）。
 * @param {*} value
 */
function stripNs(value) {
  if (Array.isArray(value)) return value.map(stripNs)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (key === '$') {
        const attrs = {}
        for (const ak of Object.keys(value[key])) {
          const al = ak.includes(':') ? ak.slice(ak.indexOf(':') + 1) : ak
          attrs[al] = value[key][ak]
        }
        out.$ = attrs
      } else {
        const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
        out[local] = stripNs(value[key])
      }
    }
    return out
  }
  return value
}

/**
 * 解析一段 XML 为对象（xml2js，单元素不强制数组；剥离命名空间前缀）。
 * @param {string|null} str
 * @returns {Promise<object>}
 */
function parseXml(str) {
  if (!str) return Promise.resolve({})
  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false, explicitRoot: true })
  return parser.parseStringPromise(str).then(stripNs)
}

/** 把任意值规范为数组（xml2js 在单元素时返回对象） */
function asArray(x) {
  if (x == null) return []
  return Array.isArray(x) ? x : [x]
}

/** 取文件扩展名（含点，小写），无则空串 */
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? '.' + m[1] : ''
}

/** 判断是否为图片条目（xl/media/ 下常见位图） */
function isImageEntry(name) {
  return /^xl\/media\//i.test(name) && !name.endsWith('/') && /\.(png|jpe?g|gif|bmp|webp)$/i.test(name)
}

/** 目录部分（去掉文件名） */
function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/**
 * 把 .rels 中的相对 / 绝对 Target 解析为相对压缩包根的绝对条目名。
 * @param {string} baseDir  被关联 part 所在目录（如 xl、xl/drawings）
 * @param {string} target   .rels 中的 Target（可为 ../ 相对或 / 绝对）
 * @returns {string}
 */
function resolveRelTarget(baseDir, target) {
  if (!target) return ''
  // 绝对路径（openpyxl 常用 /xl/...）：从包根解析，忽略 baseDir
  if (target.startsWith('/')) return target.replace(/^\/+/, '')
  const combined = (baseDir ? baseDir + '/' : '') + target
  const parts = combined.split('/')
  const stack = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (stack.length) stack.pop()
    } else {
      stack.push(p)
    }
  }
  return stack.join('/')
}

/**
 * 解析一个 .rels 文件，返回 { Id: Target }（前缀已剥离：r:id→id, r:embed→embed）。
 * @param {AdmZip} zip
 * @param {string} relPath  .rels 条目名，如 xl/_rels/workbook.xml.rels
 * @returns {Promise<Record<string,string>>}
 */
async function parseRels(zip, relPath) {
  const map = {}
  const xml = readEntry(zip, relPath)
  if (!xml) return map
  try {
    const doc = await parseXml(xml)
    const rels = doc && doc.Relationships
    if (!rels) return map
    const items = asArray(rels.Relationship)
    for (const it of items) {
      const id = it.$ && (it.$.Id || it.$.id)
      const target = it.$ && (it.$.Target || it.$.target)
      if (id && target) map[String(id)] = String(target)
    }
  } catch (e) {
    // 解析失败：返回已收集的部分映射
  }
  return map
}

/** 读取 zip 条目的字符串内容（不存在返回 null） */
function readEntry(zip, name) {
  const e = zip.getEntry(name)
  return e ? e.getData().toString('utf8') : null
}

/** 读取 zip 条目的 Buffer（不存在返回 null） */
function readEntryBuffer(zip, name) {
  const e = zip.getEntry(name)
  return e ? e.getData() : null
}

/**
 * 经 xl/workbook.xml + xl/_rels/workbook.xml.rels 解析 sheet 顺序与真实文件路径。
 * 返回 [{ sheetName, file }]（按 workbook.xml 中 <sheets> 顺序，与 wb.SheetNames 对齐）。
 * @param {AdmZip} zip
 * @returns {Promise<Array<{sheetName:string, file:string}>>}
 */
async function resolveSheetPaths(zip, sheetNames) {
  const wbXml = readEntry(zip, 'xl/workbook.xml')
  if (!wbXml) return []
  let wb
  try {
    wb = await parseXml(wbXml)
  } catch (e) {
    return []
  }
  const sheetsEl = wb && wb.workbook && wb.workbook.sheets && wb.workbook.sheets.sheet
  const sheetEls = asArray(sheetsEl)
  const relMap = await parseRels(zip, 'xl/_rels/workbook.xml.rels')
  const result = []
  for (const s of sheetEls) {
    const name = (s.$ && (s.$.name || s.$.Name)) || ''
    // r:id（前缀已剥离为 id）映射到 worksheet 文件
    const rid = s.$ && (s.$.id || s.$.rId || s.$.r_id)
    const target = rid ? relMap[String(rid)] : null
    const file = target ? resolveRelTarget('xl', target) : ''
    result.push({ sheetName: name, file })
  }
  return result
}

/**
 * Path B — WPS「嵌入单元格图片」（DISPIMG）。
 * 扫描各 worksheet 中形如 <f>_xlfn.DISPIMG("ID_xxxx",1)</f> 的单元格，从 r="C12" 得到精确行号，
 * 再经 xl/cellimages.xml + xl/_rels/cellimages.xml.rels 映射到 xl/media/*。
 * @returns {Promise<Map<string,{sheetName:string, anchorRow:number}>>}  key = 媒体条目名
 */
async function parseCellImages(zip, sheetPaths) {
  const result = new Map()
  const cellImgXml = readEntry(zip, 'xl/cellimages.xml')
  if (!cellImgXml) return result

  let doc
  try {
    doc = await parseXml(cellImgXml)
  } catch (e) {
    return result
  }
  const cellImages = doc && doc.cellImages
  if (!cellImages) return result

  // idName -> embed(Id)
  const idEmbed = new Map()
  const imgEls = asArray(cellImages.cellImage)
  for (const el of imgEls) {
    const cNvPr = el.cNvPr
    const name = cNvPr && cNvPr.$ && (cNvPr.$.name || cNvPr.$.Name)
    const blip = el.blip
    const embed = blip && blip.$ && (blip.$.embed || blip.$.Embed)
    if (name && embed) idEmbed.set(String(name), String(embed))
  }
  if (idEmbed.size === 0) return result

  // Id -> 媒体条目名
  const relMap = await parseRels(zip, 'xl/_rels/cellimages.xml.rels')
  const idMedia = new Map()
  for (const [name, embed] of idEmbed) {
    const target = relMap[embed]
    if (target) idMedia.set(name, resolveRelTarget('xl', target))
  }
  if (idMedia.size === 0) return result

  const fileToName = new Map(sheetPaths.map((sp) => [sp.file, sp.sheetName]))
  const wsRe = /^xl\/worksheets\/sheet\d+\.xml$/i

  for (const entry of zip.getEntries()) {
    if (!wsRe.test(entry.entryName)) continue
    const xml = entry.getData().toString('utf8')
    const sheetName = fileToName.get(entry.entryName)
    if (!sheetName) continue
    // 逐单元格匹配：<c r="C12">...</c> 内找 DISPIMG 公式（确保 r 与 <f> 同属一个单元格）
    const cellRe = /<c\s+r="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g
    let cm
    while ((cm = cellRe.exec(xml)) !== null) {
      const ref = cm[1]
      const inner = cm[2]
      const fm = inner.match(/<f>\s*_xlfn\.DISPIMG\("([^"]+)"\s*,\s*1\)\s*<\/f>/)
      if (!fm) continue
      const idName = fm[1]
      const rowMatch = ref.match(/(\d+)$/)
      if (!rowMatch) continue
      const anchorRow = parseInt(rowMatch[1], 10)
      const mediaName = idMedia.get(idName)
      if (mediaName && !result.has(mediaName)) {
        result.set(mediaName, { sheetName, anchorRow })
      }
    }
  }
  return result
}

/** 在 anchor 元素内下钻找到 <blip>（前缀无关：a:blip → blip） */
function findBlip(anchor) {
  const pic = anchor && anchor.pic
  if (!pic) return null
  const blipFill = pic.blipFill
  if (!blipFill) return null
  return blipFill.blip || null
}

/**
 * Path A — Excel 标准浮动图片（drawing anchor），兼容 openpyxl 默认命名空间。
 * 经 sheet 的 _rels 找到 drawingN.xml，遍历 twoCell/oneCell/absolute anchor，
 * 取 from 行列（0-based）→ anchorRow = row+1；blip 经 drawingN 的 _rels 映射到 media。
 * @returns {Promise<Array<object>>}  ExtractedImage 半成品（无 seq）
 */
async function parseDrawings(zip, sheetPaths) {
  const images = []
  const wsRe = /^xl\/worksheets\/sheet\d+\.xml$/i
  for (const sp of sheetPaths) {
    if (!sp.file) continue
    const relPath = sp.file.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/').replace(/\.xml$/, '.xml.rels')
    const sheetRelMap = await parseRels(zip, relPath)
    let drawingTarget = null
    for (const id of Object.keys(sheetRelMap)) {
      const t = sheetRelMap[id]
      if (/drawing/i.test(t)) {
        drawingTarget = resolveRelTarget(dirOf(sp.file), t)
        break
      }
    }
    if (!drawingTarget) continue
    const drawingXml = readEntry(zip, drawingTarget)
    if (!drawingXml) continue
    let d
    try {
      d = await parseXml(drawingXml)
    } catch (e) {
      continue
    }
    const wsDr = d && d.wsDr
    if (!wsDr) continue
    const anchors = []
    for (const tag of ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor']) {
      const a = wsDr[tag]
      if (a) anchors.push(...asArray(a))
    }
    // drawing 自身的 rels（blip embed 指向 media）
    const drawingRelPath = drawingTarget
      .replace(/^xl\/drawings\//, 'xl/drawings/_rels/')
      .replace(/\.xml$/, '.xml.rels')
    const drawingRelMap = await parseRels(zip, drawingRelPath)
    for (const anchor of anchors) {
      const fromEl = anchor.from
      let anchorRow = null
      if (fromEl && fromEl.row != null) {
        anchorRow = parseInt(String(fromEl.row), 10) + 1
      }
      const blip = findBlip(anchor)
      if (!blip) continue
      const embed = blip.$ && (blip.$.embed || blip.$.Embed)
      if (!embed) continue
      const mediaTarget = drawingRelMap[String(embed)]
      if (!mediaTarget) continue
      const mediaName = resolveRelTarget(dirOf(drawingTarget), mediaTarget)
      const buf = readEntryBuffer(zip, mediaName)
      if (!buf) continue
      images.push({
        sheetName: sp.sheetName,
        anchorRow,
        entryName: mediaName,
        ext: extOf(mediaName),
        size: buf.length,
        buffer: buf,
        seq: 0,
      })
    }
  }
  return images
}

/**
 * 提取 xlsx 内嵌图片，并解析其所属 Excel 行（纯函数，零 IO）。
 * @param {Buffer} buffer  原始 xlsx 字节
 * @param {string[]} sheetNames  来自 wb.SheetNames，用于对齐 sheet 顺序（fallback）
 * @returns {Promise<{images:Array, anchorMode:'cellimage'|'drawing'|'mixed'|'none', warnings:string[]}>}
 */
async function extractImages(buffer, sheetNames) {
  const warnings = []
  let zip
  try {
    zip = new AdmZip(buffer)
  } catch (e) {
    // 非 zip（.xls / .csv / 损坏）→ 安全返回空，不抛
    return { images: [], anchorMode: 'none', warnings: ['非 xlsx（zip）文件，已跳过图片提取'] }
  }

  const mediaEntries = zip.getEntries().filter((e) => isImageEntry(e.entryName))
  if (mediaEntries.length === 0) {
    return { images: [], anchorMode: 'none', warnings: [] }
  }

  const mediaBuffers = new Map()
  for (const e of mediaEntries) {
    const buf = e.getData()
    mediaBuffers.set(e.entryName, { buffer: buf, size: buf.length })
  }

  const sheetPaths = await resolveSheetPaths(zip, sheetNames || [])

  // Path B：cellimages / DISPIMG（优先）
  const cellImageMap = await parseCellImages(zip, sheetPaths)
  // Path A：drawings（兼容 openpyxl 默认命名空间）
  const drawingImages = await parseDrawings(zip, sheetPaths)

  const images = []
  const modes = []

  if (cellImageMap.size > 0) {
    for (const [entryName, info] of cellImageMap) {
      const mb = mediaBuffers.get(entryName)
      if (!mb) continue
      images.push({
        sheetName: info.sheetName,
        anchorRow: info.anchorRow,
        entryName,
        ext: extOf(entryName),
        size: mb.size,
        buffer: mb.buffer,
        seq: 0,
      })
    }
    modes.push('cellimage')
  }

  if (drawingImages.length > 0) {
    for (const img of drawingImages) images.push(img)
    modes.push('drawing')
  }

  let anchorMode = 'none'
  if (modes.length === 2) anchorMode = 'mixed'
  else if (modes.length === 1) anchorMode = modes[0]

  // 同 (sheetName, anchorRow) 组内按 entryName 稳定排序后赋 seq
  assignSeq(images)

  return { images, anchorMode, warnings }
}

/**
 * 给图片赋 seq：按 (sheetName, anchorRow ?? +∞, entryName) 排序后，在每组内从 0 递增。
 * @param {Array} images
 */
function assignSeq(images) {
  const sorted = images.slice().sort((a, b) => {
    if (a.sheetName !== b.sheetName) return a.sheetName < b.sheetName ? -1 : 1
    const ra = a.anchorRow == null ? Number.MAX_SAFE_INTEGER : a.anchorRow
    const rb = b.anchorRow == null ? Number.MAX_SAFE_INTEGER : b.anchorRow
    if (ra !== rb) return ra - rb
    return a.entryName < b.entryName ? -1 : 1
  })
  const counters = new Map()
  for (const img of sorted) {
    const key = `${img.sheetName}#${img.anchorRow == null ? 'null' : img.anchorRow}`
    const n = counters.get(key) || 0
    img.seq = n
    counters.set(key, n + 1)
  }
}

/**
 * 把图片按「向上就近」规则归属到已解析的数据行。
 * @param {Array<{sheetName:string, anchorRow:number|null}>} images
 * @param {Array<{sheetName:string, rowNo:number}>} rows  parseWorkbook 产出的行（含 sheetName + 1-based rowNo）
 * @returns {{byRowKey:Map<string,Array>, orphans:Array, warnings:string[]}}
 *   byRowKey: rowKey(`sheetName#rowNo`) -> ExtractedImage[]；orphans: 未定位图片；warnings: 截断提示
 */
function matchImagesToRows(images, rows) {
  const sheetRows = new Map() // sheetName -> [{rowNo, rowKey}]
  for (const r of rows || []) {
    const sn = r.sheetName
    if (!sn) continue
    if (!sheetRows.has(sn)) sheetRows.set(sn, [])
    sheetRows.get(sn).push({ rowNo: r.rowNo, rowKey: `${sn}#${r.rowNo}` })
  }
  for (const list of sheetRows.values()) list.sort((a, b) => a.rowNo - b.rowNo)

  const byRowKey = new Map()
  const orphans = []
  const warnings = []

  for (const img of images || []) {
    if (img.anchorRow == null) {
      orphans.push(img)
      continue
    }
    const list = sheetRows.get(img.sheetName)
    if (!list || list.length === 0) {
      orphans.push(img)
      continue
    }
    // 满足 rowNo <= anchorRow 的最大 rowNo 那一行
    let chosen = null
    for (const rr of list) {
      if (rr.rowNo <= img.anchorRow) chosen = rr
      else break
    }
    if (!chosen) {
      // 图片在表头上方（如公司 logo）
      orphans.push(img)
      continue
    }
    const arr = byRowKey.get(chosen.rowKey) || []
    if (arr.length >= MAX_PHOTO_PER_ROW) {
      orphans.push(img)
      warnings.push(`行 ${chosen.rowKey} 截图已达上限 ${MAX_PHOTO_PER_ROW} 张，超出部分已忽略`)
      continue
    }
    img.seq = arr.length
    arr.push(img)
    byRowKey.set(chosen.rowKey, arr)
  }

  return { byRowKey, orphans, warnings }
}

module.exports = {
  extractImages,
  matchImagesToRows,
  // 导出纯函数便于单测 / 复用
  resolveSheetPaths,
  parseCellImages,
  parseDrawings,
  stripNs,
  MAX_PHOTO_PER_ROW,
}
