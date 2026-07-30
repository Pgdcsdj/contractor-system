/**
 * 钉钉自定义群机器人 - 消息发送服务（Tier 0，无需管理员审批）
 *
 * 设计依据：隐患闭环系统方案 v2.1 §13 / §13.10（两步走，零依赖先上线）
 *
 * 钉钉机器人三种安全设置，本模块全部兼容（支持同时开启多项）：
 *   - 加签（sign）      ：配置 DINGTALK_ROBOT_SECRET，URL 追加 timestamp+sign
 *   - 自定义关键词（keyword）：配置 DINGTALK_ROBOT_KEYWORD，消息正文自动补关键词
 *   - IP 白名单（ip）   ：两者皆不配，要求服务端出口 IP 已加入机器人白名单
 *
 * 注意：钉钉允许同时开启"加签"+"关键词"，本模块已适配双模式并行。
 *
 * 能力：
 *   - 文本 / markdown 消息
 *   - @指定人（按手机号 atMobiles）或 @所有人（isAtAll）
 *
 * 环境变量：
 *   DINGTALK_ROBOT_WEBHOOK   机器人 webhook 地址（含 access_token 参数）
 *   DINGTALK_ROBOT_SECRET    加签密钥（安全设置选"加签"时填写；其余模式留空）
 *   DINGTALK_ROBOT_KEYWORD   自定义关键词（安全设置选"关键词"时填写；其余模式留空）
 *   DINGTALK_ROBOT_ENABLED   'true' 开启发送；'false' 关闭（关闭时发送被跳过，便于本地调试）
 *
 * 零新依赖：仅使用 Node 内置 crypto / https / url。
 */

const crypto = require('crypto')
const https  = require('https')
const url    = require('url')

const WEBHOOK  = process.env.DINGTALK_ROBOT_WEBHOOK || ''
const SECRET   = process.env.DINGTALK_ROBOT_SECRET  || ''
const KEYWORD  = process.env.DINGTALK_ROBOT_KEYWORD || ''
const ENABLED  = (process.env.DINGTALK_ROBOT_ENABLED || 'false') === 'true'

// 各安全特性独立开关（非互斥）
const USE_SIGN    = !!SECRET
const USE_KEYWORD = !!KEYWORD
const USE_IP      = !USE_SIGN && !USE_KEYWORD

/**
 * 计算钉钉加签
 * 规则：sign = base64( HMAC-SHA256( `${timestamp}\n${secret}`, secret ) )
 * @param {number} timestamp 毫秒时间戳
 * @returns {string}
 */
function sign(timestamp) {
  const stringToSign = `${timestamp}\n${SECRET}`
  return crypto.createHmac('sha256', SECRET).update(stringToSign).digest('base64')
}

/**
 * 发起 HTTPS POST（JSON），解析钉钉返回
 * 钉钉成功判定：HTTP 200 且响应体 errcode === 0
 */
function httpsPostJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const u = new url.URL(targetUrl)
    const data = JSON.stringify(payload)
    const req = https.request(
      {
        hostname: u.hostname,
        port:     u.port || 443,
        path:     u.pathname + u.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (resp) => {
        let body = ''
        resp.on('data', (c) => (body += c))
        resp.on('end', () => {
          try {
            const json = body ? JSON.parse(body) : {}
            if (json.errcode === 0) return resolve(json)
            return reject(new Error(`钉钉返回错误 errcode=${json.errcode} errmsg=${json.errmsg}`))
          } catch {
            reject(new Error('钉钉响应解析失败: ' + body.slice(0, 200)))
          }
        })
      }
    )
    req.on('error', (e) => reject(e))
    req.setTimeout(5000, () => req.destroy(new Error('钉钉请求超时（5s）')))
    req.write(data)
    req.end()
  })
}

/**
 * 发送群机器人消息（核心函数）
 *
 * @param {Object}   opts
 * @param {string}   opts.content     消息正文（text 用纯文本；markdown 支持语法）
 * @param {string[]} [opts.atMobiles] 需要 @ 的手机号列表（Tier 0 主要用这个）
 * @param {string[]} [opts.atUserIds] 需要 @ 的钉钉 userId 列表（Tier 1 用）
 * @param {boolean}  [opts.isAtAll]   是否 @ 所有人
 * @param {string}   [opts.msgtype]   'text'（默认）| 'markdown'
 * @param {string}   [opts.title]     markdown 时的标题
 * @param {number}   [opts.retry]     失败重试次数（默认 1）
 * @returns {Promise<{ok:boolean, skipped?:boolean, errmsg?:string}>}
 */
async function sendGroupRobot(opts = {}) {
  if (!ENABLED) {
    console.log('[dingtalk] 机器人未启用（DINGTALK_ROBOT_ENABLED !== true），跳过发送')
    return { ok: true, skipped: true }
  }
  if (!WEBHOOK) {
    throw new Error('未配置 DINGTALK_ROBOT_WEBHOOK')
  }
  if (USE_IP) {
    console.warn('[dingtalk] 当前为纯 IP 白名单模式（未配 SECRET/KEYWORD），请确保服务端出口 IP 已加入机器人白名单，否则会被拒。')
  }

  const {
    content,
    atMobiles = [],
    atUserIds = [],
    isAtAll   = false,
    msgtype   = 'text',
    title     = '隐患闭环通知',
    retry     = 1,
  } = opts

  // ── 关键词注入（独立于加签）：当 USE_KEYWORD=true 且正文不含关键词时自动追加 ──
  let finalContent = content
  if (USE_KEYWORD && KEYWORD && !content.includes(KEYWORD)) {
    finalContent = `${content}\n${KEYWORD}`
  }

  // ── 加签（独立于关键词）：当 USE_SIGN=true 时在 URL 追加 timestamp + sign ──
  let target = WEBHOOK
  if (USE_SIGN) {
    const timestamp = Date.now()
    const sep = WEBHOOK.includes('?') ? '&' : '?'
    target += `${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign(timestamp))}`
  }

  const at = { atMobiles, atUserIds, isAtAll }
  const payload =
    msgtype === 'markdown'
      ? { msgtype: 'markdown', markdown: { title, text: finalContent }, at }
      : { msgtype: 'text', text: { content: finalContent }, at }

  let lastErr
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await httpsPostJson(target, payload)
      return { ok: true, ...res }
    } catch (e) {
      lastErr = e
      if (i < retry) await new Promise((r) => setTimeout(r, 1500)) // 退避 1.5s
    }
  }
  throw lastErr
}

module.exports = { sendGroupRobot, sign, USE_SIGN, USE_KEYWORD, USE_IP }
