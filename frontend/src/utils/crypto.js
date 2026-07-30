/**
 * crypto.js - 答题记录 SHA-256 签名
 * 防止本地答案被篡改
 */
import CryptoJS from 'crypto-js'

const SECRET = import.meta.env.VITE_HASH_SECRET || 'tnb-training-secret-v1'

/**
 * 对答题数据生成 SHA-256 签名
 * @param {Object} answers - { questionId: answer }
 * @param {string} submitTime - ISO 时间字符串
 * @returns {string} 64位 hex 签名
 */
export function hashAnswers(answers, submitTime) {
  // 稳定序列化：按 questionId 排序
  const ordered = Object.keys(answers)
    .sort()
    .reduce((acc, key) => {
      acc[key] = answers[key]
      return acc
    }, {})

  const payload = JSON.stringify({ answers: ordered, submitTime, secret: SECRET })
  return CryptoJS.SHA256(payload).toString()
}

/**
 * 验证签名（前端仅作展示，后端验签）
 * @param {string} signature - 待验证签名
 * @param {Object} answers - 原始答案
 * @param {string} submitTime - 提交时间
 * @returns {boolean}
 */
export function verifyHash(signature, answers, submitTime) {
  const computed = hashAnswers(answers, submitTime)
  return computed === signature
}
