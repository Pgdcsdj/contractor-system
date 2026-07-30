/**
 * 权限与权限隔离共享服务（模块 A/B/C 后端共用）
 *
 * - requireRole(...roles)：Express 中间件工厂，校验 req.admin.role，越权 → 403。
 * - applyRecorderScope(role, adminId)：返回录入人(recorder)作用域 SQL 片段与参数；
 *      role==='safety' → `AND recorder_id = ?`，其余角色返回空片段。
 * - resolveRecorderContext(admin)：从 t_admin / t_contractor_unit 解析录入人四字段
 *      （id / name / unit_id / unit_name），供 hazardLoop 写入 t_hazard 时复用。
 *
 * 设计依据：系统架构设计 §8.1 / §8.2 / §3.1 / §3.2。
 */

const { verifyAdminToken } = require('./adminAuth')
const { pool } = require('../db/db')

/**
 * 鉴权中间件工厂。
 * 校验 Authorization: Bearer <token> 且 req.admin.role ∈ roles。
 * 未登录 → 401；越权 → 403 { success:false, error:'无权访问' }。
 * @param {...string} roles 允许访问的角色集合（如 'admin','superadmin'）
 * @returns {import('express').RequestHandler}
 */
function requireRole(...roles) {
  return function (req, res, next) {
    const authHeader = req.headers['authorization']
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: '未登录，请先登录' })
    }
    const payload = verifyAdminToken(authHeader.slice(7))
    if (!payload) {
      return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
    }
    req.admin = payload
    if (!roles.includes(payload.role)) {
      return res.status(403).json({ success: false, error: '无权访问' })
    }
    next()
  }
}

/**
 * 生成录入人（recorder）作用域 SQL 片段与参数。
 * 约定：调用方负责统一拼接 `deleted_at IS NULL`，本函数只追加 recorder 过滤。
 * @param {string} role  当前用户角色（'safety' | 'admin' | 'superadmin'）
 * @param {number} adminId 当前用户 id
 * @returns {{ clause: string, params: any[] }}
 */
function applyRecorderScope(role, adminId) {
  if (role === 'safety') {
    return { clause: 'AND recorder_id = ?', params: [Number(adminId)] }
  }
  return { clause: '', params: [] }
}

/**
 * 解析录入人四字段（recorder_id / recorder_name / recorder_unit_id / recorder_unit_name）。
 * 规则（设计 §8.2）：recorder_id=admin.id，recorder_name=admin.username，
 *     recorder_unit_id=admin.unit_id，recorder_unit_name=从 t_contractor_unit 取 unit_name 或空。
 * 异常时返回基于 JWT payload 的兜底值，不中断主流程。
 * @param {{id?:number, username?:string}} admin 来自 JWT 的 admin 对象
 * @returns {Promise<{recorder_id:number|null, recorder_name:string, recorder_unit_id:number|null, recorder_unit_name:string}>}
 */
async function resolveRecorderContext(admin) {
  const adminId = admin && admin.id ? Number(admin.id) : null
  const fallback = {
    recorder_id: adminId,
    recorder_name: admin && admin.username ? admin.username : '',
    recorder_unit_id: null,
    recorder_unit_name: '',
  }
  if (!adminId) return fallback
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, unit_id FROM t_admin WHERE id = ?',
      [adminId]
    )
    const a = rows[0]
    if (!a) return fallback
    let recorder_unit_name = ''
    const unitId = a.unit_id != null ? Number(a.unit_id) : null
    if (unitId) {
      const [u] = await pool.execute(
        'SELECT unit_name FROM t_contractor_unit WHERE id = ?',
        [unitId]
      )
      if (u.length) recorder_unit_name = u[0].unit_name || ''
    }
    return {
      recorder_id: a.id,
      recorder_name: a.username || fallback.recorder_name,
      recorder_unit_id: unitId,
      recorder_unit_name,
    }
  } catch (e) {
    console.error('[permission] resolveRecorderContext 失败（已用兜底）:', e.message)
    return fallback
  }
}

module.exports = { requireRole, applyRecorderScope, resolveRecorderContext }
