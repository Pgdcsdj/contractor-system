/**
 * 隐患闭环状态机路由（Sprint 2 / P0-1/3/4/5/6、P1-3）
 *
 * POST   /api/hazards                隐患上报
 * GET    /api/hazards                闭环看板列表（筛选 + 分页 + summary）
 * POST   /api/hazards/overdue/notify 超期手动通知（⚠ 必须在 /:id 之前定义）
 * GET    /api/hazards/:id            隐患详情（含照片）
 * PATCH  /api/hazards/:id/assign     分派（仅 reported → assigned）
 * PATCH  /api/hazards/:id/rectify    整改代录（assigned / rectifying）
 * PATCH  /api/hazards/:id/verify      验收（仅 verifying）
 *
 * 鉴权：管理员 token（与 hazard.js / contractorUnit.js 同款内联 adminAuth）
 * 响应：{ success:true, data } / { success:false, error }
 * 钉钉通知：fire-and-forget，先提交 DB 状态变更，再 try/catch 调 sendHazardNotification，
 *          通知失败仅 console.error，不回滚状态、不让接口 500。
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const { generateHazardCode } = require('../services/hazardCode')
const { sendHazardNotification } = require('../services/dingtalk/notify')
const schedulerConfig = require('../services/schedulerConfig')
const { STATUS, LEVELS } = require('../constants/hazardStates')
const { applyRecorderScope, resolveRecorderContext } = require('../services/permission')
const importService = require('../services/importService')
const path = require('path')
const multer = require('multer')
const xlsx = require('xlsx')

const router = express.Router()

// ─── JWT 鉴权中间件（与既有路由约定一致）─────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── 管理员 / 安全员双角色鉴权中间件 ────────────────────────────────────────
// 隐患批量导入需同时开放给管理员后台与安全员工作台调用。
// 与 adminAuth 共享同一套 JWT（signAdminToken / verifyAdminToken），仅放宽角色限制，
// 解析出的用户统一挂到 req.admin，下游 adminAuth 逻辑（含 recorder 作用域隔离）完全复用。
function requireAdminOrSafety(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── 隐患主表字段（不含 is_overdue 列，由 SQL 计算）──────────────────────────
const HAZARD_COLUMNS = [
  'id', 'hazard_code', 'contractor_unit_id', 'unit_name', 'business_dept', 'hazard_investigation_item', 'business_dept_head', 'location',
  'description', 'hazard_level', 'is_reject_item', 'deduct_score', 'rectify_measures',
  'responsible_person', 'plan_finish_time', 'rectify_status', 'status',
  'reported_by', 'reported_by_name', 'report_time', 'photo_url', 'rectify_photo_url',
  'assigned_to', 'assigned_at', 'verified_by', 'verified_at', 'verify_result',
  'verify_comment', 'remark', 'closed_at', 'overdue_notified', 'created_at', 'updated_at',
  'recorder_id', 'recorder_name', 'recorder_unit_id', 'recorder_unit_name', 'deleted_at',
].join(', ')

// ─── is_overdue 计算表达式（列表 / 详情 / 超期通用）──────────────────────────
const OVERDUE_EXPR = `CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END`

// ─── 钉钉通知 fire-and-forget ────────────────────────────────────────────────
async function fireNotify(event, payload) {
  try {
    await sendHazardNotification(event, payload)
  } catch (e) {
    console.error('[dingtalk notify failed]', event, payload?.hazardNo || '', e.message)
  }
}

// ─── 加载某承包商单位的甲方联系人手机号（群@路由用）────────────────────────────
/**
 * 从 t_contractor_unit 读取 party_a_contact_phone，按 / , 、 拆分、过滤、返回干净手机号数组。
 * @param {Object} pool
 * @param {number|null} contractorUnitId
 * @returns {Promise<string[]>}
 */
async function loadPartyAMobiles(pool, contractorUnitId) {
  if (contractorUnitId == null) return []
  try {
    const [rows] = await pool.execute(
      'SELECT party_a_contact_phone FROM t_contractor_unit WHERE id = ?',
      [Number(contractorUnitId)]
    )
    if (!rows.length) return []
    const raw = rows[0].party_a_contact_phone || ''
    return raw
      .split(/[\/,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (e) {
    console.error('[loadPartyAMobiles] 查询失败（已忽略）:', e.message)
    return []
  }
}

// ─── POST /api/hazards —— 隐患上报 ───────────────────────────────────────────
router.post('/', adminAuth, async (req, res) => {
  const {
    contractor_unit_id,
    unit_name,
    location = '',
    description,
    hazard_level,
    rectify_measures = '',
    responsible_person,
    plan_finish_time,
    business_dept = '',
    hazard_investigation_item = '',
    business_dept_head = '',
    remark = '',
    photo_urls = [],
  } = req.body

  // 必填校验
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ success: false, error: '请填写隐患单位' })
  if (!description || !description.trim()) return res.status(400).json({ success: false, error: '请填写隐患描述' })
  if (!hazard_level || !hazard_level.trim()) return res.status(400).json({ success: false, error: '请选择隐患等级' })
  if (!responsible_person || !responsible_person.trim()) return res.status(400).json({ success: false, error: '请填写整改责任人' })
  if (!plan_finish_time) return res.status(400).json({ success: false, error: '请选择计划完成时间' })
  if (!LEVELS.includes(hazard_level)) return res.status(400).json({ success: false, error: '隐患等级非法' })

  try {
    const hazard_code = await generateHazardCode(pool)
    const safeUnitId = contractor_unit_id ? Number(contractor_unit_id) : null
    const photoList = Array.isArray(photo_urls) ? photo_urls.filter(Boolean) : []
    const firstPhoto = photoList.length ? photoList[0] : ''

    // 录入人上下文：取当前登录管理员/安全员（设计 §8.2，recorder_* 由后端写入，前端不传）
    const recorderCtx = await resolveRecorderContext(req.admin)

    const [result] = await pool.execute(
      `INSERT INTO t_hazard
        (hazard_code, contractor_unit_id, unit_name, location, description, hazard_level,
         rectify_measures, responsible_person,
         plan_finish_time, business_dept, hazard_investigation_item, business_dept_head, status,
         reported_by, reported_by_name, report_time, photo_url, rectify_status,
         recorder_id, recorder_name, recorder_unit_id, recorder_unit_name, remark, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, NOW(), ?, '未整改', ?, ?, ?, ?, ?, NULL)`,
      [
        hazard_code, safeUnitId, unit_name.trim(), location.trim(), description.trim(),
        hazard_level, rectify_measures,
        responsible_person.trim(), plan_finish_time,
        business_dept || '', hazard_investigation_item || '', business_dept_head || '',
        req.admin.id, req.admin.username, firstPhoto,
        recorderCtx.recorder_id, recorderCtx.recorder_name, recorderCtx.recorder_unit_id, recorderCtx.recorder_unit_name, remark,
      ]
    )
    const hazardId = result.insertId

    if (photoList.length) {
      const values = photoList.map((url) => [hazardId, url, 'report'])
      await pool.query('INSERT INTO t_hazard_photo (hazard_id, photo_url, photo_type) VALUES ?', [values])
    }

    // 隐患录入不再即时广播；改为每天 17:00 由 hazardScheduler.sendDailyDigest 汇总发送
    res.json({
      success: true,
      data: {
        id: hazardId,
        hazard_code,
        status: 'reported',
        business_dept: business_dept || '',
        hazard_investigation_item: hazard_investigation_item || '',
        business_dept_head: business_dept_head || '',
      },
    })
  } catch (err) {
    console.error('[hazard report]', err.message)
    res.status(500).json({ success: false, error: '隐患上报失败：' + err.message })
  }
})

// ─── 批量导入：multer 配置 / 字段别名 / 解析工具 ───────────────────────────────
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls') ||
      file.originalname.endsWith('.csv') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    cb(ok ? null : new Error('只支持 .xlsx / .xls / .csv 文件'), ok)
  },
})

// 清洗函数（locateHeaderRow / buildMapping / parseDate / normalizeLevel / matchDictOption /
// cleanPhone / autoMatchPhone / editDistance / mapProgressToStatus）已抽到
// backend/src/services/importService.js 统一复用；本文件仅保留 multer 上传配置与路由委托。

// ─── POST /api/hazards/import —— 上传并返回预览（不落库）────────────────────
router.post('/import', requireAdminOrSafety, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx / .xls / .csv 文件' })
  }
  try {
    const data = await importService.previewImport(req.file.buffer, req.admin)
    res.json({ success: true, data })
  } catch (err) {
    console.error('[hazard import preview]', err && err.message ? err.message : err)
    res.status(500).json({ success: false, error: '导入预览失败：' + (err && err.message ? err.message : '未知错误') })
  }
})

// ─── POST /api/hazards/import/confirm —— 事务批量落库（失败整批回退）─────────
router.post('/import/confirm', requireAdminOrSafety, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx / .xls / .csv 文件' })
  }
  try {
    const data = await importService.commitImport(req.file.buffer, req.admin, req.file.originalname)
    res.json({ success: true, data })
  } catch (err) {
    // 门禁拒绝：存在校验错误行，整批拒绝，库零变更（未开启事务，无回退动作）。
    // 与 DB 级回退（err.rollback）区分：二者都表现为 success:false，但 rejected:true 表示门禁拦截。
    if (err && err.rejected) {
      console.error('[hazard import commit] 门禁拒绝：存在校验错误行，failList=', err.failList ? err.failList.length : 0)
      return res.status(400).json({
        success: false,
        error: err.message || '存在校验错误行，已整批拒绝，请修正 Excel 后重新上传',
        data: { rollback: true, rejected: true, failList: err.failList || [] },
      })
    }
    if (err && err.rollback) {
      console.error('[hazard import commit] 已整批回退，failAtRow=', err.failAtRow, '原因：', err.message)
      return res.status(500).json({
        success: false,
        error: err.message || '导入失败，已整批回退，库未变更',
        data: { rollback: true, failAtRow: err.failAtRow != null ? err.failAtRow : null },
      })
    }
    console.error('[hazard import commit]', err && err.message ? err.message : err)
    res.status(500).json({ success: false, error: '导入失败：' + (err && err.message ? err.message : '未知错误') })
  }
})

// ─── GET /api/hazards/import/template —— 下载标准导入模板 ───────────────────
router.get('/import/template', requireAdminOrSafety, async (req, res) => {
  try {
    const buffer = importService.generateTemplate()
    // RFC 5987 编码：filename 用 ASCII 兜底，filename* 用 UTF-8 百分号编码携带中文名，避免 Node 拒绝非 ASCII 头值
    res.setHeader(
      'Content-Disposition',
      "attachment; filename=\"hazard_import_template.xlsx\"; filename*=UTF-8''%E9%9A%90%E6%82%A3%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx"
    )
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buffer)
  } catch (err) {
    console.error('[hazard import template]', err && err.message ? err.message : err)
    res.status(500).json({ success: false, error: '模板生成失败：' + (err && err.message ? err.message : '未知错误') })
  }
})

// ─── GET /api/hazards/import/logs —— 历史导入记录（数据管理页可查）────────────
router.get('/import/logs', requireAdminOrSafety, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, filename, total_rows, success_rows, fail_rows, fail_detail, imported_by, created_at FROM t_import_log ORDER BY id DESC LIMIT 50'
    )
    const list = rows.map(function (r) {
      let detail = []
      if (r.fail_detail) {
        try { detail = typeof r.fail_detail === 'string' ? JSON.parse(r.fail_detail) : r.fail_detail } catch (e) { detail = [] }
      }
      return {
        id: r.id,
        filename: r.filename,
        totalRows: r.total_rows,
        successRows: r.success_rows,
        failRows: r.fail_rows,
        failDetail: detail,
        importedBy: r.imported_by,
        createdAt: r.created_at,
      }
    })
    res.json({ success: true, data: { list: list } })
  } catch (err) {
    console.error('[hazard import logs]', err && err.message ? err.message : err)
    res.status(500).json({ success: false, error: '查询导入记录失败：' + (err && err.message ? err.message : '未知错误') })
  }
})

// ─── GET /api/hazards —— 闭环看板列表 ────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  const {
    status = '',
    contractor_unit_id = '',
    level = '',
    keyword = '',
    is_overdue = '',
    page = 1,
    pageSize = 20,
  } = req.query

  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const offset = (safePage - 1) * safePageSize

  // 列表筛选（含 status / is_overdue 切换）
  const where = []
  const params = []
  if (contractor_unit_id) { where.push('contractor_unit_id = ?'); params.push(Number(contractor_unit_id)) }
  if (level) { where.push('hazard_level = ?'); params.push(level) }
  if (keyword) {
    where.push('(unit_name LIKE ? OR description LIKE ? OR responsible_person LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (status) { where.push('status = ?'); params.push(status) }
  if (is_overdue === '1') {
    where.push("(status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW())")
  }
  // 软删除 + 安全员录入人作用域隔离（设计 §3.4(c) / §8.3）
  where.push('deleted_at IS NULL')
  const sc = applyRecorderScope(req.admin.role, req.admin.id)
  if (sc.clause) {
    where.push(sc.clause.replace(/^AND\s*/i, '')) // applyRecorderScope 返回带 AND 前缀，此处只需条件本身
    params.push(...sc.params)
  }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''

  // 汇总筛选（忽略 status / is_overdue，用于 Tab 计数）
  const sumWhere = []
  const sumParams = []
  if (contractor_unit_id) { sumWhere.push('contractor_unit_id = ?'); sumParams.push(Number(contractor_unit_id)) }
  if (level) { sumWhere.push('hazard_level = ?'); sumParams.push(level) }
  if (keyword) {
    sumWhere.push('(unit_name LIKE ? OR description LIKE ? OR responsible_person LIKE ?)')
    sumParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  sumWhere.push('deleted_at IS NULL')
  if (sc.clause) {
    sumWhere.push(sc.clause.replace(/^AND\s*/i, ''))
    sumParams.push(...sc.params)
  }
  const sumWhereClause = sumWhere.length ? 'WHERE ' + sumWhere.join(' AND ') : ''

  try {
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM t_hazard ${whereClause}`, params)

    const [rows] = await pool.query(
      `SELECT ${HAZARD_COLUMNS}, ${OVERDUE_EXPR} AS is_overdue
         FROM t_hazard ${whereClause}
        ORDER BY report_time DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, safePageSize, offset]
    )

    // summary：各状态计数 + 超期数
    const byStatus = { reported: 0, assigned: 0, rectifying: 0, verifying: 0, closed: 0 }
    const [statusRows] = await pool.execute(
      `SELECT status, COUNT(*) AS c FROM t_hazard ${sumWhereClause} GROUP BY status`,
      sumParams
    )
    statusRows.forEach((r) => { if (r.status in byStatus) byStatus[r.status] = r.c })

    const overdueWhere = sumWhereClause
      ? sumWhereClause + " AND status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()"
      : "WHERE status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()"
    const [[{ overdue }]] = await pool.execute(`SELECT COUNT(*) AS overdue FROM t_hazard ${overdueWhere}`, sumParams)

    res.json({
      success: true,
      data: {
        total,
        list: rows,
        page: safePage,
        pageSize: safePageSize,
        summary: { byStatus, overdue },
      },
    })
  } catch (err) {
    console.error('[hazard list]', err.message)
    res.status(500).json({ success: false, error: '隐患列表查询失败：' + err.message })
  }
})

// ─── GET /api/hazards/stats —— KPI 聚合接口（必须在 /:id 之前）─────────────────
// 复用同文件 adminAuth；路径 /api/hazards/stats 命中 request.js 的 /api/hazard 前缀，自动注入 admin token。
router.get('/stats', adminAuth, async (req, res) => {
  const { granularity = 'week' } = req.query
  const byDay = granularity === 'day'
  try {
    // 总数 / 超期 / 闭环
    const [[totals]] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()) AS overdue,
         SUM(status = 'closed') AS closed
       FROM t_hazard WHERE deleted_at IS NULL`
    )
    const total = totals.total || 0
    const overdue = totals.overdue || 0
    const closed = totals.closed || 0
    const closedRate = total ? Math.round((closed / total) * 100) : 0

    // 状态分布（确保 5 态齐全，缺省 0）
    const [statusRows] = await pool.execute('SELECT status, COUNT(*) AS c FROM t_hazard WHERE deleted_at IS NULL GROUP BY status')
    const byStatus = { reported: 0, assigned: 0, rectifying: 0, verifying: 0, closed: 0 }
    statusRows.forEach((r) => { if (r.status in byStatus) byStatus[r.status] = r.c })

    // 等级分布（确保 3 级齐全，缺省 0）
    const [levelRows] = await pool.execute('SELECT hazard_level, COUNT(*) AS c FROM t_hazard WHERE deleted_at IS NULL GROUP BY hazard_level')
    const byLevel = {}
    ;['重大隐患', '较大隐患', '一般隐患'].forEach((l) => { byLevel[l] = 0 })
    levelRows.forEach((r) => { if (r.hazard_level in byLevel) byLevel[r.hazard_level] = r.c })

    // 单位归集（按 unit_name）
    const [unitRows] = await pool.execute(
      `SELECT unit_name,
              COUNT(*) AS count,
              SUM(status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()) AS overdue,
              SUM(status = 'closed') AS closed
         FROM t_hazard
        WHERE deleted_at IS NULL
        GROUP BY unit_name
        ORDER BY count DESC`
    )
    const byUnit = unitRows.map((u) => ({
      unitName: u.unit_name || '未标注',
      count: u.count || 0,
      overdue: u.overdue || 0,
      closed: u.closed || 0,
    }))

    // 趋势（近 30 天，默认按周 / granularity=day 按天）
    const bucketExpr = byDay
      ? 'DATE(report_time)'
      : 'DATE_SUB(CURDATE(), INTERVAL WEEKDAY(report_time) DAY)'
    const [trendRows] = await pool.query(
      `SELECT DATE_FORMAT(bucket, '%m-%d') AS label,
              SUM(newCount) AS newCount,
              SUM(closedCount) AS closedCount
         FROM (
           SELECT ${bucketExpr} AS bucket, COUNT(*) AS newCount, 0 AS closedCount
             FROM t_hazard
            WHERE deleted_at IS NULL AND report_time >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY bucket
           UNION ALL
           SELECT ${bucketExpr} AS bucket, 0 AS newCount, COUNT(*) AS closedCount
             FROM t_hazard
            WHERE deleted_at IS NULL AND closed_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY bucket
         ) t
        GROUP BY bucket
        ORDER BY bucket`
    )
    const trend = trendRows.map((r) => ({
      label: r.label,
      newCount: Number(r.newCount) || 0,
      closedCount: Number(r.closedCount) || 0,
    }))

    res.json({
      success: true,
      data: { total, byStatus, byLevel, byUnit, closedRate, overdue, trend },
    })
  } catch (err) {
    console.error('[hazard stats]', err.message)
    res.status(500).json({ success: false, error: '聚合统计失败：' + err.message })
  }
})

// ─── GET /api/hazards/overdue —— 超期隐患清单（必须在 /:id 之前）──────────────
// 供监控看板「超期预警清单」面板使用：返回所有未闭环、未软删且 plan_finish_time 已过的隐患。
// 支持可选筛选：
//   unit     —— 责任单位精确过滤（unit_name = ?）
//   minDays —— 最小超期天数（DATEDIFF(NOW(), plan_finish_time) >= ?）
// ORDER BY plan_finish_time ASC：计划完成时间越早（即超期最久）排在最前，便于优先处置。
// 超期天数由后端用 Date.now() 计算，前端无需再算，避免时区 / 客户端时钟偏差。
router.get('/overdue', adminAuth, async (req, res) => {
  const { unit = '', minDays = '' } = req.query
  const where = [
    "status <> 'closed'",
    'plan_finish_time IS NOT NULL',
    'plan_finish_time < NOW()',
    'deleted_at IS NULL',
  ]
  const params = []
  if (unit) {
    where.push('unit_name = ?')
    params.push(String(unit).trim())
  }
  if (minDays !== '' && !Number.isNaN(Number(minDays))) {
    where.push('DATEDIFF(NOW(), plan_finish_time) >= ?')
    params.push(Number(minDays))
  }
  const whereClause = 'WHERE ' + where.join(' AND ')

  try {
    const [rows] = await pool.execute(
      `SELECT id, hazard_code, unit_name, responsible_person, hazard_level,
              plan_finish_time,
              DATE_FORMAT(plan_finish_time, '%Y-%m-%d %H:%i') AS plan_finish_fmt,
              description,
              ${OVERDUE_EXPR} AS is_overdue
         FROM t_hazard ${whereClause}
        ORDER BY plan_finish_time ASC`,
      params
    )

    const list = rows.map((r) => {
      const overdueDays = r.plan_finish_time
        ? Math.max(0, Math.floor((Date.now() - new Date(r.plan_finish_time).getTime()) / 86400000))
        : 0
      return {
        id: r.id,
        hazardCode: r.hazard_code,
        unitName: r.unit_name || '未标注',
        responsiblePerson: r.responsible_person || '',
        hazardLevel: r.hazard_level || '',
        planFinishTime: r.plan_finish_fmt || '',
        title: r.description || '',
        overdueDays,
      }
    })

    res.json({ success: true, data: { total: list.length, list } })
  } catch (err) {
    console.error('[hazard overdue list]', err.message)
    res.status(500).json({ success: false, error: '超期清单查询失败：' + err.message })
  }
})

// ─── POST /api/hazards/overdue/notify —— 超期手动通知（必须在 /:id 之前）────────
router.post('/overdue/notify', adminAuth, async (req, res) => {
  const { ids } = req.body
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: '请提供要通知的隐患 ids 数组' })
  }

  let sent = 0
  let skipped = 0
  try {
    for (const rawId of ids) {
      const id = Number(rawId)
      if (!id) { skipped++; continue }

      const [rows] = await pool.execute(
        `SELECT ${HAZARD_COLUMNS}, last_overdue_notify_at, ${OVERDUE_EXPR} AS is_overdue FROM t_hazard WHERE id = ? AND deleted_at IS NULL`,
        [id]
      )
      const h = rows[0]
      if (!h) { skipped++; continue }
      // 二次校验：未闭环 & 真超期 & 未通知过
      if (h.status === 'closed') { skipped++; continue }
      const plan = h.plan_finish_time ? new Date(h.plan_finish_time).getTime() : null
      if (!plan || plan >= Date.now()) { skipped++; continue }
      // 跨机制幂等护栏：overdue_notified 已置位，或 last_overdue_notify_at 为当天（扫描器/手动任一路径先通知均命中）。
      // 这样无论扫描还是手动先通知，当天另一条路径都会 skipped，避免重复发送。
      const sameDayNotified =
        h.last_overdue_notify_at &&
        new Date(h.last_overdue_notify_at).toDateString() === new Date().toDateString()
      if (h.overdue_notified === 1 || sameDayNotified) { skipped++; continue }

      const overdueDays = Math.floor((Date.now() - plan) / 86400000)
      // 先 fire-and-forget 钉钉通知，再写入每日幂等护栏（last_overdue_notify_at / overdue_notified）。
      // 钉钉机器人未启用(skipped)或发送失败时，不写护栏，便于配置后或下一周期补发，避免「假已通知」。
      try {
        const r = await sendHazardNotification('OVERDUE', {
          hazardNo: h.hazard_code,
          title: h.description,
          ownerName: h.responsible_person,
          ownerMobile: undefined,
          businessDeptHead: h.business_dept_head,
          overdueDays,
        })
        if (!r.skipped) {
          await pool.execute('UPDATE t_hazard SET overdue_notified = 1, last_overdue_notify_at = NOW() WHERE id = ?', [id])
          sent++
        } else {
          skipped++
        }
      } catch (e) {
        console.error('[overdue notify failed]', h.hazard_code, e.message)
        skipped++
      }
    }
    res.json({ success: true, data: { sent, skipped } })
  } catch (err) {
    console.error('[overdue notify]', err.message)
    res.status(500).json({ success: false, error: '超期通知失败：' + err.message })
  }
})

// ─── DELETE /api/hazards/batch —— 批量删除隐患（须放在 /:id 之前定义）─────────
router.delete('/batch', adminAuth, async (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要删除的隐患' })
  }
  // 仅保留可解析的正整数，防注入
  const cleanIds = ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: '无效的隐患 ID' })
  }
  try {
    // 软删除：仅标记 deleted_at，禁止物理 DELETE（设计 §8.3）；安全员越权行自动被 recorder 作用域过滤
    const placeholders = cleanIds.map(() => '?').join(', ')
    const sc = applyRecorderScope(req.admin.role, req.admin.id)
    const [result] = await pool.execute(
      `UPDATE t_hazard SET deleted_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL ${sc.clause}`,
      [...cleanIds, ...sc.params]
    )
    if (req.admin.role === 'safety' && result.affectedRows === 0) {
      return res.status(403).json({ success: false, error: '无权删除该隐患' })
    }
    res.json({ success: true, data: { deleted: result.affectedRows } })
  } catch (err) {
    console.error('[hazard batch delete]', err.message)
    res.status(500).json({ success: false, error: '删除失败：' + err.message })
  }
})

// ─── DELETE /api/hazards/:id —— 单条软删除（须在 /:id 静态路由之后，DELETE 方法独立匹配）──
router.delete('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ success: false, error: '无效的隐患 ID' })
  try {
    const sc = applyRecorderScope(req.admin.role, req.admin.id)
    const [rows] = await pool.execute(
      'SELECT id, recorder_id FROM t_hazard WHERE id = ? AND deleted_at IS NULL',
      [id]
    )
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    // 安全员仅可删除本人录入的隐患，越权 → 403 不生效（设计 §3.4(c)）
    if (req.admin.role === 'safety' && rows[0].recorder_id !== req.admin.id) {
      return res.status(403).json({ success: false, error: '无权删除该隐患' })
    }
    const [result] = await pool.execute(
      `UPDATE t_hazard SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL ${sc.clause}`,
      [id, ...sc.params]
    )
    res.json({ success: true, data: { deleted: result.affectedRows } })
  } catch (err) {
    console.error('[hazard delete]', err.message)
    res.status(500).json({ success: false, error: '删除失败：' + err.message })
  }
})

// ─── GET /api/hazards/:id —— 隐患详情（含照片）───────────────────────────────
router.get('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  try {
    const [rows] = await pool.execute(
      `SELECT ${HAZARD_COLUMNS}, ${OVERDUE_EXPR} AS is_overdue FROM t_hazard WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })

    const hazard = rows[0]
    // 权限隔离：安全员仅可查看本人录入的隐患，越权 → 403 不返回数据（设计 §3.4(c)）
    if (req.admin.role === 'safety' && hazard.recorder_id !== req.admin.id) {
      return res.status(403).json({ success: false, error: '无权访问' })
    }
    const [photos] = await pool.execute(
      'SELECT id, photo_url, photo_type FROM t_hazard_photo WHERE hazard_id = ? ORDER BY id ASC',
      [id]
    )
    const grouped = { report: [], rectify: [] }
    photos.forEach((p) => {
      if (p.photo_type === 'rectify') grouped.rectify.push(p)
      else grouped.report.push(p)
    })
    res.json({ success: true, data: { ...hazard, photos: grouped } })
  } catch (err) {
    console.error('[hazard detail]', err.message)
    res.status(500).json({ success: false, error: '隐患详情查询失败：' + err.message })
  }
})

// ─── PATCH /api/hazards/:id —— 更新基础信息（管理员/安全员，安全员仅本人）────
// 仅用于更新隐患的基础字段；状态流转（assign/rectify/verify）由各自独立接口负责。
// 鉴权使用 requireAdminOrSafety（管理员 + 安全员）；安全员仅可更新本人录入的隐患。
router.patch('/:id', requireAdminOrSafety, async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ success: false, error: '无效的隐患 ID' })

  // 可更新字段白名单（状态流转字段 status / rectify_status 等不在此处理）
  const FIELD_MAP = {
    hazard_investigation_item: { type: 'string', trim: true },
    contractor_unit_id: { type: 'int', nullable: true },
    unit_name: { type: 'string', trim: true },
    location: { type: 'string', trim: true },
    business_dept: { type: 'string', trim: true },
    business_dept_head: { type: 'string', trim: true },
    description: { type: 'string', trim: true },
    hazard_level: { type: 'string', trim: true },
    rectify_measures: { type: 'string', trim: true },
    remark: { type: 'string', trim: true },
    responsible_person: { type: 'string', trim: true },
    plan_finish_time: { type: 'string', trim: true },
    // 验收字段（与 verify 接口 coerce 对齐）：is_reject_item 归一式 Number(v)?1:0；deduct_score 原值透传
    is_reject_item: { type: 'bool-int' },
    deduct_score: { type: 'string', trim: true },
  }

  const sets = []
  const params = []
  for (const key of Object.keys(FIELD_MAP)) {
    if (req.body[key] === undefined) continue
    const def = FIELD_MAP[key]
    let val = req.body[key]
    if (def.type === 'int') {
      val = val === null || val === '' ? null : Number(val)
      if (val !== null && Number.isNaN(val)) {
        return res.status(400).json({ success: false, error: `字段 ${key} 非法` })
      }
    } else if (def.type === 'bool-int') {
      val = Number(val) ? 1 : 0
    } else {
      val = val === null ? '' : String(val)
      if (def.trim) val = val.trim()
    }
    sets.push(`${key} = ?`)
    params.push(val)
  }

  if (!sets.length) {
    return res.status(400).json({ success: false, error: '未提供任何可更新字段' })
  }
  // 等级合法性校验（若传入）
  if (req.body.hazard_level !== undefined && req.body.hazard_level !== '' && !LEVELS.includes(req.body.hazard_level)) {
    return res.status(400).json({ success: false, error: '隐患等级非法' })
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, recorder_id FROM t_hazard WHERE id = ? AND deleted_at IS NULL',
      [id]
    )
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    // 安全员仅可更新本人录入的隐患，越权 → 403（设计 §3.4(c)）
    if (req.admin.role === 'safety' && rows[0].recorder_id !== req.admin.id) {
      return res.status(403).json({ success: false, error: '无权修改该隐患' })
    }

    sets.push('updated_at = NOW()')
    params.push(id)
    await pool.execute(`UPDATE t_hazard SET ${sets.join(', ')} WHERE id = ?`, params)

    // 返回更新后的完整记录（走 HAZARD_COLUMNS SELECT）
    const [updated] = await pool.execute(
      `SELECT ${HAZARD_COLUMNS}, ${OVERDUE_EXPR} AS is_overdue FROM t_hazard WHERE id = ?`,
      [id]
    )
    res.json({ success: true, data: updated[0] })
  } catch (err) {
    console.error('[hazard update]', err.message)
    res.status(500).json({ success: false, error: '隐患更新失败：' + err.message })
  }
})

// ─── PATCH /api/hazards/:id/assign —— 分派（仅 reported → assigned）───────────
router.patch('/:id/assign', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const { responsible_person, plan_finish_time } = req.body
  try {
    const [rows] = await pool.execute('SELECT * FROM t_hazard WHERE id = ? AND deleted_at IS NULL', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    const h = rows[0]
    if (h.status !== STATUS.reported) {
      return res.status(400).json({ success: false, error: '当前状态不可分派' })
    }

    const sets = ['status = ?', 'assigned_to = ?', 'assigned_at = NOW()']
    const params = ['assigned', req.admin.id]
    if (responsible_person !== undefined && responsible_person !== '') {
      sets.push('responsible_person = ?'); params.push(responsible_person.trim())
    }
    if (plan_finish_time !== undefined && plan_finish_time !== '') {
      sets.push('plan_finish_time = ?'); params.push(plan_finish_time)
    }
    params.push(id)
    await pool.execute(`UPDATE t_hazard SET ${sets.join(', ')} WHERE id = ?`, params)

    await fireNotify('ASSIGN', {
      hazardNo: h.hazard_code,
      title: h.description,
      unit: h.unit_name,
      ownerName: responsible_person || h.responsible_person,
      ownerMobile: undefined,
      deadline: plan_finish_time || h.plan_finish_time,
      partyAMobiles: await loadPartyAMobiles(pool, h.contractor_unit_id),
      safetyOfficeMobiles: schedulerConfig.safetyOfficeMobiles,
    })

    res.json({ success: true, data: { status: 'assigned', assigned_at: new Date().toISOString() } })
  } catch (err) {
    console.error('[hazard assign]', err.message)
    res.status(500).json({ success: false, error: '分派失败：' + err.message })
  }
})

// ─── PATCH /api/hazards/:id/rectify —— 整改代录（reported / assigned / rectifying）────────
router.patch('/:id/rectify', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  // 兼容两套字段名：管理端 rectify_measures / rectify_photo_urls；安全员端 rectify_description / rectify_photos
  const rectify_status = req.body.rectify_status
  const rectify_measures = req.body.rectify_measures ?? req.body.rectify_description ?? ''
  const rectify_photo_urls = req.body.rectify_photo_urls ?? req.body.rectify_photos ?? []
  try {
    const [rows] = await pool.execute('SELECT * FROM t_hazard WHERE id = ? AND deleted_at IS NULL', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    const h = rows[0]
    // 选项 B（试用简化流程）：已上报 / 已分派 / 整改中 均可录入整改资料
    if (![STATUS.reported, STATUS.assigned, STATUS.rectifying].includes(h.status)) {
      return res.status(400).json({ success: false, error: '当前状态不可整改' })
    }
    // 整改进度缺省为「整改中」（安全员录入页未提供进度选择器时，默认进入整改中）
    const finalStatus = rectify_status && ['整改中', '已完成'].includes(rectify_status)
      ? rectify_status
      : '整改中'
    const targetStatus = finalStatus === '已完成' ? STATUS.verifying : STATUS.rectifying

    const sets = ['status = ?', 'rectify_status = ?']
    const params = [targetStatus, finalStatus]
    if (rectify_measures !== undefined) {
      sets.push('rectify_measures = ?'); params.push(rectify_measures)
    }

    const photoList = Array.isArray(rectify_photo_urls) ? rectify_photo_urls.filter(Boolean) : []
    if (photoList.length) {
      sets.push('rectify_photo_url = ?')
      params.push(photoList[0])
      await pool.query(
        'INSERT INTO t_hazard_photo (hazard_id, photo_url, photo_type) VALUES ?',
        [photoList.map((url) => [id, url, 'rectify'])]
      )
    }

    params.push(id)
    await pool.execute(`UPDATE t_hazard SET ${sets.join(', ')} WHERE id = ?`, params)

    res.json({ success: true, data: { status: targetStatus, rectify_status: finalStatus } })
  } catch (err) {
    console.error('[hazard rectify]', err.message)
    res.status(500).json({ success: false, error: '整改代录失败：' + err.message })
  }
})

// ─── PATCH /api/hazards/:id/verify —— 验收（仅 verifying）─────────────────────
router.patch('/:id/verify', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const { verify_result, verify_comment, is_reject_item, deduct_score } = req.body
  try {
    const [rows] = await pool.execute('SELECT * FROM t_hazard WHERE id = ? AND deleted_at IS NULL', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    const h = rows[0]
    if (h.status !== STATUS.verifying) {
      return res.status(400).json({ success: false, error: '当前状态不可验收' })
    }
    if (!verify_result || !['通过', '退回'].includes(verify_result)) {
      return res.status(400).json({ success: false, error: '请选择验收结论（通过 / 退回）' })
    }

    // 验收时随结论一并写入否决项 / 扣分项；前端未传则保持原值（库内默认值 0 / ''）
    const extraSets = []
    const extraParams = []
    if (is_reject_item !== undefined) {
      extraSets.push('is_reject_item = ?')
      extraParams.push(Number(is_reject_item) ? 1 : 0)
    }
    if (deduct_score !== undefined) {
      extraSets.push('deduct_score = ?')
      extraParams.push(deduct_score)
    }

    const pass = verify_result === '通过'
    if (pass) {
      const sets = [
        "status = 'closed'", "verify_result = '通过'",
        'verified_by = ?', 'verified_at = NOW()', 'closed_at = NOW()',
        ...extraSets,
      ].join(', ')
      await pool.execute(
        `UPDATE t_hazard SET ${sets} WHERE id = ?`,
        [req.admin.id, ...extraParams, id]
      )
    } else {
      const sets = [
        "status = 'rectifying'", "verify_result = '退回'",
        'verify_comment = ?', "rectify_status = '未整改'",
        ...extraSets,
      ].join(', ')
      await pool.execute(
        `UPDATE t_hazard SET ${sets} WHERE id = ?`,
        [verify_comment || '', ...extraParams, id]
      )
    }

    await fireNotify('VERIFY', {
      hazardNo: h.hazard_code,
      title: h.description,
      result: pass ? 'pass' : 'reject',
      verifyBy: req.admin.username,
      partyAMobiles: await loadPartyAMobiles(pool, h.contractor_unit_id),
      safetyOfficeMobiles: schedulerConfig.safetyOfficeMobiles,
    })

    res.json({ success: true, data: { status: pass ? 'closed' : 'rectifying', verify_result } })
  } catch (err) {
    console.error('[hazard verify]', err.message)
    res.status(500).json({ success: false, error: '验收失败：' + err.message })
  }
})

module.exports = router
