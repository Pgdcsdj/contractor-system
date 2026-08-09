'use strict'

/**
 * xlsxImageExtractor 单元测试（零外部依赖，纯内存）
 * ───────────────────────────────────────────────────────────────────────────
 * 运行：node --test src/services/__tests__/xlsxImageExtractor.test.js
 *
 * 关键：没有真实视频督查样例（架构师 §8 待明确事项 1），故用 adm-zip 现场构造
 * 最小但结构合法的 xlsx（含 xl/media、drawing / cellimages 两条锚点路径），
 * 验证纯解析逻辑。绝不依赖真实 COS / DB。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const AdmZip = require('adm-zip')

const {
  extractImages,
  matchImagesToRows,
  resolveSheetPaths,
  parseCellImages,
  parseDrawings,
} = require('../xlsxImageExtractor')

// ── 构造工具 ──────────────────────────────────────────────────────────────
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function buildXlsx(parts) {
  const zip = new AdmZip()
  for (const [name, content] of parts) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  return zip.toBuffer()
}

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

// ── Path B（DISPIMG）合成 ─────────────────────────────────────────────────
const SHEET_B = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1"><v>header</v></c></row>
    <row r="3"><c r="A3"><v>隐患A</v></c></row>
    <row r="5"><c r="C5"><f>_xlfn.DISPIMG("ID_1",1)</f></c></row>
    <row r="8"><c r="B8"><f>_xlfn.DISPIMG("ID_1",1)</f></c></row>
  </sheetData>
</worksheet>`

const CELLIMAGES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<etc:cellImages xmlns:etc="http://schemas.openxmlformats.org/drawingml/2018/extlst" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <etc:cellImage>
    <xdr:cNvPr id="1" name="ID_1"/>
    <xdr:picLocks noChangeAspect="1"/>
    <xdr:blip r:embed="rId1"/>
  </etc:cellImage>
</etc:cellImages>`

const CELLIMAGES_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`

// ── Path A（drawing anchor）合成 ──────────────────────────────────────────
const SHEET_A = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="2"><c r="A2"><v>隐患B</v></c></row>
  </sheetData>
</worksheet>`

const SHEET_A_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`

const DRAWING_A_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>2</xdr:col><xdr:row>4</xdr:row></xdr:from>
    <xdr:to><xdr:col>5</xdr:col><xdr:row>9</xdr:row></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="1" name="Picture 1"/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>
      <xdr:spPr/>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`

const DRAWING_A_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`

// ── 测试 ──────────────────────────────────────────────────────────────────
test('resolveSheetPaths：经 workbook.xml.rels 解析 sheet 顺序与文件', async () => {
  const buf = buildXlsx([
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
    ['xl/worksheets/sheet1.xml', SHEET_B],
  ])
  const zip = new AdmZip(buf)
  const paths = await resolveSheetPaths(zip, ['Sheet1'])
  assert.equal(paths.length, 1)
  assert.equal(paths[0].sheetName, 'Sheet1')
  assert.equal(paths[0].file, 'xl/worksheets/sheet1.xml')
})

test('extractImages（Path B / DISPIMG）：图片归属到公式所在精确行', async () => {
  const buf = buildXlsx([
    ['xl/media/image1.png', PNG_MAGIC],
    ['xl/worksheets/sheet1.xml', SHEET_B],
    ['xl/cellimages.xml', CELLIMAGES_XML],
    ['xl/_rels/cellimages.xml.rels', CELLIMAGES_RELS],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
  ])
  const res = await extractImages(buf, ['Sheet1'])
  assert.equal(res.anchorMode, 'cellimage')
  assert.equal(res.images.length, 1)
  const img = res.images[0]
  assert.equal(img.sheetName, 'Sheet1')
  assert.equal(img.anchorRow, 5) // 第一个 DISPIMG 出现在第 5 行
  assert.equal(img.entryName, 'xl/media/image1.png')
  assert.equal(img.ext, '.png')
  assert.ok(Buffer.isBuffer(img.buffer))
})

test('extractImages（Path A / drawing）：anchor 0-based 行列换算正确', async () => {
  const buf = buildXlsx([
    ['xl/media/image1.png', PNG_MAGIC],
    ['xl/worksheets/sheet1.xml', SHEET_A],
    ['xl/worksheets/_rels/sheet1.xml.rels', SHEET_A_RELS],
    ['xl/drawings/drawing1.xml', DRAWING_A_XML],
    ['xl/drawings/_rels/drawing1.xml.rels', DRAWING_A_RELS],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
  ])
  const res = await extractImages(buf, ['Sheet1'])
  assert.equal(res.anchorMode, 'drawing')
  assert.equal(res.images.length, 1)
  assert.equal(res.images[0].anchorRow, 5) // from.row = 4 (0-based) -> 5
  assert.equal(res.images[0].sheetName, 'Sheet1')
})

test('extractImages：非 xlsx（损坏 zip）安全返回空，不抛', async () => {
  const res = await extractImages(Buffer.from('not a zip at all'), ['Sheet1'])
  assert.equal(res.anchorMode, 'none')
  assert.equal(res.images.length, 0)
})

test('extractImages：无内嵌图返回空 anchorMode=none', async () => {
  const buf = buildXlsx([
    ['xl/worksheets/sheet1.xml', SHEET_B],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
  ])
  const res = await extractImages(buf, ['Sheet1'])
  assert.equal(res.anchorMode, 'none')
  assert.equal(res.images.length, 0)
})

test('matchImagesToRows：向上就近归属到 <= anchorRow 的最大行', () => {
  const img = { sheetName: 'Sheet1', anchorRow: 5, entryName: 'xl/media/image1.png' }
  const rows = [
    { sheetName: 'Sheet1', rowNo: 3 },
    { sheetName: 'Sheet1', rowNo: 7 },
  ]
  const { byRowKey, orphans } = matchImagesToRows([img], rows)
  assert.equal(byRowKey.get('Sheet1#3').length, 1)
  assert.equal(orphans.length, 0)
  assert.equal(byRowKey.get('Sheet1#3')[0].seq, 0)
})

test('matchImagesToRows：anchorRow 在表头上方（< 最小行号）进 orphan', () => {
  const img = { sheetName: 'Sheet1', anchorRow: 1 }
  const rows = [{ sheetName: 'Sheet1', rowNo: 3 }]
  const { byRowKey, orphans } = matchImagesToRows([img], rows)
  assert.equal(orphans.length, 1)
  assert.equal(byRowKey.size, 0)
})

test('matchImagesToRows：anchorRow 为 null 进 orphan', () => {
  const img = { sheetName: 'Sheet1', anchorRow: null }
  const rows = [{ sheetName: 'Sheet1', rowNo: 3 }]
  const { orphans } = matchImagesToRows([img], rows)
  assert.equal(orphans.length, 1)
})

test('matchImagesToRows：单行超 MAX_PHOTO_PER_ROW 截断并告警', () => {
  const imgs = []
  for (let i = 0; i < 8; i++) imgs.push({ sheetName: 'Sheet1', anchorRow: 5, entryName: `xl/media/img${i}.png` })
  const rows = [{ sheetName: 'Sheet1', rowNo: 5 }]
  const { byRowKey, orphans, warnings } = matchImagesToRows(imgs, rows)
  assert.equal(byRowKey.get('Sheet1#5').length, 6) // MAX_PHOTO_PER_ROW
  assert.equal(orphans.length, 2)
  assert.ok(warnings.some((w) => /已达上限/.test(w)))
})

test('parseCellImages / parseDrawings 可直接调用且不抛', async () => {
  const buf = buildXlsx([
    ['xl/media/image1.png', PNG_MAGIC],
    ['xl/worksheets/sheet1.xml', SHEET_B],
    ['xl/cellimages.xml', CELLIMAGES_XML],
    ['xl/_rels/cellimages.xml.rels', CELLIMAGES_RELS],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
  ])
  const zip = new AdmZip(buf)
  const paths = await resolveSheetPaths(zip, ['Sheet1'])
  const cellMap = await parseCellImages(zip, paths)
  assert.equal(cellMap.size, 1)
  const drawingImgs = await parseDrawings(zip, paths)
  assert.equal(drawingImgs.length, 0) // 该合成文件无 drawing，安全返回空
})

test('extractImages（openpyxl 默认命名空间 / 元素无 xdr: 前缀）：stripNs 兼容 anchorMode=drawing', async () => {
  // 复现 QA 线上 FAIL 根因：openpyxl 生成的 drawing 用默认命名空间（<wsDr> 无 xdr: 前缀），
  // 解析器必须前缀无关。这是本 bug 的回归用例。
  const OPENPYXL_DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <oneCellAnchor>
    <from><col>2</col><row>1</row></from>
    <to><col>5</col><row>9</row></to>
    <pic><nvPicPr><cNvPr id="1" name="Picture 1"/></nvPicPr><blipFill><blip r:embed="rId1"/></blipFill><spPr/></pic>
    <clientData/>
  </oneCellAnchor>
</wsDr>`
  const SHEET_OP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="2"><c r="A2"><v>隐患B</v></c></row></sheetData>
</worksheet>`
  const SHEET_OP_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`
  const DRAWING_OP_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`
  const buf = buildXlsx([
    ['xl/media/image1.png', PNG_MAGIC],
    ['xl/worksheets/sheet1.xml', SHEET_OP],
    ['xl/worksheets/_rels/sheet1.xml.rels', SHEET_OP_RELS],
    ['xl/drawings/drawing1.xml', OPENPYXL_DRAWING],
    ['xl/drawings/_rels/drawing1.xml.rels', DRAWING_OP_RELS],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
  ])
  const res = await extractImages(buf, ['Sheet1'])
  assert.equal(res.anchorMode, 'drawing')
  assert.equal(res.images.length, 1)
  assert.equal(res.images[0].anchorRow, 2) // from.row=1 (0-based) -> 2
  assert.equal(res.images[0].sheetName, 'Sheet1')
  assert.ok(Buffer.isBuffer(res.images[0].buffer))
})
