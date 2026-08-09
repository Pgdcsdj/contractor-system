/**
 * 出题质量量化校验与追踪 —— 路由（管理员）
 *
 * GET    /api/quality/config             读取质量配置（?materialId= 可选，缺省取全局默认）
 * PUT    /api/quality/config             保存质量配置（materialId 为空 → 全局默认）
 * POST   /api/quality/:id/check          运行整卷质量校验（落库 t_quality_report）
 * GET    /api/quality/:id/report         读取最近一次质量报告（不重算）
 * POST   /api/quality/:id/enrich         存量题目一键 AI 补标
 * POST   /api/quality/:id/keypoints      重新抽取源文档关键点（刷新缓存）
 * GET    /api/quality/:id/history        修订留痕历史（?round= 可选）
 * GET    /api/quality/:id/export         导出质量报告 Excel（4 个 sheet）
 *
 * 设计约束：
 *   - 不引入新依赖，业务逻辑全部在 services/qualityService.js
 *   - 全部接口需管理员登录（Bearer Token），与 material.js 的 adminAuth 一致
 *   - AI 相关接口（check / enrich / keypoints）耗时较长，前端需带 loading
 */

const express = require('express')
const { verifyAdminToken } = require('../services/adminAuth')
const quality = require('../services/qualityService')

const router = express.Router()

// ─── JWT 鉴权中间件（与 material.js 保持一致）─────────────────────────────────
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

/**
 * 解析并校验路径上的素材 ID
 * @param {*} raw
 * @returns {number} 合法时返回正整数，否则返回 0
 */
function parseMaterialId(raw) {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : 0
}

/**
 * 统一错误响应
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {string} fallbackMsg
 */
function failWith(res, err, fallbackMsg) {
  const msg = (err && err.message) || fallbackMsg
  // 业务型错误（素材不存在 / 参数非法）返回 400，其余按 500
  const isBiz = /不存在|无效|不能为空|未找到/.test(msg)
  console.error(`[quality] ${fallbackMsg}:`, msg)
  return res.status(isBiz ? 400 : 500).json({ error: msg })
}

router.use(adminAuth)

// ─── 1. 读取质量配置 ─────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const materialId = parseMaterialId(req.query.materialId)
    const config = await quality.getConfig(materialId)
    return res.json({
      success: true,
      data: {
        materialId: materialId || null,
        config,
        defaults: quality.DEFAULT_CONFIG,
        bloomLevels: quality.BLOOM_LEVELS,
        weights: quality.SCORE_WEIGHTS,
      },
    })
  } catch (err) {
    return failWith(res, err, '读取质量配置失败')
  }
})

// ─── 2. 保存质量配置 ─────────────────────────────────────────────────────────
router.put('/config', async (req, res) => {
  try {
    const { materialId = null, config = {}, name = '' } = req.body || {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: 'config 必须是对象' })
    }

    const mid = parseMaterialId(materialId)
    const saved = await quality.saveConfig({ materialId: mid || null, config, name })

    // 配置变更留痕（仅素材级配置需要追溯到具体素材）
    if (mid > 0) {
      await quality.logRevision({
        materialId: mid,
        roundNo: 0,
        operatorId: req.admin.id,
        operatorName: req.admin.username,
        opType: 'CONFIG',
        opContent: '修改质量校验配置',
        before: saved.before,
        after: saved.after,
      })
    }

    return res.json({ success: true, data: saved })
  } catch (err) {
    return failWith(res, err, '保存质量配置失败')
  }
})

// ─── 3. 运行整卷质量校验 ─────────────────────────────────────────────────────
router.post('/:id/check', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  try {
    const report = await quality.runQualityCheck(materialId)
    return res.json({ success: true, data: report })
  } catch (err) {
    return failWith(res, err, '质量校验失败')
  }
})

// ─── 4. 读取最近一次报告（不触发重算）─────────────────────────────────────────
router.get('/:id/report', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  try {
    const report = await quality.getLatestReport(materialId)
    return res.json({ success: true, data: report })
  } catch (err) {
    return failWith(res, err, '读取质量报告失败')
  }
})

// ─── 5. 存量题目一键补标 ─────────────────────────────────────────────────────
router.post('/:id/enrich', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  const force = req.body && (req.body.force === true || req.body.force === 'true')

  try {
    const result = await quality.enrichQuestions(materialId, { force })

    await quality.logRevision({
      materialId,
      roundNo: 0,
      operatorId: req.admin.id,
      operatorName: req.admin.username,
      opType: 'EDIT',
      opContent: `AI 补全标注：成功 ${result.annotated} 道（跳过 ${result.skipped}，失败 ${result.failed}）`,
      before: null,
      after: result,
    })

    return res.json({ success: true, data: result })
  } catch (err) {
    return failWith(res, err, '补全标注失败')
  }
})

// ─── 6. 重新抽取源文档关键点 ─────────────────────────────────────────────────
router.post('/:id/keypoints', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  const force = !req.body || req.body.force !== false

  try {
    const result = await quality.extractSourceKeyPoints(materialId, { force })
    return res.json({ success: true, data: result })
  } catch (err) {
    return failWith(res, err, '抽取源文档关键点失败')
  }
})

// ─── 7. 修订留痕历史 ─────────────────────────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  const roundRaw = req.query.round
  const round =
    roundRaw === undefined || roundRaw === null || String(roundRaw) === ''
      ? undefined
      : Number(roundRaw)

  try {
    const list = await quality.getRevisionHistory(materialId, round)
    return res.json({ success: true, data: list, total: list.length })
  } catch (err) {
    return failWith(res, err, '读取修订历史失败')
  }
})

// ─── 8. 导出质量报告 Excel ───────────────────────────────────────────────────
router.get('/:id/export', async (req, res) => {
  const materialId = parseMaterialId(req.params.id)
  if (!materialId) return res.status(400).json({ error: '素材ID无效' })

  try {
    const { buffer, filename } = await quality.exportQualityExcel(materialId)
    const encoded = encodeURIComponent(filename)

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
    )
    res.setHeader('Content-Length', buffer.length)
    return res.end(buffer)
  } catch (err) {
    return failWith(res, err, '导出质量报告失败')
  }
})

module.exports = router
