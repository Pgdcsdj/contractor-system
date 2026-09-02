/**
 * 题库导入/导出路由（管理员）
 *
 * GET    /api/admin/quiz-import/template     下载导入模板 Excel
 * POST   /api/admin/quiz-import/import       上传 Excel 导入题目
 * GET    /api/admin/quiz-import/export/:id   导出指定题库的题目
 *
 * P0 改造（T02）：
 *  - 导入题目显式写入 status = 1（启用），避免"导入后题目未生效"导致 404。
 *  - 题型仅允许 single/multiple/judgment/essay（含别名 choice/multi/subjective 归一化）；
 *    非法题型列为失败项并说明原因，不整批失败。
 *  - 返回 data.validation：题型覆盖、空答案行、未识别题型行、0 题标记、materialStatusAfter。
 */

const express  = require('express')
const multer   = require('multer')
const XLSX     = require('xlsx')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const token = authHeader.slice(7)
  const payload = verifyAdminToken(token)
  if (!payload) return res.status(401).json({ error: '登录已过期' })
  req.admin = payload
  next()
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// 模板列定义
const TEMPLATE_HEADERS = ['题型', '题目内容', '选项A', '选项B', '选项C', '选项D', '正确答案', '解析', '分值']

// 题型归一化：中文 + 英文别名 -> 规范值（single/multiple/judgment/essay）
const TYPE_MAP = {
  '单选': 'single', '多选': 'multiple', '判断': 'judgment', '简答': 'essay',
  'choice': 'single', 'multi': 'multiple', 'subjective': 'essay',
  'single': 'single', 'multiple': 'multiple', 'judgment': 'judgment', 'essay': 'essay',
}
// 导出反向映射
const TYPE_MAP_REV = { single: '单选', multiple: '多选', judgment: '判断', essay: '简答' }

// 把任意题型字符串归一化为规范值（大小写不敏感）；无法识别返回 null
function normalizeType(raw) {
  if (!raw) return null
  return TYPE_MAP[String(raw).trim().toLowerCase()] || null
}

// ─── GET /api/admin/quiz-import/template ──────────────────────────────────────
router.get('/template', adminAuth, (req, res) => {
  const wb = XLSX.utils.book_new()
  const data = [
    TEMPLATE_HEADERS,
    ['单选', '关于动火作业，以下说法正确的是？', '必须办理动火作业票', '可以直接操作', '不需要监护', '', 'A', '根据安全管理规定...', '5'],
    ['多选', '以下哪些属于安全防护用品？', '安全帽', '安全带', '防护眼镜', '手机', 'ABC', '...', '5'],
    ['判断', '高处作业必须佩戴安全带', '正确', '错误', '', '', '正确', '...', '5'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(data)
  ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 30 }, { wch: 8 }]
  XLSX.utils.book_append_sheet(wb, ws, '题目模板')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  const filename = encodeURIComponent('题库导入模板.xlsx')
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(buf)
})

// ─── POST /api/admin/quiz-import/import ───────────────────────────────────────
router.post('/import', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' })

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })

    if (rows.length < 2) return res.status(400).json({ error: '文件为空或只有表头，请按模板填写题目后重试' })

    // 表头容错：首行首格归一化后含「题型」字样即通过（兼容「题型（必填）」「题目类型」及前后空格/BOM）
    const header0 = String(rows[0]?.[0] ?? '').replace(/^﻿/, '').trim()
    const isHeaderOk = /题型|题目类型|试题类型|类型/.test(header0)
    if (!isHeaderOk) {
      return res.status(400).json({
        error: `模板格式不对：第1行第1列应为「题型」，当前是「${header0 || '（空）'}」。请先点「下载模板」按标准格式填写。`,
      })
    }

    const { material_id, exam_single_num, exam_multiple_num, exam_judgment_num } = req.body
    if (!material_id) return res.status(400).json({ error: '请指定目标题库ID' })

    // 检查题库是否存在
    const [material] = await pool.execute('SELECT id FROM t_material WHERE id = ?', [material_id])
    if (!material.length) return res.status(400).json({ error: '题库不存在' })

    let success = 0
    const failList = []
    // 校验报告累积
    const questionTypes = { single: 0, multiple: 0, judgment: 0, essay: 0, unrecognized: 0 }
    const emptyAnswerRows = []
    const unrecognizedTypeRows = []

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || !row[0]) continue

      const qType = normalizeType(row[0])
      if (!qType) {
        failList.push({ row: i + 1, error: `未知题型: ${row[0]}` })
        unrecognizedTypeRows.push(i + 1)
        questionTypes.unrecognized++
        continue
      }

      const question = String(row[1] || '').trim()
      if (!question) {
        failList.push({ row: i + 1, error: '题目内容为空' })
        questionTypes.unrecognized++
        continue
      }

      let options = null
      if (qType === 'single' || qType === 'multiple') {
        const opts = {}
        const labels = ['A', 'B', 'C', 'D']
        for (let j = 0; j < 4; j++) {
          const val = String(row[2 + j] || '').trim()
          if (val) opts[labels[j]] = val
        }
        if (Object.keys(opts).length >= 2) options = opts
      }

      const answer = String(row[6] || '').trim()
      const analysis = String(row[7] || '').trim()
      const score = Math.min(100, Math.max(1, Number(row[8]) || 5))

      // 空答案（客观题必须有答案；简答允许空参考答案，但记录提示）
      if (qType !== 'essay' && !answer) {
        emptyAnswerRows.push(i + 1)
      }

      try {
        await pool.execute(
          `INSERT INTO t_question
             (material_id, type, question, options, answer, analysis, score, sort_order, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [material_id, qType, question, options ? JSON.stringify(options) : null, answer, analysis, score, 99]
        )
        success++
        questionTypes[qType]++
      } catch (e) {
        failList.push({ row: i + 1, error: e.message })
        questionTypes.unrecognized++
      }
    }

    // 更新题目计数（仅统计启用题目）
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [material_id]
    )
    // 导入完成后置为「待审核」(status=2)，由管理员发布闸门控制可见性
    const MATERIAL_STATUS_AFTER = 2
    // 考试随机抽题配置：导入时由前端指定（0=全抽）
    const examSingle = Math.max(0, Number(exam_single_num) || 0)
    const examMultiple = Math.max(0, Number(exam_multiple_num) || 0)
    const examJudgment = Math.max(0, Number(exam_judgment_num) || 0)
    await pool.execute(
      `UPDATE t_material
       SET question_cnt = ?, status = ?, ai_status = 2,
           exam_single_num = ?, exam_multiple_num = ?, exam_judgment_num = ?
       WHERE id = ?`,
      [cnt, MATERIAL_STATUS_AFTER, examSingle, examMultiple, examJudgment, material_id]
    )

    const fail = failList.length
    const validation = {
      totalRows: Math.max(0, rows.length - 1),
      questionTypes,
      emptyAnswerRows,
      unrecognizedTypeRows,
      zeroQuestion: success === 0,
      materialStatusAfter: MATERIAL_STATUS_AFTER,
    }

    res.json({
      success: true,
      message: `导入完成：成功 ${success} 条 / 失败 ${fail} 条`,
      data: {
        success,
        fail,
        failPreview: failList.slice(0, 10),
        validation,
      },
    })
  } catch (e) {
    res.status(500).json({ error: '导入失败：' + e.message })
  }
})

// ─── POST /api/admin/quiz-import/import-docx ────────────────────────────────
// 直接导入 Word 试卷：试题卷.docx（必填）+ 参考答案.docx（可选）。
// 支持含主观题（简答/案例分析）的试卷，参考答案为整段文本存入 answer（TEXT）。
const uploadDocx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
router.post('/import-docx', adminAuth, uploadDocx.fields([
  { name: 'questions', maxCount: 1 },
  { name: 'answers', maxCount: 1 },
]), async (req, res) => {
  const files = req.files || {}
  const qFile = files.questions && files.questions[0]
  if (!qFile) return res.status(400).json({ error: '请上传试题卷 Word 文件（.docx）' })
  if (!qFile.originalname.toLowerCase().endsWith('.docx')) {
    return res.status(400).json({ error: '试题卷需为 .docx 格式' })
  }
  const aFile = files.answers && files.answers[0]

  const { material_id, exam_single_num, exam_multiple_num, exam_judgment_num } = req.body
  if (!material_id) return res.status(400).json({ error: '请指定目标题库ID' })
  const [material] = await pool.execute('SELECT id FROM t_material WHERE id = ?', [material_id])
  if (!material.length) return res.status(400).json({ error: '题库不存在' })

  try {
    const { parseExamPaper } = require('../services/docxQuizImport')
    const { questions, validation } = parseExamPaper(qFile.buffer, aFile ? aFile.buffer : null)

    let success = 0
    const failList = []
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      try {
        await pool.execute(
          `INSERT INTO t_question
             (material_id, type, question, options, answer, analysis, score, sort_order, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [material_id, q.type, q.question, q.options ? JSON.stringify(q.options) : null, q.answer || '', q.analysis || '', q.score, i + 1]
        )
        success++
      } catch (e) {
        failList.push({ index: i + 1, error: e.message })
      }
    }

    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [material_id]
    )
    const MATERIAL_STATUS_AFTER = 2
    const examSingle = Math.max(0, Number(exam_single_num) || 0)
    const examMultiple = Math.max(0, Number(exam_multiple_num) || 0)
    const examJudgment = Math.max(0, Number(exam_judgment_num) || 0)
    await pool.execute(
      `UPDATE t_material
       SET question_cnt = ?, status = ?, ai_status = 2,
           exam_single_num = ?, exam_multiple_num = ?, exam_judgment_num = ?
       WHERE id = ?`,
      [cnt, MATERIAL_STATUS_AFTER, examSingle, examMultiple, examJudgment, material_id]
    )

    res.json({
      success: true,
      message: `导入完成：成功 ${success} 条 / 失败 ${failList.length} 条`,
      data: { success, fail: failList.length, failPreview: failList.slice(0, 10), validation },
    })
  } catch (e) {
    res.status(500).json({ error: '导入失败：' + e.message })
  }
})

// ─── GET /api/admin/quiz-import/export/:id ────────────────────────────────────
router.get('/export/:id', adminAuth, async (req, res) => {
  const { id } = req.params

  const [material] = await pool.execute('SELECT id, title FROM t_material WHERE id = ?', [id])
  if (!material.length) return res.status(404).json({ error: '题库不存在' })

  const [questions] = await pool.execute(
    'SELECT type, question, options, answer, analysis, score FROM t_question WHERE material_id = ? AND status = 1 ORDER BY sort_order ASC',
    [id]
  )

  const data = [TEMPLATE_HEADERS]
  for (const q of questions) {
    const opts = q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : {}
    data.push([
      TYPE_MAP_REV[q.type] || q.type,
      q.question,
      opts['A'] || '',
      opts['B'] || '',
      opts['C'] || '',
      opts['D'] || '',
      q.answer || '',
      q.analysis || '',
      q.score || 5,
    ])
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(data)
  ws['!cols'] = [{ wch: 10 }, { wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 30 }, { wch: 8 }]
  XLSX.utils.book_append_sheet(wb, ws, '题目')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  const filename = encodeURIComponent(`${material[0].title}_题目.xlsx`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
  res.send(buf)
})

module.exports = router
