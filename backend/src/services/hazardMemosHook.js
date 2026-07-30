'use strict'

/**
 * 隐患状态机 → 工作日志（Memos）联动 Hook
 * ───────────────────────────────────────────────────────────────────────────
 * 由隐患状态机在每次转移成功后调用（见 routes/hazardLoop.js）：
 *   reported / assigned / rectifying / verifying / closed 五个节点各写一条日志。
 *
 * 设计纪律（务必遵守）：
 *  - 任何失败都「仅告警、不阻断」隐患状态流转；
 *  - 缺失 MEMOS_SAFETY_PAT 时仅 console.warn 跳过，不抛异常；
 *  - 内容含：隐患编号 / 状态 / 责任人 / 时间，附回跳链接；
 *  - 统一打 #隐患 #安全员 标签。
 */

const config = require('../config/memos.config')
const memosClient = require('./memosClient')

const STATUS_LABEL = {
  reported: '已上报',
  assigned: '已分派',
  rectifying: '整改中',
  verifying: '待验收',
  closed: '已闭环',
}

/**
 * 隐患状态变更回调。
 * @param {object} hazard      隐患对象（至少含 id / hazard_code / responsible_person）
 * @param {?string} fromStatus 变更前状态（reported 新建时为 null）
 * @param {string} toStatus    变更后状态
 * @returns {Promise<void>} 永不 reject（失败仅告警）
 */
async function onTransition(hazard, fromStatus, toStatus) {
  // ── 优雅降级：缺 PAT 时跳过写日志，不影响业务 ──
  if (!config.memos.safetyPatConfigured) {
    console.warn('[hazard->memos] 跳过写日志：MEMOS_SAFETY_PAT 未配置')
    return
  }
  try {
    const h = hazard || {}
    const code = h.hazard_code || `#${h.id != null ? h.id : '?'}`
    const toLabel = STATUS_LABEL[toStatus] || toStatus
    const fromLabel = fromStatus ? STATUS_LABEL[fromStatus] || fromStatus : '新建'
    const owner = h.responsible_person || h.assigned_to || '未指定'
    const time = new Date().toISOString()
    const link = (config.hazardLinkTemplate || '').replace('{id}', String(h.id != null ? h.id : ''))

    const lines = [
      `### 隐患状态更新 · ${toLabel}`,
      '',
      `- 隐患编号：${code}`,
      `- 状态：${fromLabel} → ${toLabel}`,
      `- 责任人：${owner}`,
      `- 时间：${time}`,
    ]
    if (link) lines.push(`- 详情：${link}`)
    lines.push('', '#隐患 #安全员')

    const content = lines.join('\n')
    await memosClient.createMemoAsSafety(content, 'PRIVATE', ['隐患', '安全员'])
    console.log(`[hazard->memos] 已写日志：${code} ${fromLabel}→${toLabel}`)
  } catch (err) {
    // 绝不影响隐患状态流转
    console.error('[hazard->memos] 写日志失败（已忽略）：', err.message)
  }
}

module.exports = { onTransition }
