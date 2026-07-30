/**
 * 监控看板数据格式化纯函数（Sprint 3 / T04）
 * 无副作用、可单测；供 HazardMonitorPage 复用。
 */

/** 闭环率百分比（整数），total=0 时返回 0 */
export function calcClosedRate(total = 0, closed = 0) {
  if (!total) return 0
  return Math.round((closed / total) * 100)
}

/** 占比百分比（整数），total=0 时返回 0 */
export function pct(part = 0, total = 0) {
  if (!total) return 0
  return Math.round((part / total) * 100)
}

/** 取一组对象某数值键的最大值 */
export function maxOf(arr = [], key = 'count') {
  return arr.reduce((m, it) => Math.max(m, Number(it?.[key]) || 0), 0)
}

/** 趋势归一化：返回 max 与原始点（供 SVG 高度计算） */
export function normalizeTrend(trend = []) {
  const max = trend.reduce(
    (m, p) => Math.max(m, Number(p?.newCount) || 0, Number(p?.closedCount) || 0),
    0
  )
  return { max, points: trend }
}

/** 单位排名排序（按 count 降序，可选 TopN） */
export function sortUnits(byUnit = [], topN = 0) {
  const arr = [...byUnit].sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
  return topN > 0 ? arr.slice(0, topN) : arr
}
