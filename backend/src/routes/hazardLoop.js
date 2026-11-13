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
 * 模块三：fireNotify 仅放行「超期」通知（OVERDUE / OVERDUE_DIGEST），
 *          上报/分派/验收即时通知一律静默跳过；手动超期通知（L628）不经白名单，保留。
 */

const express = require('express')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const { generateHazardCode } = require('../services/hazardCode')
const { sendHazardNotification } = require('../services/dingtalk/notify')
const { loadNotifyConfig, EVENT_TO_KEY } = require('../services/notifyConfig')
const schedulerConfig = require('../services/schedulerConfig')
const { STATUS, LEVELS } = require('../constants/hazardStates')
const { applyRecorderScope, resolveRecorderContext } = require('../services/permission')
const importService = require('../services/importService')
const { loadRules, resolveStation, CENTER_STATIONS } = require('../services/stationResolver')
const { matchStandardBasisDb } = require('../services/standardBasisService')
const { decodeFilename } = require('../utils/filename')
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
  'verify_comment', 'remark', 'closed_at', 'overdue_notified', 'created_at', 'updated_at', 'standard_basis',
  'recorder_id', 'recorder_name', 'recorder_unit_id', 'recorder_unit_name', 'deleted_at',
].join(', ')

// ─── is_overdue 计算表达式（列表 / 详情 / 超期通用）──────────────────────────
const OVERDUE_EXPR = `CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END`

// ─── 钉钉通知 fire-and-forget ────────────────────────────────────────────────
// 事件开关统一收口到「钉钉通知设置」配置（t_system_config.dingtalk_notify_config）：
//   - 总开关 enabled=false → 全部静默跳过
//   - 各事件开关（events.report/assign/verify/overdue/...）关闭 → 对应事件静默跳过
//   - 手动超期通知（L628）不经此处，保留直接发送（仍受总开关/事件开关拦截于 sendHazardNotification 内）
async function fireNotify(event, payload) {
  const cfg = loadNotifyConfig()
  if (!cfg.enabled) return
  const key = EVENT_TO_KEY[event]
  if (!key || !cfg.events[key]) return
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
    standard_basis = '',
  } = req.body

  // 必填校验
  if (!unit_name || !unit_name.trim()) return res.status(400).json({ success: false, error: '请填写隐患单位' })
  if (!location || !String(location).trim()) return res.status(400).json({ success: false, error: '请填写场所站点' })
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

    // 标准依据：前端未填则按排查项目从问题依据库服务端兜底匹配
    let standardBasisValue = standard_basis || ''
    if (!standardBasisValue && hazard_investigation_item) {
      const m = await matchStandardBasisDb(pool, { category: hazard_investigation_item })
      if (m.matched) standardBasisValue = m.standard_basis
    }

    // 场所 → 中心站自动归属（宁可空也不要错，未命中即空）
    await loadRules()
    const st = resolveStation(location) || { center_station_name: '', gas_station_name: '' }

    const [result] = await pool.execute(
      `INSERT INTO t_hazard
        (hazard_code, contractor_unit_id, unit_name, location, center_station_name, gas_station_name, description, standard_basis, hazard_level,
         rectify_measures, responsible_person,
         plan_finish_time, business_dept, hazard_investigation_item, business_dept_head, status,
         reported_by, reported_by_name, report_time, photo_url, rectify_status,
         recorder_id, recorder_name, recorder_unit_id, recorder_unit_name, remark, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, NOW(), ?, '未整改', ?, ?, ?, ?, ?, NULL)`,
      [
        hazard_code, safeUnitId, unit_name.trim(), location.trim(), st.center_station_name, st.gas_station_name, description.trim(),
        standardBasisValue,
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
    // import_type 来自 multipart 普通字段（''=普通台账导入，'video_supervision'=视频督查导入）
    // D7：透传 originalname，使 parseWorkbook 能按扩展名判断是否走截图解析
    const data = await importService.previewImport(req.file.buffer, req.admin, {
      importType: req.body && req.body.import_type,
      originalname: decodeFilename(req.file.originalname),
    })
    res.json({ success: true, data })
  } catch (err) {
    console.error('[hazard import preview]', err && err.message ? err.message : err)
    // 场所缺失门禁：整份文件判为不合格，前端据此提示并引导下载最新模板
    if (err && err.code === 'MISSING_LOCATION') {
      return res.status(400).json({
        success: false,
        code: 'MISSING_LOCATION',
        error: err.message,
        data: { missing: err.missing || ['场所'], templateUrl: err.templateUrl || '/api/hazards/import/template' },
      })
    }
    // 责任单位比对门禁：与网格化管理库不一致，整份文件拒绝，回传逐行明细
    if (err && err.code === 'UNIT_UNMATCH') {
      return res.status(400).json({
        success: false,
        code: 'UNIT_UNMATCH',
        error: err.message,
        data: { mismatches: err.mismatches || [], templateUrl: err.templateUrl || '/api/hazards/import/template' },
      })
    }
    res.status(500).json({ success: false, error: '导入预览失败：' + (err && err.message ? err.message : '未知错误') })
  }
})

// ─── POST /api/hazards/import/confirm —— 事务批量落库（失败整批回退）─────────
router.post('/import/confirm', requireAdminOrSafety, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx / .xls / .csv 文件' })
  }
  try {
    const data = await importService.commitImport(req.file.buffer, req.admin, decodeFilename(req.file.originalname), {
      importType: req.body && req.body.import_type,
    })
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
    if (err && err.code === 'MISSING_LOCATION') {
      console.error('[hazard import commit] 缺少「场所」列，整批拒绝')
      return res.status(400).json({
        success: false,
        code: 'MISSING_LOCATION',
        error: err.message,
        data: { rollback: true, missing: err.missing || ['场所'], templateUrl: err.templateUrl || '/api/hazards/import/template' },
      })
    }
    // 责任单位比对门禁：与网格化管理库不一致，整份文件拒绝（未开启事务，无回退动作），回传逐行明细
    if (err && err.code === 'UNIT_UNMATCH') {
      console.error('[hazard import commit] 责任单位与网格化管理库不一致，整批拒绝')
      return res.status(400).json({
        success: false,
        code: 'UNIT_UNMATCH',
        error: err.message,
        data: { rollback: true, mismatches: err.mismatches || [], templateUrl: err.templateUrl || '/api/hazards/import/template' },
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
        filename: decodeFilename(r.filename),
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
    unit_name = '',
    level = '',
    keyword = '',
    is_overdue = '',
    hazard_investigation_item = '',
    page = 1,
    pageSize = 20,
  } = req.query

  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const offset = (safePage - 1) * safePageSize

  // 隐患排查项目多选筛选：支持「a,b,c」逗号串或重复 query 参数数组
  let investigationItems = []
  if (hazard_investigation_item) {
    const raw = Array.isArray(hazard_investigation_item)
      ? hazard_investigation_item
      : String(hazard_investigation_item).split(',').map((s) => s.trim())
    investigationItems = raw.filter(Boolean)
  }

  // 列表筛选（含 status / is_overdue 切换）
  const where = []
  const params = []
  if (contractor_unit_id) { where.push('contractor_unit_id = ?'); params.push(Number(contractor_unit_id)) }
  if (unit_name) { where.push('unit_name = ?'); params.push(unit_name) }
  if (level) { where.push('hazard_level = ?'); params.push(level) }
  if (investigationItems.length) {
    const inPh = investigationItems.map(() => '?').join(', ')
    where.push(`hazard_investigation_item IN (${inPh})`)
    params.push(...investigationItems)
  }

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
  if (unit_name) { sumWhere.push('unit_name = ?'); sumParams.push(unit_name) }
  if (level) { sumWhere.push('hazard_level = ?'); sumParams.push(level) }
  if (investigationItems.length) {
    const inPh = investigationItems.map(() => '?').join(', ')
    sumWhere.push(`hazard_investigation_item IN (${inPh})`)
    sumParams.push(...investigationItems)
  }
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

// ─── GET /api/hazards/unit-names —— 责任单位去重列表（用于闭环页「全部单位」下拉）──
// ⚠ 必须定义在 router.get('/:id') 之前，否则会被 :id 占位符吞掉。
// 返回隐患表中实际出现的、非空的 unit_name 去重列表，按出现次数降序、名称升序。
router.get('/unit-names', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT unit_name, COUNT(*) AS cnt
         FROM t_hazard
        WHERE deleted_at IS NULL AND unit_name IS NOT NULL AND unit_name <> ''
        GROUP BY unit_name
        ORDER BY cnt DESC, unit_name ASC`
    )
    const list = rows.map((r) => ({ unit_name: r.unit_name, cnt: r.cnt || 0 }))
    res.json({ success: true, data: { list } })
  } catch (err) {
    console.error('[hazard unit-names]', err.message)
    res.status(500).json({ success: false, error: '责任单位列表查询失败：' + err.message })
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

    // 等级分布（两级口径：重大隐患 / 一般隐患，确保齐全，缺省 0）
    const [levelRows] = await pool.execute('SELECT hazard_level, COUNT(*) AS c FROM t_hazard WHERE deleted_at IS NULL GROUP BY hazard_level')
    const byLevel = {}
    ;['重大隐患', '一般隐患'].forEach((l) => { byLevel[l] = 0 })
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
    // 软删除：仅标记 deleted_at，禁止物理 DELETE（设计 §8.3）。
    // 安全员批量删：仍仅允许删除本人录入的隐患（显式守卫，不再依赖 applyRecorderScope——
    // 因为安全员列表已放开为看项目部全部隐患，批量删若沿用作用域会误删他人隐患）。
    const placeholders = cleanIds.map(() => '?').join(', ')
    let scopeClause = ''
    const scopeParams = []
    if (req.admin.role === 'safety') {
      scopeClause = 'AND recorder_id = ?'
      scopeParams.push(req.admin.id)
    }
    const [result] = await pool.execute(
      `UPDATE t_hazard SET deleted_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL ${scopeClause}`,
      [...cleanIds, ...scopeParams]
    )
    if (req.admin.role === 'safety' && result.affectedRows === 0) {
      return res.status(403).json({ success: false, error: '无权删除该隐患（仅可删除本人录入的）' })
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

// ─── GET /api/hazards/center-station-ranking —— 四中心站隐患排名统计 ──────────
// ⚠ 必须定义在 router.get('/:id') 之前，否则会被 :id 占位符吞掉。
// 时间口径：report_time（前端「检查时间」）；start_date/end_date 可选；end_date 含当天 23:59:59。
// 排名方向：隐患越多排名越靠前（第 1 名 = 问题最多）。固定输出 4 个中心站。
router.get('/center-station-ranking', requireAdminOrSafety, async (req, res) => {
  const { start_date, end_date, unit_name } = req.query
  const unitFilter = unit_name && String(unit_name).trim() ? String(unit_name).trim() : ''
  try {
    const where = ['deleted_at IS NULL']
    const params = []
    if (start_date) { where.push('report_time >= ?'); params.push(String(start_date) + ' 00:00:00') }
    if (end_date) { where.push('report_time <= ?'); params.push(String(end_date) + ' 23:59:59') }
    if (unitFilter) { where.push('unit_name = ?'); params.push(unitFilter) }

    const sql = `
      SELECT center_station_name,
             COUNT(*) AS total,
             SUM(status = 'closed') AS closed_cnt,
             SUM(status <> 'closed') AS open_cnt,
             SUM(status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()) AS overdue_cnt
        FROM t_hazard
       WHERE ${where.join(' AND ')}
       GROUP BY center_station_name`
    const [rows] = await pool.query(sql, params)

    const byCenter = new Map()
    let grandTotal = 0
    let assignedTotal = 0
    for (const r of rows) {
      const name = r.center_station_name || ''
      const rec = {
        total: Number(r.total) || 0,
        closed: Number(r.closed_cnt) || 0,
        open: Number(r.open_cnt) || 0,
        overdue: Number(r.overdue_cnt) || 0,
      }
      byCenter.set(name, rec)
      grandTotal += rec.total
      if (name) assignedTotal += rec.total
    }

    // 固定 4 个中心站，缺数据补 0
    const outRows = CENTER_STATIONS.map((c) => {
      const d = byCenter.get(c) || { total: 0, closed: 0, open: 0, overdue: 0 }
      return {
        center_station_name: c,
        total: d.total,
        closed: d.closed,
        open: d.open,
        overdue: d.overdue,
        close_rate: d.total ? Math.round((d.closed / d.total) * 1000) / 10 : 0,
        rank: 0,
      }
    })
    outRows.sort((a, b) => b.total - a.total)
    outRows.forEach((r, i) => { r.rank = i + 1 })

    // 未归属样本（按场所聚合 Top10）
    const [unRows] = await pool.query(
      `SELECT location, COUNT(*) AS c
         FROM t_hazard
        WHERE deleted_at IS NULL AND (center_station_name = '' OR center_station_name IS NULL)
        ${unitFilter ? 'AND unit_name = ?' : ''}
        GROUP BY location ORDER BY c DESC LIMIT 10`,
      unitFilter ? [unitFilter] : []
    )
    const unassignedTotal = (byCenter.get('') || { total: 0 }).total
    const sample = unRows.map((r) => ({
      location: r.location || '',
      count: Number(r.c) || 0,
    }))

    res.json({
      success: true,
      data: {
        rows: outRows,
        centers: CENTER_STATIONS,
        unassigned: { total: unassignedTotal, sample },
        summary: {
          total: grandTotal,
          assigned: assignedTotal,
          assigned_rate: grandTotal ? Math.round((assignedTotal / grandTotal) * 1000) / 10 : 0,
        },
      },
    })
  } catch (err) {
    console.error('[center-station-ranking]', err.message)
    res.status(500).json({ success: false, error: '排名统计失败：' + err.message })
  }
})

// ─── 四中心站排名「数字下钻明细 / 清单导出」────────────────────────────────────
// ⚠ 以下两个 GET 路由必须定义在 router.get('/:id') 之前，否则会被 :id 占位符吞掉。
// 口径与 /center-station-ranking 严格一致：report_time 为检查时间、恒带 deleted_at IS NULL、
// closed = status='closed'、open = status<>'closed'、
// overdue = 未闭环且 plan_finish_time < NOW()。
// 目的是保证「明细行数 / 导出行数」与排名表上显示的数字完全相等。
const STATION_DETAIL_COLUMNS = `
  id, hazard_code,
  DATE_FORMAT(report_time, '%Y-%m-%d %H:%i') AS report_time,
  center_station_name, gas_station_name, location, unit_name, business_dept,
  hazard_investigation_item, description, hazard_level, standard_basis,
  rectify_measures, responsible_person,
  DATE_FORMAT(plan_finish_time, '%Y-%m-%d %H:%i') AS plan_finish_time,
  status, rectify_status, ${OVERDUE_EXPR} AS is_overdue, remark,
  DATE_FORMAT(closed_at, '%Y-%m-%d %H:%i') AS closed_at
`

const STATION_STATUS_TEXT = {
  reported: '已上报', assigned: '已分派', rectifying: '整改中',
  verifying: '待验收', closed: '已闭环',
}
const STATION_METRIC_TEXT = {
  total: '全部隐患', closed: '已闭环', open: '未闭环', overdue: '超期',
}
const STATION_DETAIL_HEADERS = [
  '序号', '隐患编号', '检查时间', '中心站', '集气站', '场所', '责任单位',
  '业务主管部门', '隐患排查项目', '隐患描述', '隐患等级', '标准依据',
  '整改措施', '整改责任人', '计划完成时间', '状态', '整改状态',
  '是否超期', '备注', '闭环时间',
]

/**
 * 构造与 /center-station-ranking 同口径的明细查询条件。
 * 全部外部输入走参数化占位符，不拼进 SQL。
 */
function buildStationDetailWhere(query) {
  const where = ['deleted_at IS NULL']
  const params = []
  const filter = {
    start_date: '', end_date: '', unit_name: '',
    center_station_name: '', metric: 'total',
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/

  const sd = query.start_date ? String(query.start_date).trim() : ''
  const ed = query.end_date ? String(query.end_date).trim() : ''
  if (sd) {
    if (!dateRe.test(sd)) throw new Error('start_date 格式应为 YYYY-MM-DD')
    where.push('report_time >= ?'); params.push(sd + ' 00:00:00'); filter.start_date = sd
  }
  if (ed) {
    if (!dateRe.test(ed)) throw new Error('end_date 格式应为 YYYY-MM-DD')
    where.push('report_time <= ?'); params.push(ed + ' 23:59:59'); filter.end_date = ed
  }
  const unit = query.unit_name ? String(query.unit_name).trim() : ''
  if (unit) {
    where.push('unit_name = ?'); params.push(unit); filter.unit_name = unit
  }

  const center = query.center_station_name ? String(query.center_station_name).trim() : ''
  if (center === '__all_assigned__') {
    where.push(`center_station_name IN (${CENTER_STATIONS.map(() => '?').join(',')})`)
    params.push(...CENTER_STATIONS)
    filter.center_station_name = '__all_assigned__'
  } else if (center === '__unassigned__') {
    where.push("(center_station_name IS NULL OR center_station_name = '')")
    filter.center_station_name = '__unassigned__'
  } else if (center) {
    if (!CENTER_STATIONS.includes(center)) throw new Error('center_station_name 不是有效的中心站')
    where.push('center_station_name = ?'); params.push(center)
    filter.center_station_name = center
  }

  const rawMetric = String(query.metric || '')
  const metric = Object.prototype.hasOwnProperty.call(STATION_METRIC_TEXT, rawMetric) ? rawMetric : 'total'
  filter.metric = metric
  if (metric === 'closed') where.push("status = 'closed'")
  if (metric === 'open') where.push("status <> 'closed'")
  if (metric === 'overdue') {
    where.push("status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW()")
  }
  return { whereClause: 'WHERE ' + where.join(' AND '), params, filter }
}

function stationDetailFilterText(filter) {
  const center = filter.center_station_name === '__all_assigned__'
    ? '四个中心站（全部已归属）'
    : filter.center_station_name === '__unassigned__'
      ? '未归属到中心站的隐患'
      : (filter.center_station_name || '全部（含未归属）')
  return {
    center,
    date: (filter.start_date || '不限') + ' ~ ' + (filter.end_date || '不限'),
    unit: filter.unit_name || '全部单位',
    metric: STATION_METRIC_TEXT[filter.metric] || '全部隐患',
  }
}

/** 生成「隐患明细 + 统计口径」双 sheet 工作簿 */
function buildStationDetailWorkbook(rows, filter) {
  const body = rows.map((r, i) => [
    i + 1,
    r.hazard_code || '',
    r.report_time || '',
    r.center_station_name || '',
    r.gas_station_name || '',
    r.location || '',
    r.unit_name || '',
    r.business_dept || '',
    r.hazard_investigation_item || '',
    r.description || '',
    r.hazard_level || '',
    r.standard_basis || '',
    r.rectify_measures || '',
    r.responsible_person || '',
    r.plan_finish_time || '',
    STATION_STATUS_TEXT[r.status] || r.status || '',
    r.rectify_status || '',
    Number(r.is_overdue) ? '是' : '否',
    r.remark || '',
    r.closed_at || '',
  ])
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([STATION_DETAIL_HEADERS, ...body])
  ws['!cols'] = [
    { wch: 6 }, { wch: 18 }, { wch: 17 }, { wch: 16 }, { wch: 16 }, { wch: 20 },
    { wch: 24 }, { wch: 18 }, { wch: 20 }, { wch: 48 }, { wch: 12 }, { wch: 30 },
    { wch: 36 }, { wch: 14 }, { wch: 17 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 30 }, { wch: 17 },
  ]
  xlsx.utils.book_append_sheet(wb, ws, '隐患明细')

  const f = stationDetailFilterText(filter)
  const now = new Date()
  const meta = [
    ['项目', '内容'],
    ['报表名称', '四中心站隐患排名 · 具体问题清单'],
    ['生成时间', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`],
    ['检查时间区间', f.date],
    ['中心站范围', f.center],
    ['隐患单位', f.unit],
    ['统计指标', f.metric],
    ['导出条数', rows.length],
    ['时间口径', "report_time（检查时间）；end_date 含当天 23:59:59"],
    ['数据范围', "t_hazard 且 deleted_at IS NULL（不含软删除记录）"],
    ['已闭环', "status = 'closed'"],
    ['未闭环', "status <> 'closed'"],
    ['超期', "未闭环 且 plan_finish_time 早于当前时间"],
    ['闭环率', "已闭环 / 隐患数"],
    ['说明', '本清单与「四中心站隐患排名（考核）」统计表口径一致，行数应与表上对应数字相等'],
  ]
  const ws2 = xlsx.utils.aoa_to_sheet(meta)
  ws2['!cols'] = [{ wch: 20 }, { wch: 76 }]
  xlsx.utils.book_append_sheet(wb, ws2, '统计口径')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

// ─── GET /api/hazards/center-station-ranking/details —— 排名数字下钻明细 ──────
router.get('/center-station-ranking/details', requireAdminOrSafety, async (req, res) => {
  let built
  try {
    built = buildStationDetailWhere(req.query || {})
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message })
  }
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20))
  const offset = (page - 1) * pageSize
  try {
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) AS total FROM t_hazard ${built.whereClause}`, built.params
    )
    const [rows] = await pool.query(
      `SELECT ${STATION_DETAIL_COLUMNS} FROM t_hazard ${built.whereClause}
        ORDER BY report_time DESC, id DESC LIMIT ? OFFSET ?`,
      [...built.params, pageSize, offset]
    )
    res.json({
      success: true,
      data: {
        total: Number(cnt.total) || 0,
        page, pageSize, list: rows, filter: built.filter,
      },
    })
  } catch (err) {
    console.error('[station-ranking-details]', err.message)
    res.status(500).json({ success: false, error: '明细查询失败：' + err.message })
  }
})

// ─── GET /api/hazards/center-station-ranking/export —— 具体问题清单 Excel ─────
router.get('/center-station-ranking/export', requireAdminOrSafety, async (req, res) => {
  let built
  try {
    built = buildStationDetailWhere(req.query || {})
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message })
  }
  try {
    const [rows] = await pool.query(
      `SELECT ${STATION_DETAIL_COLUMNS} FROM t_hazard ${built.whereClause}
        ORDER BY report_time DESC, id DESC LIMIT 5001`, built.params
    )
    if (rows.length > 5000) {
      return res.status(400).json({
        success: false,
        error: '本次导出行数超过 5000 条，请缩小日期范围或按中心站分别导出',
      })
    }
    const buffer = buildStationDetailWorkbook(rows, built.filter)
    const now = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const fileDate = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}`
    const filename = `四中心站隐患明细_${fileDate}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    res.send(buffer)
  } catch (err) {
    console.error('[station-ranking-export]', err.message)
    res.status(500).json({ success: false, error: '隐患明细导出失败：' + err.message })
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
    standard_basis: { type: 'string', trim: true },
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
  // 场所变更时重算中心站归属（宁可空也不要错）
  if (req.body.location !== undefined) {
    await loadRules()
    const st = resolveStation(req.body.location) || { center_station_name: '', gas_station_name: '' }
    sets.push('center_station_name = ?'); params.push(st.center_station_name)
    sets.push('gas_station_name = ?'); params.push(st.gas_station_name)
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

// ─── 整改闭环资料完整性校验（现场检查问题必须录入整改情况 + 整改后照片）────────
// 口径：推进到「待验收」(rectify_status='已完成') 或「验收通过/闭环」时，该隐患
//       必须同时具备整改情况文本与至少 1 张整改后照片；资料 = 本次提交的 ∪ 库中已录的，
//       避免重复录入。历史已闭环台账不回溯修改，仅约束新的闭环动作。
async function loadRectifyEvidence(h, incoming = {}) {
  // 显式提交整改情况时以提交值为准（含清空场景，不允许被库里旧值兜底绕过）
  const measures = incoming.measures !== undefined
    ? String(incoming.measures ?? '').trim()
    : String(h.rectify_measures || '').trim()
  const urls = Array.isArray(incoming.photoUrls) ? incoming.photoUrls.filter(Boolean) : []
  let photoCount = urls.length
  if (photoCount === 0) {
    const [[row]] = await pool.execute(
      "SELECT COUNT(*) AS c FROM t_hazard_photo WHERE hazard_id = ? AND photo_type = 'rectify'",
      [h.id]
    )
    photoCount = Number(row.c) || 0
  }
  if (photoCount === 0 && String(h.rectify_photo_url || '').trim()) photoCount = 1
  return { measures, photoCount }
}

function rectifyEvidenceError(ev) {
  const missing = []
  if (!ev.measures) missing.push('整改情况')
  if (!ev.photoCount) missing.push('整改后照片')
  if (!missing.length) return null
  return `现场检查问题闭环前必须录入${missing.join('和')}，请先在「整改资料录入」中补齐`
}

// ─── PATCH /api/hazards/:id/rectify —— 整改代录（reported / assigned / rectifying / verifying 补录）────────
router.patch('/:id/rectify', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  // 兼容两套字段名：管理端 rectify_measures / rectify_photo_urls；安全员端 rectify_description / rectify_photos
  // 关键：只有「显式传了整改情况字段」才更新该列，避免只传状态的一键操作把已录入的整改情况清空。
  const rectify_status = req.body.rectify_status
  const rawMeasures = req.body.rectify_measures ?? req.body.rectify_description
  const hasMeasuresField = rawMeasures !== undefined
  const rectify_measures = hasMeasuresField ? String(rawMeasures).trim() : ''
  const rectify_photo_urls = req.body.rectify_photo_urls ?? req.body.rectify_photos ?? []
  const photoList = Array.isArray(rectify_photo_urls) ? rectify_photo_urls.filter(Boolean) : []
  try {
    const [rows] = await pool.execute('SELECT * FROM t_hazard WHERE id = ? AND deleted_at IS NULL', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '隐患不存在' })
    const h = rows[0]
    // 允许状态：已上报/已分派/整改中正常流转；待验收仅允许「补录整改资料」（不推进状态，用于补齐后验收）
    const isSupplement = h.status === STATUS.verifying
    if (![STATUS.reported, STATUS.assigned, STATUS.rectifying, STATUS.verifying].includes(h.status)) {
      return res.status(400).json({ success: false, error: '当前状态不可整改' })
    }
    // 整改进度缺省为「整改中」（安全员录入页未提供进度选择器时，默认进入整改中）
    const finalStatus = rectify_status && ['整改中', '已完成'].includes(rectify_status)
      ? rectify_status
      : '整改中'
    const targetStatus = finalStatus === '已完成' ? STATUS.verifying : STATUS.rectifying

    // ── 闭环资料强制校验：现场检查问题推进「整改完成/待验收」必须已有整改情况 + 整改后照片 ──
    if (finalStatus === '已完成' && !isSupplement) {
      const ev = await loadRectifyEvidence(h, { measures: hasMeasuresField ? rectify_measures : undefined, photoUrls: photoList })
      const errMsg = rectifyEvidenceError(ev)
      if (errMsg) return res.status(400).json({ success: false, error: errMsg })
    }

    const sets = []
    const params = []
    if (!isSupplement) {
      sets.push('status = ?', 'rectify_status = ?')
      params.push(targetStatus, finalStatus)
    }
    if (hasMeasuresField) {
      sets.push('rectify_measures = ?'); params.push(rectify_measures)
    }
    if (photoList.length) {
      // 首图仅在原值为空时回填，保留历史首图
      sets.push("rectify_photo_url = CASE WHEN rectify_photo_url IS NULL OR rectify_photo_url = '' THEN ? ELSE rectify_photo_url END")
      params.push(photoList[0])
      // 去重插入，避免同一照片重复补录造成明细重复
      const [existingRows] = await pool.execute(
        "SELECT photo_url FROM t_hazard_photo WHERE hazard_id = ? AND photo_type = 'rectify'",
        [id]
      )
      const known = new Set(existingRows.map((r) => r.photo_url))
      const fresh = photoList.filter((u) => !known.has(u))
      if (fresh.length) {
        await pool.query(
          'INSERT INTO t_hazard_photo (hazard_id, photo_url, photo_type) VALUES ?',
          [fresh.map((url) => [id, url, 'rectify'])]
        )
      }
    }
    if (!sets.length) {
      return res.status(400).json({ success: false, error: '请录入整改情况或上传整改后照片' })
    }
    sets.push('updated_at = NOW()')

    params.push(id)
    await pool.execute(`UPDATE t_hazard SET ${sets.join(', ')} WHERE id = ?`, params)

    res.json({ success: true, data: { status: isSupplement ? h.status : targetStatus, rectify_status: finalStatus } })
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
      // 兜底卡口：验收通过（真正闭环）时，库中必须已有整改情况 + 整改后照片。
      // 即便绕过「整改完成」步骤直接验收，也不允许无资料闭环。
      const ev = await loadRectifyEvidence(h)
      const errMsg = rectifyEvidenceError(ev)
      if (errMsg) return res.status(400).json({ success: false, error: errMsg })
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

// ─── 测试钩子（仅供本地/服务器自验脚本调用，不影响 Express 路由行为）────────────
router.fireNotify = fireNotify

module.exports = router
