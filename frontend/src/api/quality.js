/**
 * 出题质量量化校验与追踪 —— 接口封装
 *
 * 全部走 /api/quality*，request.js 已把该前缀加入 ADMIN_API_PREFIXES，
 * 会自动注入管理员 token，并把超时放宽到 300s（内部含多次大模型调用）。
 */
import { request } from '@/utils/request'

/**
 * 读取质量配置（不传 materialId 则取全局默认）
 * @param {number|null} materialId
 * @returns {Promise} data: { materialId, config, defaults, bloomLevels, weights }
 */
export function getQualityConfig(materialId = null) {
  const params = {}
  if (materialId) params.materialId = materialId
  return request.get('/api/quality/config', { params })
}

/**
 * 保存质量配置
 * @param {{materialId?: number|null, config: Object, name?: string}} payload
 */
export function saveQualityConfig(payload) {
  return request.put('/api/quality/config', payload)
}

/**
 * 运行整卷质量校验（会落库一条质量报告）
 * @param {number} materialId
 */
export function runQualityCheck(materialId) {
  return request.post(`/api/quality/${materialId}/check`)
}

/**
 * 读取最近一次质量报告（不触发重算，进页面时先调它）
 * @param {number} materialId
 */
export function getLatestQualityReport(materialId) {
  return request.get(`/api/quality/${materialId}/report`)
}

/**
 * 存量题目一键 AI 补标
 * @param {number} materialId
 * @param {boolean} force 是否覆盖已有标注
 */
export function enrichQuestions(materialId, force = false) {
  return request.post(`/api/quality/${materialId}/enrich`, { force })
}

/**
 * 重新抽取源文档关键点（刷新覆盖率基准）
 * @param {number} materialId
 */
export function refreshSourceKeypoints(materialId) {
  return request.post(`/api/quality/${materialId}/keypoints`, { force: true })
}

/**
 * 修订留痕历史
 * @param {number} materialId
 * @param {number} [round] 可选，过滤指定轮次
 */
export function getRevisionHistory(materialId, round) {
  const params = {}
  if (round !== undefined && round !== null && round !== '') params.round = round
  return request.get(`/api/quality/${materialId}/history`, { params })
}

/**
 * 导出质量报告 Excel（浏览器直接下载）
 * @param {number} materialId
 * @param {string} [title] 用于拼接下载文件名
 * @returns {Promise<void>}
 */
export async function exportQualityExcel(materialId, title = '') {
  const res = await request.get(`/api/quality/${materialId}/export`, {
    responseType: 'blob',
  })
  const blob = new Blob([res.data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safeTitle = String(title || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  a.download = safeTitle
    ? `质量报告_${safeTitle}_${materialId}.xlsx`
    : `质量报告_${materialId}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}
