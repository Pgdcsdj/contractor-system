/**
 * 承包商人员清单报送服务
 *
 * 业务背景：承包商每月（定期）报送本单位在场人员（含分包人员），安全员导入后
 * 不直接改人员库，需管理员审核。审核通过后：
 *   - add/keep → 写入/更新 t_user，主管单位 = 通南巴项目部
 *   - remove   → 不删除人员，只把主管单位改为「普光分公司」，使其退出通南巴
 *                的全部统计与看板，但仍留在普光分公司大库中，人员可流动回来。
 *
 * 数据只写暂存表 t_staff_roster_batch / t_staff_roster_item，审核通过才写 t_user。
 */
const xlsx = require('xlsx')
const { pool } = require('../db/db')
const { matchUnit } = require('./importUser')
const { genQrToken } = require('../utils/hashHelper')

const TNB_UNIT = '通南巴项目部'
const PUGUANG_UNIT = '普光分公司'

// Excel 表头映射（在 importUser 基础上增加「报送动作」列）
const FIELD_MAP = {
  action:           ['报送动作', '动作', '操作', '变更类型', 'action'],
  name:             ['姓名', '名字', 'name'],
  id_card:          ['身份证号', '身份证', '证件号', 'idcard', 'id_card'],
  unit:             ['所属单位', '承包商', '承包商名称', '公司', '单位', 'unit'],
  position:         ['岗位', '职务', '职位', 'position', 'post'],
  phone:            ['手机号', '手机', '电话', 'phone', 'mobile'],
}

const ACTION_ALIAS = {
  '新增': 'add', '增加': 'add', 'add': 'add', 'a': 'add',
  '保留': 'keep', '不变': 'keep', '继续': 'keep', 'keep': 'keep', 'k': 'keep',
  '移除': 'remove', '删除': 'remove', '退出': 'remove', '调离': 'remove',
  'remove': 'remove', 'r': 'remove',
}

function normalizeMonth(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  // 支持 2026-11 / 2026年11月 / 202611 / Date
  let m = s.match(/^(\d{4})[-/年.]?(\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`
  return ''
}

function mapHeaders(headers) {
  const mapping = {}
  headers.forEach((h, idx) => {
    const lower = String(h).trim().toLowerCase()
    for (const [field, aliases] of Object.entries(FIELD_MAP)) {
      if (aliases.some(a => lower.includes(a.toLowerCase()))) {
        mapping[idx] = field
        break
      }
    }
  })
  return mapping
}

/** 解析 Excel，返回 { headers, rows } */
function parseExcel(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  if (raw.length < 2) throw new Error('Excel 为空或格式不正确（至少需要表头和一行数据）')
  return { headers: raw[0].map(h => String(h).trim()), rows: raw.slice(1) }
}

/**
 * 安全员报送：解析 Excel → 写暂存表（不碰 t_user）
 * @returns {{batchId, total, addCount, removeCount, keepCount, failList, warnings, replacedBatchId}}
 */
async function submitRoster(buffer, { unitId, reportMonth, submittedBy, submittedByName, filename }) {
  const { headers, rows } = parseExcel(buffer)
  const hm = mapHeaders(headers)
  const vals = Object.values(hm)
  if (!vals.includes('name') || !vals.includes('id_card')) {
    throw new Error('Excel 表头缺少必填列：姓名、身份证号')
  }

  const month = normalizeMonth(reportMonth)
  if (!month) throw new Error('报送月份格式不正确，应为 YYYY-MM（如 2026-11）')

  // 确认报送单位（必须是活跃的三/四级网格单位）
  const [[unit]] = await pool.execute(
    "SELECT id, unit_name FROM t_contractor_unit WHERE id = ? AND is_active = 1 AND grid_level IN ('三级','四级')",
    [unitId]
  )
  if (!unit) throw new Error('报送单位不在网格化在册名单，请联系管理员')

  // 同单位同月份若有未审核批次 → 作废（逻辑删除：直接删明细+批次，避免重复报送堆积）
  const [[old]] = await pool.execute(
    'SELECT id FROM t_staff_roster_batch WHERE unit_id = ? AND report_month = ? AND status = 0 LIMIT 1',
    [unitId, month]
  )
  let replacedBatchId = null
  if (old) {
    await pool.execute('DELETE FROM t_staff_roster_item WHERE batch_id = ?', [old.id])
    await pool.execute('DELETE FROM t_staff_roster_batch WHERE id = ?', [old.id])
    replacedBatchId = old.id
  }

  // 预加载白名单 + 库中现有人员（按身份证索引）
  const [unitList] = await pool.execute(
    "SELECT id, unit_name FROM t_contractor_unit WHERE grid_level IN ('三级','四级') AND is_active = 1"
  )
  const [users] = await pool.execute('SELECT id, id_card, name, unit, supervising_unit, contractor_unit_id FROM t_user')
  const userMap = new Map(users.map(u => [String(u.id_card).toUpperCase(), u]))

  const [batchRes] = await pool.execute(
    `INSERT INTO t_staff_roster_batch
       (unit_id, unit_name, report_month, status, submitted_by, submitted_by_name, submitted_at, total_count, source_file)
     VALUES (?, ?, ?, 0, ?, ?, NOW(), 0, ?)`,
    [unitId, unit.unit_name, month, submittedBy || null, submittedByName || '', filename || '']
  )
  const batchId = batchRes.insertId

  const failList = []
  const warnings = []
  let addCount = 0, removeCount = 0, keepCount = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2
    if (row.every(c => String(c).trim() === '')) continue

    const d = {}
    for (const [idx, field] of Object.entries(hm)) d[field] = String(row[idx] ?? '').trim()

    const name = d.name || ''
    const idCard = d.id_card.toUpperCase()
    const action = ACTION_ALIAS[d.action] || ''

    if (!name) { failList.push({ row: rowNum, data: row, error: '姓名不能为空' }); continue }
    if (!/^\d{17}[\dX]$/.test(idCard)) {
      failList.push({ row: rowNum, data: row, error: '身份证号格式不正确（需18位）' }); continue
    }
    if (!action) {
      failList.push({ row: rowNum, data: row, error: '报送动作必须是 新增/保留/移除 之一' }); continue
    }

    // 单位：优先用报送人填的；未填则按批次单位兜底（分包人员也归到报送单位下）
    let hit = null
    if (d.unit) {
      hit = matchUnit(d.unit, unitList)
      if (!hit) {
        failList.push({ row: rowNum, data: row, error: `单位「${d.unit}」不在网格化在册名单` }); continue
      }
      if (d.unit !== hit.unit_name) warnings.push(`第${rowNum}行 单位「${d.unit}」已规范为「${hit.unit_name}」`)
    } else {
      hit = { id: unitId, unit_name: unit.unit_name }
      warnings.push(`第${rowNum}行 未填单位，按报送单位「${unit.unit_name}」归属`)
    }

    // 与现有人库对照（供管理员审核时判断）
    const existing = userMap.get(idCard) || null
    if (action === 'remove' && !existing) {
      failList.push({ row: rowNum, data: row, error: `人员库中不存在该身份证，无法标记移除（${name}）` }); continue
    }
    if (action === 'add' && existing && existing.supervising_unit === TNB_UNIT) {
      warnings.push(`第${rowNum}行 ${name} 已在通南巴管理名单中，按「保留」处理`)
    }

    await pool.execute(
      `INSERT INTO t_staff_roster_item
         (batch_id, action, name, id_card, unit_name, contractor_unit_id, position, phone,
          current_unit_id, current_supervising, exists_in_db)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, action, name, idCard, hit.unit_name, hit.id, d.position || '', d.phone || null,
       existing ? existing.contractor_unit_id : null, existing ? existing.supervising_unit : '', existing ? 1 : 0]
    )

    if (action === 'add') addCount++
    else if (action === 'remove') removeCount++
    else keepCount++
  }

  await pool.execute(
    'UPDATE t_staff_roster_batch SET total_count = ?, add_count = ?, remove_count = ? WHERE id = ?',
    [addCount + removeCount + keepCount, addCount, removeCount, batchId]
  )

  return {
    batchId, total: addCount + removeCount + keepCount,
    addCount, removeCount, keepCount, failList, warnings, replacedBatchId,
  }
}

/** 报送模板（带动作下拉），复用隐患模板的 adm-zip 注入方式由路由层处理 */
function buildTemplateRows() {
  return [
    { '报送动作': '新增', '姓名': '', '身份证号': '', '所属单位': '', '岗位': '', '手机号': '' },
    { '报送动作': '保留', '姓名': '', '身份证号': '', '所属单位': '', '岗位': '', '手机号': '' },
    { '报送动作': '移除', '姓名': '', '身份证号': '', '所属单位': '', '岗位': '', '手机号': '' },
  ]
}

/**
 * 管理员审核通过：把批次明细应用到 t_user
 * remove → supervising_unit 改为「普光分公司」，保留原记录；add/keep → 通南巴项目部
 * @returns {{applied, skipped, details}}
 */
async function applyBatch(batchId, admin) {
  const [[batch]] = await pool.execute('SELECT * FROM t_staff_roster_batch WHERE id = ?', [batchId])
  if (!batch) throw new Error('报送批次不存在')
  if (batch.status !== 0) throw new Error('该批次已审核，不能重复应用')

  const [items] = await pool.execute('SELECT * FROM t_staff_roster_item WHERE batch_id = ? ORDER BY id', [batchId])
  const details = []
  let applied = 0, skipped = 0

  for (const it of items) {
    // 管理员审核时已手动剔除的明细不再应用
    if (it.apply_status === 'skipped') {
      details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: '已剔除，不应用' })
      skipped++
      continue
    }
    try {
      if (it.action === 'remove') {
        // 移除：只改主管单位，保留人员在大库中
        const [r] = await pool.execute(
          `UPDATE t_user SET supervising_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id_card = ?`,
          [PUGUANG_UNIT, it.id_card]
        )
        if (r.affectedRows > 0) {
          details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: `已移出通南巴，主管单位改为「${PUGUANG_UNIT}」` })
          applied++
        } else {
          details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: '人员库中未找到，跳过' })
          skipped++
        }
      } else {
        // 新增/保留：走 upsert（身份证为唯一键）
        const [existing] = await pool.execute('SELECT id FROM t_user WHERE id_card = ?', [it.id_card])
        if (existing.length) {
          await pool.execute(
            `UPDATE t_user
                SET name = ?, unit = ?, supervising_unit = ?, contractor_unit_id = ?,
                    phone = ?, position = ?, qr_token = ?, status = 1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [it.name, it.unit_name, TNB_UNIT, it.contractor_unit_id,
             it.phone || '', it.position || '', genQrToken(it.id_card), existing[0].id]
          )
          details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: '已更新人员库' })
        } else {
          await pool.execute(
            `INSERT INTO t_user (name, id_card, qr_token, unit, supervising_unit, contractor_unit_id, phone, position)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [it.name, it.id_card, genQrToken(it.id_card), it.unit_name, TNB_UNIT,
             it.contractor_unit_id, it.phone || '', it.position || '']
          )
          details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: '已新增到人员库' })
        }
        applied++
      }
      await pool.execute(
        "UPDATE t_staff_roster_item SET apply_status = 'applied', apply_note = ? WHERE id = ?",
        [details[details.length - 1].result, it.id]
      )
    } catch (e) {
      skipped++
      details.push({ id: it.id, name: it.name, id_card: it.id_card, action: it.action, result: '失败：' + e.message })
      await pool.execute(
        "UPDATE t_staff_roster_item SET apply_status = 'skipped', apply_note = ? WHERE id = ?",
        [e.message.slice(0, 180), it.id]
      )
    }
  }

  await pool.execute(
    `UPDATE t_staff_roster_batch
        SET status = 1, reviewed_by = ?, reviewed_by_name = ?, reviewed_at = NOW(),
            apply_count = ?, review_note = ?
      WHERE id = ?`,
    [admin.id || null, admin.username || admin.real_name || '', applied, '审核通过', batchId]
  )

  return { applied, skipped, details }
}

module.exports = {
  submitRoster, applyBatch, buildTemplateRows, parseExcel,
  TNB_UNIT, PUGUANG_UNIT,
}
