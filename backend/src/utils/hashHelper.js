/**
 * Hash 签名工具
 * 用途：答题记录防篡改签名（SHA-256）
 *
 * 签名规则：
 *   rawStr = `${userId}:${materialId}:${score}:${submittedAt}:${SECRET}`
 *   hash   = SHA256(rawStr).hex
 */

const crypto = require('crypto')

// 签名私钥，生产环境务必通过环境变量注入
const SECRET = process.env.HASH_SECRET || 'tnb-training-secret-2026'

/**
 * 生成答题记录签名
 * @param {number} userId
 * @param {number} materialId
 * @param {number} score
 * @param {string|Date} submittedAt  ISO 时间字符串或 Date 对象
 * @returns {string} 64位十六进制 hash
 */
function signRecord(userId, materialId, score, submittedAt) {
  const ts = submittedAt instanceof Date
    ? submittedAt.toISOString()
    : String(submittedAt)

  const raw = `${userId}:${materialId}:${score}:${ts}:${SECRET}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * 验证答题记录签名是否合法
 * @returns {boolean}
 */
function verifyRecord(userId, materialId, score, submittedAt, hash) {
  const expected = signRecord(userId, materialId, score, submittedAt)
  // 使用 timingSafeEqual 防止时序攻击
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(hash, 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * 生成二维码 Token（基于身份证号）
 * @param {string} idCard 身份证号
 * @returns {string} 16位短token（用于二维码）
 */
function genQrToken(idCard) {
  const raw = `${idCard}:${SECRET}:qr`
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16)
}

module.exports = { signRecord, verifyRecord, genQrToken }
