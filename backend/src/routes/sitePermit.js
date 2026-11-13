'use strict'

/**
 * 直接作业预约报备 · 管理端路由 /api/site-permit（需 admin token）
 *
 *   GET    /config            读同步配置（密钥打码）+ 上次同步状态
 *   PUT    /config            保存配置
 *   POST   /test              连通性测试（真的去钉钉拉一次表头）
 *   POST   /sync              立即同步（?dryRun=1 只解析不写库）
 *   POST   /import-excel      上传每日 Excel 清单入账（?dryRun=1 只预演）
 *   GET    /sync-logs         同步批次日志
 *   GET    /list              台账（按日期/单位/风险分级/关键词筛选）
 *   GET    /stats             看板统计
 *   GET    /export            导出 xlsx（与原表同列序）
 *   GET    /:id               单条详情
 *
 * 数据来源：① 每日 Excel 清单上传（当前主用，source='excel'，无需钉钉凭证）
 *           ② 每晚 22:00 node-cron 调 syncNow('cron')（需钉钉应用凭证，当前未启用）
 */

const express = require('express')
const xlsx = require('xlsx')
const multer = require('multer')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const svc = require('../services/sitePermitSync')
const dingDoc = require('../services/dingtalkDoc')

const router = express.Router()

/**
 * 台账列清单（显式 DATE_FORMAT）
 * 坑：mysql2 连接池设了 timezone:'+08:00'，DATE/DATETIME 会被解析成 Date 对象，
 * JSON 序列化成 UTC ISO（2026-11-11 00:00+08 → 2026-11-10T16:00Z），前端 slice(0,10) 会差一天。
 * 因此这里统一用 DATE_FORMAT 取出字符串，与项目其他模块口径一致。
 */
const ROW_COLS = `
  id, sheet_name, seq_no, apply_unit, work_unit, content, place, camera, work_type,
  dual_op, risk_level, measures, leader, supervisor, plan_time_raw,
  DATE_FORMAT(plan_date, '%Y-%m-%d')            AS plan_date,
  DATE_FORMAT(plan_start, '%Y-%m-%d %H:%i')     AS plan_start,
  auditor, reporter, report_date_raw,
  DATE_FORMAT(report_date, '%Y-%m-%d')          AS report_date,
  remark, is_active, source,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i')     AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i')     AS updated_at
`

function adminAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  const payload = verifyAdminToken(h.slice(7))
  if (!payload) return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  req.admin = payload
  next()
}
router.use(adminAuth)

function ok(res, data) { res.json({ success: true, data }) }
function fail(res, e, code = 500) {
  console.error('[site-permit]', e && e.message ? e.message : e)
  res.status(code).json({ success: false, error: e && e.message ? e.message : '操作失败' })
}

// ─── 配置 ────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const cfg = await svc.loadConfig()
    ok(res, { config: svc.maskConfig(cfg), defaults: svc.DEFAULT_CONFIG })
  } catch (e) { fail(res, e) }
})

router.put('/config', async (req, res) => {
  try {
    const saved = await svc.saveConfig(req.body || {})
    ok(res, svc.maskConfig(saved))
  } catch (e) { fail(res, e, 400) }
})

// ─── 连通性测试：只拉工作表清单，不碰数据 ─────────────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const cfg = await svc.loadConfig()
    const patch = req.body || {}
    // 允许用请求里临时覆盖的值测试（前端填完没保存也能测）
    for (const k of ['sourceType', 'appKey', 'appSecret', 'workbookId', 'baseId', 'operatorId', 'sheetNames', 'rangeEnd']) {
      if (patch[k] !== undefined && patch[k] !== '' && patch[k] !== '******') cfg[k] = patch[k]
    }
    dingDoc.assertConfig(cfg)
    const type = cfg.sourceType === 'notable' ? 'notable' : 'workbook'
    const sheets = type === 'workbook'
      ? await dingDoc.listSheets(cfg)
      : await dingDoc.listNotableSheets(cfg)
    ok(res, { ok: true, sourceType: type, sheets, message: `连通成功，读到 ${sheets.length} 个工作表` })
  } catch (e) { fail(res, e, 400) }
})

// ─── 立即同步 ────────────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const dryRun = String(req.query.dryRun || '') === '1' || (req.body && req.body.dryRun === true)
    const r = await svc.syncNow('manual', { dryRun })
    if (!r.ok) return res.status(400).json({ success: false, error: r.message, data: r })
    ok(res, r)
  } catch (e) { fail(res, e) }
})


// ─── POST /api/site-permit/import-excel —— 上传每日 Excel 清单入账 ────────────
// 群里每天发的《直接作业环节施工风险分级清单XX.XX.xlsx》是文件附件，不是钉钉在线表格。
// 直接复用 parseSheet 的 17 列字段映射 + 多分表（钻井/试气/地面）解析，
// 无需任何钉钉开放平台凭证。dryRun=1 只预演不写库。
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
})

router.post('/import-excel', excelUpload.single('file'), async (req, res) => {
  const dryRun = String(req.query.dryRun || '') === '1' || (req.body && String(req.body.dryRun || '') === '1')
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: '请选择要上传的 .xlsx / .xls 文件' })
    }
    const name = String(req.file.originalname || '')
    if (!/\.(xlsx|xls)$/i.test(name)) {
      return res.status(400).json({ success: false, error: '只支持 .xlsx / .xls 文件' })
    }
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false })
    if (!wb.SheetNames || !wb.SheetNames.length) {
      return res.status(400).json({ success: false, error: '文件里没有读到工作表' })
    }
    const rowsBySheet = wb.SheetNames.map((n) => ({
      name: n,
      rows: xlsx.utils.sheet_to_json(wb.Sheets[n], {
        header: 1, raw: true, defval: '', blankrows: false,
      }),
    }))
    const result = await svc.syncNow('manual', { rowsBySheet, dryRun, source: 'excel' })
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.message, data: result })
    }
    ok(res, { ...result, fileName: name, sheets: rowsBySheet.map((s) => s.name) })
  } catch (e) {
    fail(res, e, 400)
  }
})

router.get('/sync-logs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, triggered_by, status, message, total_rows, new_rows, updated_rows, inactive_rows,
              DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s')  AS started_at,
              DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS finished_at,
              duration_ms
         FROM t_site_permit_sync ORDER BY id DESC LIMIT 30`
    )
    ok(res, rows)
  } catch (e) { fail(res, e) }
})

// ─── 台账 ────────────────────────────────────────────────────────────────────
function buildWhere(q) {
  const where = ['is_active = 1']
  const params = []
  if (q.date) { where.push('plan_date = ?'); params.push(q.date) }
  if (q.dateFrom) { where.push('plan_date >= ?'); params.push(q.dateFrom) }
  if (q.dateTo) { where.push('plan_date <= ?'); params.push(q.dateTo) }
  if (q.unit) { where.push('work_unit LIKE ?'); params.push(`%${q.unit}%`) }
  if (q.risk) { where.push('risk_level = ?'); params.push(q.risk) }
  if (q.sheet) { where.push('sheet_name = ?'); params.push(q.sheet) }
  if (q.keyword) {
    where.push('(work_unit LIKE ? OR content LIKE ? OR place LIKE ? OR reporter LIKE ? OR leader LIKE ?)')
    const k = `%${q.keyword}%`
    params.push(k, k, k, k, k)
  }
  return { sql: `WHERE ${where.join(' AND ')}`, params }
}

router.get('/list', async (req, res) => {
  try {
    const q = req.query || {}
    const page = Math.max(1, Number(q.page) || 1)
    const pageSize = Math.min(200, Math.max(5, Number(q.pageSize) || 20))
    const w = buildWhere(q)
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM t_site_permit ${w.sql}`, w.params)
    const [rows] = await pool.query(
      `SELECT ${ROW_COLS} FROM t_site_permit ${w.sql}
        ORDER BY plan_date DESC, plan_start DESC, sheet_name, id
        LIMIT ? OFFSET ?`,
      [...w.params, pageSize, (page - 1) * pageSize]
    )
    ok(res, { list: rows, total, page, pageSize })
  } catch (e) { fail(res, e) }
})

router.get('/stats', async (req, res) => {
  try {
    // 默认统计日口径：优先「今天及以后最近的一天」（因为 22:00 同步的是次日预约），
    // 没有未来数据时退回库里最大的 plan_date。纯 CURDATE() 会在当晚同步后统计到空。
    let date = String(req.query.date || '').slice(0, 10)
    if (!date) {
      const [[r]] = await pool.query(
        `SELECT DATE_FORMAT(
                  COALESCE(
                    (SELECT MIN(plan_date) FROM t_site_permit WHERE is_active=1 AND plan_date >= CURDATE()),
                    (SELECT MAX(plan_date) FROM t_site_permit WHERE is_active=1)
                  ), '%Y-%m-%d') AS d`
      )
      date = (r && r.d) || ''
    }
    const w = date ? 'WHERE is_active = 1 AND plan_date = ?' : 'WHERE 1=0'
    const params = date ? [date] : []
    const [byRisk] = await pool.query(`SELECT risk_level, COUNT(*) AS cnt FROM t_site_permit ${w} GROUP BY risk_level`, params)
    const [bySheet] = await pool.query(`SELECT sheet_name, COUNT(*) AS cnt FROM t_site_permit ${w} GROUP BY sheet_name`, params)
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM t_site_permit ${w}`, params)
    const [dates] = await pool.query(
      `SELECT DATE_FORMAT(plan_date, '%Y-%m-%d') AS plan_date, COUNT(*) AS cnt
         FROM t_site_permit
        WHERE is_active = 1 AND plan_date IS NOT NULL
        GROUP BY plan_date ORDER BY plan_date DESC LIMIT 14`
    )
    // 板块下拉候选：全表 distinct（不受统计日限制）
    const [sheetAll] = await pool.query(
      `SELECT DISTINCT sheet_name FROM t_site_permit WHERE is_active=1 AND sheet_name <> '' ORDER BY sheet_name`
    )

    // 当月口径：当前自然月，按计划日期归属，与「当日」并列展示。
    // 统一用 DATE_FORMAT 出字符串比较，避免 mysql2 把 DATE 解析成 Date 后跨时区差一天。
    const [[{ ym }]] = await pool.query(`SELECT DATE_FORMAT(CURDATE(), '%Y-%m') AS ym`)
    const month = ym || ''
    const mw = `WHERE is_active = 1 AND DATE_FORMAT(plan_date, '%Y-%m') = ?`
    const [monthByRisk] = await pool.query(
      `SELECT risk_level, COUNT(*) AS cnt FROM t_site_permit ${mw} GROUP BY risk_level`, [month]
    )
    const [[{ monthTotal }]] = await pool.query(
      `SELECT COUNT(*) AS monthTotal FROM t_site_permit ${mw}`, [month]
    )
    const [[{ monthDays }]] = await pool.query(
      `SELECT COUNT(DISTINCT plan_date) AS monthDays FROM t_site_permit ${mw}`, [month]
    )

    ok(res, {
      date, total, byRisk, bySheet, dates,
      month, monthTotal, monthByRisk, monthDays,
      sheets: sheetAll.map((x) => x.sheet_name),
    })
  } catch (e) { fail(res, e) }
})

router.get('/export', async (req, res) => {
  try {
    const w = buildWhere(req.query || {})
    const [rows] = await pool.query(
      `SELECT ${ROW_COLS} FROM t_site_permit ${w.sql} ORDER BY plan_date, sheet_name, id`, w.params
    )
    const header = [
      '序号', '申请单位', '施工单位', '施工内容', '施工地点', '监控设备名称', '施工作业类别',
      '是否属于双边作业', '风险分级', '风险管控措施', '带班人姓名、职务及联系方式',
      '监护人姓名及联系方式', '预计施工时间', '审核人姓名', '上报人姓名', '上报日期', '备注',
    ]
    const aoa = [header]
    rows.forEach((r, i) => {
      aoa.push([
        i + 1, r.apply_unit || '', r.work_unit || '', r.content || '', r.place || '',
        r.camera || '', r.work_type || '', r.dual_op || '', r.risk_level || '',
        r.measures || '', r.leader || '', r.supervisor || '',
        r.plan_time_raw || r.plan_start || '',
        r.auditor || '', r.reporter || '',
        r.report_date_raw || r.report_date || '',
        r.remark || '',
      ])
    })
    const ws = xlsx.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [6, 24, 28, 46, 22, 26, 14, 16, 10, 60, 30, 28, 20, 14, 12, 14, 20]
      .map((wch) => ({ wch }))
    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, '直接作业预约清单')
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const name = `直接作业预约清单_${new Date().toISOString().slice(0, 10)}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    res.send(buf)
  } catch (e) { fail(res, e) }
})

router.get('/:id', async (req, res) => {
  try {
    const [[r]] = await pool.query(`SELECT ${ROW_COLS} FROM t_site_permit WHERE id = ?`, [Number(req.params.id)])
    if (!r) return res.status(404).json({ success: false, error: '记录不存在' })
    ok(res, r)
  } catch (e) { fail(res, e) }
})

module.exports = router
