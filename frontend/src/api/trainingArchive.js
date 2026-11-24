/**
 * 培训档案（一期一档 / 一人一档）· 接口封装
 * 制度依据：中原油勘制〔2024〕39号 3.10
 * axios 拦截器为 (res)=>res，业务数据取 res.data.data
 */
import { request } from '@/utils/request'

const BASE = '/api/training-archive'

export function getArchiveMeta() {
  return request.get(`${BASE}/meta`)
}

export function listSessions(params = {}) {
  return request.get(`${BASE}/sessions`, { params })
}

export function getSession(id) {
  return request.get(`${BASE}/sessions/${id}`)
}

export function createSession(payload) {
  return request.post(`${BASE}/sessions`, payload)
}

export function updateSession(id, payload) {
  return request.put(`${BASE}/sessions/${id}`, payload)
}

export function deleteSession(id) {
  return request.delete(`${BASE}/sessions/${id}`)
}

export function getRoster(id) {
  return request.get(`${BASE}/sessions/${id}/roster`)
}

export function getAnnual(params = {}) {
  return request.get(`${BASE}/annual`, { params })
}

export function getLedger(params = {}) {
  return request.get(`${BASE}/ledger`, { params })
}

/**
 * 导出直链（window.open 无法携带 Authorization 头，改用 ?token= 直链模式）。
 * path 例：`/sessions/12/export`
 */
export function openArchiveExport(path) {
  const token = localStorage.getItem('tnb_admin_token') || ''
  const sep = path.includes('?') ? '&' : '?'
  window.open(`${BASE}${path}${sep}token=${encodeURIComponent(token)}`, '_blank')
}
