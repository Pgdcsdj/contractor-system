/**
 * 直接作业预约报备 · 接口封装
 * 数据源：钉钉在线表格（每晚 22:00 自动同步）→ t_site_permit
 * axios 拦截器 (res)=>res 不剥 data，业务取 res.data.data。
 */
import { request } from '@/utils/request'

const BASE = '/api/site-permit'

// ── 同步配置 ──────────────────────────────────────────────────────────────
export function getSitePermitConfig() {
  return request.get(`${BASE}/config`)
}
export function saveSitePermitConfig(payload) {
  return request.put(`${BASE}/config`, payload)
}
/** 连通性测试：用未保存的表单值也能测 */
export function testSitePermitConn(payload) {
  return request.post(`${BASE}/test`, payload, { timeout: 60000 })
}
/** 立即同步；dryRun=true 只解析不写库 */
export function syncSitePermitNow(dryRun = false) {
  return request.post(`${BASE}/sync${dryRun ? '?dryRun=1' : ''}`, {}, { timeout: 300000 })
}
export function getSitePermitSyncLogs() {
  return request.get(`${BASE}/sync-logs`)
}

// ── 台账 ──────────────────────────────────────────────────────────────────
export function getSitePermitList(params = {}) {
  return request.get(`${BASE}/list`, { params })
}
export function getSitePermitStats(date = '') {
  return request.get(`${BASE}/stats`, { params: date ? { date } : {} })
}
export function getSitePermitDetail(id) {
  return request.get(`${BASE}/${id}`)
}

// ── 导出 ──────────────────────────────────────────────────────────────────
export function exportSitePermit(params = {}) {
  return request.get(`${BASE}/export`, { params, responseType: 'blob', timeout: 300000 })
    .then((res) => {
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `直接作业预约清单_${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
      return res
    })
}
