/**
 * Excel 人员导入服务
 *
 * 功能：
 *   - 解析 .xlsx 文件，提取姓名/身份证/承包商/主管单位/手机
 *   - UPSERT 写入 t_user（重复身份证自动更新）
 *   - 同步生成二维码 Token
 *   - 返回成功/失败统计，支持下载失败行报告
 *
 * 期望 Excel 表头（第一行）：
 *   姓名 | 身份证号 | 所属单位（承包商）| 主管单位（甲方）| 手机号（可选）
 */

const xlsx = require('xlsx')
const { pool } = require('../db/db')
const { genQrToken } = require('../utils/hashHelper')

// ─── 字段映射（宽松匹配，支持中文表头变体）─────────────────────────────────────
// 注意：unit=承包商单位, supervising_unit=主管单位（甲方）
//
// Excel 列名规范：
//   "所属单位" → unit（承包商）
//   "主管单位" → supervising_unit（主管单位/甲方）
const FIELD_MAP = {
  name:             ['姓名', '名字', 'name'],
  id_card:          ['身份证号', '身份证', '证件号', 'idcard', 'id_card'],
  unit:             ['所属单位', '承包商', '承包商名称', '公司', 'unit'],
  supervising_unit: ['主管单位', '甲方单位', 'supervising_unit'],
  phone:            ['手机号', '手机', '电话', 'phone', 'mobile'],
}

/**
 * 从 Excel 缓冲区解析人员数据
 * @param {Buffer} buffer  Excel 文件 Buffer
 * @returns {{ rows: Array, headers: string[] }}
 */
function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  if (raw.length < 2) throw new Error('Excel 文件为空或格式不正确')

  const headers = raw[0].map(h => String(h).trim())
  const dataRows = raw.slice(1)

  return { headers, dataRows }
}

/**
 * 将表头映射为字段名
 */
function mapHeaders(headers) {
  const mapping = {} // 列索引 → 字段名
  headers.forEach((header, idx) => {
    const lowerHeader = header.toLowerCase()
    for (const [field, aliases] of Object.entries(FIELD_MAP)) {
      if (aliases.some(a => lowerHeader.includes(a.toLowerCase()))) {
        mapping[idx] = field
        break
      }
    }
  })
  return mapping
}

/**
 * 验证单行数据
 * @returns {{ valid: boolean, error?: string, data?: object }}
 */
function validateRow(row, headerMapping) {
  const data = {}
  for (const [idx, field] of Object.entries(headerMapping)) {
    data[field] = String(row[idx] || '').trim()
  }

  if (!data.name) return { valid: false, error: '姓名不能为空' }
  if (!data.id_card) return { valid: false, error: '身份证号不能为空' }

  // 简单身份证格式校验（18位，末位允许X）
  if (!/^\d{17}[\dXx]$/.test(data.id_card)) {
    return { valid: false, error: `身份证号格式不正确: ${data.id_card}` }
  }

  // 统一大写末位X
  data.id_card = data.id_card.toUpperCase()

  return { valid: true, data }
}

/**
 * 主函数：解析并导入 Excel
 * @param {Buffer} buffer   Excel 文件 Buffer
 * @param {number} adminId  操作管理员ID
 * @param {string} filename 文件名（用于日志）
 * @returns {ImportResult}
 */
async function importUsers(buffer, adminId = 0, filename = '') {
  const { headers, dataRows } = parseExcel(buffer)
  const headerMapping = mapHeaders(headers)

  // 必须包含姓名和身份证
  const hasMandatory = Object.values(headerMapping).includes('name') &&
                       Object.values(headerMapping).includes('id_card')
  if (!hasMandatory) {
    throw new Error('Excel 表头缺少必填列：姓名、身份证号')
  }

  const successList = []
  const failList = []

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rowNum = i + 2  // Excel 行号（含表头）

    // 跳过空行
    if (row.every(cell => String(cell).trim() === '')) continue

    const { valid, error, data } = validateRow(row, headerMapping)
    if (!valid) {
      failList.push({ row: rowNum, data: row, error })
      continue
    }

    // 生成二维码 Token
    data.qr_token = genQrToken(data.id_card)
    if (!data.unit)             data.unit             = ''
    if (!data.supervising_unit) data.supervising_unit = ''
    if (!data.phone)            data.phone = null

    try {
      await pool.execute(
        `INSERT INTO t_user (name, id_card, qr_token, unit, supervising_unit, phone)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name             = VALUES(name),
           qr_token         = VALUES(qr_token),
           unit             = VALUES(unit),
           supervising_unit = VALUES(supervising_unit),
           phone            = VALUES(phone),
           status           = 1,
           updated_at       = CURRENT_TIMESTAMP`,
        [data.name, data.id_card, data.qr_token, data.unit, data.supervising_unit, data.phone]
      )
      successList.push({ row: rowNum, name: data.name, id_card: data.id_card })
    } catch (dbErr) {
      failList.push({ row: rowNum, data: row, error: `数据库错误: ${dbErr.message}` })
    }
  }

  // 写入导入日志
  await pool.execute(
    `INSERT INTO t_import_log (filename, total_rows, success_rows, fail_rows, fail_detail, imported_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      filename,
      dataRows.length,
      successList.length,
      failList.length,
      failList.length > 0 ? JSON.stringify(failList) : null,
      adminId,
    ]
  )

  return {
    total:   dataRows.length,
    success: successList.length,
    fail:    failList.length,
    failList,
    successList,
  }
}

/**
 * 生成失败行 Excel（供管理员下载）
 * @param {Array} failList  失败行数组
 * @returns {Buffer}  xlsx Buffer
 */
function generateFailReport(failList) {
  const rows = failList.map(item => ({
    行号:   item.row,
    原始数据: Array.isArray(item.data) ? item.data.join(' | ') : JSON.stringify(item.data),
    错误原因: item.error,
  }))

  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.json_to_sheet(rows)
  xlsx.utils.book_append_sheet(wb, ws, '导入失败明细')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = { importUsers, generateFailReport }
