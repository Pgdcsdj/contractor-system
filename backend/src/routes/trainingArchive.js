/**
 * 培训档案路由（管理端）
 *
 * 制度依据：中原油勘制〔2024〕39号 3.10.1「一期一档」、3.10.2「一人一档」
 *
 * GET    /api/training-archive/meta                下拉选项（类别/方式/清单项）
 * GET    /api/training-archive/sessions            场次列表
 * POST   /api/training-archive/sessions            新建场次
 * GET    /api/training-archive/sessions/:id        场次详情
 * PUT    /api/training-archive/sessions/:id        编辑场次
 * DELETE /api/training-archive/sessions/:id        删除场次（有考试记录则拒绝）
 * GET    /api/training-archive/sessions/:id/roster     参训名单
 * GET    /api/training-archive/sessions/:id/export     一期一档（6 Sheet）
 * GET    /api/training-archive/sessions/:id/sign-sheet 空白签到表
 * GET    /api/training-archive/sessions/:id/score-sheet 成绩表
 * GET    /api/training-archive/person/:userId/archive  一人一档导出
 * GET    /api/training-archive/annual                  年度学时统计（JSON）
 * GET    /api/training-archive/annual/export           年度学时统计（Excel）
 * GET    /api/training-archive/ledger                  培训台账（JSON）
 * GET    /api/training-archive/ledger/export           培训台账（Excel）
 */

const express = require('express')
const { verifyAdminToken } = require('../services/adminAuth')
const { pool } = require('../db/db')
const svc = require('../services/trainingArchiveService')
const exporter = require('../services/exportTrainingArchive')

const router = express.Router()

// ─── 鉴权（与 record.js 同款，支持 Authorization 头或 ?token= 直链下载）──────
function adminAuth(req, res, next) {
  const h = req.headers['authorization']
  let token = null
  if (h && h.startsWith('Bearer ')) token = h.slice(7)
  else if (req.query && req.query.token) token = String(req.query.token)
  if (!token) return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  const payload = verifyAdminToken(token)
  if (!payload) return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  req.admin = payload
  next()
}

router.use(adminAuth)

function sendError(res, status, msg) {
  return res.status(status).json({ success: false, error: msg })
}

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

/* ─── 下拉选项 ─────────────────────────────────────────────────────────── */
router.get('/meta', async (req, res) => {
  try {
    const [cats] = await pool.query('SELECT id, name FROM t_material_category ORDER BY sort_order, id')
    res.json({
      success: true,
      data: {
        categories: cats,
        trainModes: svc.TRAIN_MODES,
        assessmentTypes: svc.ASSESSMENT_TYPES,
        statusList: svc.STATUS_LIST,
        checklist: svc.CHECKLIST_KEYS.map(([key, label]) => ({ key, label })),
        hoursStandard: { default: 20, teamLeader: 24 },
      },
    })
  } catch (e) {
    console.error('[training-archive meta]', e.message)
    sendError(res, 500, '查询失败：' + e.message)
  }
})

/* ─── 场次列表 / 新建 ─────────────────────────────────────────────────── */
router.get('/sessions', async (req, res) => {
  try {
    const { year, month, categoryId, status, keyword, page, pageSize } = req.query
    const data = await svc.listSessions({ year, month, categoryId, status, keyword, page, pageSize })
    res.json({ success: true, data })
  } catch (e) {
    console.error('[training-archive list]', e.message)
    sendError(res, 500, '查询失败：' + e.message)
  }
})

router.post('/sessions', async (req, res) => {
  try {
    const b = req.body || {}
    if (!String(b.title || '').trim()) return sendError(res, 400, '培训名称不能为空')
    if (!b.sessionDate) return sendError(res, 400, '培训日期不能为空')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.sessionDate))) return sendError(res, 400, '培训日期格式应为 YYYY-MM-DD')
    const id = await svc.createSession(b, req.admin && req.admin.id)
    res.json({ success: true, data: { id } })
  } catch (e) {
    console.error('[training-archive create]', e.message)
    sendError(res, 500, '创建失败：' + e.message)
  }
})

/* ─── 场次详情 / 编辑 / 删除 ───────────────────────────────────────────── */
router.get('/sessions/:id', async (req, res) => {
  try {
    const s = await svc.getSession(Number(req.params.id))
    if (!s) return sendError(res, 404, '培训场次不存在')
    res.json({ success: true, data: s })
  } catch (e) {
    sendError(res, 500, '查询失败：' + e.message)
  }
})

router.put('/sessions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, '场次ID不合法')
    if (req.body && req.body.sessionDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.sessionDate))) {
      return sendError(res, 400, '培训日期格式应为 YYYY-MM-DD')
    }
    await svc.updateSession(id, req.body || {})
    res.json({ success: true })
  } catch (e) {
    console.error('[training-archive update]', e.message)
    sendError(res, 500, '保存失败：' + e.message)
  }
})

router.delete('/sessions/:id', async (req, res) => {
  try {
    await svc.deleteSession(Number(req.params.id))
    res.json({ success: true })
  } catch (e) {
    if (e.code === 'HAS_RECORDS') return sendError(res, 409, e.message)
    console.error('[training-archive delete]', e.message)
    sendError(res, 500, '删除失败：' + e.message)
  }
})

/* ─── 参训名单 ────────────────────────────────────────────────────────── */
router.get('/sessions/:id/roster', async (req, res) => {
  try {
    const data = await svc.getRoster(Number(req.params.id))
    if (!data) return sendError(res, 404, '培训场次不存在')
    res.json({ success: true, data })
  } catch (e) {
    console.error('[training-archive roster]', e.message)
    sendError(res, 500, '查询失败：' + e.message)
  }
})

/* ─── 导出：一期一档 / 签到表 / 成绩表 ─────────────────────────────────── */
router.get('/sessions/:id/export', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const roster = await svc.getRoster(id)
    if (!roster) return sendError(res, 404, '培训场次不存在')
    const scores = await svc.getScores(id)
    const buf = exporter.buildSessionPack({ session: roster.session, roster, scores })
    const d = String(roster.session.session_date).slice(0, 10)
    sendXlsx(res, buf, `${d}_${roster.session.title}_培训档案.xlsx`)
  } catch (e) {
    console.error('[training-archive export]', e.message)
    sendError(res, 500, '导出失败：' + e.message)
  }
})

router.get('/sessions/:id/sign-sheet', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const roster = await svc.getRoster(id)
    if (!roster) return sendError(res, 404, '培训场次不存在')
    const buf = exporter.buildSignSheet({ session: roster.session, roster })
    const d = String(roster.session.session_date).slice(0, 10)
    sendXlsx(res, buf, `${d}_${roster.session.title}_签到表.xlsx`)
  } catch (e) {
    sendError(res, 500, '导出失败：' + e.message)
  }
})

router.get('/sessions/:id/score-sheet', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const scores = await svc.getScores(id)
    if (!scores) return sendError(res, 404, '培训场次不存在')
    const buf = exporter.buildScoreSheet({ session: scores.session, scores })
    const d = String(scores.session.session_date).slice(0, 10)
    sendXlsx(res, buf, `${d}_${scores.session.title}_成绩表.xlsx`)
  } catch (e) {
    sendError(res, 500, '导出失败：' + e.message)
  }
})

/* ─── 一人一档 ────────────────────────────────────────────────────────── */
router.get('/person/:userId/archive', async (req, res) => {
  try {
    const userId = Number(req.params.userId)
    const year = req.query.year ? Number(req.query.year) : null
    const person = await svc.personArchive(userId, year)
    if (!person) return sendError(res, 404, '人员不存在')
    if (req.query.format === 'json') return res.json({ success: true, data: person })
    const buf = exporter.buildPersonArchive(person)
    sendXlsx(res, buf, `${person.user.name}_个人培训档案${year ? '_' + year : ''}.xlsx`)
  } catch (e) {
    console.error('[training-archive person]', e.message)
    sendError(res, 500, '导出失败：' + e.message)
  }
})

/* ─── 年度学时统计 ────────────────────────────────────────────────────── */
router.get('/annual', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear()
    const list = await svc.annualStats({ year, unit: req.query.unit })
    const qualified = list.filter((r) => r.qualified).length
    res.json({
      success: true,
      data: { year, list, summary: { total: list.length, qualified, unqualified: list.length - qualified } },
    })
  } catch (e) {
    console.error('[training-archive annual]', e.message)
    sendError(res, 500, '查询失败：' + e.message)
  }
})

router.get('/annual/export', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear()
    const list = await svc.annualStats({ year, unit: req.query.unit })
    const buf = exporter.buildAnnualStats(list, year)
    sendXlsx(res, buf, `${year}年度安全培训学时统计表.xlsx`)
  } catch (e) {
    console.error('[training-archive annual export]', e.message)
    sendError(res, 500, '导出失败：' + e.message)
  }
})

/* ─── 培训台账 ────────────────────────────────────────────────────────── */
router.get('/ledger', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear()
    const data = await svc.ledger(year)
    res.json({ success: true, data })
  } catch (e) {
    console.error('[training-archive ledger]', e.message)
    sendError(res, 500, '查询失败：' + e.message)
  }
})

router.get('/ledger/export', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear()
    const data = await svc.ledger(year)
    const buf = exporter.buildLedger(data)
    sendXlsx(res, buf, `${year}年度安全培训台账.xlsx`)
  } catch (e) {
    console.error('[training-archive ledger export]', e.message)
    sendError(res, 500, '导出失败：' + e.message)
  }
})

module.exports = router
