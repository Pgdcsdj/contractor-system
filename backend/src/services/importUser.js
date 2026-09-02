/**
 * Excel 人员导入服务
 *
 * 功能：
 *   - 解析 .xlsx 文件，提取姓名/身份证/承包商/主管单位/手机/岗位
 *   - 去重规则（身份证号为主键）：身份证号相同即视为同一人，以最新导入信息覆盖原记录
 *   - 姓名仅作辅助提示：若姓名与既有记录重复但身份证不同，记录 warning（仍作为新记录插入）
 *   - 同步生成/刷新二维码 Token
 *   - 返回成功/失败/新增/覆盖统计与失败报告
 *
 * 期望 Excel 表头（第一行）：
 *   姓名 | 身份证号 | 所属单位（承包商）| 主管单位（甲方）| 岗位（选填）| 手机号（选填）
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
  position:         ['岗位', '职务', '职位', 'position', 'post'],
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
  const insertedList = []
  const updatedList = []
  const warnings = []
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
    if (!data.phone)            data.phone            = null
    if (!data.position)         data.position         = ''

    try {
      // 去重主键：身份证号（用户确认：身份证号为主键）
      const [existing] = await pool.execute(
        'SELECT id FROM t_user WHERE id_card = ?',
        [data.id_card]
      )

      if (existing.length) {
        // 身份证号相同 → 视为同一人，以最新导入信息覆盖原记录
        await pool.execute(
          `UPDATE t_user
              SET name = ?, unit = ?, supervising_unit = ?, phone = ?, position = ?,
                  qr_token = ?, status = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [data.name, data.unit, data.supervising_unit, data.phone, data.position, data.qr_token, existing[0].id]
        )
        updatedList.push({ row: rowNum, name: data.name, id_card: data.id_card })
      } else {
        // 辅助提示：姓名与既有「不同身份证」记录重复（可能是同名不同人，仍作为新记录保留）
        const [nameHit] = await pool.execute(
          'SELECT id_card FROM t_user WHERE name = ? AND id_card != ? LIMIT 1',
          [data.name, data.id_card]
        )
        if (nameHit.length) {
          warnings.push({ row: rowNum, name: data.name, id_card: data.id_card, existing_id_card: nameHit[0].id_card })
        }
        await pool.execute(
          `INSERT INTO t_user (name, id_card, qr_token, unit, supervising_unit, phone, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [data.name, data.id_card, data.qr_token, data.unit, data.supervising_unit, data.phone, data.position]
        )
        insertedList.push({ row: rowNum, name: data.name, id_card: data.id_card })
      }
      successList.push({ row: rowNum, name: data.name, id_card: data.id_card })
    } catch (dbErr) {
      failList.push({ row: rowNum, data: row, error: `数据库错误: ${dbErr.message}` })
    }
  }

  // 写入导入日志
  const [logRes] = await pool.execute(
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
    total:     dataRows.length,
    success:   successList.length,
    fail:      failList.length,
    failList,
    successList,
    inserted:  insertedList.length,
    updated:   updatedList.length,
    insertedList,
    updatedList,
    warnings,
    logId:     logRes.insertId,
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
