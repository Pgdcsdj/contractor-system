/**
 * 培训档案服务（一期一档 / 一人一档）
 *
 * 制度依据：
 *   · 《中原油田安全生产教育和培训管理细则》中原油勘制〔2024〕39号
 *     3.10.1 教学档案「一期一档」；3.10.2 员工档案「一人一档」；3.9.1 8 学时以上须考核
 *   · 《中国石化安全生产教育和培训管理办法》中国石化制〔2024〕24号
 *     3.3.4.3 基层员工在岗培训 ≥20 学时/年，班组长 ≥24 学时/年
 *
 * 口径约定：
 *   · 学时由管理员在培训场次里人工录入，个人学时 = 所属场次学时之和。
 *     绝不用答题耗时折算学时（不严谨，且检查时无法自证）。
 *   · 参训认定：该场次关联试卷下存在 mode='exam' 的答题记录。练习/学习记录不计。
 *   · 培训日期一律取 t_training_session.session_date，不取 t_record.submitted_at。
 */

const { pool } = require('../db/db')
const { deleteFile } = require('./cosUpload')

// 培训看板/档案统一只统计「主管单位 = 通南巴项目部」的人员（与 record.js 同口径）
const SCOPE_SUPERVISING_UNIT = '通南巴项目部'

// 岗位学时标准（中国石化制〔2024〕24号 3.3.4.3）
const HOURS_STANDARD = { default: 20, teamLeader: 24 }

// 附件清单键位（对应 39号 3.3 培训方案 + 3.10 档案要求）
const CHECKLIST_KEYS = [
  ['notice', '培训通知'],
  ['plan', '培训方案'],
  ['sign', '签到表'],
  ['ppt', '课件/教材'],
  ['paper', '试卷'],
  ['score', '成绩表'],
  ['eval', '效果评估表'],
]

const TRAIN_MODES = ['集中授课', '现场实操', '视频学习', '会议宣贯', '网络自学', '符合培训']
const ASSESSMENT_TYPES = ['闭卷考试', '实操考核', '问答', '无考核', '抄写制度']
const STATUS_LIST = ['planned', 'done', 'archived']

/** 某岗位的年度学时标准：班组长 24，其余 20 */
function hoursStandardOf(position) {
  return /班组长|班长|组长/.test(String(position || '')) ? HOURS_STANDARD.teamLeader : HOURS_STANDARD.default
}


/**
 * DATE 字段统一输出为 YYYY-MM-DD 字符串。
 * mysql2 默认把 DATE 解析成 Date 对象，JSON 序列化后会变成 UTC ISO 串
 * （2026-11-21 会显示成 2026-11-20T16:00:00.000Z），前端稍不注意就错一天。
 * 容器 TZ=Asia/Shanghai，这里按本地时区取值。
 */
function toDateStr(v) {
  if (!v) return ''
  if (typeof v === 'string') return v.slice(0, 10)
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 计算一组试卷的目标人群并集人数（应参人数） */
async function expectedCountByMaterials(materialIds) {
  const ids = (materialIds || []).map(Number).filter(Boolean)
  if (!ids.length) return 0
  const ph = ids.map(() => '?').join(',')
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT u.id) AS cnt
       FROM t_user u
       JOIN t_material m ON m.id IN (${ph})
      WHERE u.status = 1 AND u.supervising_unit = ?
        AND (
          m.target_type = 'all'
          OR (m.target_type = 'unit'     AND JSON_CONTAINS(m.target_value, JSON_QUOTE(u.unit)))
          OR (m.target_type = 'position' AND JSON_CONTAINS(m.target_value, JSON_QUOTE(u.position)))
          OR (m.target_type = 'specific' AND JSON_CONTAINS(m.target_value, CAST(u.id AS JSON)))
        )`,
    [...ids, SCOPE_SUPERVISING_UNIT]
  )
  return Number(row?.cnt || 0)
}

/** 取场次关联的试卷 id 列表 */
async function materialIdsOf(sessionId) {
  const [rows] = await pool.query(
    'SELECT material_id FROM t_training_session_material WHERE session_id = ? ORDER BY material_id',
    [sessionId]
  )
  return rows.map((r) => r.material_id)
}

/** 场次列表 */
async function listSessions({ year, month, categoryId, status, keyword, page = 1, pageSize = 20 } = {}) {
  const safeSize = Math.min(200, Math.max(1, Number(pageSize) || 20))
  const offset = (Math.max(1, Number(page) || 1) - 1) * safeSize
  const where = ['1=1']
  const params = []

  if (year) {
    where.push('YEAR(s.session_date) = ?')
    params.push(Number(year))
  }
  if (month) {
    where.push('MONTH(s.session_date) = ?')
    params.push(Number(month))
  }
  if (categoryId) {
    where.push('s.category_id = ?')
    params.push(Number(categoryId))
  }
  if (status && STATUS_LIST.includes(String(status))) {
    where.push('s.status = ?')
    params.push(String(status))
  }
  if (keyword) {
    where.push('(s.title LIKE ? OR s.lecturer LIKE ? OR s.location LIKE ?)')
    const kw = `%${keyword}%`
    params.push(kw, kw, kw)
  }

  const [rows] = await pool.query(
    `SELECT s.*, c.name AS category_name,
            (SELECT COUNT(*) FROM t_training_session_material sm WHERE sm.session_id = s.id) AS material_cnt,
            (SELECT COUNT(*) FROM t_training_session_attachment a WHERE a.session_id = s.id) AS attachment_cnt,
            (SELECT GROUP_CONCAT(m.title ORDER BY m.id SEPARATOR '、')
               FROM t_training_session_material sm JOIN t_material m ON m.id = sm.material_id
              WHERE sm.session_id = s.id) AS material_titles
       FROM t_training_session s
       LEFT JOIN t_material_category c ON c.id = s.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.session_date DESC, s.id DESC
      LIMIT ${safeSize} OFFSET ${offset}`,
    params
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM t_training_session s WHERE ${where.join(' AND ')}`,
    params
  )

  // 补齐应参/实参/合格数
  for (const r of rows) {
    r.session_date = toDateStr(r.session_date)
    const mids = await materialIdsOf(r.id)
    r.material_ids = mids
    r.expected_count = r.expected_count ?? (await expectedCountByMaterials(mids))
    const stat = await sessionStat(r.id, mids)
    r.actual_count = stat.actual
    r.passed_count = stat.passed
    r.avg_rate = stat.avgRate
    r.doc_ready = countReady(r.doc_checklist)
  }
  return { total, list: rows, page: Number(page), pageSize: safeSize }
}

function countReady(checklist) {
  let obj = checklist
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { obj = null }
  }
  if (!obj || typeof obj !== 'object') return 0
  return CHECKLIST_KEYS.filter(([k]) => obj[k]).length
}

/** 单场次统计：实参人数、合格人数、平均得分率 */
async function sessionStat(sessionId, mids) {
  const ids = mids || (await materialIdsOf(sessionId))
  if (!ids.length) return { actual: 0, passed: 0, avgRate: 0 }
  const ph = ids.map(() => '?').join(',')
  const [[row]] = await pool.query(
    `SELECT COUNT(DISTINCT r.user_id) AS actual,
            COUNT(DISTINCT CASE WHEN r.max_score > 0
                  AND ROUND(r.score / r.max_score * 100) >= m.pass_score THEN r.user_id END) AS passed,
            ROUND(AVG(CASE WHEN r.max_score > 0 THEN r.score / r.max_score * 100 END), 1) AS avgRate
       FROM t_record r
       JOIN t_user     u ON u.id = r.user_id
       JOIN t_material m ON m.id = r.material_id
      WHERE r.material_id IN (${ph}) AND r.mode = 'exam'`,
    ids
  )
  return {
    actual: Number(row?.actual || 0),
    passed: Number(row?.passed || 0),
    avgRate: row?.avgRate === null || row?.avgRate === undefined ? 0 : Number(row.avgRate),
  }
}

/** 场次详情（含关联试卷） */
async function getSession(id) {
  const [[s]] = await pool.query(
    `SELECT s.*, c.name AS category_name
       FROM t_training_session s LEFT JOIN t_material_category c ON c.id = s.category_id
      WHERE s.id = ?`,
    [id]
  )
  if (!s) return null
  const [mats] = await pool.query(
    `SELECT m.id, m.title, m.question_cnt, m.pass_score, m.time_limit, m.target_type, m.target_value
       FROM t_training_session_material sm JOIN t_material m ON m.id = sm.material_id
      WHERE sm.session_id = ? ORDER BY m.id`,
    [id]
  )
  const [atts] = await pool.query(
    `SELECT id, session_id, category, original_name, cos_key, cos_url, file_ext, file_size,
            uploaded_by, uploaded_by_name, uploaded_at
       FROM t_training_session_attachment WHERE session_id = ? ORDER BY id`,
    [id]
  )
  s.session_date = toDateStr(s.session_date)
  s.materials = mats
  s.material_ids = mats.map((m) => m.id)
  s.attachments = atts
  s.expected_count = s.expected_count ?? (await expectedCountByMaterials(s.material_ids))
  const stat = await sessionStat(id, s.material_ids)
  Object.assign(s, { actual_count: stat.actual, passed_count: stat.passed, avg_rate: stat.avgRate })
  return s
}

function normalizeChecklist(raw) {
  let obj = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { obj = {} }
  }
  const out = {}
  for (const [k] of CHECKLIST_KEYS) out[k] = obj && obj[k] ? 1 : 0
  return out
}

/** 新建场次 */
async function createSession(data, adminId) {
  const {
    title, categoryId, sessionDate, timeRange, location, lecturer, lecturerUnit,
    hours, trainMode, organizer, targetDesc, expectedCount, assessmentType, remark, materialIds,
  } = data
  const [res] = await pool.query(
    `INSERT INTO t_training_session
       (title, category_id, session_date, time_range, location, lecturer, lecturer_unit,
        hours, train_mode, organizer, target_desc, expected_count, assessment_type, doc_checklist, status, remark, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(title || '').trim(), categoryId || null, sessionDate,
      String(timeRange || ''), String(location || ''), String(lecturer || ''), String(lecturerUnit || ''),
      Number(hours) || 0, String(trainMode || ''), String(organizer || ''), String(targetDesc || ''),
      expectedCount === '' || expectedCount === undefined || expectedCount === null ? null : Number(expectedCount),
      String(assessmentType || ''),
      JSON.stringify(normalizeChecklist(data.docChecklist)),
      STATUS_LIST.includes(String(data.status)) ? String(data.status) : 'planned',
      String(remark || ''), adminId || null,
    ]
  )
  const id = res.insertId
  await replaceMaterials(id, materialIds)
  return id
}

/** 编辑场次 */
async function updateSession(id, data) {
  const fields = []
  const params = []
  const map = {
    title: 'title', category_id: 'categoryId', session_date: 'sessionDate', time_range: 'timeRange',
    location: 'location', lecturer: 'lecturer', lecturer_unit: 'lecturerUnit', hours: 'hours',
    train_mode: 'trainMode', organizer: 'organizer', target_desc: 'targetDesc',
    expected_count: 'expectedCount', assessment_type: 'assessmentType', status: 'status', remark: 'remark',
  }
  for (const [col, key] of Object.entries(map)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = ?`)
      let v = data[key]
      if (col === 'expected_count') v = (v === '' || v === null || v === undefined) ? null : Number(v)
      if (col === 'hours') v = Number(v) || 0
      if (col === 'category_id') v = v || null
      params.push(v)
    }
  }
  if (data.docChecklist !== undefined) {
    fields.push('doc_checklist = ?')
    params.push(JSON.stringify(normalizeChecklist(data.docChecklist)))
  }
  if (fields.length) {
    params.push(id)
    await pool.query(`UPDATE t_training_session SET ${fields.join(', ')} WHERE id = ?`, params)
  }
  if (data.materialIds !== undefined) await replaceMaterials(id, data.materialIds)
  return true
}

async function replaceMaterials(sessionId, materialIds) {
  const ids = (materialIds || []).map(Number).filter(Boolean)
  await pool.query('DELETE FROM t_training_session_material WHERE session_id = ?', [sessionId])
  if (!ids.length) return
  const values = ids.map(() => '(?,?)').join(',')
  const flat = []
  ids.forEach((mid) => flat.push(sessionId, mid))
  await pool.query(`INSERT IGNORE INTO t_training_session_material (session_id, material_id) VALUES ${values}`, flat)
}

/** 删除场次（有考试记录的场次禁止删除，防止档案断链） */
async function deleteSession(id) {
  const mids = await materialIdsOf(id)
  if (mids.length) {
    const ph = mids.map(() => '?').join(',')
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM t_record WHERE material_id IN (${ph}) AND mode = 'exam'`,
      mids
    )
    if (Number(cnt) > 0) {
      const err = new Error('该场次已产生考试记录，不能删除。如确需作废，请把状态改为「已归档」')
      err.code = 'HAS_RECORDS'
      throw err
    }
  }
  const [atts] = await pool.query('SELECT cos_key FROM t_training_session_attachment WHERE session_id = ?', [id])
  for (const a of atts) {
    if (!a.cos_key) continue
    try { await deleteFile(a.cos_key) } catch (e) { console.error('[training-archive] 删除COS附件失败:', e.message) }
  }
  await pool.query('DELETE FROM t_training_session_attachment WHERE session_id = ?', [id])
  await pool.query('DELETE FROM t_training_session_material WHERE session_id = ?', [id])
  await pool.query('DELETE FROM t_training_session WHERE id = ?', [id])
  return true
}

/**
 * 参训名单：应参（按试卷目标人群）∪ 实参（有 exam 记录）
 * 返回每人的出席状态、首次交卷时间、成绩行
 */
async function getRoster(sessionId) {
  const s = await getSession(sessionId)
  if (!s) return null
  const ids = s.material_ids

  // 应参名单
  let expected = []
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    const [rows] = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.unit, u.position, u.phone
         FROM t_user u
         JOIN t_material m ON m.id IN (${ph})
        WHERE u.status = 1 AND u.supervising_unit = ?
          AND (
            m.target_type = 'all'
            OR (m.target_type = 'unit'     AND JSON_CONTAINS(m.target_value, JSON_QUOTE(u.unit)))
            OR (m.target_type = 'position' AND JSON_CONTAINS(m.target_value, JSON_QUOTE(u.position)))
            OR (m.target_type = 'specific' AND JSON_CONTAINS(m.target_value, CAST(u.id AS JSON)))
          )
        ORDER BY u.unit, u.name`,
      [...ids, SCOPE_SUPERVISING_UNIT]
    )
    expected = rows
  }

  // 实参：该场次试卷下的考试记录
  let records = []
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    const [rows] = await pool.query(
      `SELECT r.id, r.user_id, r.material_id, r.score, r.max_score, r.duration_sec,
              r.submitted_at, r.is_offline, r.answers,
              u.name, u.unit, u.position, u.phone,
              m.title AS material_title, m.pass_score,
              CASE WHEN r.max_score > 0
                   THEN ROUND(r.score / r.max_score * 100) >= m.pass_score ELSE 0 END AS passed
         FROM t_record r
         JOIN t_user     u ON u.id = r.user_id
         JOIN t_material m ON m.id = r.material_id
        WHERE r.material_id IN (${ph}) AND r.mode = 'exam'
        ORDER BY u.unit, u.name, r.submitted_at`,
      ids
    )
    records = rows
  }

  // 合并：以 userId 为键
  const map = new Map()
  for (const e of expected) {
    map.set(e.id, { ...e, userId: e.id, attended: false, firstSubmit: null, records: [] })
  }
  for (const r of records) {
    let p = map.get(r.user_id)
    if (!p) {
      p = {
        userId: r.user_id, id: r.user_id, name: r.name, unit: r.unit, position: r.position,
        phone: r.phone, attended: false, firstSubmit: null, records: [],
      }
      map.set(r.user_id, p)
    }
    p.attended = true
    p.records.push(r)
    const t = new Date(r.submitted_at).getTime()
    if (!p.firstSubmit || t < new Date(p.firstSubmit).getTime()) p.firstSubmit = r.submitted_at
  }

  const list = [...map.values()]
  return {
    session: s,
    list,
    summary: {
      expected: expected.length || (s.expected_count || 0),
      actual: list.filter((x) => x.attended).length,
      absent: list.filter((x) => !x.attended).length,
    },
  }
}

/** 成绩明细（一人多卷展开为多行） */
async function getScores(sessionId) {
  const s = await getSession(sessionId)
  if (!s) return null
  const ids = s.material_ids
  if (!ids.length) return { session: s, list: [], summary: { rows: 0, passed: 0, avgRate: 0 } }
  const ph = ids.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT r.id AS record_id, u.name, u.unit, u.position, u.id_card,
            m.title AS material_title, r.score, r.max_score, r.duration_sec, r.submitted_at,
            r.is_offline, r.hash,
            CASE WHEN r.max_score > 0 THEN ROUND(r.score / r.max_score * 100) ELSE 0 END AS rate,
            CASE WHEN r.max_score > 0
                 THEN ROUND(r.score / r.max_score * 100) >= m.pass_score ELSE 0 END AS passed,
            m.pass_score
       FROM t_record r
       JOIN t_user     u ON u.id = r.user_id
       JOIN t_material m ON m.id = r.material_id
      WHERE r.material_id IN (${ph}) AND r.mode = 'exam'
      ORDER BY u.unit, u.name, r.submitted_at`,
    ids
  )
  const passed = rows.filter((r) => r.passed).length
  const avgRate = rows.length ? Math.round(rows.reduce((a, r) => a + Number(r.rate || 0), 0) / rows.length * 10) / 10 : 0
  return { session: s, list: rows, summary: { rows: rows.length, passed, avgRate } }
}

/** 年度学时统计（按人）
 *  一场培训可能挂多张卷，学时按「人 × 场次」去重后再累加，否则多卷会重复计学时。
 */
async function annualStats({ year, unit } = {}) {
  const y = Number(year) || new Date().getFullYear()
  const params = [y, SCOPE_SUPERVISING_UNIT]
  let unitCond = ''
  if (unit) {
    unitCond = ' AND u.unit = ?'
    params.push(String(unit))
  }
  const [rows] = await pool.query(
    `SELECT u.id AS user_id, u.name, u.unit, u.position,
            IFNULL(agg.session_cnt, 0) AS session_cnt,
            IFNULL(agg.total_hours, 0) AS total_hours
       FROM t_user u
       LEFT JOIN (
         SELECT t.user_id, COUNT(*) AS session_cnt, SUM(t.hours) AS total_hours
           FROM (
             SELECT DISTINCT r.user_id, s.id AS sid, s.hours
               FROM t_record r
               JOIN t_training_session_material sm ON sm.material_id = r.material_id
               JOIN t_training_session s ON s.id = sm.session_id
              WHERE r.mode = 'exam' AND YEAR(s.session_date) = ?
           ) t
          GROUP BY t.user_id
       ) agg ON agg.user_id = u.id
      WHERE u.status = 1 AND u.supervising_unit = ?${unitCond}
      ORDER BY u.unit, u.name`,
    params
  )
  return rows.map((r) => {
    const std = hoursStandardOf(r.position)
    const got = Number(r.total_hours || 0)
    return {
      ...r,
      total_hours: got,
      standard: std,
      gap: Math.max(0, Math.round((std - got) * 10) / 10),
      qualified: got >= std,
    }
  })
}

/** 一人一档：个人培训履历（含学时累计） */
async function personArchive(userId, year) {
  const [[u]] = await pool.query(
    `SELECT id, name, unit, position, phone, id_card, supervising_unit, created_at
       FROM t_user WHERE id = ?`,
    [userId]
  )
  if (!u) return null
  const params = [userId]
  let yearCond = ''
  if (year) {
    yearCond = ' AND YEAR(s.session_date) = ?'
    params.push(Number(year))
  }
  const [rows] = await pool.query(
    `SELECT r.id AS record_id, r.score, r.max_score, r.duration_sec, r.submitted_at, r.hash,
            m.title AS material_title, m.pass_score,
            CASE WHEN r.max_score > 0
                 THEN ROUND(r.score / r.max_score * 100) >= m.pass_score ELSE 0 END AS passed,
            s.id AS session_id, s.title AS session_title, s.session_date, s.hours,
            s.location, s.lecturer, s.assessment_type, c.name AS category_name
       FROM t_record r
       JOIN t_material m ON m.id = r.material_id
       LEFT JOIN t_training_session_material sm ON sm.material_id = r.material_id
       LEFT JOIN t_training_session s ON s.id = sm.session_id
       LEFT JOIN t_material_category c ON c.id = s.category_id
      WHERE r.user_id = ? AND r.mode = 'exam'${yearCond}
      ORDER BY s.session_date DESC, r.submitted_at DESC`,
    params
  )
  // 同一场次可能挂多张卷，学时按场次去重累计
  const sessionHours = new Map()
  for (const r of rows) {
    if (r.session_id) sessionHours.set(r.session_id, Number(r.hours || 0))
  }
  const totalHours = [...sessionHours.values()].reduce((a, h) => a + h, 0)
  const std = hoursStandardOf(u.position)
  return {
    user: u,
    records: rows,
    summary: {
      sessions: sessionHours.size,
      totalHours,
      standard: std,
      gap: Math.max(0, Math.round((std - totalHours) * 10) / 10),
      qualified: totalHours >= std,
      passed: rows.filter((r) => r.passed).length,
      total: rows.length,
    },
  }
}

/** 培训台账（全年一览） */
async function ledger(year) {
  const y = Number(year) || new Date().getFullYear()
  const [rows] = await pool.query(
    `SELECT s.id, s.title, s.session_date, s.hours, s.location, s.lecturer,
            s.train_mode, s.assessment_type, s.status, s.doc_checklist,
            c.name AS category_name,
            (SELECT COUNT(*) FROM t_training_session_material sm WHERE sm.session_id = s.id) AS material_cnt
       FROM t_training_session s
       LEFT JOIN t_material_category c ON c.id = s.category_id
      WHERE YEAR(s.session_date) = ?
      ORDER BY s.session_date, s.id`,
    [y]
  )
  for (const r of rows) {
    r.session_date = toDateStr(r.session_date)
    const mids = await materialIdsOf(r.id)
    const st = await sessionStat(r.id, mids)
    r.material_ids = mids
    r.expected_count = await expectedCountByMaterials(mids)
    r.actual_count = st.actual
    r.passed_count = st.passed
    r.avg_rate = st.avgRate
    r.doc_ready = countReady(r.doc_checklist)
    r.doc_total = CHECKLIST_KEYS.length
  }
  const totalHours = rows.reduce((a, r) => a + Number(r.hours || 0), 0)
  return { year: y, list: rows, summary: { sessions: rows.length, totalHours } }
}

/** 场次附件列表 */
async function listAttachments(sessionId) {
  const [rows] = await pool.query(
    `SELECT id, session_id, category, original_name, cos_key, cos_url, file_ext, file_size,
            uploaded_by, uploaded_by_name, uploaded_at
       FROM t_training_session_attachment WHERE session_id = ? ORDER BY id`,
    [sessionId]
  )
  return rows
}

/** 写入附件元数据（COS 上传由路由层完成） */
async function addAttachment({ sessionId, category, originalName, cos, fileExt, fileSize, adminId, adminName }) {
  const [res] = await pool.query(
    `INSERT INTO t_training_session_attachment
       (session_id, category, original_name, cos_key, cos_url, file_ext, file_size, uploaded_by, uploaded_by_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [sessionId, category || 'other', originalName, cos.key, cos.url, fileExt, fileSize, adminId || null, adminName || '']
  )
  return res.insertId
}

/** 同步附件到位勾选：上传自动勾上，删完同类附件自动取消 */
async function syncChecklistFlag(sessionId, category) {
  if (!CHECKLIST_KEYS.some(([k]) => k === category)) return
  const [[row]] = await pool.query('SELECT doc_checklist FROM t_training_session WHERE id = ?', [sessionId])
  let obj = row?.doc_checklist
  if (typeof obj === 'string') { try { obj = JSON.parse(obj) } catch { obj = {} } }
  obj = obj || {}
  const [[{ cnt }]] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM t_training_session_attachment WHERE session_id = ? AND category = ?',
    [sessionId, category]
  )
  obj[category] = Number(cnt) > 0 ? 1 : 0
  await pool.query('UPDATE t_training_session SET doc_checklist = ? WHERE id = ?', [JSON.stringify(obj), sessionId])
}

/** 删除附件：先删 COS 再删元数据，并回写附件清单勾选 */
async function removeAttachment(attachmentId) {
  const [[a]] = await pool.query('SELECT * FROM t_training_session_attachment WHERE id = ?', [attachmentId])
  if (!a) return null
  if (a.cos_key) {
    try { await deleteFile(a.cos_key) } catch (e) { console.error('[training-archive] 删除COS附件失败:', e.message) }
  }
  await pool.query('DELETE FROM t_training_session_attachment WHERE id = ?', [attachmentId])
  await syncChecklistFlag(a.session_id, a.category)
  return a
}

module.exports = {
  SCOPE_SUPERVISING_UNIT,
  CHECKLIST_KEYS,
  TRAIN_MODES,
  ASSESSMENT_TYPES,
  STATUS_LIST,
  listAttachments,
  addAttachment,
  syncChecklistFlag,
  removeAttachment,
  hoursStandardOf,
  expectedCountByMaterials,
  materialIdsOf,
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getRoster,
  getScores,
  annualStats,
  personArchive,
  ledger,
  countReady,
  sessionStat,
}
