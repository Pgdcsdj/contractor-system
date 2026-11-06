/**
 * 承包商安全活动模块接口封装
 * - /api/activity        管理端（需 admin token，已在 request.js 登记）
 * - /api/open/activity   公开免登录填报端
 * axios 拦截器 (res)=>res 不剥 data，业务取 res.data.data。
 */
import { request } from '@/utils/request'

const ADMIN = '/api/activity'
const OPEN = '/api/open/activity'

// ── 管理端 ────────────────────────────────────────────────────────────────
export function getActivityUnits(keyword = '') {
  return request.get(`${ADMIN}/units`, { params: { keyword } })
}
export function getActivityPeriods(params = {}) {
  return request.get(`${ADMIN}/periods`, { params })
}
export function getActivityPeriod(id) {
  return request.get(`${ADMIN}/periods/${id}`)
}
export function createActivityPeriod(form) {
  return request.post(`${ADMIN}/periods`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 })
}
export function updateActivityPeriod(id, payload) {
  return request.put(`${ADMIN}/periods/${id}`, payload)
}
export function deleteActivityPeriod(id) {
  return request.delete(`${ADMIN}/periods/${id}`)
}
export function uploadActivityTemplate(id, form) {
  return request.post(`${ADMIN}/periods/${id}/template`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 })
}
export function getActivityRecords(params = {}) {
  return request.get(`${ADMIN}/records`, { params })
}
export function getActivityRecord(id) {
  return request.get(`${ADMIN}/records/${id}`)
}
export function deleteActivityRecord(id) {
  return request.delete(`${ADMIN}/records/${id}`)
}
export function getActivitySummary(id) {
  return request.get(`${ADMIN}/periods/${id}/summary`)
}
export function getActivityReminders() {
  return request.get(`${ADMIN}/reminders`)
}
/** 月度看板：周一/周三 完成情况统计 */
export function getActivityDashboard(month = '') {
  return request.get(`${ADMIN}/dashboard`, { params: { month } })
}
/** 受控单位名单（月度统计表的行设置） */
export function getActivityStatUnits() {
  return request.get(`${ADMIN}/stat-units`)
}
export function saveActivityStatUnits(rows) {
  return request.post(`${ADMIN}/stat-units`, { rows })
}
export function exportActivityDashboard(month) {
  return adminDownload(`/dashboard/export?month=${encodeURIComponent(month)}`, `${month}_安全活动完成情况统计.xlsx`)
}
export function readActivityReminder(id) {
  return request.put(`${ADMIN}/reminders/${id}/read`)
}

/** 下载标准表 / 空白模板 / 汇总导出（blob） */
function adminDownload(path, filename) {
  return request.get(`${ADMIN}${path}`, { responseType: 'blob', timeout: 300000 })
    .then((res) => downloadBlob(res, filename))
}
export function downloadPeriodTemplate(id, title, blank = false) {
  return adminDownload(`/periods/${id}/template${blank ? '?blank=1' : ''}`, `${title}_${blank ? '空白填报模板' : '标准表'}.xlsx`)
}
export function exportPeriodSummary(id, title, type) {
  return adminDownload(`/periods/${id}/export`, `${title}_${type === 'inspection' ? '类比排查汇总' : '活动记录汇总'}.xlsx`)
}

// ── 公开填报端 ────────────────────────────────────────────────────────────
export function getOpenUnits(keyword = '') {
  return request.get(`${OPEN}/units`, { params: { keyword } })
}
export function getOpenPeriods(type = '') {
  return request.get(`${OPEN}/periods`, { params: { type } })
}
export function getOpenPeriod(id) {
  return request.get(`${OPEN}/periods/${id}`)
}
export function submitActivityForm(payload) {
  return request.post(`${OPEN}/submit`, payload)
}
export function importActivityFilled(form) {
  return request.post(`${OPEN}/import`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 })
}
export function submitActivityRows(payload) {
  return request.post(`${OPEN}/rows`, payload)
}
export function uploadActivityFile(form) {
  return request.post(`${OPEN}/files`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 })
}
export function getMySubmission(params) {
  return request.get(`${OPEN}/mine`, { params })
}
export function deleteMyRow(id, uploader_name, uploader_phone) {
  return request.delete(`${OPEN}/rows/${id}`, { params: { uploader_name, uploader_phone } })
}
export function openDownloadTemplate(id, title, blank = false) {
  return request.get(`${OPEN}/periods/${id}/template${blank ? '?blank=1' : ''}`, { responseType: 'blob', timeout: 300000 })
    .then((res) => downloadBlob(res, `${title}_${blank ? '空白填报模板' : '标准表'}.xlsx`))
}

// ── 通用 blob 下载 ────────────────────────────────────────────────────────
export function downloadBlob(res, filename) {
  const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
  return res
}
