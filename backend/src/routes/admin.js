/**
 * 管理员路由
 *
 * POST   /api/admin/login                   管理员登录（无需鉴权）
 * GET    /api/admin/me                      获取当前管理员信息（需JWT）
 * POST   /api/admin/import-users            上传 Excel 并导入人员（需JWT）
 * GET    /api/admin/import-users/fail/:id   下载失败报告 Excel（需JWT）
 * GET    /api/admin/users                   查询人员列表（需JWT）
 * GET    /api/admin/users/export            导出人员信息 Excel（需JWT，支持筛选）
 * PATCH  /api/admin/users/:id/status        启用/禁用人员（需JWT）
 * DELETE /api/admin/users/:id               删除单个人员（需JWT）
 * POST   /api/admin/users/batch             批量处理（delete/enable/disable，需JWT）
 * GET    /api/admin/import-logs             导入历史（需JWT）
 */

const express   = require('express')
const multer    = require('multer')
const XLSX      = require('xlsx')
const { pool }  = require('../db/db')
const { importUsers, generateFailReport } = require('../services/importUser')
const { adminLogin, verifyAdminToken }   = require('../services/adminAuth')

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const token = authHeader.slice(7)
  const payload = verifyAdminToken(token)
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── POST /api/admin/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body
  try {
    const result = await adminLogin(username, password)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// ─── GET /api/admin/me ────────────────────────────────────────────────────────
router.get('/me', adminAuth, (req, res) => {
  res.json({ success: true, user: req.admin })
})

// ─── 以下路由全部需要鉴权 ─────────────────────────────────────────────────────

// multer：只接收 xlsx / xls 文件，限制 5MB，存内存
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ]
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
      cb(null, true)
    } else {
      cb(new Error('只支持 .xlsx / .xls 格式文件'))
    }
  },
})

// ─── POST /api/admin/import-users ────────────────────────────────────────────
router.post('/import-users', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传 .xlsx 文件' })
  }

  try {
    const adminId  = req.admin.id
    const filename = req.file.originalname

    const result = await importUsers(req.file.buffer, adminId, filename)

    res.json({
      success: true,
      message: `导入完成：成功 ${result.success} 条 / 失败 ${result.fail} 条`,
      data: {
        total:   result.total,
        success: result.success,
        fail:    result.fail,
        // 只返回前10条失败记录（完整报告用下载接口）
        failPreview: result.failList.slice(0, 10),
      },
    })
  } catch (err) {
    console.error('[importUsers error]', err.message)
    res.status(400).json({ error: err.message })
  }
})

// ─── GET /api/admin/import-users/fail/:logId ────────────────────────────────
// 下载失败明细 Excel
router.get('/import-users/fail/:logId', adminAuth, async (req, res) => {
  const { logId } = req.params

  const [rows] = await pool.execute(
    'SELECT fail_detail, filename FROM t_import_log WHERE id = ?',
    [logId]
  )

  if (!rows.length || !rows[0].fail_detail) {
    return res.status(404).json({ error: '记录不存在或无失败数据' })
  }

  const failList = rows[0].fail_detail
  const buffer   = generateFailReport(failList)
  const filename = encodeURIComponent(`失败明细_${rows[0].filename || logId}.xlsx`)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(buffer)
})

// ─── GET /api/admin/users ───────────────────────────────────────────────────
router.get('/users', adminAuth, async (req, res) => {
  const { keyword = '', unit = '', supervising_unit = '', page = 1, pageSize = 20 } = req.query
  const safePage     = Math.max(1, Number(page)     || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const safeOffset   = (safePage - 1) * safePageSize

  let where = 'WHERE 1=1'
  const params = []

  if (keyword) {
    where += ' AND (name LIKE ? OR id_card LIKE ? OR unit LIKE ? OR supervising_unit LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (unit) {
    where += ' AND unit = ?'
    params.push(unit)
  }
  if (supervising_unit) {
    where += ' AND supervising_unit = ?'
    params.push(supervising_unit)
  }

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_user ${where}`,
    params
  )

  const [rows] = await pool.query(
    `SELECT id, name, id_card, unit, supervising_unit, phone, status, qr_token, created_at
     FROM t_user ${where}
     ORDER BY created_at DESC
     LIMIT ${safePageSize} OFFSET ${safeOffset}`,
    params
  )

  res.json({
    success: true,
    data: { total, list: rows, page: Number(page), pageSize: Number(pageSize) },
  })
})

// ─── GET /api/admin/filter-options ───────────────────────────────────────────
// 获取所有唯一的承包商和主管单位（供前端筛选下拉框使用）
router.get('/filter-options', adminAuth, async (req, res) => {
  const [units] = await pool.query('SELECT DISTINCT unit FROM t_user WHERE unit != "" ORDER BY unit')
  const [supervisingUnits] = await pool.query('SELECT DISTINCT supervising_unit FROM t_user WHERE supervising_unit != "" ORDER BY supervising_unit')
  res.json({
    success: true,
    data: {
      units: units.map(r => r.unit),
      supervisingUnits: supervisingUnits.map(r => r.supervising_unit),
    },
  })
})

// ─── PATCH /api/admin/users/:id/status ──────────────────────────────────────
// 启用/禁用人员
router.patch('/users/:id/status', adminAuth, async (req, res) => {
  const { id } = req.params
  const { status } = req.body  // 0=禁用 1=启用

  if (![0, 1].includes(Number(status))) {
    return res.status(400).json({ error: 'status 只能为 0 或 1' })
  }

  const [result] = await pool.execute(
    'UPDATE t_user SET status = ? WHERE id = ?',
    [Number(status), id]
  )

  if (!result.affectedRows) {
    return res.status(404).json({ error: '用户不存在' })
  }

  res.json({ success: true, message: status === 1 ? '已启用' : '已禁用' })
})

// ─── POST /api/admin/users ────────────────────────────────────────────────────
// 新增单个人员（管理员手动录入）
router.post('/users', adminAuth, async (req, res) => {
  const { name, id_card, unit, supervising_unit, phone } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入姓名' })
  if (!id_card || !id_card.trim()) return res.status(400).json({ error: '请输入身份证号' })

  // 检查是否已存在
  const [existing] = await pool.execute('SELECT id FROM t_user WHERE id_card = ?', [id_card.trim()])
  if (existing.length > 0) return res.status(400).json({ error: '该身份证号已存在' })

  const crypto = require('crypto')
  const qrToken = crypto.createHash('sha256').update(id_card.trim()).digest('hex').slice(0, 16)

  const [result] = await pool.execute(
    `INSERT INTO t_user (name, id_card, unit, supervising_unit, phone, qr_token, status)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [name.trim(), id_card.trim(), (unit || '').trim(), (supervising_unit || '').trim(), (phone || '').trim(), qrToken]
  )
  res.json({ success: true, message: '人员已添加', data: { id: result.insertId } })
})

// ─── GET /api/admin/users/export ──────────────────────────────────────────
// 导出人员信息为 Excel（支持与列表相同的筛选条件）
// 注意：本路由必须注册在 GET /users/:id 之前，否则 'export' 会被 :id 吞掉
router.get('/users/export', adminAuth, async (req, res) => {
  const { keyword = '', unit = '', supervising_unit = '' } = req.query

  let where = 'WHERE 1=1'
  const params = []
  if (keyword) {
    where += ' AND (name LIKE ? OR id_card LIKE ? OR unit LIKE ? OR supervising_unit LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (unit) {
    where += ' AND unit = ?'
    params.push(unit)
  }
  if (supervising_unit) {
    where += ' AND supervising_unit = ?'
    params.push(supervising_unit)
  }

  try {
    const [rows] = await pool.query(
      `SELECT name, id_card, unit, supervising_unit, phone, status, created_at
       FROM t_user ${where}
       ORDER BY created_at DESC`,
      params
    )

    const data = rows.map((u, idx) => ({
      序号:       idx + 1,
      姓名:       u.name,
      身份证号:   u.id_card,
      承包商单位: u.unit || '',
      主管单位:   u.supervising_unit || '',
      手机号:     u.phone || '',
      状态:       Number(u.status) === 1 ? '启用' : '禁用',
      录入时间:   u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '',
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [
      { wch: 6 }, { wch: 12 }, { wch: 20 }, { wch: 24 }, { wch: 20 },
      { wch: 16 }, { wch: 8 }, { wch: 20 },
    ]
    XLSX.utils.book_append_sheet(wb, ws, '人员信息')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const filename = encodeURIComponent(`人员信息_${stamp}.xlsx`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
    res.send(buf)
  } catch (err) {
    console.error('[users export]', err.message)
    res.status(500).json({ error: '导出失败：' + err.message })
  }
})

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
// 获取单个人员详情
router.get('/users/:id', adminAuth, async (req, res) => {
  const { id } = req.params
  const [rows] = await pool.execute(
    'SELECT id, name, id_card, unit, supervising_unit, phone, status, qr_token, created_at, updated_at FROM t_user WHERE id = ?',
    [id]
  )
  if (!rows.length) return res.status(404).json({ error: '用户不存在' })
  res.json({ success: true, data: rows[0] })
})

// --- PUT /api/admin/users/:id ---
// 编辑人员信息
router.put('/users/:id', adminAuth, async (req, res) => {
  const { id } = req.params
  const { name, id_card, unit, supervising_unit, phone, status } = req.body

  const [existing] = await pool.execute('SELECT id FROM t_user WHERE id = ?', [id])
  if (!existing.length) return res.status(404).json({ error: '用户不存在' })

  const updates = []
  const params = []

  if (name !== undefined)             { updates.push('name = ?');             params.push(name.trim()) }
  if (id_card !== undefined)          { updates.push('id_card = ?');          params.push(id_card.trim()) }
  if (unit !== undefined)             { updates.push('unit = ?');             params.push(unit.trim()) }
  if (supervising_unit !== undefined) { updates.push('supervising_unit = ?'); params.push(supervising_unit.trim()) }
  if (phone !== undefined)            { updates.push('phone = ?');            params.push(phone.trim()) }
  if (status !== undefined)           { updates.push('status = ?');           params.push(Number(status)) }

  if (updates.length === 0) return res.status(400).json({ error: '请提供要修改的字段' })

  await pool.execute(`UPDATE t_user SET ${updates.join(', ')} WHERE id = ?`, [...params, id])
  res.json({ success: true, message: '人员信息已更新' })
})

// ─── DELETE /api/admin/users/:id ───────────────────────────────────────────────
// 删除单个人员
router.delete('/users/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '无效人员ID' })
  try {
    const [result] = await pool.execute('DELETE FROM t_user WHERE id = ?', [id])
    if (!result.affectedRows) return res.status(404).json({ error: '人员不存在' })
    res.json({ success: true, message: '人员已删除' })
  } catch (err) {
    console.error('[users delete]', err.message)
    res.status(500).json({ error: '删除失败：' + err.message })
  }
})

// ─── POST /api/admin/users/batch ──────────────────────────────────────────────
// 批量处理：{ ids: number[], action: 'delete' | 'enable' | 'disable' }
router.post('/users/batch', adminAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const ids = body.ids
    const action = body.action
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请选择要操作的人员' })
    }
    const cleanIds = Array.from(new Set(ids.map(Number).filter(function (n) { return Number.isInteger(n) && n > 0 })))
    if (cleanIds.length === 0) {
      return res.status(400).json({ error: '人员ID无效' })
    }
    if (action !== 'delete' && action !== 'enable' && action !== 'disable') {
      return res.status(400).json({ error: '不支持的批量操作' })
    }
    const q = cleanIds.map(function () { return '?' }).join(',')
    if (action === 'delete') {
      const out = await pool.execute('DELETE FROM t_user WHERE id IN (' + q + ')', cleanIds)
      const aff = out[0].affectedRows
      return res.json({ success: true, message: '已删除 ' + aff + ' 人', affected: aff })
    }
    const newStatus = action === 'enable' ? 1 : 0
    const out = await pool.execute('UPDATE t_user SET status = ? WHERE id IN (' + q + ')', [newStatus].concat(cleanIds))
    const aff = out[0].affectedRows
    const verb = action === 'enable' ? '启用' : '禁用'
    return res.json({ success: true, message: '已' + verb + ' ' + aff + ' 人', affected: aff })
  } catch (err) {
    console.error('[users batch]', err.stack || err.message)
    res.status(500).json({ error: '批量操作失败：' + err.message })
  }
})

// ─── GET /api/admin/import-logs ─────────────────────────────────────────────
router.get('/import-logs', adminAuth, async (req, res) => {
  const { page = 1, pageSize = 10 } = req.query
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 10))
  const safeOffset   = (Math.max(1, Number(page) || 1) - 1) * safePageSize

  const [rows] = await pool.query(
    `SELECT id, filename, total_rows, success_rows, fail_rows, imported_by, created_at
     FROM t_import_log
     ORDER BY created_at DESC
     LIMIT ${safePageSize} OFFSET ${safeOffset}`
  )

  res.json({ success: true, data: rows })
})

// ─── GET /api/admin/settings ────────────────────────────────────────────────
// 获取系统配置（目前只有一个 server_public_url）
router.get('/settings', adminAuth, async (req, res) => {
  const [rows] = await pool.execute('SELECT config_key, config_value FROM t_system_config')
  const settings = {}
  rows.forEach(r => { settings[r.config_key] = r.config_value })
  res.json({ success: true, data: settings })
})

// ─── POST /api/admin/settings ────────────────────────────────────────────────
// 保存系统配置（支持批量）
router.post('/settings', adminAuth, async (req, res) => {
  const { data } = req.body
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: '参数错误，请传入 data 对象' })
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue
    await pool.execute(
      'INSERT INTO t_system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
      [key, value, value]
    )
  }
  res.json({ success: true, message: '配置已保存' })
})

// ─── POST /api/admin/migrate ────────────────────────────────────────────────
// 数据库迁移（一次性使用，执行后可删除）
router.post('/migrate', adminAuth, async (req, res) => {
  try {
    // 检查 supervising_unit 字段是否已存在
    const [cols] = await pool.execute("SHOW COLUMNS FROM t_user LIKE 'supervising_unit'")
    if (cols.length > 0) {
      return res.json({ success: true, message: 'supervising_unit 字段已存在，无需迁移' })
    }
    await pool.execute(
      "ALTER TABLE t_user ADD COLUMN supervising_unit VARCHAR(100) NOT NULL DEFAULT '' COMMENT '所属主管单位（甲方）' AFTER unit"
    )
    await pool.execute('ALTER TABLE t_user ADD INDEX idx_supervising_unit (supervising_unit)')
    res.json({ success: true, message: '✅ supervising_unit 字段和索引添加完成' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/admin/fix-swap ─────────────────────────────────────────────────
// 修正 unit / supervising_unit 字段互换问题
// Excel中"主管单位"列装承包商，"所属单位"列装主管单位（列名与内容标反了）
// 历史导入时两列被错误映射，此接口将所有记录的 unit <-> supervising_unit 互换
router.post('/fix-swap', adminAuth, async (req, res) => {
  try {
    // MySQL UPDATE 中对同一表自引用时，RHS 全部先算再赋值，可直接互换
    const [r] = await pool.execute(
      `UPDATE t_user
       SET unit             = supervising_unit,
           supervising_unit = unit,
           updated_at       = CURRENT_TIMESTAMP
       WHERE unit != supervising_unit OR (unit != "" AND supervising_unit = "")`
    )

    // 验证
    const [after] = await pool.execute(
      `SELECT
         COUNT(*) as total,
         SUM(unit != "" AND supervising_unit != "") as both_filled,
         SUM(unit != "" AND supervising_unit = "") as only_unit,
         SUM(unit = "" AND supervising_unit != "") as only_su,
         SUM(unit = "" AND supervising_unit = "") as both_empty
       FROM t_user`
    )

    res.json({
      success: true,
      message: `✅ 互换完成，影响 ${r.affectedRows} 条记录`,
      stats: after[0],
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
