/**
 * 安全员 / 账号 / 数据管理 接口封装（模块 A/B/D 前端）
 *
 * 全部走 /api/safety、/api/account、/api/data，request.js 已自动注入 admin token。
 * 说明：safetyLogin 走 /api/safety/login（公开，但 token 复用 tnb_admin_token 存储）。
 */
import { request } from '@/utils/request'

/** 安全员登录（公开） */
export function safetyLogin(payload) {
  return request.post('/api/safety/login', payload)
}

/** 账号列表（admin/superadmin） */
export function getAccounts(params = {}) {
  return request.get('/api/account', { params: { pageSize: 50, ...params } })
}

/** 创建账号 */
export function createAccount(payload) {
  return request.post('/api/account', payload)
}

/** 更新账号 */
export function updateAccount(id, payload) {
  return request.put(`/api/account/${id}`, payload)
}

/** 删除账号 */
export function deleteAccount(id) {
  return request.delete(`/api/account/${id}`)
}

/** 密码重置（重置为 bcrypt(phone)） */
export function resetPassword(id, payload) {
  return request.put(`/api/account/${id}/reset-password`, payload)
}

/** 立即备份 */
export function triggerBackup() {
  return request.post('/api/data/backup')
}

/** 导出隐患（返回 xlsx 附件 blob） */
export function exportHazards(payload) {
  return request.post('/api/data/export', payload, { responseType: 'blob' })
}

/** 备份文件列表 */
export function listBackups() {
  return request.get('/api/data/backups')
}

/** 隐患排查项目下拉枚举（来自已入库数据） */
export function getInvestigationItems() {
  return request.get('/api/data/investigation-items')
}
