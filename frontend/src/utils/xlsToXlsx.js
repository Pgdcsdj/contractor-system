/**
 * .xls（Excel 97-2003 / BIFF8）→ .xlsx 前端转换（方案 C）。
 *
 * 背景：后端 multer 上传红线 5MB 不可动。用户从视频督查系统导出的 .xls 常带大量
 * 内嵌截图，体积远超 5MB，直出必被拒。本模块用 SheetJS 在浏览器端把 .xls 读成
 * 工作簿对象（社区版只解析「单元格数据」，图片/OLE 对象天然被丢弃），再以 xlsx
 * (OOXML + deflate) 格式写回，得到一份「纯文字」的 .xlsx：
 *   1）体积通常骤降到几十~几百 KB，绕过 5MB 红线；
 *   2）产物是标准 .xlsx，直接复用既有 video_supervision 文字导入链路。
 *
 * 已知限制（必须在 UI 告知用户）：社区版 SheetJS 读 .xls 不保留图片，
 * 转换后的 .xlsx 不含任何现场截图。需要截图进系统的，请用户把原文件
 * 「另存为 .xlsx」后再上传（走 xlsxImageCompress 的图片压缩链路）。
 *
 * 与上传缓存的关系：转换结果由调用方缓存（HazardImportModal 的 compressedFileRef），
 * 保证「预览 / 确认」两次上传是同一份字节（设计 §7.8）。
 */

import * as XLSX from 'xlsx'

/** 后端 multer 上传红线：5MB（backend/src/routes/hazardLoop.js，本次不改动） */
export const HARD_LIMIT_BYTES = 5 * 1024 * 1024

/** xlsx (OOXML) 标准 MIME */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * @typedef {Object} XlsConvertResult
 * @property {File}   file           转换后的 .xlsx File（同名换扩展名，可直接上传）
 * @property {number} originalSize   原始 .xls 字节数
 * @property {number} convertedSize  转换后 .xlsx 字节数
 * @property {number} sheetCount     工作表数量
 * @property {boolean} overLimit     转换后仍 > 5MB（调用方应阻断上传）
 */

/** 是否是 .xls（Excel 97-2003）文件 */
export function isXlsFile(file) {
  return !!file && typeof file.name === 'string' && /\.xls$/i.test(file.name)
}

/** 把 xxx.xls 换名为 xxx.xlsx（大小写不敏感，仅替换结尾扩展名） */
export function toXlsxName(name) {
  const safe = typeof name === 'string' && name ? name : 'import.xls'
  return safe.replace(/\.xls$/i, '.xlsx')
}

/**
 * 把 .xls 转换为「仅含文字单元格」的 .xlsx。
 *
 * @param {File} file 用户选择的 .xls 文件
 * @returns {Promise<XlsConvertResult>}
 * @throws {Error} 读取失败 / 解析失败 / 写出失败时抛出带可读中文描述的错误
 */
export async function convertXlsToXlsx(file) {
  if (!file) {
    throw new Error('未选择文件，无法转换')
  }
  const originalSize = Number(file.size) || 0

  // ① 读入原始字节
  let buf = null
  try {
    buf = await file.arrayBuffer()
  } catch (e) {
    throw new Error(`读取 .xls 文件失败：${(e && e.message) || '浏览器无法读取该文件'}`)
  }
  if (!buf || buf.byteLength === 0) {
    throw new Error('读取 .xls 文件失败：文件为空或已损坏')
  }

  // ② 解析为工作簿（cellStyles:false → 不带样式；社区版不解析图片，天然只剩文字数据）
  let wb = null
  try {
    wb = XLSX.read(buf, { type: 'array', cellDates: true, cellStyles: false })
  } catch (e) {
    throw new Error(
      `解析 .xls 失败：${(e && e.message) || '文件可能已损坏或不是标准 Excel 97-2003 格式'}`
    )
  }
  const sheetNames = (wb && wb.SheetNames) || []
  if (sheetNames.length === 0) {
    throw new Error('解析 .xls 失败：文件中没有任何工作表')
  }

  // ③ 以 xlsx 格式写回（compression:true 走 deflate，体积最小）
  let out = null
  try {
    out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true })
  } catch (e) {
    throw new Error(`生成 .xlsx 失败：${(e && e.message) || '写出工作簿时出错'}`)
  }
  if (!out || out.byteLength === 0) {
    throw new Error('生成 .xlsx 失败：输出为空')
  }

  // ④ 包装成 File，供 FormData 直接上传
  const converted = new File([out], toXlsxName(file.name), { type: XLSX_MIME })
  const convertedSize = Number(converted.size) || out.byteLength

  return {
    file: converted,
    originalSize,
    convertedSize,
    sheetCount: sheetNames.length,
    overLimit: convertedSize > HARD_LIMIT_BYTES,
  }
}
