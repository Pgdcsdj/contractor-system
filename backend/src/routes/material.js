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
const XLSX     = require('xlsx')
const { pool } = require('../db/db')
const { uploadFile }   = require('../services/cosUpload')
const { generateQuestions, generateImageQuestions } = require('../ai/aiQuestion')
const { extractFromBuffer } = require('../services/docParser')
const { verifyAdminToken } = require('../services/adminAuth')
const { QUIZ_MODES } = require('../constants/quizCodes')
const {
  getNextRound,
  logRevision,
  clampDifficulty,
  normalizeBloom,
  toStringArray,
} = require('../services/qualityService')

// ─── 规范化模式参数（仅允许 study/practice/exam，非法值回退 'exam'）──
function normalizeModeParam(value, fallback = QUIZ_MODES.EXAM) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.values(QUIZ_MODES).includes(v) ? v : fallback
}

/**
 * 从 AI 题目对象中提取质量标注字段，缺失时给安全默认值
 *
 * 用于 t_question 的 5 个新增列，保证任何出题链路（预览确认 / 图片题 /
 * 纯文字题 / 重试）落库后都带有可统计的标注数据。
 *
 * @param {Object} q         单道题目对象
 * @param {number} roundNo   本次出题轮次
 * @returns {[number, string, string, string, number]} 依次对应
 *          difficulty, bloom_level, knowledge_points, source_keypoints, quality_round
 */
function annotationValues(q, roundNo = 1) {
  const src = q && typeof q === 'object' ? q : {}
  return [
    clampDifficulty(src.difficulty),
    normalizeBloom(src.bloom_level ?? src.bloomLevel),
    JSON.stringify(toStringArray(src.knowledge_points ?? src.knowledgePoints)),
    JSON.stringify(toStringArray(src.source_keypoints ?? src.sourceKeypoints)),
    Math.max(1, Number(roundNo) || 1),
  ]
}

/**
 * 取当前请求的操作人信息（PUT/DELETE 等未挂 adminAuth 的接口可能为空）
 * @param {import('express').Request} req
 * @returns {{operatorId:number, operatorName:string}}
 */
function operatorOf(req) {
  return {
    operatorId: Number(req.admin?.id) || 0,
    operatorName: String(req.admin?.username || '') || '系统',
  }
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

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE },
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

// 上传守卫：捕获 multer 错误并返回清晰文案，避免超限时冒泡到全局
// 错误处理逻辑被误报成「文件超过 5MB 限制」（与实际 50MB 上限不一致）。
function uploadGuard(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `单个文件不得超过 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        })
      }
      return res.status(400).json({ error: err.message || '文件上传失败' })
    }
    next()
  })
}

// ─── POST /api/material/upload ──────────────────────────────────────────────
router.post('/upload', adminAuth, uploadGuard, async (req, res) => {
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
    difficulty = 3,
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

    // ── 读取 preview 参数 ──────────────────────────────────────
    const preview = req.query.preview === 'true'

    if (preview) {
      // ── Preview 模式：上传 + 提取文本，不触发 AI ─────────────
      let contentText = ''
      try {
        const extracted = await extractFromBuffer(req.file.buffer, ext)
        contentText = extracted.text || ''
        if (contentText) {
          await pool.execute(
            'UPDATE t_material SET content_text = ? WHERE id = ?',
            [contentText, materialId]
          )
        }
      } catch (extractErr) {
        console.warn('[upload preview] extractFromBuffer 失败:', extractErr.message)
      }

      res.json({
        success: true,
        message: '上传成功',
        data: { materialId, preview: true, hasContent: !!contentText, fileUrl: url },
      })
      return
    }

    // ── 非 Preview 模式：原有异步 AI 流程 ──────────────────────
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
        difficulty: Math.min(5, Math.max(1, Number(difficulty) || 3)),
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

// ─── POST /api/material/:id/preview-ai ──────────────────────────────────────
// 预览模式：生成题目但不保存到数据库
router.post('/:id/preview-ai', adminAuth, async (req, res) => {
  const { id } = req.params

  try {
    const [material] = await pool.execute(
      'SELECT id, title, content_text, file_type FROM t_material WHERE id = ?',
      [id]
    )
    if (!material.length) {
      return res.status(404).json({ error: '素材不存在' })
    }

    const content = material[0].content_text
    if (!content || !content.trim()) {
      return res.status(400).json({
        error: '素材内容为空，无法生成题目。请确保文件内容已正确提取。',
      })
    }

    const {
      count = 10,
      questionTypes = 'choice',
      difficulty = 3,
    } = req.body || {}

    const result = await generateQuestions({
      content,
      count: Number(count) || 10,
      docType: 'policy_notice',
      questionTypes: questionTypes || 'choice',
      difficulty: Math.min(5, Math.max(1, Number(difficulty) || 3)),
    })

    res.json({
      success: true,
      data: {
        questions: result.questions || [],
        hasErrors: !!result.hasErrors,
        validationSummary: result.validationSummary || '',
        repairAttempted: !!result.repairAttempted,
        difficulty: Math.min(5, Math.max(1, Number(difficulty) || 3)),
      },
    })
  } catch (err) {
    console.error('[preview-ai error]', err.message)
    res.status(500).json({ error: 'AI 出题失败：' + err.message })
  }
})

// ─── POST /api/material/:id/confirm-questions ────────────────────────────────
// 确认保存预览的题目到数据库
router.post('/:id/confirm-questions', adminAuth, async (req, res) => {
  const { id } = req.params
  const { questions } = req.body

  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '题目列表不能为空' })
  }

  // 本次确认属于新一轮出题，取轮次号用于质量追踪
  const roundNo = await getNextRound(id)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // 记录变更前的题目快照（用于修订留痕）
    const [beforeRows] = await conn.execute(
      'SELECT id, type, question, answer FROM t_question WHERE material_id = ?',
      [id]
    )

    // 清掉旧题目
    await conn.execute('DELETE FROM t_question WHERE material_id = ?', [id])

    // 批量 INSERT
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      await conn.execute(
        `INSERT INTO t_question
          (material_id, type, question, options, answer, analysis, score, sort_order,
           difficulty, bloom_level, knowledge_points, source_keypoints, quality_round)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          q.type || 'single',
          q.question || '',
          q.options ? JSON.stringify(q.options) : null,
          q.answer || '',
          q.explanation || q.analysis || '',
          q.score || 5,
          i,
          ...annotationValues(q, roundNo),
        ]
      )
    }

    // 计算 hasErrors：存在任意题缺少 options 或 answer 则算有问题
    const hasErrors = questions.some(
      (q) => !q.options || !q.answer || (Array.isArray(q.answer) && q.answer.length === 0)
    )
    const aiStatus = hasErrors ? 3 : 2

    await conn.execute(
      'UPDATE t_material SET status = 2, ai_status = ?, question_cnt = ? WHERE id = ?',
      [aiStatus, questions.length, id]
    )

    await conn.commit()

    // 修订留痕（事务外，失败不影响主流程）
    const op = operatorOf(req)
    await logRevision({
      materialId: Number(id),
      roundNo,
      operatorId: op.operatorId,
      operatorName: op.operatorName,
      opType: beforeRows.length ? 'REGEN' : 'GENERATE',
      opContent: `确认保存题目：${beforeRows.length} 道 → ${questions.length} 道（第 ${roundNo} 轮）`,
      before: { count: beforeRows.length, questions: beforeRows },
      after: {
        count: questions.length,
        questions: questions.map(q => ({
          type: q.type || 'single',
          question: q.question || '',
          answer: q.answer || '',
        })),
      },
    })

    res.json({
      success: true,
      message: `已保存 ${questions.length} 道题`,
      data: {
        questionCount: questions.length,
        aiStatus,
        roundNo,
      },
    })
  } catch (err) {
    await conn.rollback()
    console.error('[confirm-questions error]', err.message)
    res.status(500).json({ error: '保存题目失败：' + err.message })
  } finally {
    conn.release()
  }
})

// ─── POST /api/material/:id/cancel-ai ────────────────────────────────────────
// 取消 AI 出题（重置 ai_status 为 0，回到未出题状态）
router.post('/:id/cancel-ai', adminAuth, async (req, res) => {
  const { id } = req.params

  try {
    await pool.execute('UPDATE t_material SET ai_status = 0 WHERE id = ?', [id])
    res.json({ success: true, message: '已取消出题' })
  } catch (err) {
    console.error('[cancel-ai error]', err.message)
    res.status(500).json({ error: '取消失败：' + err.message })
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
  const { count = 10, types = 'choice', material_type = 'other', difficulty = 3 } = config || {}

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
      // visionImages 与 imageUrls 严格同序同长：只收录上传成功的图片，
      // 避免上传失败时 AI 侧下标与 COS URL 下标错位（图文对错的根因之一）
      const imageUrls = []
      const visionImages = []
      for (let i = 0; i < extractedImages.length; i++) {
        const img = extractedImages[i]
        try {
          const { url } = await uploadFile(img.buffer, img.filename, 'materials/images')
          imageUrls.push(url)
          visionImages.push({ buffer: img.buffer, filename: img.filename, url })
          // 存入素材图片表
          await pool.execute(
            `INSERT INTO t_material_image (material_id, url, sort_order, description)
             VALUES (?, ?, ?, ?)`,
            [materialId, url, imageUrls.length - 1, null]
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

      // 图片题固定题型集合（与 calcDistribution('image_violation') 的分布保持一致）
      const questionTypes = '单选+多选+判断+填空'
      const result = await generateImageQuestions({
        content,
        images: visionImages,
        count: count,
        difficulty,
        questionTypes,
        materialId,
      })

      const questions = result.questions || []
      const fallbackUsed = !!result.fallbackUsed
      const droppedCount = Number(result.droppedCount) || 0

      // 本轮出题轮次（质量追踪用）
      const imageRoundNo = await getNextRound(materialId)

      // 批量写入 t_question，优先用 AI 侧按文件名反查绑定好的 image_url
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        // image_index 为 null 表示该题已降级为纯文字题，不绑定任何图片
        const imageUrl = q.image_url
          || (q.image_index === null || q.image_index === undefined ? null : (imageUrls[q.image_index] || null))

        await pool.execute(
          `INSERT INTO t_question
            (material_id, type, question, image_url, options, answer, analysis, score, sort_order,
             difficulty, bloom_level, knowledge_points, source_keypoints, quality_round)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            materialId,
            q.type || 'single',
            q.question,
            imageUrl,
            q.options ? JSON.stringify(q.options) : null,
            // t_question.answer 为 VARCHAR(50)，填空题答案可能超长，
            // 严格模式下会抛 ER_DATA_TOO_LONG 导致整批写入失败，故截断
            String(q.answer || '').slice(0, 50),
            q.explanation || q.analysis || '',
            q.score || 5,
            i,
            ...annotationValues(q, imageRoundNo),
          ]
        )
      }

      // 降级（fallback 为纯文字题）或有题目被丢弃时，标记 ai_status=3 提示管理员复核
      const imageAiStatus = (fallbackUsed || droppedCount > 0) ? 3 : 2

      await pool.execute(
        'UPDATE t_material SET status = 2, ai_status = ?, question_cnt = ? WHERE id = ?',
        [imageAiStatus, questions.length, materialId]
      )

      await logRevision({
        materialId,
        roundNo: imageRoundNo,
        operatorId: Number(req.admin?.id) || 0,
        operatorName: String(req.admin?.username || '') || '系统',
        opType: 'GENERATE',
        opContent: `AI 图片出题：生成 ${questions.length} 道（丢弃 ${droppedCount} 道，第 ${imageRoundNo} 轮）`,
        before: null,
        after: { count: questions.length, droppedCount, fallbackUsed },
      })

      console.log(
        `[AI图片出题完成] materialId=${materialId}，生成 ${questions.length} 道题，` +
        `丢弃 ${droppedCount} 道，降级为文字题=${fallbackUsed}，` +
        `校验=${result.validationSummary || '-'}，耗时=${result.metadata?.durationMs ?? '-'}ms`
      )

    } else {
      // ── 原有逻辑：纯文字出题（统一用解析器提取真实文本，支持 docx/doc/pdf/jpg/png）──
      const extracted = await extractFromBuffer(buffer, fileType)
      content = extracted.text || ''
      if (content.length < 20) {
        content = '[文档内容提取失败，请在审核页手动补充题目内容]'
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
        difficulty,
      })

      const questions = result.questions || []

      // 本轮出题轮次（质量追踪用）
      const textRoundNo = await getNextRound(materialId)

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        await pool.execute(
          `INSERT INTO t_question
            (material_id, type, question, options, answer, analysis, score, sort_order,
             difficulty, bloom_level, knowledge_points, source_keypoints, quality_round)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            materialId,
            q.type || 'single',
            q.question,
            q.options ? JSON.stringify(q.options) : null,
            // t_question.answer 为 VARCHAR(50)，超长答案会触发 ER_DATA_TOO_LONG，故截断
            String(q.answer || '').slice(0, 50),
            q.analysis || '',
            q.score || 5,
            i,
            ...annotationValues(q, textRoundNo),
          ]
        )
      }

      await logRevision({
        materialId,
        roundNo: textRoundNo,
        operatorId: Number(req.admin?.id) || 0,
        operatorName: String(req.admin?.username || '') || '系统',
        opType: 'GENERATE',
        opContent: `AI 文字出题：生成 ${questions.length} 道（第 ${textRoundNo} 轮）`,
        before: null,
        after: { count: questions.length },
      })

      // 处理新的返回值格式：hasErrors 时设置 ai_status=3 但保存题目
      const aiStatus = result.hasErrors ? 3 : 2

      await pool.execute(
        'UPDATE t_material SET status = 2, ai_status = ?, question_cnt = ? WHERE id = ?',
        [aiStatus, questions.length, materialId]
      )

      const summary = result.validationSummary || `${questions.length} 道题`
      console.log(`[AI出题完成] materialId=${materialId}，${summary}，修复=${result.repairAttempted}，降级=${result.hasErrors}`)
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
            exam_single_num, exam_multiple_num, exam_judgment_num,
            exam_single_score, exam_multiple_score, exam_judgment_score,
          CASE
            WHEN status = 3 THEN 'published'
            WHEN status = 4 THEN 'closed'
            ELSE 'pending'
          END AS status,
          ai_status,
          m.target_type,
          m.target_value,
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

// ─── 题库导出 / 重新发布 ────────────────────────────────────────────────────
const TYPE_CN = { single: '单选题', multiple: '多选题', judgment: '判断题', essay: '简答题' }
const MODE_CN = { study: '学习', practice: '练习', exam: '考试' }
const TARGET_CN = { all: '全员', unit: '指定承包商', specific: '指定人员', position: '指定岗位' }
const STATUS_CN = { 3: '已发布', 4: '已关闭' }

function optParse(v) {
  if (!v) return null
  if (typeof v === 'object') return v
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null } catch (e) { return null }
}
function fmtTime(v) {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function sendXlsx(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buf)
}

// 导出某个题库的全部题目（xlsx，含「题目」「题库信息」两个 sheet）
router.get('/:id/export', adminAuth, async (req, res) => {
  const { id } = req.params
  try {
    const [[m]] = await pool.execute(
      `SELECT m.*, c.name AS category_name FROM t_material m
       LEFT JOIN t_material_category c ON c.id = m.category_id WHERE m.id = ?`, [id]
    )
    if (!m) return res.status(404).json({ success: false, error: '题库不存在' })
    const [qs] = await pool.execute(
      'SELECT * FROM t_question WHERE material_id = ? ORDER BY sort_order ASC, id ASC', [id]
    )

    // 选项列数：按实际最大选项个数（至少 A-D，最多 A-H）
    let maxOpt = 4
    qs.forEach((q) => {
      const o = optParse(q.options)
      if (o) maxOpt = Math.max(maxOpt, Object.keys(o).length)
    })
    maxOpt = Math.min(maxOpt, 8)
    const letters = 'ABCDEFGH'.slice(0, maxOpt).split('')

    const head = ['序号', '题型', '题干', ...letters.map((l) => `选项${l}`), '正确答案',
      '分值', '难度', '认知层次', '解析', '知识点', '配图URL', '启用']
    const aoa = [head]
    qs.forEach((q, i) => {
      const o = optParse(q.options) || {}
      aoa.push([
        i + 1,
        TYPE_CN[q.type] || q.type,
        q.question || '',
        ...letters.map((l) => (o[l] != null ? String(o[l]) : '')),
        q.answer || '',
        q.score != null ? Number(q.score) : '',
        q.difficulty != null ? Number(q.difficulty) : '',
        q.bloom_level || '',
        q.analysis || '',
        q.knowledge_points || '',
        q.image_url || '',
        Number(q.status) === 1 ? '是' : '否',
      ])
    })
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [
      { wch: 6 }, { wch: 9 }, { wch: 60 },
      ...letters.map(() => ({ wch: 18 })),
      { wch: 10 }, { wch: 6 }, { wch: 6 }, { wch: 10 }, { wch: 50 }, { wch: 20 }, { wch: 30 }, { wch: 6 },
    ]

    // 第二张表：题库基本信息（便于归档回溯）
    const [[eff]] = await pool.execute(
      'SELECT COUNT(*) AS c FROM t_question WHERE material_id = ? AND status = 1', [id]
    )
    const info = [
      ['项目', '内容'],
      ['题库ID', m.id],
      ['题库名称', m.title || ''],
      ['分类', m.category_name || '未分类'],
      ['答题模式', MODE_CN[m.mode] || m.mode || ''],
      ['当前状态', STATUS_CN[Number(m.status)] || '待发布'],
      ['题目总数', qs.length],
      ['有效题目数', eff.c],
      ['及格分', m.pass_score != null ? m.pass_score : ''],
      ['考试时长(分钟)', m.time_limit != null ? m.time_limit : ''],
      ['考试抽题(单选/多选/判断)',
        `${m.exam_single_num || 0} / ${m.exam_multiple_num || 0} / ${m.exam_judgment_num || 0}（0=全抽）`],
      ['目标人群', TARGET_CN[m.target_type] || m.target_type || ''],
      ['创建时间', fmtTime(m.created_at)],
      ['导出时间', fmtTime(new Date())],
    ]
    const ws2 = XLSX.utils.aoa_to_sheet(info)
    ws2['!cols'] = [{ wch: 24 }, { wch: 60 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '题目')
    XLSX.utils.book_append_sheet(wb, ws2, '题库信息')
    sendXlsx(res, wb, `${(m.title || '题库').slice(0, 40)}_题库导出.xlsx`)
  } catch (err) {
    console.error('[material export error]', err.message)
    res.status(500).json({ success: false, error: '导出失败：' + err.message })
  }
})

// 导出题库清单（全部题库一览，便于管理留档）
router.get('/export-list', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.title, m.mode, m.status, m.question_cnt, m.pass_score, m.time_limit,
              m.exam_single_num, m.exam_multiple_num, m.exam_judgment_num,
              m.target_type, m.created_at, c.name AS category_name,
              (SELECT COUNT(*) FROM t_question q WHERE q.material_id = m.id AND q.status = 1) AS eff_cnt
       FROM t_material m LEFT JOIN t_material_category c ON c.id = m.category_id
       ORDER BY m.id DESC`
    )
    const aoa = [['题库ID', '题库名称', '分类', '答题模式', '状态', '题目总数', '有效题目', '及格分', '时长(分钟)',
      '单选抽题', '多选抽题', '判断抽题', '目标人群', '创建时间']]
    rows.forEach((r) => aoa.push([
      r.id, r.title || '', r.category_name || '',
      MODE_CN[r.mode] || r.mode || '',
      STATUS_CN[Number(r.status)] || '待发布',
      r.question_cnt || 0, r.eff_cnt || 0,
      r.pass_score != null ? r.pass_score : '',
      r.time_limit != null ? r.time_limit : '',
      r.exam_single_num || 0, r.exam_multiple_num || 0, r.exam_judgment_num || 0,
      TARGET_CN[r.target_type] || r.target_type || '',
      fmtTime(r.created_at),
    ]))
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = [{ wch: 8 }, { wch: 46 }, { wch: 16 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 9 },
      { wch: 8 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 14 }, { wch: 18 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '题库清单')
    sendXlsx(res, wb, `题库清单_${fmtTime(new Date()).slice(0, 10)}.xlsx`)
  } catch (err) {
    console.error('[material export-list error]', err.message)
    res.status(500).json({ success: false, error: '导出失败：' + err.message })
  }
})

// 重新发布（已关闭 / 已下线 的题库再次上线）
// 与首次发布的区别：**保留原有的目标人群、分类、时长、及格分与抽题配置**，只在显式传参时覆盖
router.post('/:id/republish', adminAuth, async (req, res) => {
  const { id } = req.params
  try {
    const [[m]] = await pool.execute('SELECT * FROM t_material WHERE id = ?', [id])
    if (!m) return res.status(404).json({ success: false, error: '题库不存在' })

    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [id]
    )
    if (!cnt) return res.status(400).json({ success: false, error: '题库中没有有效题目，无法重新发布' })

    const b = req.body || {}
    const target_type = b.target_type !== undefined ? b.target_type : m.target_type
    const target_value = b.target_value !== undefined
      ? (b.target_value ? JSON.stringify(b.target_value) : null)
      : m.target_value
    const category_id = b.category_id !== undefined ? b.category_id : m.category_id
    const time_limit = b.time_limit !== undefined && b.time_limit !== null && b.time_limit !== ''
      ? Number(b.time_limit) : m.time_limit
    const pass_score = b.pass_score !== undefined && b.pass_score !== null && b.pass_score !== ''
      ? Number(b.pass_score) : m.pass_score

    await pool.execute(
      `UPDATE t_material SET status = 3, question_cnt = ?, target_type = ?, target_value = ?,
        category_id = ?, time_limit = ?, pass_score = ?, updated_at = NOW() WHERE id = ?`,
      [cnt, target_type, target_value, category_id, time_limit, pass_score, id]
    )

    res.json({
      success: true,
      message: `已重新发布（${cnt} 道题），历史答题记录保留；目标人群：${TARGET_CN[target_type] || target_type}`,
      data: { id: Number(id), status: 3, question_cnt: cnt },
    })
  } catch (err) {
    console.error('[republish error]', err.message)
    res.status(500).json({ success: false, error: '重新发布失败：' + err.message })
  }
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

  // 本次重试属于新一轮出题，先取轮次并留存旧题快照
  const roundNo = await getNextRound(id)
  const [oldQuestions] = await pool.execute(
    'SELECT id, type, question, answer FROM t_question WHERE material_id = ?', [id]
  )
  const retryOp = operatorOf(req)

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
        `INSERT INTO t_question
          (material_id, type, question, options, answer, analysis, score, sort_order,
           difficulty, bloom_level, knowledge_points, source_keypoints, quality_round)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, q.type || 'single', q.question,
         q.options ? JSON.stringify(q.options) : null,
         // t_question.answer 为 VARCHAR(50)，超长答案会触发 ER_DATA_TOO_LONG，故截断
         String(q.answer || '').slice(0, 50), q.analysis || '', q.score || 5, i,
         ...annotationValues(q, roundNo)]
      )
    }

    const aiStatus = result.hasErrors ? 3 : 2
    await pool.execute(
      'UPDATE t_material SET status = 2, ai_status = ?, question_cnt = ? WHERE id = ?',
      [aiStatus, questions.length, id]
    )

    await logRevision({
      materialId: Number(id),
      roundNo,
      operatorId: retryOp.operatorId,
      operatorName: retryOp.operatorName,
      opType: 'REGEN',
      opContent: `重新 AI 出题：${oldQuestions.length} 道 → ${questions.length} 道（第 ${roundNo} 轮）`,
      before: { count: oldQuestions.length, questions: oldQuestions },
      after: { count: questions.length },
    })

    const summary = result.validationSummary || `${questions.length} 道题`
    console.log(`[AI出题完成] materialId=${id}，${summary}，修复=${result.repairAttempted}，降级=${result.hasErrors}`)
  } catch (err) {
    await pool.execute(
      'UPDATE t_material SET status = 2, ai_status = 3 WHERE id = ?', [id]
    )
    console.error(`[AI出题失败] materialId=${id}:`, err.message)
  }
})

// ─── POST /api/material/:id/question ────────────────────────────────────────
// 人工新增单道题目（审核页手动补题），同步写入质量标注字段并留痕
router.post('/:id/question', adminAuth, async (req, res) => {
  const { id } = req.params
  const {
    type = 'single',
    question = '',
    options = null,
    answer = '',
    analysis = '',
    score = 5,
    image_url = null,
    difficulty,
    bloom_level,
    knowledge_points,
    source_keypoints,
  } = req.body || {}

  if (!String(question).trim()) {
    return res.status(400).json({ error: '题干不能为空' })
  }

  try {
    const [material] = await pool.execute('SELECT id FROM t_material WHERE id = ?', [id])
    if (!material.length) return res.status(404).json({ error: '素材不存在' })

    // 排序号接在现有题目之后
    const [[{ maxSort }]] = await pool.execute(
      'SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM t_question WHERE material_id = ?',
      [id]
    )

    // 人工新增归入当前最新轮次（不新开一轮）
    const [[{ curRound }]] = await pool.execute(
      'SELECT COALESCE(MAX(quality_round), 1) AS curRound FROM t_question WHERE material_id = ?',
      [id]
    )

    const [result] = await pool.execute(
      `INSERT INTO t_question
        (material_id, type, question, image_url, options, answer, analysis, score, sort_order,
         difficulty, bloom_level, knowledge_points, source_keypoints, quality_round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        type || 'single',
        String(question),
        image_url || null,
        options ? JSON.stringify(options) : null,
        String(answer || '').slice(0, 50),
        analysis || '',
        Number(score) || 5,
        Number(maxSort) + 1,
        ...annotationValues(
          { difficulty, bloom_level, knowledge_points, source_keypoints },
          Number(curRound) || 1
        ),
      ]
    )

    // 更新题目数量
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [id]
    )
    await pool.execute('UPDATE t_material SET question_cnt = ? WHERE id = ?', [cnt, id])

    const op = operatorOf(req)
    await logRevision({
      materialId: Number(id),
      roundNo: Number(curRound) || 1,
      operatorId: op.operatorId,
      operatorName: op.operatorName,
      opType: 'ADD',
      opContent: `人工新增题目 #${result.insertId}`,
      before: null,
      after: { id: result.insertId, type, question: String(question).slice(0, 200), answer },
    })

    res.json({
      success: true,
      message: '题目已新增',
      data: { id: result.insertId, questionCount: cnt },
    })
  } catch (err) {
    console.error('[add-question error]', err.message)
    res.status(500).json({ error: '新增题目失败：' + err.message })
  }
})

// ─── PUT /api/material/:id/question/:qid ────────────────────────────────────
router.put('/:id/question/:qid', async (req, res) => {
  const { id, qid } = req.params
  const { question, options, answer, analysis, score } = req.body

  // 变更前快照（用于修订留痕）
  const [beforeRows] = await pool.execute(
    `SELECT id, type, question, options, answer, analysis, score, quality_round
       FROM t_question WHERE id = ?`,
    [qid]
  )

  await pool.execute(
    `UPDATE t_question
     SET question=?, options=?, answer=?, analysis=?, score=?
     WHERE id=?`,
    [question, options ? JSON.stringify(options) : null, answer, analysis || '', score || 5, qid]
  )

  const before = beforeRows[0] || null
  const op = operatorOf(req)
  await logRevision({
    materialId: Number(id),
    roundNo: Number(before && before.quality_round) || 1,
    operatorId: op.operatorId,
    operatorName: op.operatorName,
    opType: 'EDIT',
    opContent: `修改题目 #${qid}`,
    before,
    after: { id: Number(qid), question, options, answer, analysis: analysis || '', score: score || 5 },
  })

  res.json({ success: true, message: '题目已更新' })
})

// ─── DELETE /api/material/:id/question/:qid ─────────────────────────────────
router.delete('/:id/question/:qid', async (req, res) => {
  const { id, qid } = req.params

  // 变更前快照（用于修订留痕）
  const [beforeRows] = await pool.execute(
    `SELECT id, type, question, options, answer, analysis, score, quality_round
       FROM t_question WHERE id = ? AND material_id = ?`,
    [qid, id]
  )

  await pool.execute('DELETE FROM t_question WHERE id = ? AND material_id = ?', [qid, id])

  // 更新题目数量
  const [[{ cnt }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM t_question WHERE material_id = ? AND status = 1', [id]
  )
  await pool.execute('UPDATE t_material SET question_cnt = ? WHERE id = ?', [cnt, id])

  const before = beforeRows[0] || null
  const op = operatorOf(req)
  await logRevision({
    materialId: Number(id),
    roundNo: Number(before && before.quality_round) || 1,
    operatorId: op.operatorId,
    operatorName: op.operatorName,
    opType: 'DELETE',
    opContent: `删除题目 #${qid}`,
    before,
    after: null,
  })

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
      message: `题库已发布（共 ${cnt} 道题），目标人群: ${{ all: '全员', unit: '指定承包商', specific: '指定人员', position: '指定岗位' }[target_type] || target_type}`,
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

// ─── PUT /api/material/:id/exam-config ─────────────────────────────────────
// 配置「考试随机抽题组卷」：按题型设置考试时随机抽取的题目数。
// 规则（与 GET /api/quiz/:materialId 的抽题实现严格一致）：
//   - 仅 mode = exam 生效；study / practice 始终返回全量题目
//   - 某题型填 0 或留空 = 该题型全抽；三个都为 0 = 整卷全抽（保持原有行为）
// 注：必须注册在 '/:id/questions' 等动态段之前不会冲突，此处放于文件末尾亦可，
//     但为避免与其它 '/:id/xxx' 路由产生歧义，统一使用 PUT 方法区分。
router.put('/:id/exam-config', adminAuth, async (req, res) => {
  const { id } = req.params
  const {
    mode,
    exam_single_num = 0,
    exam_multiple_num = 0,
    exam_judgment_num = 0,
    exam_single_score = 0,
    exam_multiple_score = 0,
    exam_judgment_score = 0,
    // 考试时长(分钟) / 及格分：可选传入，未传或非法时保留原值
    time_limit,
    pass_score,
  } = req.body || {}

  const toSafeNum = (v) => Math.min(9999, Math.max(0, parseInt(v, 10) || 0))
  // 每题分数：0 = 沿用题目自身分值；保留 1 位小数
  const toSafeScore = (v) => Math.min(1000, Math.max(0, Math.round((Number(v) || 0) * 10) / 10))
  // 默认模式：接收 exam/study/practice，非法/缺失时保留原值
  const safeMode = (mode && normalizeModeParam(mode)) || null

  try {
    const [[material]] = await pool.execute(
      'SELECT id, title, mode, time_limit, pass_score FROM t_material WHERE id = ?', [id]
    )
    if (!material) return res.status(404).json({ error: '题库不存在' })

    // 未传 mode（旧客户端）时保留素材原有默认模式
    const newMode = safeMode || material.mode || 'exam'
    // 考试时长：1~600 分钟；及格分：0~100。未传/非法 → 保留原值
    const newTimeLimit = (time_limit !== undefined && time_limit !== null && time_limit !== '')
      ? Math.min(600, Math.max(1, parseInt(time_limit, 10) || 30))
      : (Number(material.time_limit) || 30)
    const newPassScore = (pass_score !== undefined && pass_score !== null && pass_score !== '')
      ? Math.min(100, Math.max(0, Number(pass_score) || 0))
      : (Number(material.pass_score) || 60)

    await pool.execute(
      `UPDATE t_material
          SET exam_single_num = ?, exam_multiple_num = ?, exam_judgment_num = ?,
              exam_single_score = ?, exam_multiple_score = ?, exam_judgment_score = ?,
              mode = ?, time_limit = ?, pass_score = ?
        WHERE id = ?`,
      [toSafeNum(exam_single_num), toSafeNum(exam_multiple_num), toSafeNum(exam_judgment_num),
       toSafeScore(exam_single_score), toSafeScore(exam_multiple_score), toSafeScore(exam_judgment_score),
       newMode, newTimeLimit, newPassScore, id]
    )

    res.json({
      success: true,
      message: newMode === 'exam'
        ? '考试配置已保存'
        : `考试配置已保存（当前题库默认模式为「${newMode}」，抽题配置仅考试模式生效）`,
      data: {
        materialId: Number(id),
        mode: newMode,
        time_limit: newTimeLimit,
        pass_score: newPassScore,
        exam_single_num:   toSafeNum(exam_single_num),
        exam_multiple_num: toSafeNum(exam_multiple_num),
        exam_judgment_num: toSafeNum(exam_judgment_num),
        exam_single_score:   toSafeScore(exam_single_score),
        exam_multiple_score: toSafeScore(exam_multiple_score),
        exam_judgment_score: toSafeScore(exam_judgment_score),
      },
    })
  } catch (err) {
    console.error('[material exam-config error]', err.message)
    res.status(500).json({ error: '保存失败：' + err.message })
  }
})

// ─── POST /api/material/create ─────────────────────────────────────────────
// 无文件创建培训（用于导入题库流程）
router.post('/create', adminAuth, async (req, res) => {
  const { title, category_id, pass_score, time_limit, mode } = req.body
  // 考试抽题配置（可选；0 或留空 = 该题型全抽；每题分数 0 = 沿用题目自身分值）
  const {
    exam_single_num = 0, exam_multiple_num = 0, exam_judgment_num = 0,
    exam_single_score = 0, exam_multiple_score = 0, exam_judgment_score = 0,
  } = req.body

  if (!title || !title.trim()) {
    return res.status(400).json({ error: '培训标题不能为空' })
  }

  const safePassScore = Math.min(100, Math.max(0, Number(pass_score) || 60))
  const safeTimeLimit = Math.min(180, Math.max(5, Number(time_limit) || 30))
  const safeCategoryId = category_id ? Number(category_id) : null
  const safeMode = normalizeModeParam(mode)
  const toSafeNum = (v) => Math.min(9999, Math.max(0, parseInt(v, 10) || 0))
  const toSafeScore = (v) => Math.min(1000, Math.max(0, Math.round((Number(v) || 0) * 10) / 10))

  try {
    const [result] = await pool.execute(
      `INSERT INTO t_material
         (title, pass_score, time_limit, status, ai_status, category_id, created_by, mode,
          exam_single_num, exam_multiple_num, exam_judgment_num,
          exam_single_score, exam_multiple_score, exam_judgment_score)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(), safePassScore, safeTimeLimit, safeCategoryId, req.admin.id, safeMode,
        toSafeNum(exam_single_num), toSafeNum(exam_multiple_num), toSafeNum(exam_judgment_num),
        toSafeScore(exam_single_score), toSafeScore(exam_multiple_score), toSafeScore(exam_judgment_score),
      ]
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
