/**
 * 登录路由
 *
 * POST /api/auth/qr-login        扫码登录（Token来自二维码）
 * POST /api/auth/manual-login    手动登录（姓名 + 身份证后四位）
 * POST /api/auth/register        临时注册（未录入人员自助注册）
 * GET  /api/auth/me              获取当前登录用户信息（需JWT）
 */

const express = require('express')
const { loginByQr, loginByManual, verifyToken, signToken } = require('../services/authService')
const { pool } = require('../db/db')
const { resolveUnit, normUnit } = require('../services/importService')
const { lookupAlias } = require('../services/unitAlias')

const router = express.Router()

// 主管单位值域（当前业务只允许通南巴项目部；如需扩展在此追加）
const ALLOWED_SUPERVISING_UNITS = ['通南巴项目部']

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先扫码或手动登录' })
  }
  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) {
    return res.status(401).json({ error: 'Token 已过期，请重新登录' })
  }
  req.user = payload
  next()
}

// ─── POST /api/auth/qr-login ─────────────────────────────────────────────────
router.post('/qr-login', async (req, res) => {
  const { token: qrToken } = req.body

  if (!qrToken) {
    return res.status(400).json({ error: '缺少二维码 Token' })
  }

  try {
    const result = await loginByQr(qrToken)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// ─── POST /api/auth/manual-login ────────────────────────────────────────────
router.post('/manual-login', async (req, res) => {
  const { name, last4 } = req.body

  try {
    const result = await loginByManual(name, last4)
    res.json({ success: true, ...result })
  } catch (err) {
    // 姓名+后4位不匹配且确属库里没有该名员工 → 返回 404 结构化，前端自动弹补全注册
    if (err.code === 'USER_NOT_FOUND') {
      return res.status(404).json({
        error: err.message,
        code: 'USER_NOT_FOUND',
        name: err.payload?.name,
        last4: err.payload?.inputLast4,
      })
    }
    res.status(401).json({ error: err.message })
  }
})

// ─── POST /api/auth/register ──────────────────────────────────────────────────
// 自助注册：未录入系统的人员补全信息注册（支持登录失败自动跳转的补全流程）
// 接受字段：name, id_card(完整18位), unit, supervising_unit, phone, position,
//          contractor_unit_id, last4(登录时填写的身份证后4位，用于校验防伪造，可选)
router.post('/register', async (req, res) => {
  const {
    name, id_card, unit, supervising_unit = '', phone = '',
    position = '', contractor_unit_id = null, last4 = '',
  } = req.body

  const su = String(supervising_unit || '').trim()
  if (!su) {
    return res.status(400).json({ error: '请选择主管单位' })
  }
  if (!ALLOWED_SUPERVISING_UNITS.includes(su)) {
    return res.status(400).json({ error: '主管单位不在允许范围：' + su })
  }

  if (!name || !name.trim())   return res.status(400).json({ error: '请输入姓名' })
  if (!id_card || !id_card.trim()) return res.status(400).json({ error: '请输入身份证号' })

  const trimmedName = name.trim()
  const trimmedId   = id_card.trim().toUpperCase()

  // 校验完整身份证末4位 ≡ 登录时后4位（末位X→0），仅当传了 last4 时校验，防伪造补全
  if (last4) {
    const norm = String(last4).toUpperCase().replace(/X$/, '0')
    const cardLast4 = trimmedId.slice(-4).replace(/X$/, '0')
    if (cardLast4 !== norm) {
      return res.status(400).json({ error: '身份证号末四位与登录填写不一致' })
    }
  }

  // 检查是否已注册
  const [existing] = await pool.execute(
    'SELECT id, name, id_card, unit, status FROM t_user WHERE id_card = ? LIMIT 1',
    [trimmedId]
  )

  if (existing.length > 0) {
    // 已存在 → 直接登录（含库里已有但信息不全的老用户，无需重复建号）
    const user = existing[0]
    if (user.status === 0) return res.status(403).json({ error: '账号已被禁用，请联系管理员' })
    const token = signToken(user)
    return res.json({
      success: true,
      message: '欢迎回来',
      token,
      user: { id: user.id, name: user.name, unit: user.unit },
    })
  }

  // 新用户 → 注册
  // 生成简单的 qr_token（用 SHA-256 截断）
  const crypto = require('crypto')
  const qrToken = crypto.createHash('sha256').update(trimmedId).digest('hex').slice(0, 16)

  // ── 承包商单位规范化（2026-11-24）─────────────────────────────────────────
  // 背景：临时注册过去是自由文本框、后端零校验，库里出现「石油气保障中心」等错字，
  // 导致网格概述统计和培训档案的单位列对不上。现在统一走归一化：
  //   · 下拉选中在册单位 → 以 id 为准，写标准全称，状态 ok
  //   · 自填名称命中在册单位（含简称/别名）→ 写标准全称 + id，状态 ok
  //   · 自填命中已确认的别名（目标单位可能停用，如「试油气保障中心」）→ 写标准全称，
  //     不写 contractor_unit_id（避免把人挂到停用单位），状态 ok
  //   · 自填「其他（不在清单内）」且无法匹配 → 保留原文，状态 pending 待管理员审核
  const [unitRows] = await pool.execute(
    "SELECT id, unit_name FROM t_contractor_unit WHERE grid_level IN ('三级','四级') AND is_active = 1"
  )
  const unitList = unitRows
  let finalUnit = String(unit || '').trim()
  let finalCid = contractor_unit_id != null ? Number(contractor_unit_id) : null
  let verifyStatus = 'ok'

  const selected = finalCid ? unitList.find((u) => u.id === finalCid) : null
  if (selected) {
    // 前端下拉选择：以 id 为准，避免传来的名称被改过
    finalUnit = selected.unit_name
    verifyStatus = 'ok'
  } else if (finalUnit) {
    // 关键顺序（2026-11-24 实测修正）：
    // normUnit() 自身已带「异写归一」（例如「石油气保障中心」直接纠正成「试油气保障中心」），
    // 此时别名表反而查不到。所以先取别名，没有别名就用归一化结果本身当作候选标准名。
    const normalized = normUnit(finalUnit)
    const aliasName = lookupAlias(normalized, 'personnel') || normalized
    const activeHit = unitList.find((u) => u.unit_name === aliasName)

    if (activeHit) {
      finalUnit = activeHit.unit_name
      finalCid = activeHit.id
    } else {
      // 候选标准名可能在册但已停用（如「试油气保障中心」is_active=0）：
      // 用户填的确实是标准名，采用它但不写 contractor_unit_id，避免挂到停用单位。
      const [[anyRow]] = await pool.execute(
        'SELECT unit_name FROM t_contractor_unit WHERE unit_name = ? LIMIT 1',
        [aliasName]
      )
      if (anyRow) {
        finalUnit = anyRow.unit_name
        finalCid = null
      } else {
        // 最后才走通用归一化（队号/编辑距离等兜底），仍匹配不上就待审核
        const hit = resolveUnit(finalUnit, unitList)
        if (hit && hit.matched) {
          finalUnit = hit.unit_name
          finalCid = hit.id
        } else {
          verifyStatus = 'pending'
        }
      }
    }
  } else {
    // 单位留空同样需要人工补，纳入待审核
    verifyStatus = 'pending'
  }

  const [result] = await pool.execute(
    `INSERT INTO t_user (name, id_card, unit, supervising_unit, phone, position, contractor_unit_id, unit_verify_status, qr_token, status, self_registered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    [trimmedName, trimmedId, finalUnit, su, phone || '', position || '', finalCid, verifyStatus, qrToken]
  )

  const token = signToken({ id: result.insertId, name: trimmedName, unit: finalUnit })

  res.json({
    success: true,
    message: verifyStatus === 'pending' ? '注册成功，单位将由管理员审核确认' : '注册成功',
    token,
    user: {
      id: result.insertId,
      name: trimmedName,
      unit: finalUnit,
      unitVerifyStatus: verifyStatus,
    },
  })
})

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user })
})

// 导出鉴权中间件，供其他路由复用
router.authMiddleware = authMiddleware

module.exports = router
