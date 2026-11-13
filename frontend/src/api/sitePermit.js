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

/**
 * 上传群里每日发的《直接作业环节施工风险分级清单XX.XX.xlsx》直接入账。
 * 走 multipart，必须显式覆盖 axios 全局的 application/json，否则 FormData 会被序列化坏。
 * dryRun=true 只预演解析、不写库。
 */
export function importSitePermitExcel(file, dryRun = false) {
  const fd = new FormData()
  fd.append('file', file)
  if (dryRun) fd.append('dryRun', '1')
  const token = localStorage.getItem('tnb_admin_token') || ''
  return request.post(`${BASE}/import-excel${dryRun ? '?dryRun=1' : ''}`, fd, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeout: 300000,
  })
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
