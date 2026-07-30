/**
 * 隐患状态 / 等级 → 中文标签 & badge 颜色映射（Sprint 2 / 共享约定）
 *
 * badge 颜色与后端状态机一致：
 *   reported=info / assigned&rectifying=warning / verifying=info / closed=success
 *   重大隐患=danger / 较大隐患=warning / 一般隐患=info
 */

export const HAZARD_STATUS_LABEL = {
  reported: '已上报',
  assigned: '已分派',
  rectifying: '整改中',
  verifying: '待验收',
  closed: '已闭环',
}

export const HAZARD_STATUS_BADGE = {
  reported: 'badge-info',
  assigned: 'badge-warning',
  rectifying: 'badge-warning',
  verifying: 'badge-info',
  closed: 'badge-success',
}

export const HAZARD_LEVEL_BADGE = {
  '重大隐患': 'badge-danger',
  '较大隐患': 'badge-warning',
  '一般隐患': 'badge-info',
}

/** 状态 → 中文 */
export function statusLabel(s) {
  return HAZARD_STATUS_LABEL[s] || s || '-'
}

/** 状态 → badge class */
export function statusBadge(s) {
  return HAZARD_STATUS_BADGE[s] || 'badge-neutral'
}

/** 等级 → badge class */
export function levelBadge(l) {
  return HAZARD_LEVEL_BADGE[l] || 'badge-neutral'
}

/** 等级 → 中文（透传） */
export function levelLabel(l) {
  return l || '-'
}
