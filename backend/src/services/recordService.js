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
 * 支持筛选：userId / materialId / unit / dateFrom / dateTo / keyword(姓名或手机) / passed(0|1)
 */
async function queryRecords({ userId, materialId, unit, dateFrom, dateTo, keyword, passed, page = 1, pageSize = 20 }) {
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const safeOffset   = (Math.max(1, Number(page) || 1) - 1) * safePageSize
  let where = 'WHERE 1=1'
  const params = []

  if (userId)     { where += ' AND r.user_id = ?';          params.push(userId) }
  if (materialId) { where += ' AND r.material_id = ?';      params.push(materialId) }
  if (unit)       { where += ' AND u.unit = ?';             params.push(unit) }
  if (dateFrom)   { where += ' AND r.submitted_at >= ?';    params.push(dateFrom) }
  if (dateTo)     { where += ' AND r.submitted_at <= ?';    params.push(dateTo + ' 23:59:59') }
  if (keyword) {
    where += ' AND (u.name LIKE ? OR u.phone LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  // 及格判定必须用百分比口径（与 submit 一致），不能用 score>=pass_score（不完整提交 max_score 会偏小）
  if (passed === '1' || passed === 1) {
    where += ' AND r.max_score > 0 AND ROUND(r.score / r.max_score * 100) >= m.pass_score'
  } else if (passed === '0' || passed === 0) {
    where += ' AND (r.max_score = 0 OR ROUND(r.score / r.max_score * 100) < m.pass_score)'
  }

  const sql = `
    SELECT
      r.id, r.score, r.max_score, r.duration_sec, r.submitted_at, r.is_offline, r.mode, r.attempt_no,
      r.hash, r.essay_graded, r.graded_at,
      u.name AS user_name, u.unit, u.supervising_unit,
      m.title AS material_title, m.pass_score,
      CASE WHEN r.max_score > 0
        THEN ROUND(r.score / r.max_score * 100) >= m.pass_score
        ELSE 0 END AS passed,
      EXISTS(
        SELECT 1 FROM t_question q
        WHERE q.material_id = r.material_id AND q.type = 'essay' AND q.status = 1
      ) AS needs_grading
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

/**
 * 查询单条答题记录（含用户/题库信息），供人工评分详情页使用
 * @param {number} id 记录ID
 * @returns {object|null} 记录行（answers 为 MySQL JSON 解析后的对象/数组，或原样字符串）
 */
async function getRecordById(id) {
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name, u.unit, u.phone, u.supervising_unit,
            m.title AS material_title, m.pass_score, m.ai_grading
     FROM t_record r
     JOIN t_user     u ON u.id = r.user_id
     JOIN t_material m ON m.id = r.material_id
     WHERE r.id = ? LIMIT 1`,
    [id]
  )
  return rows.length ? rows[0] : null
}

/**
 * 保存人工评分结果（essay 打分回写）
 * @param {object} params
 * @param {number} params.recordId     记录ID
 * @param {Array}  params.answers      合并后的完整 answers 数组（含 manualGraded/score 等）
 * @param {number} params.score        重算后的实际得分
 * @param {number} params.maxScore     兜底后的满分（material 全部题分值之和）
 * @param {number} params.essayGraded  0/1 是否已全部人工评完
 * @param {number} params.gradedBy     管理员ID
 * @param {Date}   params.gradedAt     评分时间
 * @param {string} params.hash         重签后的防篡改 hash
 * @returns {boolean} 是否更新成功
 */
async function saveEssayGrades({ recordId, answers, score, maxScore, essayGraded, gradedBy, gradedAt, hash }) {
  const [result] = await pool.execute(
    `UPDATE t_record
        SET answers = ?, score = ?, max_score = ?, essay_graded = ?, graded_by = ?, graded_at = ?, hash = ?
      WHERE id = ?`,
    [
      JSON.stringify(answers),
      score,
      maxScore,
      essayGraded ? 1 : 0,
      gradedBy || null,
      gradedAt || null,
      hash,
      recordId,
    ]
  )
  return result.affectedRows > 0
}

module.exports = { saveRecord, saveOfflineRecords, hasCompleted, queryRecords, getRecordById, saveEssayGrades }
