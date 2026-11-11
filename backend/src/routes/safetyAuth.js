/**
 * 安全员工作台登录路由（模块 A）
 *
 * POST /api/safety/login  （公开，无需鉴权）
 *   两种凭据模式（前端传 mode）：
 *     · name（默认）: { real_name, phone }     —— 姓名+电话定位，密码即电话
 *     · account      : { username, password }  —— 账号+密码定位（供没有姓名/电话的
 *                       超级管理员账号使用，如 admin / admin123）
 *   角色范围：safety / admin / superadmin 三类账号均可从本入口登录（2026.11.11 起）
 *   校验：bcrypt.compare(secret, password)
 *   成功：**一律以 safety 身份签发 JWT** 并返回 role='safety'。
 *         本入口是安全员工作台入口，管理员/超管从这里登录同样进工作台（权限不降级）；
 *         如需进入管理后台，请另用 /api/admin/login 取得对应角色的 token。
 *   出参：{ success, token, role:'safety', real_name, unit_id, id }
 *   错误：400 参数不全 / 401 凭据错误 / 423 账号禁用(status=0)
 *   安全：401 提示不区分「账号不存在」与「密码错误」，避免账号枚举。
 *
 * 设计依据：系统架构设计 §3.4(a) / §1.2；主理人 8 项裁决 第 1 条。
 */

const express = require('express')
const bcrypt = require('bcrypt')
const { pool } = require('../db/db')
const { signAdminToken } = require('../services/adminAuth')

const router = express.Router()

// ─── POST /api/safety/login ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const body = req.body || {}
  const isAccount = String(body.mode || '') === 'account'
  // 姓名模式：key=姓名，secret=电话；账号模式：key=账号，secret=密码
  const key = String((isAccount ? body.username : body.real_name) || '').trim()
  const secret = String((isAccount ? body.password : body.phone) || '').trim()
  const authErr = isAccount ? '账号或密码错误' : '姓名或电话错误'
  if (!key || !secret) {
    return res.status(400).json({ success: false, error: '请输入完整的登录信息' })
  }

  try {
    // 1) 定位账号
    //    姓名模式按 (real_name + phone) 双人组；账号模式只按 username（密码交给 bcrypt 校验）
    //    角色放宽到 safety / admin / superadmin —— 三类账号都能从安全员工作台入口登录
    const sql = isAccount
      ? `SELECT id, username, password, role, status, real_name, unit_id
           FROM t_admin
          WHERE username = ? AND role IN ('safety','admin','superadmin')
          LIMIT 1`
      : `SELECT id, username, password, role, status, real_name, unit_id
           FROM t_admin
          WHERE real_name = ? AND phone = ? AND role IN ('safety','admin','superadmin')
          LIMIT 1`
    const params = isAccount ? [key] : [key, secret]
    const [rows] = await pool.execute(sql, params)

    // 2) 账号不存在 → 401（提示与密码错误保持一致，避免账号枚举）
    if (!rows.length) {
      return res.status(401).json({ success: false, error: authErr })
    }
    const admin = rows[0]

    // 3) 已禁用 → 423（status=0）
    if (admin.status === 0) {
      return res.status(423).json({ success: false, error: '账号已被禁用，请联系管理员' })
    }

    // 4) 校验密码：账号模式传密码、姓名模式传电话，二者都是该账号 password 列的明文
    const valid = await bcrypt.compare(secret, admin.password)
    if (!valid) {
      return res.status(401).json({ success: false, error: authErr })
    }

    // 5) 更新最后登录时间（fire-and-forget）
    pool.execute('UPDATE t_admin SET last_login = NOW() WHERE id = ?', [admin.id])
      .catch((e) => console.error('[safetyAuth] 更新登录时间失败:', e.message))

    // 6) 一律以 safety 身份签发 —— 本入口只通往安全员工作台
    const token = signAdminToken({ id: admin.id, username: admin.username, role: 'safety' })

    res.json({
      success: true,
      token,
      role: 'safety',
      // 超管账号可能没有 real_name，兜底用 username，避免工作台显示空白姓名
      real_name: admin.real_name || admin.username || '',
      unit_id: admin.unit_id != null ? Number(admin.unit_id) : null,
      id: admin.id,
    })
  } catch (err) {
    console.error('[safety login]', err.message)
    res.status(500).json({ success: false, error: '登录失败：' + err.message })
  }
})

module.exports = router
