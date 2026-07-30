'use strict'

/**
 * 钉钉 unionId ↔ Memos 安全员账号映射 / 解析
 * ───────────────────────────────────────────────────────────────────────────
 * 当前为单一固定安全员账号（设计：独立 Memos 账号，多用户模型）。
 * 未来多安全员时，可按 unionId 扩展为「一个钉钉用户 → 一个 Memos 账号」映射。
 */

const config = require('../config/memos.config')
const memosClient = require('./memosClient')

/**
 * 解析钉钉用户对应的 Memos 安全员账号。
 * 确保该账号在 Memos 中存在（需要 owner PAT 时自动创建）。
 * @param {string} unionId 钉钉用户唯一标识（稳定主键）
 * @param {string} name    钉钉昵称 / 姓名
 * @returns {Promise<{username: string, unionId: string, name: string}>}
 */
async function resolveMemosUser(unionId, name) {
  if (!config.memos.safetyConfigured) {
    throw new Error('安全员账号未配置（MEMOS_SAFETY_USERNAME / MEMOS_SAFETY_PASSWORD）')
  }
  // 确保账号存在（owner PAT 可用时自动创建；否则假定已存在）
  if (config.memos.ownerConfigured) {
    try {
      await memosClient.getOrCreateSafetyOfficer(name)
    } catch (err) {
      // 账号已存在或创建失败都不阻断桥接：登录仍可能成功（账号已手工建好）
      console.warn('[safetyOfficerSync] 确保账号存在时提示：', err.message)
    }
  }
  return { username: config.memos.safetyUsername, unionId, name: name || config.memos.safetyUsername }
}

module.exports = { resolveMemosUser }
