/**
 * 监控看板聚合接口封装（Sprint 3 / P0-4）
 *
 * 走 /api/hazards/stats，命中 request.js 的 /api/hazard 前缀 → 自动注入 admin token（不 401）。
 * 返回 axios 响应，调用方通过 res.data?.data 取聚合对象。
 */
import { request } from '@/utils/request'

/**
 * 获取隐患 KPI 聚合数据
 * @param {Object} params { granularity?: 'week' | 'day' }
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function getHazardStats(params = {}) {
  return request.get('/api/hazards/stats', { params })
}

/**
 * 获取超期隐患清单（监控看板「超期预警清单」面板用）
 * @param {Object} params { unit?: string, minDays?: number }
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export function getOverdueHazards(params = {}) {
  return request.get('/api/hazards/overdue', { params })
}
