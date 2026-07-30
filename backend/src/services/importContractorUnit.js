/**
 * Excel 承包商单位导入服务（Sprint 1 / S1-3）
 *
 * 功能：
 *   - 解析 .xlsx，提取 承包商单位名称 / 甲方主管单位 / 联系人 / 联系电话 / 安全员姓名 / 安全员手机号
 *   - UPSERT 写入 t_contractor_unit（按 unit_name 唯一，重复则更新）
 *   - 返回成功/失败统计，前端展示失败预览
 *
 * 期望 Excel 表头（第一行，支持中文表头变体，列序不限）：
 *   承包商单位名称 | 甲方主管单位 | 联系人 | 联系电话 | 安全员姓名 | 安全员手机号
 */

const xlsx = require('xlsx')
const { pool } = require('../db/db')

// ─── 字段映射（宽松匹配，支持中文表头变体）─────────────────────────────────────
const FIELD_MAP = {
  unit_name:            ['承包商单位名称', '单位名称', '承包商', '承包商名称', 'unit_name', '单位'],
  supervising_unit:     ['甲方主管单位', '主管单位', '甲方单位', 'supervising_unit'],
  contact_name:         ['联系人', '单位联系人', 'contact_name'],
  contact_phone:        ['联系电话', '联系人电话', 'contact_phone', 'phone'],
  safety_officer_name:  ['安全员姓名', '安全员', 'safety_officer_name'],
  safety_officer_phone: ['安全员手机号', '安全员电话', 'safety_officer_phone'],
}

function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  if (raw.length < 2) throw new Error('Excel 文件为空或格式不正确（至少需要表头 + 1 行数据）')

  const headers = raw[0].map(h => String(h).trim())
  return { headers, dataRows: raw.slice(1) }
}

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

function validateRow(row, headerMapping) {
  const data = {}
  for (const [idx, field] of Object.entries(headerMapping)) {
    data[field] = String(row[idx] || '').trim()
  }
  if (!data.unit_name) return { valid: false, error: '承包商单位名称不能为空' }
  return { valid: true, data }
}

async function importContractorUnits(buffer, adminId = 0, filename = '') {
  const { headers, dataRows } = parseExcel(buffer)
  const headerMapping = mapHeaders(headers)

  const hasMandatory = Object.values(headerMapping).includes('unit_name')
  if (!hasMandatory) {
    throw new Error('Excel 表头缺少必填列：承包商单位名称')
  }

  const successList = []
  const failList = []

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rowNum = i + 2 // Excel 行号（含表头）

    // 跳过空行
    if (row.every(cell => String(cell).trim() === '')) continue

    const { valid, error, data } = validateRow(row, headerMapping)
    if (!valid) {
      failList.push({ row: rowNum, data: row, error })
      continue
    }

    try {
      await pool.execute(
        `INSERT INTO t_contractor_unit
           (unit_name, supervising_unit, contact_name, contact_phone, safety_officer_name, safety_officer_phone, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           supervising_unit     = VALUES(supervising_unit),
           contact_name         = VALUES(contact_name),
           contact_phone        = VALUES(contact_phone),
           safety_officer_name  = VALUES(safety_officer_name),
           safety_officer_phone = VALUES(safety_officer_phone),
           is_active            = 1,
           updated_at           = CURRENT_TIMESTAMP`,
        [data.unit_name, data.supervising_unit || '', data.contact_name || '',
         data.contact_phone || '', data.safety_officer_name || '', data.safety_officer_phone || '']
      )
      successList.push({ row: rowNum, unit_name: data.unit_name })
    } catch (dbErr) {
      failList.push({ row: rowNum, data: row, error: `数据库错误: ${dbErr.message}` })
    }
  }

  return {
    total:   dataRows.length,
    success: successList.length,
    fail:    failList.length,
    failList,
    successList,
  }
}

module.exports = { importContractorUnits }
