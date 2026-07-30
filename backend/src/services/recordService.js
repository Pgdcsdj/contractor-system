/**
 * 答题记录存档服务
 *
 * - 写入答题记录（含 Hash 防篡改签名）
 * - 离线上传批量写入
 * - 查询记录（管理员）
 */

const { pool }                    = require('../db/db')
const { signRecord, verifyRecord } = require('../utils/hashHelper')

/**
 * 提交单次答题记录
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.materialId
 * @param {Array}  params.answers       用户答案快照: [{questionId, answer, isCorrect, score}]
 * @param {number} params.score         实际得分
 * @param {number} params.maxScore      满分
 * @param {number} params.durationSec   答题耗时(秒)
 * @param {boolean} params.isOffline    是否离线延迟上传
 * @param {string} [params.mode]        答题模式 study/practice/exam（默认 exam）
 * @param {number} [params.attemptNo]   第几次作答（默认 1）
 * @returns {object}  插入的记录 { id, hash, submittedAt }
 */
async function saveRecord({ userId, materialId, answers, score, maxScore, durationSec, isOffline = false, mode = 'exam', attemptNo = 1 }) {
  const submittedAt = new Date()
  const hash = signRecord(userId, materialId, score, submittedAt)

  const [result] = await pool.execute(
    `INSERT INTO t_record
       (user_id, material_id, answers, score, max_score, duration_sec, submitted_at, is_offline, hash, mode, attempt_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      materialId,
      JSON.stringify(answers),
      score,
      maxScore,
      durationSec,
      submittedAt,
      isOffline ? 1 : 0,
      hash,
      mode || 'exam',
      Number(attemptNo) || 1,
    ]
  )

  return { id: result.insertId, hash, submittedAt }
}

/**
 * 批量写入离线答题记录（网络恢复后上传）
 * @param {Array} records  多条记录数组
 * @returns {{ success: number, fail: number, errors: Array }}
 */
async function saveOfflineRecords(records) {
  let success = 0
  const errors = []

  for (const rec of records) {
    try {
      await saveRecord({ ...rec, isOffline: true })
      success++
    } catch (err) {
      // 重复提交（uk_user_material）静默忽略
      if (err.code === 'ER_DUP_ENTRY') {
        success++ // 已提交过，视为成功
      } else {
        errors.push({ materialId: rec.materialId, error: err.message })
      }
    }
  }

  return { success, fail: errors.length, errors }
}

/**
 * 查询某用户是否已完成指定题库
 */
async function hasCompleted(userId, materialId) {
  const [[row]] = await pool.execute(
    'SELECT id FROM t_record WHERE user_id = ? AND material_id = ? LIMIT 1',
    [userId, materialId]
  )
  return !!row
}

/**
 * 管理员查询答题记录列表
 */
async function queryRecords({ userId, materialId, unit, dateFrom, dateTo, page = 1, pageSize = 20 }) {
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const safeOffset   = (Math.max(1, Number(page) || 1) - 1) * safePageSize
  let where = 'WHERE 1=1'
  const params = []

  if (userId)     { where += ' AND r.user_id = ?';     params.push(userId) }
  if (materialId) { where += ' AND r.material_id = ?'; params.push(materialId) }
  if (unit)       { where += ' AND u.unit = ?';        params.push(unit) }
  if (dateFrom)   { where += ' AND r.submitted_at >= ?'; params.push(dateFrom) }
  if (dateTo)     { where += ' AND r.submitted_at <= ?'; params.push(dateTo + ' 23:59:59') }

  const sql = `
    SELECT
      r.id, r.score, r.max_score, r.duration_sec, r.submitted_at, r.is_offline, r.mode, r.attempt_no,
      u.name AS user_name, u.unit, u.supervising_unit,
      m.title AS material_title
    FROM t_record r
    JOIN t_user     u ON u.id = r.user_id
    JOIN t_material m ON m.id = r.material_id
    ${where}
    ORDER BY r.submitted_at DESC
    LIMIT ${safePageSize} OFFSET ${safeOffset}
  `

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM t_record r
     JOIN t_user     u ON u.id = r.user_id
     JOIN t_material m ON m.id = r.material_id
     ${where}`,
    params
  )

  const [rows] = await pool.query(sql, params)

  return { total, list: rows, page: Math.max(1, Number(page) || 1), pageSize: safePageSize }
}

module.exports = { saveRecord, saveOfflineRecords, hasCompleted, queryRecords }
