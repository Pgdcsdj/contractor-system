/**
 * 承包商人员清单报送路由
 *
 * 安全员端（role=safety）：
 *   GET  /api/staff-roster/mine          我本单位报送批次（按 t_admin.unit_id 隔离）
 *   GET  /api/staff-roster/units         我可报送的单位列表
 *   GET  /api/staff-roster/template      下载报送模板
 *   POST /api/staff-roster/submit        报送（Excel，写暂存表，不改人员库）
 *   GET  /api/staff-roster/batches/:id   批次明细（仅本单位）
 *
 * 管理端（role=admin/superadmin）：
 *   GET  /api/staff-roster/admin/batches 全部批次（可按 status/month/unit 筛选）
 *   GET  /api/staff-roster/admin/batches/:id  批次明细
 *   POST /api/staff-roster/admin/batches/:id/approve  审核通过并应用到人员库
 *   POST /api/staff-roster/admin/batches/:id/reject   驳回
 *   POST /api/staff-roster/admin/items/:id/skip       跳过某条明细
 */
const express = require('express')
const multer = require('multer')
const xlsx = require('xlsx')
const { pool } = require('../db/db')
const { requireRole, resolveRecorderContext } = require('../services/permission')
const {
  submitRoster, applyBatch, buildTemplateRows, TNB_UNIT, PUGUANG_UNIT,
} = require('../services/staffRosterService')

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname || '')
    if (!ok) return cb(new Error('仅支持 .xlsx / .xls 文件'))
    cb(null, true)
  },
})

function ok(res, data, extra = {}) { res.json({ success: true, data, ...extra }) }
function fail(res, code, msg) { res.status(code).json({ success: false, error: msg }) }

/** 从 token 解析当前安全员可报送的单位：优先 t_admin.unit_id */
async function myUnit(admin) {
  const adminId = admin && admin.id ? Number(admin.id) : 0
  if (!adminId) return null
  const [[row]] = await pool.execute(
    `SELECT a.id, a.username, a.real_name, a.unit_id, u.unit_name
       FROM t_admin a LEFT JOIN t_contractor_unit u ON u.id = a.unit_id
      WHERE a.id = ?`,
    [adminId]
  )
  if (!row) return null
  return row
}

// ─────────────────────────── 安全员端 ─────────────────────────────────────

// 可报送单位列表
router.get('/units', requireRole('safety'), async (req, res) => {
  try {
    const ctx = await myUnit(req.admin)
    if (!ctx || !ctx.unit_id) return ok(res, [])
    const [rows] = await pool.execute(
      "SELECT id, unit_name FROM t_contractor_unit WHERE id = ? AND is_active = 1 AND grid_level IN ('三级','四级')",
      [ctx.unit_id]
    )
    ok(res, rows)
  } catch (e) { fail(res, 500, e.message) }
})

// 我本单位的报送批次
router.get('/mine', requireRole('safety'), async (req, res) => {
  try {
    const ctx = await myUnit(req.admin)
    if (!ctx || !ctx.unit_id) return ok(res, [])
    const [rows] = await pool.execute(
      `SELECT b.*,
              (SELECT COUNT(*) FROM t_staff_roster_item i WHERE i.batch_id = b.id AND i.apply_status = 'applied') AS applied_items
         FROM t_staff_roster_batch b
        WHERE b.unit_id = ?
        ORDER BY b.report_month DESC, b.id DESC`,
      [ctx.unit_id]
    )
    ok(res, rows)
  } catch (e) { fail(res, 500, e.message) }
})

// 报送模板
router.get('/template', requireRole('safety'), async (req, res) => {
  try {
    const wb = xlsx.utils.book_new()
    const ws = xlsx.utils.json_to_sheet(buildTemplateRows())
    xlsx.utils.book_append_sheet(wb, ws, '人员清单')
    // 说明：报送动作仅接受 新增/保留/移除；服务端会硬校验（数据校验下拉见后续按需加）
    ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 32 }, { wch: 16 }, { wch: 16 }]
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('承包商人员清单报送模板.xlsx'))
    res.send(buf)
  } catch (e) { fail(res, 500, e.message) }
})

// 报送（安全员，写暂存）
router.post('/submit', requireRole('safety'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 400, '请选择 Excel 文件')
    const ctx = await myUnit(req.admin)
    if (!ctx || !ctx.unit_id) return fail(res, 400, '当前安全员账号未绑定承包商单位，请联系管理员')
    const month = String(req.body.month || '').trim()
    const result = await submitRoster(req.file.buffer, {
      unitId: ctx.unit_id,
      reportMonth: month,
      submittedBy: ctx.id,
      submittedByName: ctx.real_name || ctx.username || '',
      filename: req.file.originalname,
    })
    ok(res, result, { message: result.replacedBatchId ? '已替换本月未审核批次，请核对后等待管理员审核' : '报送成功，请等待管理员审核' })
  } catch (e) { fail(res, 400, e.message) }
})

// 批次明细（安全员，限本单位）
router.get('/batches/:id', requireRole('safety'), async (req, res) => {
  try {
    const ctx = await myUnit(req.admin)
    if (!ctx || !ctx.unit_id) return fail(res, 403, '无权访问')
    const [[batch]] = await pool.execute('SELECT * FROM t_staff_roster_batch WHERE id = ? AND unit_id = ?', [req.params.id, ctx.unit_id])
    if (!batch) return fail(res, 404, '批次不存在')
    const [items] = await pool.execute('SELECT * FROM t_staff_roster_item WHERE batch_id = ? ORDER BY id', [batch.id])
    ok(res, { batch, items })
  } catch (e) { fail(res, 500, e.message) }
})

// ─────────────────────────── 管理端 ───────────────────────────────────────

// 全部批次
router.get('/admin/batches', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { status, month, unitId } = req.query
    let where = '1=1'
    const params = []
    if (status !== undefined && status !== '') { where += ' AND b.status = ?'; params.push(Number(status)) }
    if (month) { where += ' AND b.report_month = ?'; params.push(String(month)) }
    if (unitId) { where += ' AND b.unit_id = ?'; params.push(Number(unitId)) }
    const [rows] = await pool.execute(
      `SELECT b.*,
              (SELECT COUNT(*) FROM t_staff_roster_item i WHERE i.batch_id = b.id AND i.apply_status = 'applied') AS applied_items
         FROM t_staff_roster_batch b
        WHERE ${where}
        ORDER BY b.status ASC, b.report_month DESC, b.id DESC`,
      params
    )
    ok(res, rows)
  } catch (e) { fail(res, 500, e.message) }
})

// 批次明细
router.get('/admin/batches/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const [[batch]] = await pool.execute('SELECT * FROM t_staff_roster_batch WHERE id = ?', [req.params.id])
    if (!batch) return fail(res, 404, '批次不存在')
    const [items] = await pool.execute('SELECT * FROM t_staff_roster_item WHERE batch_id = ? ORDER BY id', [batch.id])
    ok(res, { batch, items })
  } catch (e) { fail(res, 500, e.message) }
})

// 审核通过 → 应用到人员库
router.post('/admin/batches/:id/approve', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const ctx = await resolveRecorderContext(req.admin)
    const result = await applyBatch(req.params.id, {
      id: req.admin.id,
      username: req.admin.username || ctx.recorder_name || '',
    })
    ok(res, result, { message: `审核完成：应用 ${result.applied} 人，跳过 ${result.skipped} 人` })
  } catch (e) { fail(res, 400, e.message) }
})

// 驳回
router.post('/admin/batches/:id/reject', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const note = String(req.body.note || '').trim()
    const [[b]] = await pool.execute('SELECT status FROM t_staff_roster_batch WHERE id = ?', [req.params.id])
    if (!b) return fail(res, 404, '批次不存在')
    if (b.status !== 0) return fail(res, 400, '该批次已审核')
    const ctx = await resolveRecorderContext(req.admin)
    await pool.execute(
      `UPDATE t_staff_roster_batch
          SET status = 2, reviewed_by = ?, reviewed_by_name = ?, reviewed_at = NOW(), review_note = ?
        WHERE id = ?`,
      [req.admin.id, req.admin.username || ctx.recorder_name || '', note || '审核驳回', req.params.id]
    )
    ok(res, { id: Number(req.params.id) }, { message: '已驳回，安全员可重新报送' })
  } catch (e) { fail(res, 500, e.message) }
})

// 跳过某条明细（审核时剔除个别人）
router.post('/admin/items/:id/skip', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const note = String(req.body.note || '').trim() || '管理员审核时剔除'
    const [r] = await pool.execute(
      "UPDATE t_staff_roster_item SET apply_status = 'skipped', apply_note = ? WHERE id = ? AND apply_status = 'pending'",
      [note.slice(0, 180), req.params.id]
    )
    if (!r.affectedRows) return fail(res, 400, '明细不存在或已处理')
    ok(res, { id: Number(req.params.id) })
  } catch (e) { fail(res, 500, e.message) }
})

module.exports = router
