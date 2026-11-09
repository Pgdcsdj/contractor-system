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
const { lookupAlias } = require('./unitAlias')
const { INTERNAL_ORG_NAMES } = require('../constants/internalUnits')

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

// ─── 承包商单位归一化与匹配（与网格化管理库比对）─────────────────────────────
/**
 * 单位名称归一化：消除全半角、括号内容、空白、集团前缀、常见异写与末尾标点
 */
function normUnit(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[（(【\[〔][^）)】\]〕]*[）)】\]〕]/g, '')
    .replace(/\s+/g, '')
    .replace(/^(中石化|中国石化|石化)/, '')
    .replace(/技术监测/g, '技术检测')
    .replace(/石油气保障/g, '试油气保障')
    .replace(/[。．.，,、；;：:·]+$/, '')
    .toUpperCase()
}

// 内部机构（一/二级网格）归一化集合：不是承包商单位，匹配入口先拦截
const INTERNAL_ORG_NORMS = new Set(INTERNAL_ORG_NAMES.map((n) => normUnit(n)))

/**
 * 将原始单位名称匹配到白名单，返回 { id, unit_name } 或 null
 * @param {string} raw   Excel 中的原始值
 * @param {Array<{id:number, unit_name:string}>} list  白名单
 */
function matchUnit(raw, list) {
  const rawStr = String(raw || '').trim()
  if (!rawStr || !Array.isArray(list) || !list.length) return null

  // 0. 内部机构（一/二级网格）不是承包商单位，直接判未匹配
  if (INTERNAL_ORG_NORMS.has(normUnit(rawStr))) return null

  // 1. 精确相等
  const exact = list.find(u => u.unit_name === rawStr)
  if (exact) return { id: exact.id, unit_name: exact.unit_name }

  const nr = normUnit(rawStr)

  // 2.5 别名表：历史简称 / 旧名 / 只写到公司层级的写法 → 在册标准全称
  //     例：「西南钻井」→「西南钻井分公司」；「天然气产销厂」→「天然气产销厂通南巴项目部」
  //     见 services/unitAlias.js（personnel 场景比 hazard 多启用「西南钻井」）
  const aliasName = lookupAlias(nr, 'personnel')
  if (aliasName) {
    const hit = list.find(u => u.unit_name === aliasName)
    if (hit) return { id: hit.id, unit_name: hit.unit_name }
  }

  // 2. 归一化后相等且唯一
  const normEq = list.filter(u => normUnit(u.unit_name) === nr)
  if (normEq.length === 1) return { id: normEq[0].id, unit_name: normEq[0].unit_name }

  // 3. 队号唯一匹配（连续 3 位以上数字）
  const nums = rawStr.match(/\d{3,}/g) || []
  for (const n of nums) {
    const byNum = list.filter(u => normUnit(u.unit_name).includes(n))
    if (byNum.length === 1) return { id: byNum[0].id, unit_name: byNum[0].unit_name }
  }

  // 4. 名称包含且候选唯一
  const sub1 = list.filter(u => {
    const nu = normUnit(u.unit_name)
    return nu.length >= nr.length * 0.6 && nr.includes(nu)   // 标准名是原值子串
  })
  const sub2 = list.filter(u => {
    const nu = normUnit(u.unit_name)
    return nr.length >= 2 && nu.includes(nr)                // 原值是标准名子串
  })
  const seen = new Set()
  const combined = []
  for (const u of [...sub1, ...sub2]) {
    if (!seen.has(u.id)) { seen.add(u.id); combined.push(u) }
  }
  if (combined.length === 1) return { id: combined[0].id, unit_name: combined[0].unit_name }

  // 5. 无法唯一确定
  return null
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

  // 预加载承包商单位白名单（网格化管理库：三级/四级 在册单位）
  const [unitRows] = await pool.execute(
    "SELECT id, unit_name FROM t_contractor_unit WHERE grid_level IN ('三级','四级') AND is_active = 1"
  )
  const unitList = unitRows

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

    // ── 承包商单位：必须与网格化管理库在册单位一致 ──
    if (data.unit) {
      const rawUnit = data.unit
      if (INTERNAL_ORG_NORMS.has(normUnit(rawUnit))) {
        failList.push({ row: rowNum, data: row, error: `第${rowNum}行 「${rawUnit}」是项目部内部机构（甲方），不是承包商单位，请填写具体施工单位全称` })
        continue
      }
      const hit = matchUnit(rawUnit, unitList)
      if (!hit) {
        failList.push({ row: rowNum, data: row, error: `第${rowNum}行 承包商单位「${rawUnit}」不在网格化管理库在册名单，请到「承包商准入→网格化管理」核对后改为标准全称` })
        continue
      }
      data.unit = hit.unit_name
      data.contractor_unit_id = hit.id
      if (rawUnit !== hit.unit_name) {
        warnings.push(`第${rowNum}行 承包商单位「${rawUnit}」已规范为「${hit.unit_name}」`)
      }
    } else {
      warnings.push(`第${rowNum}行 未填承包商单位`)
    }

    // ── 主管单位：固定白名单，仅允许「通南巴项目部」──
    if (!data.supervising_unit) {
      data.supervising_unit = '通南巴项目部'
      warnings.push(`第${rowNum}行 未填主管单位，已自动补为「通南巴项目部」`)
    } else if (data.supervising_unit !== '通南巴项目部') {
      failList.push({ row: rowNum, data: row, error: `第${rowNum}行 主管单位「${data.supervising_unit}」不在允许范围，请改为「通南巴项目部」` })
      continue
    }

    // 生成二维码 Token
    data.qr_token = genQrToken(data.id_card)
    if (!data.unit)             data.unit             = ''
    if (!data.supervising_unit) data.supervising_unit = ''
    if (data.contractor_unit_id === undefined) data.contractor_unit_id = null
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
              SET name = ?, unit = ?, supervising_unit = ?, contractor_unit_id = ?, phone = ?, position = ?,
                  qr_token = ?, status = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [data.name, data.unit, data.supervising_unit, data.contractor_unit_id, data.phone, data.position, data.qr_token, existing[0].id]
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
          `INSERT INTO t_user (name, id_card, qr_token, unit, supervising_unit, contractor_unit_id, phone, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [data.name, data.id_card, data.qr_token, data.unit, data.supervising_unit, data.contractor_unit_id, data.phone, data.position]
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

module.exports = { importUsers, generateFailReport, matchUnit, normUnit }
