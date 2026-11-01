/**
 * Excel 承包商单位（网格化管理）导入服务
 *
 * 对照模板「承包商单位导入模板终」11 列重做：
 *   序号 | 二级板块(grid_l2) | 单位名称 | 网格层级 | 上级单位 | 系统现有ID
 *   | 是否启用(1/0) | 操作(新增/更新/保留/删除) | 网格长 | 网格员 | 备注
 *
 * 关键规则：
 *   1) 系统现有ID = 库内 t_contractor_unit.id，按 ID 原地更新，保留 t_user / t_hazard 外键关联。
 *   2) 操作=新增 且 系统现有ID 为空 → INSERT 新行；操作=保留/更新 → 按 ID 更新；删除 → 软退场(is_active=0)。
 *   3) 上级单位(parent_id) 两遍解析：先按本批单位名 → 再按导入前库名快照 → 去尾括号归一 → 子串兜底；自引用置空防环。
 *   4) 只更新网格化相关字段，保留既有 甲方联系人 / 主管单位 / 电话 等历史数据。
 *   5) 模板未出现的既有行一律不动（无删除操作），关联数据零丢失。
 */

const xlsx = require('xlsx')
const { pool } = require('../db/db')

// ─── 字段映射（宽松匹配，列序不限）──────────────────────────────────────────
const FIELD_MAP = {
  seq_no:           ['序号', 'seq_no', 'seq'],
  grid_l2:          ['二级板块', 'grid_l2', '板块'],
  unit_name:        ['单位名称', '承包商单位名称', '承包商名称', 'unit_name'],
  grid_level:       ['网格层级', '层级', 'grid_level'],
  parent_unit_name: ['上级单位', 'parent_unit_name', '上级'],
  sys_existing_id:  ['系统现有ID', '系统现有id', 'sys_existing_id', '现有id'],
  is_active:        ['是否启用', '启用', 'is_active'],
  op:               ['操作', 'operation', 'op'],
  grid_leader:      ['网格长', 'leader', 'grid_leader'],
  grid_member:      ['网格员', 'member', 'grid_member'],
  remark:           ['备注', 'remark', 'note'],
}

function toStr(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  return String(v).trim()
}

// 去尾括号归一： stripping trailing （...）/（普光项目部）/ (...)
function normName(s) {
  return toStr(s)
    .replace(/[（(][^（）()]*[)）]\s*$/g, '')
    .replace(/（普光项目部）|\(普光项目部\)/g, '')
    .trim()
}

function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  if (raw.length < 2) throw new Error('Excel 文件为空或格式不正确（至少需要表头 + 1 行数据）')
  const headers = raw[0].map(h => toStr(h))
  return { headers, dataRows: raw.slice(1) }
}

function mapHeaders(headers) {
  const mapping = {}
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
    data[field] = toStr(row[idx])
  }
  if (!data.unit_name) return { valid: false, error: '单位名称不能为空' }
  return { valid: true, data }
}

async function importContractorUnits(buffer, adminId = 0, filename = '') {
  const { headers, dataRows } = parseExcel(buffer)
  const headerMapping = mapHeaders(headers)

  if (!Object.values(headerMapping).includes('unit_name')) {
    throw new Error('Excel 表头缺少必填列：单位名称')
  }

  // 导入前库名→id 快照（用于解析上级单位，避免本批重命名后查不到）
  const [snapRows] = await pool.execute('SELECT id, unit_name FROM t_contractor_unit')
  const dbNameToId = {}
  const dbNormToId = {}
  for (const r of snapRows) {
    const n = toStr(r.unit_name)
    if (n) {
      if (!(n in dbNameToId)) dbNameToId[n] = r.id
      const nn = normName(n)
      if (nn && !(nn in dbNormToId)) dbNormToId[nn] = r.id
    }
  }

  const sheetNameToId = {}
  const rowsMeta = [] // { id, parentName }
  const successList = []
  const failList = []
  const warnings = []

  // ── 第一遍：upsert 所有行，建立 单位名→id 映射 ──────────────────────────
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rowNum = i + 2
    if (row.every(cell => toStr(cell) === '')) continue

    const { valid, error, data } = validateRow(row, headerMapping)
    if (!valid) { failList.push({ row: rowNum, error }); continue }

    const op = (data.op || '保留').trim()
    const sysId = parseInt(data.sys_existing_id, 10)
    const hasSysId = !isNaN(sysId) && sysId > 0
    const isActive = data.is_active === '0' ? 0 : 1

    try {
      let targetId = null

      if (op === '删除') {
        // 软退场（保留历史关联）
        if (hasSysId) {
          await pool.execute(
            'UPDATE t_contractor_unit SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [sysId]
          )
          targetId = sysId
        } else {
          // 无系统ID的删除视为无效
          failList.push({ row: rowNum, error: '删除操作缺少系统现有ID' })
          continue
        }
      } else if (hasSysId) {
        // 保留/更新：按系统现有ID 原地更新网格化字段（保留历史联系方式等）
        const [exist] = await pool.execute('SELECT id FROM t_contractor_unit WHERE id = ?', [sysId])
        if (exist.length) {
          await pool.execute(
            `UPDATE t_contractor_unit SET
               unit_name        = ?,
               grid_l2          = ?,
               grid_level       = ?,
               parent_unit_name = ?,
               grid_leader      = ?,
               grid_member      = ?,
               remark           = ?,
               sys_existing_id  = ?,
               is_active        = ?,
               updated_at       = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [data.unit_name, data.grid_l2, data.grid_level, data.parent_unit_name,
             data.grid_leader, data.grid_member, data.remark, data.sys_existing_id, isActive, sysId]
          )
          targetId = sysId
        } else {
          // 系统ID不存在 → 退化为新增插入
          const [res] = await pool.execute(
            `INSERT INTO t_contractor_unit
               (unit_name, grid_l2, grid_level, parent_unit_name, grid_leader, grid_member,
                remark, sys_existing_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [data.unit_name, data.grid_l2, data.grid_level, data.parent_unit_name,
             data.grid_leader, data.grid_member, data.remark, data.sys_existing_id, isActive]
          )
          targetId = res.insertId
        }
      } else {
        // 新增：无系统ID → 插入
        const [res] = await pool.execute(
          `INSERT INTO t_contractor_unit
             (unit_name, grid_l2, grid_level, parent_unit_name, grid_leader, grid_member,
              remark, sys_existing_id, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [data.unit_name, data.grid_l2, data.grid_level, data.parent_unit_name,
           data.grid_leader, data.grid_member, data.remark, data.sys_existing_id, isActive]
        )
        targetId = res.insertId
      }

      if (targetId != null) {
        sheetNameToId[data.unit_name] = targetId
        rowsMeta.push({ id: targetId, parentName: data.parent_unit_name, selfName: data.unit_name })
        successList.push({ row: rowNum, unit_name: data.unit_name, op, id: targetId })
      }
    } catch (dbErr) {
      failList.push({ row: rowNum, error: `数据库错误: ${dbErr.message}` })
    }
  }

  // ── 第二遍：解析上级单位 parent_id ────────────────────────────────────────
  let parentResolved = 0
  let parentUnresolved = 0
  for (const meta of rowsMeta) {
    const P = toStr(meta.parentName)
    let parentId = null
    let unresolved = false

    if (P) {
      if (Object.prototype.hasOwnProperty.call(sheetNameToId, P) && sheetNameToId[P] !== meta.id) {
        parentId = sheetNameToId[P]
      } else if (Object.prototype.hasOwnProperty.call(dbNameToId, P) && dbNameToId[P] !== meta.id) {
        parentId = dbNameToId[P]
      } else {
        const np = normName(P)
        if (np && Object.prototype.hasOwnProperty.call(dbNormToId, np) && dbNormToId[np] !== meta.id) {
          parentId = dbNormToId[np]
        } else {
          // 子串兜底：库名包含上级名 或 上级名包含库名
          const cand = Object.keys(dbNameToId).find(n =>
            (n.includes(P) || P.includes(n)) && dbNameToId[n] !== meta.id)
          if (cand) parentId = dbNameToId[cand]
          else unresolved = true
        }
      }
    }

    // 自引用/循环防护：parent_id 不能等于自身
    if (parentId !== null && parentId === meta.id) parentId = null

    if (P && parentId !== null) parentResolved++
    if (P && parentId === null && unresolved) {
      parentUnresolved++
      warnings.push(`第 ${meta.id} 行「${meta.selfName}」上级单位「${P}」未匹配到库内单位，parent_id 置空`)
    }

    try {
      await pool.execute(
        'UPDATE t_contractor_unit SET parent_id = ? WHERE id = ?',
        [parentId, meta.id]
      )
    } catch (dbErr) {
      warnings.push(`第 ${meta.id} 行 parent_id 写入失败: ${dbErr.message}`)
    }
  }

  return {
    total: dataRows.length,
    success: successList.length,
    fail: failList.length,
    parentResolved,
    parentUnresolved,
    failList,
    successList,
    warnings,
  }
}

module.exports = { importContractorUnits }
