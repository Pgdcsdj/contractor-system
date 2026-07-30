/**
 * 通报素材路由（管理员）
 *
 * POST   /api/material/upload         上传素材文件 → 存 COS → 触发 AI 出题
 * GET    /api/material/list           素材列表
 * GET    /api/material/:id/questions  查看题目（审核页）
 * PUT    /api/material/:id/question/:qid  修改题目
 * DELETE /api/material/:id/question/:qid  删除题目
 * POST   /api/material/:id/publish    发布题库（员工可见）
 * POST   /api/material/:id/offline    下线题库
 */

const express  = require('express')
const multer   = require('multer')
const { pool } = require('../db/db')
const { uploadFile }   = require('../services/cosUpload')
const { generateQuestions, generateImageQuestions } = require('../ai/aiQuestion')
const { extractFromBuffer } = require('../services/docParser')
const { verifyAdminToken } = require('../services/adminAuth')
const { QUIZ_MODES } = require('../constants/quizCodes')

// ─── 规范化模式参数（仅允许 study/practice/exam，非法值回退 'exam'）──
function normalizeModeParam(value, fallback = QUIZ_MODES.EXAM) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.values(QUIZ_MODES).includes(v) ? v : fallback
}

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const token = authHeader.slice(7)
  const payload = verifyAdminToken(token)
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/jpeg',
  'image/png',
]

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase()
    const allowed = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png']
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('只支持 PDF、DOCX、JPG/PNG 格式'))
    }
  },
})

// ─── POST /api/material/upload ──────────────────────────────────────────────
router.post('/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' })

  const {
    title = '',
    material_type = 'other',
    category_id,
    pass_score,
    time_limit,
    mode,
    ai_enabled = 'false',
    ai_question_types = 'choice',
    ai_question_count = 10,
  } = req.body

  const safePassScore  = Math.min(100, Math.max(0, Number(pass_score) || 60))
  const safeTimeLimit  = Math.min(180, Math.max(5,  Number(time_limit) || 30))
  const safeCategoryId = category_id ? Number(category_id) : null
  const safeMode       = normalizeModeParam(mode)
  const safeAiEnabled  = ai_enabled === 'true' || ai_enabled === true

  try {
    // 1. 上传 COS
    const { url, key } = await uploadFile(
      req.file.buffer,
      req.file.originalname,
      'materials'
    )

    const ext = req.file.originalname.split('.').pop().toLowerCase()

    // 2. 写入素材表（含 category_id）
    const [result] = await pool.execute(
      `INSERT INTO t_material (title, file_url, file_type, file_size, pass_score, time_limit, status, ai_status, category_id, created_by, mode)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        title || req.file.originalname,
        url,
        material_type,
        req.file.size,
        safePassScore,
        safeTimeLimit,
        safeCategoryId,
        req.admin.id,
        safeMode,
      ]
    )
    const materialId = result.insertId

    res.json({
      success: true,
      message: '上传成功，正在触发 AI 出题（异步处理）',
      data: { materialId, fileUrl: url },
    })

    // 3. 异步触发 AI 出题（仅当启用时）
    if (safeAiEnabled) {
      triggerAiQuestion(materialId, req.file.buffer, ext, {
        count:  Number(ai_question_count) || 10,
        types:  ai_question_types || 'choice',
        material_type: material_type,
      }).catch(err => {
        console.error(`[AI出题失败] materialId=${materialId}`, err.message)
      })
    }

  } catch (err) {
    console.error('[upload error]', err.message)
    // 区分 COS 配置错误 vs 其他错误，便于排查
    const isCosError = err.message && (
      err.message.includes('credentials') ||
      err.message.includes('SecretId') ||
      err.message.includes('SecretKey') ||
      err.message.includes('bucket') ||
      err.message.includes('Bucket') ||
      err.message.includes('403') ||
      err.message.includes('404') ||
      err.message.includes('NoSuch')
    )
    if (isCosError) {
      res.status(500).json({ error: 'COS上传失败：' + err.message })
    } else {
      res.status(500).json({ error: err.message })
    }
  }
})

/**
 * 异步：从文件提取文本/图片 → 调用 AI 出题 → 写入 t_question
 * @param {number} materialId
 * @param {Buffer} buffer
 * @param {string} fileType
 * @param {{ count: number, types: string, material_type?: string }} config
 */
async function triggerAiQuestion(materialId, buffer, fileType, config) {
  const { count = 10, types = 'choice', material_type = 'other' } = config || {}

  // 更新状态：出题中
  await pool.execute(
    'UPDATE t_material SET status = 1, ai_status = 1 WHERE id = ?',
    [materialId]
  )

  try {
    // ── 判断是否为图片违章识别模式 ────────────────────────────
    const isImageViolation = material_type === 'image_violation'

    let content = ''
    let extractedImages = []

    if (isImageViolation) {
      // 图片违章模式：提取文档中的文字和图片
      const extracted = await extractFromBuffer(buffer, fileType)
      content = extracted.text
      extractedImages = extracted.images || []

      // 将提取的图片上传到COS
      const imageUrls = []
      for (let i = 0; i < extractedImages.length; i++) {
        const img = extractedImages[i]
        try {
          const { url } = await uploadFile(img.buffer, img.filename, 'materials/images')
          imageUrls.push(url)
          // 存入素材图片表
          await pool.execute(
            `INSERT INTO t_material_image (material_id, url, sort_order, description)
             VALUES (?, ?, ?, ?)`,
            [materialId, url, i, null]
          )
        } catch (uploadErr) {
          console.error(`[图片上传失败] ${img.filename}:`, uploadErr.message)
        }
      }

      console.log(`[图片素材] 提取图片 ${extractedImages.length} 张，成功上传 ${imageUrls.length} 张`)

      // 保存文字内容到素材表
      await pool.execute(
        'UPDATE t_material SET content_text = ? WHERE id = ?',
        [content, materialId]
      )

      // 调用 Vision AI 出题
      if (imageUrls.length === 0) {
        throw new Error('未能从文档中提取到图片，请确保上传的Word文档中包含图片')
      }

      const questionTypes = types === 'mixed' ? '单选+多选+判断+填空' : '单选+多选+判断'
      const result = await generateImageQuestions({
        content,
        images: extractedImages.filter((_, i) => i < imageUrls.length),
        count: count,
      })

      const questions = result.questions || []

      // 批量写入 t_question，根据 image_index 关联图片URL
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        const imageIndex = q.image_index || 0
        const imageUrl = imageUrls[imageIndex] || null

        await pool.execute(
          `INSERT INTO t_question (material_id, type, question, image_url, options, answer, analysis, score, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            materialId,
            q.type || 'single',
            q.question,
            imageUrl,
            q.options ? JSON.stringify(q.options) : null,
            q.answer || '',
            q.explanation || q.analysis || '',
            q.score || 5,
            i,
          ]
        )
      }

      await pool.execute(
        'UPDATE t_material SET status = 2, ai_status = 2, question_cnt = ? WHERE id = ?',
        [questions.length, materialId]
      )

      console.log(`[AI图片出题完成] materialId=${materialId}，生成 ${questions.length} 道题`)

    } else {
      // ── 原有逻辑：纯文字出题 ─────────────────────────────────
      if (['docx', 'doc'].includes(fileType)) {
        content = buffer.toString('utf8').replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、：；""''（）\s]/g, '').trim()
        if (content.length < 50) content = '[文档内容已上传，请在题目审核页手动录入或重新提取]'
        if (content.length > 100000) {
          console.log(`[AI出题] 原始内容 ${content.length} 字符，截断至 100000 字符`)
          content = content.slice(0, 100000) + '\n\n[内容已截断，完整内容请在审核页查看]'
        }
      } else if (['jpg', 'jpeg', 'png'].includes(fileType)) {
        content = '[图片素材，AI将根据图片描述生成题目，请确保通报内容清晰可读]'
      } else if (fileType === 'pdf') {
        content = '[PDF素材，文本提取需要 pdfjs 库，当前降级处理：请在审核页手动补充题目内容]'
      }

      // 保存文字内容
      await pool.execute(
        'UPDATE t_material SET content_text = ? WHERE id = ?',
        [content, materialId]
      )

      const questionTypes = types === 'mixed' ? '单选+多选+判断+简答' : '单选题'
      const result = await generateQuestions({
        content,
        count:   count,
        docType: 'policy_notice',
        questionTypes,
      })

      const questions = result.questions || []

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        await pool.execute(
          `INSERT INTO t_question (material_id, type, question, options, answer, analysis, score, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            materialId,
            q.type || 'single',
            q.question,
            q.options ? JSON.stringify(q.options) : null,
            q.answer || '',
            q.analysis || '',
            q.score || 5,
            i,
          ]
        )
      }

      await pool.execute(
        'UPDATE t_material SET status = 2, ai_status = 2, question_cnt = ? WHERE id = ?',
        [questions.length, materialId]
      )

      console.log(`[AI出题完成] materialId=${materialId}，生成 ${questions.length} 道题`)
    }

  } catch (err) {
    // AI 失败：状态改为"出题失败"，管理员可手动录入
    await pool.execute(
      'UPDATE t_material SET status = 2, ai_status = 3 WHERE id = ?',
      [materialId]
    )
    throw err
  }
}

// ─── GET /api/material/list ─────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  const { status, page = 1, pageSize = 20 } = req.query
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const safeOffset   = (Math.max(1, Number(page) || 1) - 1) * safePageSize
  const params = []
  let where = 'WHERE 1=1'

  if (status !== undefined) {
    where += ' AND status = ?'
    params.push(Number(status))
  }

  const [rows] = await pool.query(
    `SELECT m.id, m.title, m.mode, m.file_url,
            file_type AS material_type,
            file_size,
            question_cnt AS total_questions,
            pass_score,
            time_limit,
          CASE
            WHEN status = 3 THEN 'published'
            WHEN status = 4 THEN 'closed'
            ELSE 'pending'
          END AS status,
          ai_status,
          c.name AS category_name,
          m.created_at,
          m.updated_at AS published_at
   FROM t_material m
   LEFT JOIN t_material_category c ON c.id = m.category_id
     ${where}
     ORDER BY created_at DESC
     LIMIT ${safePageSize} OFFSET ${safeOffset}`,
    params
  )

  res.json({ success: true, data: rows })
})

// ─── GET /api/material/:id/questions ────────────────────────────────────────
router.get('/:id/questions', async (req, res) => {
  const { id } = req.params

  const [material] = await pool.execute(
    'SELECT id, title, status, ai_status FROM t_material WHERE id = ?', [id]
  )
  if (!material.length) return res.status(404).json({ error: '素材不存在' })

  const [questions] = await pool.execute(
    'SELECT * FROM t_question WHERE material_id = ? ORDER BY sort_order ASC',
    [id]
  )

  res.json({ success: true, data: { material: material[0], questions } })
})

// ─── POST /api/material/:id/retry-ai ─────────────────────────────────────────
// 重新触发AI出题（清掉旧题，重置状态）
router.post('/:id/retry-ai', adminAuth, async (req, res) => {
  const { id } = req.params

  // 检查素材是否存在
  const [material] = await pool.execute(
    'SELECT id, title, file_url, file_type, content_text FROM t_material WHERE id = ?', [id]
  )
  if (!material.length) return res.status(404).json({ error: '素材不存在' })

  // 清掉旧题目
  await pool.execute('DELETE FROM t_question WHERE material_id = ?', [id])
  // 重置状态
  await pool.execute(
    'UPDATE t_material SET status = 0, ai_status = 0, question_cnt = 0 WHERE id = ?', [id]
  )

  res.json({ success: true, message: '已重置，AI出题正在后台处理' })

  // 异步触发 AI 出题
  try {
    await pool.execute('UPDATE t_material SET status = 1, ai_status = 1 WHERE id = ?', [id])

    const result = await generateQuestions({
      content: material[0].content_text || '[素材内容不可用，请在审核页手动录入题目]',
      count:   10,
      docType: 'policy_notice',
    })

    const questions = result.questions || []
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      await pool.execute(
        `INSERT INTO t_question (material_id, type, question, options, answer, analysis, score, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, q.type || 'single', q.question,
         q.options ? JSON.stringify(q.options) : null,
         q.answer || '', q.analysis || '', q.score || 5, i]
      )
    }

    await pool.execute(
      'UPDATE t_material SET status = 2, ai_status = 2, question_cnt = ? WHERE id = ?',
      [questions.length, id]
    )
    console.log(`[AI出题完成] materialId=${id}，生成 ${questions.length} 道题`)
  } catch (err) {
    await pool.execute(
      'UPDATE t_material SET status = 2, ai_status = 3 WHERE id = ?', [id]
    )
    console.error(`[AI出题失败] materialId=${id}:`, err.message)
  }
})

// ─── PUT /api/material/:id/question/:qid ────────────────────────────────────
router.put('/:id/question/:qid', async (req, res) => {
  const { qid } = req.params
  const { question, options, answer, analysis, score } = req.body

  await pool.execute(
    `UPDATE t_question
     SET question=?, options=?, answer=?, analysis=?, score=?
     WHERE id=?`,
    [question, options ? JSON.stringify(options) : null, answer, analysis || '', score || 5, qid]
  )

  res.json({ success: true, message: '题目已更新' })
})

// ─── DELETE /api/material/:id/question/:qid ─────────────────────────────────
router.delete('/:id/question/:qid', async (req, res) => {
  const { id, qid } = req.params

  await pool.execute('DELETE FROM t_question WHERE id = ? AND material_id = ?', [qid, id])

  // 更新题目数量
  const [[{ cnt }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [id]
  )
  await pool.execute('UPDATE t_material SET question_cnt = ? WHERE id = ?', [cnt, id])

  res.json({ success: true, message: '题目已删除' })
})

// ─── POST /api/material/:id/publish ─────────────────────────────────────────
router.post('/:id/publish', adminAuth, async (req, res) => {
  const { id } = req.params

  try {
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [id]
    )
    if (cnt === 0) return res.status(400).json({ error: '请至少保留一道题目才能发布' })

    // 保存目标人群设置
    const { target_type = 'all', target_value = null, category_id = null } = req.body

    await pool.execute(
      'UPDATE t_material SET status = 3, question_cnt = ?, category_id = ?, target_type = ?, target_value = ? WHERE id = ?',
      [cnt, category_id, target_type, target_value ? JSON.stringify(target_value) : null, id]
    )

    res.json({
      success: true,
      message: `题库已发布（共 ${cnt} 道题），目标人群: ${{ all: '全员', unit: '指定承包商', specific: '指定人员' }[target_type] || target_type}`,
    })
  } catch (err) {
    console.error('[publish error]', err.message)
    res.status(500).json({ success: false, error: '发布失败：' + err.message })
  }
})

// ─── POST /api/material/:id/offline ─────────────────────────────────────────
router.post('/:id/offline', async (req, res) => {
  const { id } = req.params
  await pool.execute('UPDATE t_material SET status = 4 WHERE id = ?', [id])
  res.json({ success: true, message: '题库已下线' })
})

// ─── POST /api/material/:id/close ───────────────────────────────────────────
// 前端调用的关闭接口（等价于 offline）
router.post('/:id/close', async (req, res) => {
  const { id } = req.params
  await pool.execute('UPDATE t_material SET status = 4 WHERE id = ?', [id])
  res.json({ success: true, message: '题库已关闭' })
})

// ─── DELETE /api/material/:id ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params
  await pool.execute('DELETE FROM t_question WHERE material_id = ?', [id])
  await pool.execute('DELETE FROM t_record WHERE material_id = ?', [id])
  await pool.execute('DELETE FROM t_material WHERE id = ?', [id])
  res.json({ success: true, message: '已删除' })
})

// ─── POST /api/material/create ─────────────────────────────────────────────
// 无文件创建培训（用于导入题库流程）
router.post('/create', adminAuth, async (req, res) => {
  const { title, category_id, pass_score, time_limit, mode } = req.body

  if (!title || !title.trim()) {
    return res.status(400).json({ error: '培训标题不能为空' })
  }

  const safePassScore = Math.min(100, Math.max(0, Number(pass_score) || 60))
  const safeTimeLimit = Math.min(180, Math.max(5, Number(time_limit) || 30))
  const safeCategoryId = category_id ? Number(category_id) : null
  const safeMode = normalizeModeParam(mode)

  try {
    const [result] = await pool.execute(
      `INSERT INTO t_material (title, pass_score, time_limit, status, ai_status, category_id, created_by, mode)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
      [title.trim(), safePassScore, safeTimeLimit, safeCategoryId, req.admin.id, safeMode]
    )

    res.json({
      success: true,
      message: '培训创建成功，请导入题目',
      data: { materialId: result.insertId, title: title.trim() },
    })
  } catch (err) {
    console.error('[material create error]', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
