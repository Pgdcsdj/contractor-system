'use strict'

/**
 * 个人工作日志（Memos）集中配置
 * ───────────────────────────────────────────────────────────────────────────
 * 所有密钥 / 域名 / 账号均来自环境变量，严禁硬编码。
 * 变量集中在 /root/.env（bind-mount 进后端容器 /app/.env），
 * 模板见 deploy/.env.example。
 *
 * 关键约定（来自系统架构设计）：
 *  - Memos 内部调用地址固定 http://127.0.0.1:5230（宿主 localhost，绝不暴露公网）
 *  - 浏览器访问地址为子域 https://log.choiceeffect.store
 *  - 跨子域共享 cookie 的父域为 .choiceeffect.store
 */

/** 读取环境变量并兜底为空串，避免 undefined 参与字符串拼接。 */
function str(v, fallback = '') {
  if (v === undefined || v === null) return fallback
  return String(v)
}

const config = {
  // ── 钉钉 OAuth2（授权码模式）──
  dingtalk: {
    clientId: str(process.env.DINGTALK_CLIENT_ID),
    clientSecret: str(process.env.DINGTALK_CLIENT_SECRET),
    redirectUri: str(process.env.DINGTALK_REDIRECT_URI),
  },

  // ── Memos 实例 ──
  memos: {
    // 后端 → Memos 的内部地址（宿主 localhost，仅本机）
    baseUrl: str(process.env.MEMOS_BASE_URL, 'http://127.0.0.1:5230'),
    // 浏览器访问 Memos 的公网地址（子域）
    publicUrl: str(process.env.MEMOS_PUBLIC_URL, 'https://log.choiceeffect.store'),
    // owner 服务账号长期 PAT：用于创建安全员账号 / 查询
    ownerPat: str(process.env.MEMOS_OWNER_PAT),
    // 安全员独立账号（写联动日志、钉钉桥接登录）
    safetyUsername: str(process.env.MEMOS_SAFETY_USERNAME),
    safetyPassword: str(process.env.MEMOS_SAFETY_PASSWORD),
    // 安全员账号 PAT：用于以 Bearer 写入联动日志
    safetyPat: str(process.env.MEMOS_SAFETY_PAT),
  },

  // 跨子域共享 cookie 的父域（含子域）
  cookieDomain: str(process.env.COOKIE_DOMAIN, '.choiceeffect.store'),

  // 主站（根域）地址，用于回跳链接
  appBaseUrl: str(process.env.APP_BASE_URL, 'https://choiceeffect.store'),

  // 隐患详情回跳链接模板，{id} 会被替换为隐患 id
  hazardLinkTemplate: str(
    process.env.HAZARD_LINK_TEMPLATE,
    'https://choiceeffect.store/tnb/admin/hazards/{id}'
  ),
}

// ── 派生「是否配置完成」标志，供优雅降级判断 ──
config.dingtalk.configured =
  Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret && config.dingtalk.redirectUri)
config.memos.ownerConfigured = Boolean(config.memos.ownerPat)
config.memos.safetyConfigured = Boolean(config.memos.safetyUsername && config.memos.safetyPassword)
config.memos.safetyPatConfigured = Boolean(config.memos.safetyPat)

module.exports = config
