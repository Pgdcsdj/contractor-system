/**
 * 出题质量量化校验与追踪服务（培训模块）
 *
 * 能力总览：
 *   1) 质量配置：getConfig / saveConfig（素材级 → 全局默认 → 内置兜底 三级回落）
 *   2) 修订留痕：logRevision / getRevisionHistory / getNextRound
 *   3) AI 标注：enrichQuestions（存量题目一键补标 difficulty/bloom/知识点/源关键点）
 *   4) 源覆盖：extractSourceKeyPoints / runCoverageCheck
 *   5) 整卷一致性：runConsistencyCheck
 *   6) 量化描述：computeQualityScore / runQualityCheck（落库 t_quality_report）
 *   7) 报告导出：exportQualityExcel（SheetJS，4 个 sheet）
 *
 * 设计约束：
 *   - 不引入任何新 npm 依赖：AI 调用复用 ai/aiQuestion 的 callAI / parseJSONResponse，
 *     Excel 复用 services/unclosedHazardReport 的 SheetJS 范式（xlsx 包）。
 *   - 全部向后兼容：旧题无标注不影响运行，缺字段一律走安全默认值。
 *   - 所有 AI 调用失败均降级为「不标注」而不是抛错中断整卷校验。
 */

const xlsx = require('xlsx')
const { pool } = require('../db/db')
const { callAI, parseJSONResponse } = require('../ai/aiQuestion')
const { fmtDateTime } = require('./unclosedHazardReport')

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** Bloom 三级枚举（与 aiQuestion 标注增强保持一致） */
const BLOOM_LEVELS = ['识记', '理解', '应用']

/** 内置兜底配置（DB 无素材级配置、也无全局默认配置时使用） */
const DEFAULT_CONFIG = {
  expectedCount: 10,
  typeDistribution: { single: 0.4, multiple: 0.3, judgment: 0.2, essay: 0.1 },
  difficultyHistogram: { 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.2, 5: 0.1 },
  bloomDistribution: { 识记: 0.3, 理解: 0.5, 应用: 0.2 },
  coverageThreshold: 0.8,
  kpMinCount: 5,
}

/** 一致性偏差阈值（占比绝对偏差） */
const DEVIATION_MID = 0.15
const DEVIATION_LOW = 0.05

/** 综合分权重 */
const SCORE_WEIGHTS = {
  countRate: 0.25,
  typeMatch: 0.20,
  coveragePct: 0.30,
  annotateRate: 0.15,
  revisionConvergence: 0.10,
}

/** 修订操作类型枚举 */
const OP_TYPES = ['GENERATE', 'REGEN', 'ADD', 'EDIT', 'DELETE', 'CONFIG']

/** AI 标注每批题目数（过大易超 token） */
const ENRICH_BATCH_SIZE = 5

/** needsManual（图片类素材无正文）时覆盖率的保守记分 */
const COVERAGE_MANUAL_SCORE = 60

// ─── 通用小工具 ──────────────────────────────────────────────────────────────

/**
 * 安全解析 JSON 列：mysql2 对 JSON 列可能返回对象，也可能返回字符串
 * @param {*} value
 * @param {*} fallback
 * @returns {*}
 */
function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

/**
 * 强制转为字符串数组（去空、去重、trim）
 * @param {*} value
 * @returns {string[]}
 */
function toStringArray(value) {
  const raw = Array.isArray(value) ? value : parseJsonColumn(value, [])
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (item === null || item === undefined) continue
    const s = typeof item === 'string' ? item.trim() : String(item).trim()
    if (s === '') continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 归一化文本用于模糊包含匹配：小写 + 去空白 + 去常见标点
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。；：、！？“”‘’（）《》,.;:!?"'()<>\[\]{}\-_/\\]/g, '')
}

/** 限制难度到 1-5 整数 */
function clampDifficulty(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 3
  return Math.min(5, Math.max(1, n))
}

/** 规范 Bloom 层级（非法值回落「理解」） */
function normalizeBloom(value) {
  const s = String(value || '').trim()
  return BLOOM_LEVELS.includes(s) ? s : '理解'
}

/** 保留 2 位小数 */
function round2(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

/**
 * 把「比例或绝对值」的分布配置统一换算为占比 map（总和 1）
 * @param {Object} dist
 * @returns {Object<string, number>}
 */
function toRatioMap(dist) {
  const src = dist && typeof dist === 'object' ? dist : {}
  const keys = Object.keys(src)
  if (keys.length === 0) return {}
  let sum = 0
  for (const k of keys) {
    const v = Number(src[k])
    if (Number.isFinite(v) && v > 0) sum += v
  }
  if (sum <= 0) return {}
  const out = {}
  for (const k of keys) {
    const v = Number(src[k])
    out[k] = Number.isFinite(v) && v > 0 ? v / sum : 0
  }
  return out
}

/**
 * 计数 map 转占比 map
 * @param {Object<string, number>} counts
 * @param {number} total
 * @returns {Object<string, number>}
 */
function countsToRatio(counts, total) {
  const out = {}
  const t = Number(total) || 0
  for (const k of Object.keys(counts || {})) {
    out[k] = t > 0 ? Number(counts[k]) / t : 0
  }
  return out
}

/**
 * 合并用户配置与内置默认（浅合并，缺项走默认）
 * @param {Object} config
 * @returns {Object}
 */
function mergeConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    expectedCount: Number.isFinite(Number(c.expectedCount)) ? Number(c.expectedCount) : DEFAULT_CONFIG.expectedCount,
    typeDistribution: c.typeDistribution && typeof c.typeDistribution === 'object'
      ? c.typeDistribution : { ...DEFAULT_CONFIG.typeDistribution },
    difficultyHistogram: c.difficultyHistogram && typeof c.difficultyHistogram === 'object'
      ? c.difficultyHistogram : { ...DEFAULT_CONFIG.difficultyHistogram },
    bloomDistribution: c.bloomDistribution && typeof c.bloomDistribution === 'object'
      ? c.bloomDistribution : { ...DEFAULT_CONFIG.bloomDistribution },
    coverageThreshold: Number.isFinite(Number(c.coverageThreshold)) ? Number(c.coverageThreshold) : DEFAULT_CONFIG.coverageThreshold,
    kpMinCount: Number.isFinite(Number(c.kpMinCount)) ? Number(c.kpMinCount) : DEFAULT_CONFIG.kpMinCount,
  }
}

/**
 * 调用 AI 并解析 JSON（失败返回 null，不抛错，保证质量校验主流程不被打断）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @returns {Promise<*|null>}
 */
async function callAIJson(systemPrompt, userPrompt, maxTokens = 3000) {
  try {
    const raw = await callAI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxTokens
    )
    if (!raw || String(raw).trim() === '') return null
    return parseJSONResponse(raw)
  } catch (err) {
    console.warn('[quality] AI 调用/解析失败（已降级）:', err.message)
    return null
  }
}

// ─── 1. 质量配置 ─────────────────────────────────────────────────────────────

/**
 * 获取素材的质量配置：素材级 → 全局默认（material_id IS NULL AND is_default=1）→ 内置默认
 * @param {number} materialId
 * @returns {Promise<Object>} 合并后的完整配置对象
 */
async function getConfig(materialId) {
  const id = Number(materialId) || 0

  if (id > 0) {
    const [rows] = await pool.execute(
      'SELECT config_json FROM t_quality_config WHERE material_id = ? ORDER BY id DESC LIMIT 1',
      [id]
    )
    if (rows.length) {
      const parsed = parseJsonColumn(rows[0].config_json, null)
      if (parsed) return mergeConfig(parsed)
    }
  }

  const [defRows] = await pool.execute(
    'SELECT config_json FROM t_quality_config WHERE material_id IS NULL AND is_default = 1 ORDER BY id DESC LIMIT 1'
  )
  if (defRows.length) {
    const parsed = parseJsonColumn(defRows[0].config_json, null)
    if (parsed) return mergeConfig(parsed)
  }

  return { ...DEFAULT_CONFIG }
}

/**
 * 保存质量配置（upsert：同 material_id 已有则更新，否则插入）
 * @param {Object} params
 * @param {number|null} params.materialId  null / 0 表示全局默认配置
 * @param {Object} params.config
 * @param {string} [params.name]
 * @returns {Promise<{id:number, before:Object|null, after:Object, isDefault:boolean}>}
 */
async function saveConfig({ materialId = null, config = {}, name = '' } = {}) {
  const id = Number(materialId) || 0
  const isGlobal = id <= 0
  const merged = mergeConfig(config)
  const configName = String(name || '').trim() || (isGlobal ? '全局默认质量配置' : `素材${id}质量配置`)

  let existing = []
  if (isGlobal) {
    const [rows] = await pool.execute(
      'SELECT id, config_json FROM t_quality_config WHERE material_id IS NULL AND is_default = 1 ORDER BY id DESC LIMIT 1'
    )
    existing = rows
  } else {
    const [rows] = await pool.execute(
      'SELECT id, config_json FROM t_quality_config WHERE material_id = ? ORDER BY id DESC LIMIT 1',
      [id]
    )
    existing = rows
  }

  const before = existing.length ? parseJsonColumn(existing[0].config_json, null) : null

  if (existing.length) {
    await pool.execute(
      'UPDATE t_quality_config SET name = ?, config_json = ? WHERE id = ?',
      [configName.slice(0, 80), JSON.stringify(merged), existing[0].id]
    )
    return { id: existing[0].id, before, after: merged, isDefault: isGlobal }
  }

  const [result] = await pool.execute(
    'INSERT INTO t_quality_config (material_id, name, config_json, is_default) VALUES (?, ?, ?, ?)',
    [isGlobal ? null : id, configName.slice(0, 80), JSON.stringify(merged), isGlobal ? 1 : 0]
  )
  return { id: result.insertId, before, after: merged, isDefault: isGlobal }
}

// ─── 2. 修订留痕 ─────────────────────────────────────────────────────────────

/**
 * 写入一条修订日志（写失败仅告警，不影响业务主流程）
 * @param {Object} params
 * @param {number} params.materialId
 * @param {number} [params.roundNo=0]
 * @param {number} [params.operatorId=0]
 * @param {string} [params.operatorName='']
 * @param {string} params.opType   GENERATE/REGEN/ADD/EDIT/DELETE/CONFIG
 * @param {string} [params.opContent='']
 * @param {string} [params.reason='']
 * @param {*} [params.before=null]
 * @param {*} [params.after=null]
 * @returns {Promise<number>} 日志ID（失败返回 0）
 */
async function logRevision({
  materialId,
  roundNo = 0,
  operatorId = 0,
  operatorName = '',
  opType = 'EDIT',
  opContent = '',
  reason = '',
  before = null,
  after = null,
} = {}) {
  try {
    const mid = Number(materialId) || 0
    if (mid <= 0) return 0

    const safeOpType = OP_TYPES.includes(String(opType).toUpperCase())
      ? String(opType).toUpperCase()
      : 'EDIT'

    const [result] = await pool.execute(
      `INSERT INTO t_question_revision_log
        (material_id, round_no, operator_id, operator_name, op_type, op_content, reason, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mid,
        Math.max(0, Number(roundNo) || 0),
        Math.max(0, Number(operatorId) || 0),
        String(operatorName || '').slice(0, 40),
        safeOpType,
        String(opContent || '').slice(0, 255),
        reason === null || reason === undefined ? '' : String(reason),
        before === null || before === undefined ? null : JSON.stringify(before),
        after === null || after === undefined ? null : JSON.stringify(after),
      ]
    )
    return result.insertId
  } catch (err) {
    console.warn('[quality] 修订日志写入失败（已忽略）:', err.message)
    return 0
  }
}

/**
 * 取该素材下一轮轮次号（同时参考日志表与题目表的最大轮次）
 * @param {number} materialId
 * @returns {Promise<number>}
 */
async function getNextRound(materialId) {
  const mid = Number(materialId) || 0
  if (mid <= 0) return 1

  let maxRound = 0
  try {
    const [logRows] = await pool.execute(
      'SELECT COALESCE(MAX(round_no), 0) AS m FROM t_question_revision_log WHERE material_id = ?',
      [mid]
    )
    maxRound = Math.max(maxRound, Number(logRows[0] && logRows[0].m) || 0)
  } catch (err) {
    console.warn('[quality] 读取日志轮次失败（按 0 处理）:', err.message)
  }
  try {
    const [qRows] = await pool.execute(
      'SELECT COALESCE(MAX(quality_round), 0) AS m FROM t_question WHERE material_id = ?',
      [mid]
    )
    maxRound = Math.max(maxRound, Number(qRows[0] && qRows[0].m) || 0)
  } catch (err) {
    console.warn('[quality] 读取题目轮次失败（按 0 处理）:', err.message)
  }

  return maxRound + 1
}

/**
 * 查询修订历史（按轮次倒序、时间倒序）
 * @param {number} materialId
 * @param {number} [roundNo]  可选，过滤指定轮次
 * @returns {Promise<Array<Object>>}
 */
async function getRevisionHistory(materialId, roundNo) {
  const mid = Number(materialId) || 0
  if (mid <= 0) return []

  const params = [mid]
  let where = 'WHERE material_id = ?'
  if (roundNo !== undefined && roundNo !== null && String(roundNo) !== '') {
    where += ' AND round_no = ?'
    params.push(Math.max(0, Number(roundNo) || 0))
  }

  const [rows] = await pool.execute(
    `SELECT id, material_id, round_no, operator_id, operator_name, op_type, op_content,
            reason, before_json, after_json, created_at
       FROM t_question_revision_log
       ${where}
      ORDER BY round_no DESC, id DESC
      LIMIT 500`,
    params
  )

  return rows.map(r => ({
    id: r.id,
    materialId: r.material_id,
    roundNo: r.round_no,
    operatorId: r.operator_id,
    operatorName: r.operator_name || '',
    opType: r.op_type,
    opContent: r.op_content || '',
    reason: r.reason || '',
    before: parseJsonColumn(r.before_json, null),
    after: parseJsonColumn(r.after_json, null),
    createdAt: r.created_at,
  }))
}

// ─── 3. AI 标注（存量补标）───────────────────────────────────────────────────

const ENRICH_SYSTEM_PROMPT = `你是一名石油石化安全培训题库质量标注专家。
你的任务是为已有题目补充四项元数据标注：难度、Bloom认知层级、知识点标签、源文档关键点。
标注要求：
1. difficulty 为 1-5 整数（1-2 基础识记，3 理解应用，4-5 综合分析）
2. bloom_level 只能是 "识记"、"理解"、"应用" 三者之一
3. knowledge_points 为 1-4 个精炼知识点短语（每个不超过 15 字），自由生成不受词表限制
4. source_keypoints 为该题所依据的源文档关键句/关键规定（1-3 条，每条不超过 40 字），无法判定时给出题干核心考点
5. 严格只输出 JSON 数组，不要任何其他文字`

/**
 * 为一批题目请求 AI 标注
 * @param {Array<Object>} batch  [{id, type, question, options, answer, analysis}]
 * @param {string} materialTitle
 * @returns {Promise<Object<string, Object>>} id → {difficulty, bloom_level, knowledge_points, source_keypoints}
 */
async function requestAnnotationForBatch(batch, materialTitle) {
  const payload = batch.map(q => ({
    id: q.id,
    type: q.type,
    question: String(q.question || '').slice(0, 500),
    options: q.options || null,
    answer: String(q.answer || '').slice(0, 120),
    analysis: String(q.analysis || '').slice(0, 300),
  }))

  const userPrompt = `## 培训素材
${materialTitle || '（未命名素材）'}

## 待标注题目（JSON）
${JSON.stringify(payload, null, 2)}

## 输出格式（严格 JSON 数组，与输入题目一一对应）
[
  {
    "id": 题目原始id,
    "difficulty": 3,
    "bloom_level": "理解",
    "knowledge_points": ["高处作业防护", "安全带使用"],
    "source_keypoints": ["高处作业必须系挂安全带"]
  }
]

## 输出要求
严格只输出 JSON 数组，数组长度必须与输入题目数量一致，id 必须原样回填。`

  const parsed = await callAIJson(ENRICH_SYSTEM_PROMPT, userPrompt, 2500)
  const map = {}
  if (!parsed) return map

  let list = parsed
  if (!Array.isArray(list)) {
    if (Array.isArray(parsed.annotations)) list = parsed.annotations
    else if (Array.isArray(parsed.data)) list = parsed.data
    else if (Array.isArray(parsed.questions)) list = parsed.questions
    else list = []
  }

  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return
    // id 缺失时按顺序对齐输入批次
    const rawId = item.id !== undefined && item.id !== null ? item.id : (batch[idx] && batch[idx].id)
    const key = String(rawId)
    if (!key || key === 'undefined') return
    map[key] = {
      difficulty: clampDifficulty(item.difficulty),
      bloom_level: normalizeBloom(item.bloom_level),
      knowledge_points: toStringArray(item.knowledge_points).slice(0, 8),
      source_keypoints: toStringArray(item.source_keypoints).slice(0, 8),
    }
  })

  return map
}

/**
 * 存量题目一键补标：对缺少标注（或 force 全量）的题目调用 AI 生成四字段并回写
 * @param {number} materialId
 * @param {Object} [options]
 * @param {boolean} [options.force=false]  true = 全量重标
 * @returns {Promise<{annotated:number, total:number, skipped:number, failed:number}>}
 */
async function enrichQuestions(materialId, { force = false } = {}) {
  const mid = Number(materialId) || 0
  if (mid <= 0) return { annotated: 0, total: 0, skipped: 0, failed: 0 }

  const [materialRows] = await pool.execute(
    'SELECT id, title FROM t_material WHERE id = ?',
    [mid]
  )
  const materialTitle = materialRows.length ? materialRows[0].title : ''

  const [rows] = await pool.execute(
    `SELECT id, type, question, options, answer, analysis,
            difficulty, bloom_level, knowledge_points, source_keypoints
       FROM t_question
      WHERE material_id = ?
      ORDER BY sort_order ASC, id ASC`,
    [mid]
  )

  const total = rows.length
  if (total === 0) return { annotated: 0, total: 0, skipped: 0, failed: 0 }

  const pending = rows.filter(r => {
    if (force) return true
    const kp = toStringArray(r.knowledge_points)
    const skp = toStringArray(r.source_keypoints)
    return kp.length === 0 || skp.length === 0
  })

  const skipped = total - pending.length
  if (pending.length === 0) return { annotated: 0, total, skipped, failed: 0 }

  let annotated = 0
  let failed = 0

  for (let i = 0; i < pending.length; i += ENRICH_BATCH_SIZE) {
    const batch = pending.slice(i, i + ENRICH_BATCH_SIZE).map(r => ({
      id: r.id,
      type: r.type,
      question: r.question,
      options: parseJsonColumn(r.options, null),
      answer: r.answer,
      analysis: r.analysis,
    }))

    const annotationMap = await requestAnnotationForBatch(batch, materialTitle)

    for (const q of batch) {
      const ann = annotationMap[String(q.id)]
      if (!ann) {
        failed++
        continue
      }
      try {
        await pool.execute(
          `UPDATE t_question
              SET difficulty = ?, bloom_level = ?, knowledge_points = ?, source_keypoints = ?
            WHERE id = ?`,
          [
            ann.difficulty,
            ann.bloom_level,
            JSON.stringify(ann.knowledge_points),
            JSON.stringify(ann.source_keypoints),
            q.id,
          ]
        )
        annotated++
      } catch (err) {
        failed++
        console.warn(`[quality] 题目 ${q.id} 标注回写失败:`, err.message)
      }
    }
  }

  console.log(`[quality] 补标完成 materialId=${mid}：成功 ${annotated} / 待标 ${pending.length}（跳过 ${skipped}，失败 ${failed}）`)
  return { annotated, total, skipped, failed }
}

// ─── 4. 源文档关键点抽取 ─────────────────────────────────────────────────────

const KEYPOINT_SYSTEM_PROMPT = `你是一名安全培训教材分析专家，擅长从制度、通报、规程正文中抽取"可考核关键点"。
抽取要求：
1. 每条关键点是一句可独立成题的关键规定/事实/数值要求，不超过 40 字
2. 覆盖全文主要章节，不要集中在某一段
3. 不要输出与安全培训无关的行政套话（发文字号、抄送单位等）
4. 严格只输出 JSON 字符串数组，不要任何其他文字`

/**
 * 抽取素材源文档关键点集合
 *
 * 优先级：缓存列 t_material.source_keypoints → AI 抽取正文 → 汇总题目已有 source_keypoints
 * 三者皆空时返回 needsManual=true（典型场景：纯图片违章素材无正文）
 *
 * @param {number} materialId
 * @param {Object} [options]
 * @param {boolean} [options.force=false] 忽略缓存重新抽取
 * @returns {Promise<{keyPoints:string[], source:string, needsManual:boolean}>}
 */
async function extractSourceKeyPoints(materialId, { force = false } = {}) {
  const mid = Number(materialId) || 0
  if (mid <= 0) return { keyPoints: [], source: 'none', needsManual: true }

  const [rows] = await pool.execute(
    'SELECT id, title, content_text, source_keypoints FROM t_material WHERE id = ?',
    [mid]
  )
  if (!rows.length) return { keyPoints: [], source: 'none', needsManual: true }

  const material = rows[0]

  // 1) 缓存命中
  if (!force) {
    const cached = toStringArray(material.source_keypoints)
    if (cached.length > 0) {
      return { keyPoints: cached, source: 'cache', needsManual: false }
    }
  }

  // 2) 正文非空 → AI 抽取
  const contentText = String(material.content_text || '').trim()
  if (contentText.length >= 40) {
    const userPrompt = `## 素材标题
${material.title || '（未命名）'}

## 正文内容
${contentText.slice(0, 12000)}

## 任务
从上述正文中抽取 10-20 条可考核关键点。

## 输出格式（严格 JSON 字符串数组）
["关键点1", "关键点2", "关键点3"]

## 输出要求
严格只输出 JSON 数组，不要任何其他文字。`

    const parsed = await callAIJson(KEYPOINT_SYSTEM_PROMPT, userPrompt, 2000)
    let list = []
    if (Array.isArray(parsed)) list = parsed
    else if (parsed && Array.isArray(parsed.keyPoints)) list = parsed.keyPoints
    else if (parsed && Array.isArray(parsed.key_points)) list = parsed.key_points
    else if (parsed && Array.isArray(parsed.data)) list = parsed.data

    const keyPoints = toStringArray(list).slice(0, 40)
    if (keyPoints.length > 0) {
      try {
        await pool.execute(
          'UPDATE t_material SET source_keypoints = ? WHERE id = ?',
          [JSON.stringify(keyPoints), mid]
        )
      } catch (err) {
        console.warn('[quality] 关键点缓存写入失败（已忽略）:', err.message)
      }
      return { keyPoints, source: 'ai', needsManual: false }
    }
  }

  // 3) 回退：汇总题目已有 source_keypoints
  const [qRows] = await pool.execute(
    'SELECT source_keypoints FROM t_question WHERE material_id = ?',
    [mid]
  )
  const aggregated = []
  const seen = new Set()
  for (const r of qRows) {
    for (const kp of toStringArray(r.source_keypoints)) {
      const key = normalizeForMatch(kp)
      if (!key || seen.has(key)) continue
      seen.add(key)
      aggregated.push(kp)
    }
  }

  if (aggregated.length > 0) {
    return { keyPoints: aggregated, source: 'questions', needsManual: true }
  }

  return { keyPoints: [], source: 'none', needsManual: true }
}

// ─── 5. 整卷一致性校验 ───────────────────────────────────────────────────────

/**
 * 整卷一致性校验：题量 / 题型分布 / 难度分布 / Bloom 分布 / 知识点数量
 * @param {number} materialId
 * @param {Object} [config]  未传则内部 getConfig
 * @returns {Promise<Object>}
 */
async function runConsistencyCheck(materialId, config) {
  const mid = Number(materialId) || 0
  const cfg = config ? mergeConfig(config) : await getConfig(mid)

  const [rows] = await pool.execute(
    `SELECT id, type, difficulty, bloom_level, knowledge_points, source_keypoints
       FROM t_question
      WHERE material_id = ?`,
    [mid]
  )

  const actualCount = rows.length
  const expectedCount = Math.max(0, Number(cfg.expectedCount) || 0)

  // ── 分布统计 ──
  const typeCounts = {}
  const difficultyCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const bloomCounts = { 识记: 0, 理解: 0, 应用: 0 }
  const kpSet = new Set()
  let annotatedCount = 0

  for (const r of rows) {
    const t = String(r.type || 'single')
    typeCounts[t] = (typeCounts[t] || 0) + 1

    const d = clampDifficulty(r.difficulty)
    difficultyCounts[d] = (difficultyCounts[d] || 0) + 1

    const b = normalizeBloom(r.bloom_level)
    bloomCounts[b] = (bloomCounts[b] || 0) + 1

    const kps = toStringArray(r.knowledge_points)
    for (const kp of kps) kpSet.add(normalizeForMatch(kp) || kp)

    const hasDifficulty = r.difficulty !== null && r.difficulty !== undefined
    const hasBloom = !!String(r.bloom_level || '').trim()
    if (hasDifficulty && hasBloom && kps.length > 0) annotatedCount++
  }

  const kpCount = kpSet.size
  const kpMinCount = Math.max(0, Number(cfg.kpMinCount) || 0)

  const diffs = []
  const warnings = []

  // ── 题量 ──
  if (expectedCount > 0 && actualCount !== expectedCount) {
    diffs.push({
      dimension: '题目总量',
      expected: `${expectedCount} 道`,
      actual: `${actualCount} 道`,
      severity: 'high',
    })
    warnings.push(`题目总量不符：期望 ${expectedCount} 道，实际 ${actualCount} 道`)
  }

  // ── 通用分布比对 ──
  /**
   * @param {string} label
   * @param {Object} expectedDist
   * @param {Object} actualCounts
   * @param {string} keyPrefix
   */
  function compareDistribution(label, expectedDist, actualCounts, keyPrefix) {
    const expectedRatios = toRatioMap(expectedDist)
    const actualRatios = countsToRatio(actualCounts, actualCount)
    const keys = new Set([...Object.keys(expectedRatios), ...Object.keys(actualCounts || {})])

    for (const key of keys) {
      const exp = Number(expectedRatios[key] || 0)
      const act = Number(actualRatios[key] || 0)
      // 期望与实际都为 0 的维度无需提示
      if (exp === 0 && act === 0) continue
      const deviation = Math.abs(exp - act)
      if (deviation <= DEVIATION_LOW) continue

      const severity = deviation > DEVIATION_MID ? 'mid' : 'low'
      diffs.push({
        dimension: `${label}·${keyPrefix}${key}`,
        expected: `${(exp * 100).toFixed(0)}%`,
        actual: `${(act * 100).toFixed(0)}%（${Number(actualCounts[key] || 0)} 道）`,
        severity,
      })
      if (severity === 'mid') {
        warnings.push(`${label}「${keyPrefix}${key}」偏差 ${(deviation * 100).toFixed(0)}%（期望 ${(exp * 100).toFixed(0)}%，实际 ${(act * 100).toFixed(0)}%）`)
      }
    }
  }

  compareDistribution('题型分布', cfg.typeDistribution, typeCounts, '')
  compareDistribution('难度分布', cfg.difficultyHistogram, difficultyCounts, '难度')
  compareDistribution('Bloom分布', cfg.bloomDistribution, bloomCounts, '')

  // ── 知识点数量 ──
  if (kpMinCount > 0 && kpCount < kpMinCount) {
    diffs.push({
      dimension: '知识点覆盖数',
      expected: `≥ ${kpMinCount} 个`,
      actual: `${kpCount} 个`,
      severity: 'mid',
    })
    warnings.push(`去重知识点仅 ${kpCount} 个，低于配置下限 ${kpMinCount} 个`)
  }

  const hasHigh = diffs.some(d => d.severity === 'high')
  const hasMid = diffs.some(d => d.severity === 'mid')
  const pass = !hasHigh && !hasMid

  // ── 子指标：题量达标率 / 题型匹配度 ──
  const countRate = expectedCount > 0
    ? Math.min(actualCount / expectedCount, 1) * 100
    : 100

  const expectedTypeRatios = toRatioMap(cfg.typeDistribution)
  const actualTypeRatios = countsToRatio(typeCounts, actualCount)
  const typeKeys = Object.keys(expectedTypeRatios)
  let typeMatch = 100
  if (typeKeys.length > 0) {
    const allKeys = new Set([...typeKeys, ...Object.keys(actualTypeRatios)])
    let sumAbs = 0
    for (const k of allKeys) {
      sumAbs += Math.abs(Number(expectedTypeRatios[k] || 0) - Number(actualTypeRatios[k] || 0))
    }
    const meanAbs = sumAbs / allKeys.size
    typeMatch = Math.max(0, (1 - meanAbs) * 100)
  }

  const annotateRate = actualCount > 0 ? (annotatedCount / actualCount) * 100 : 0

  return {
    pass,
    actualCount,
    expectedCount,
    typeCounts,
    typeRatios: actualTypeRatios,
    difficultyHistogram: difficultyCounts,
    bloomDistribution: bloomCounts,
    kpCount,
    kpMinCount,
    annotatedCount,
    annotateRate: round2(annotateRate),
    countRate: round2(countRate),
    typeMatch: round2(typeMatch),
    diffs,
    warnings,
  }
}

// ─── 6. 源覆盖率校验 ─────────────────────────────────────────────────────────

/**
 * 源文档覆盖率：源关键点集合中，被题目 source_keypoints 命中的比例（模糊包含匹配）
 * @param {number} materialId
 * @returns {Promise<{coveragePct:number, covered:string[], uncovered:string[], needsManual:boolean, totalKP:number, source:string}>}
 */
async function runCoverageCheck(materialId) {
  const mid = Number(materialId) || 0
  const { keyPoints, source, needsManual } = await extractSourceKeyPoints(mid)

  const [rows] = await pool.execute(
    'SELECT source_keypoints FROM t_question WHERE material_id = ?',
    [mid]
  )

  const questionKeyPoints = []
  for (const r of rows) {
    for (const kp of toStringArray(r.source_keypoints)) {
      const norm = normalizeForMatch(kp)
      if (norm) questionKeyPoints.push(norm)
    }
  }

  if (keyPoints.length === 0) {
    return {
      coveragePct: 100,
      covered: [],
      uncovered: [],
      needsManual: true,
      totalKP: 0,
      source,
    }
  }

  const covered = []
  const uncovered = []
  for (const kp of keyPoints) {
    const norm = normalizeForMatch(kp)
    const hit = questionKeyPoints.some(qk => qk === norm || qk.includes(norm) || norm.includes(qk))
    if (hit) covered.push(kp)
    else uncovered.push(kp)
  }

  const coveragePct = round2((covered.length / keyPoints.length) * 100)

  return {
    coveragePct,
    covered,
    uncovered,
    needsManual: !!needsManual,
    totalKP: keyPoints.length,
    source,
  }
}

// ─── 7. 综合分计算 ───────────────────────────────────────────────────────────

/**
 * 依据综合分返回分档
 * @param {number} score
 * @returns {string}
 */
function gradeOf(score) {
  if (score >= 90) return '优秀'
  if (score >= 75) return '良好'
  if (score >= 60) return '合格'
  return '待改进'
}

/**
 * 计算综合质量分与 5 项子指标
 * @param {Object} params
 * @param {Object} params.consistency  runConsistencyCheck 结果
 * @param {Object} params.coverage     runCoverageCheck 结果
 * @param {number} [params.annotateRate]         覆盖 consistency.annotateRate
 * @param {number} [params.revisionConvergence]  默认按 consistency.warnings 推算
 * @param {Object} [params.revision]   {rounds, lastWarnings}
 * @returns {Object}
 */
function computeQualityScore({
  consistency = {},
  coverage = {},
  annotateRate,
  revisionConvergence,
  revision = { rounds: 0, lastWarnings: 0 },
} = {}) {
  const countRate = Number.isFinite(Number(consistency.countRate)) ? Number(consistency.countRate) : 100
  const typeMatch = Number.isFinite(Number(consistency.typeMatch)) ? Number(consistency.typeMatch) : 100

  const coveragePct = coverage.needsManual
    ? COVERAGE_MANUAL_SCORE
    : (Number.isFinite(Number(coverage.coveragePct)) ? Number(coverage.coveragePct) : 0)

  const finalAnnotateRate = Number.isFinite(Number(annotateRate))
    ? Number(annotateRate)
    : (Number.isFinite(Number(consistency.annotateRate)) ? Number(consistency.annotateRate) : 0)

  const warningCount = Number.isFinite(Number(revision.lastWarnings))
    ? Number(revision.lastWarnings)
    : (Array.isArray(consistency.warnings) ? consistency.warnings.length : 0)

  const finalConvergence = Number.isFinite(Number(revisionConvergence))
    ? Number(revisionConvergence)
    : (warningCount === 0 ? 100 : Math.max(0, 100 - warningCount * 20))

  const metrics = {
    countRate: round2(countRate),
    typeMatch: round2(typeMatch),
    coveragePct: round2(coveragePct),
    annotateRate: round2(finalAnnotateRate),
    revisionConvergence: round2(finalConvergence),
  }

  const qualityScore = Math.round(
    metrics.countRate * SCORE_WEIGHTS.countRate +
    metrics.typeMatch * SCORE_WEIGHTS.typeMatch +
    metrics.coveragePct * SCORE_WEIGHTS.coveragePct +
    metrics.annotateRate * SCORE_WEIGHTS.annotateRate +
    metrics.revisionConvergence * SCORE_WEIGHTS.revisionConvergence
  )

  const safeScore = Math.min(100, Math.max(0, qualityScore))

  const hints = []
  if (coverage.needsManual) {
    hints.push('该素材无可用正文（或未抽取到关键点），源覆盖率按 60 分保守计入，建议人工复核题目与源文档的对应关系')
  }
  if (metrics.annotateRate < 100) {
    hints.push('存在未完成标注的题目，可点击「补全标注」由 AI 自动补标后重新校验')
  }

  return {
    qualityScore: safeScore,
    grade: gradeOf(safeScore),
    metrics,
    consistency,
    coverage,
    revision: {
      rounds: Math.max(0, Number(revision.rounds) || 0),
      lastWarnings: warningCount,
    },
    hints,
  }
}

// ─── 8. 质量校验主流程 ───────────────────────────────────────────────────────

/**
 * 运行完整质量校验并落库 t_quality_report
 * @param {number} materialId
 * @returns {Promise<Object>} 完整报告对象
 */
async function runQualityCheck(materialId) {
  const mid = Number(materialId) || 0
  if (mid <= 0) throw new Error('materialId 无效')

  const [materialRows] = await pool.execute(
    'SELECT id, title, content_text FROM t_material WHERE id = ?',
    [mid]
  )
  if (!materialRows.length) throw new Error('素材不存在')

  const config = await getConfig(mid)
  const consistency = await runConsistencyCheck(mid, config)
  const coverage = await runCoverageCheck(mid)

  // 修订轮次统计
  let rounds = 0
  try {
    const [roundRows] = await pool.execute(
      'SELECT COALESCE(MAX(round_no), 0) AS m FROM t_question_revision_log WHERE material_id = ?',
      [mid]
    )
    rounds = Number(roundRows[0] && roundRows[0].m) || 0
  } catch (err) {
    console.warn('[quality] 统计修订轮次失败（按 0 处理）:', err.message)
  }

  const scored = computeQualityScore({
    consistency,
    coverage,
    annotateRate: consistency.annotateRate,
    revision: { rounds, lastWarnings: consistency.warnings.length },
  })

  const report = {
    materialId: mid,
    materialTitle: materialRows[0].title || '',
    roundNo: rounds,
    config,
    checkedAt: new Date().toISOString(),
    ...scored,
  }

  try {
    await pool.execute(
      `INSERT INTO t_quality_report
        (material_id, round_no, report_json, coverage_pct, consistency_pass, quality_score)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        mid,
        rounds,
        JSON.stringify(report),
        Math.min(999.99, Math.max(0, Number(coverage.coveragePct) || 0)),
        consistency.pass ? 1 : 0,
        Math.min(255, Math.max(0, Number(scored.qualityScore) || 0)),
      ]
    )
  } catch (err) {
    console.warn('[quality] 质量报告落库失败（结果仍返回）:', err.message)
  }

  console.log(
    `[quality] 校验完成 materialId=${mid}：综合分 ${scored.qualityScore}（${scored.grade}），` +
    `一致性=${consistency.pass ? '通过' : '未通过'}，覆盖率=${coverage.coveragePct}%`
  )

  return report
}

/**
 * 读取最近一次质量报告（无则返回 null）
 * @param {number} materialId
 * @returns {Promise<Object|null>}
 */
async function getLatestReport(materialId) {
  const mid = Number(materialId) || 0
  if (mid <= 0) return null
  const [rows] = await pool.execute(
    `SELECT report_json, coverage_pct, consistency_pass, quality_score, round_no, created_at
       FROM t_quality_report
      WHERE material_id = ?
      ORDER BY id DESC LIMIT 1`,
    [mid]
  )
  if (!rows.length) return null
  const report = parseJsonColumn(rows[0].report_json, null)
  if (!report) return null
  report.createdAt = rows[0].created_at
  return report
}

// ─── 9. Excel 导出（复用 unclosedHazardReport 的 SheetJS 范式）────────────────

/** 严重度中文映射 */
const SEVERITY_CN = { high: '严重', mid: '中等', low: '轻微' }

/** 操作类型中文映射 */
const OP_TYPE_CN = {
  GENERATE: '首次出题',
  REGEN: '重新出题',
  ADD: '新增题目',
  EDIT: '修改题目',
  DELETE: '删除题目',
  CONFIG: '配置变更',
}

/**
 * 生成质量报告 Excel（4 个 sheet）
 * @param {number} materialId
 * @returns {Promise<{buffer:Buffer, filename:string, report:Object}>}
 */
async function exportQualityExcel(materialId) {
  const mid = Number(materialId) || 0
  const report = await runQualityCheck(mid)
  const history = await getRevisionHistory(mid)

  const wb = xlsx.utils.book_new()

  // ── Sheet 1：质量总览 ──
  const overviewAoa = [
    ['指标', '数值', '说明'],
    ['素材ID', report.materialId, ''],
    ['素材标题', report.materialTitle, ''],
    ['综合质量分', report.qualityScore, '满分 100'],
    ['质量分档', report.grade, '优秀≥90 / 良好75-89 / 合格60-74 / 待改进<60'],
    ['题量达标率', `${report.metrics.countRate}%`, `权重 ${SCORE_WEIGHTS.countRate * 100}%（实际 ${report.consistency.actualCount} 道 / 期望 ${report.consistency.expectedCount} 道）`],
    ['题型匹配度', `${report.metrics.typeMatch}%`, `权重 ${SCORE_WEIGHTS.typeMatch * 100}%`],
    ['源覆盖率', `${report.metrics.coveragePct}%`, `权重 ${SCORE_WEIGHTS.coveragePct * 100}%${report.coverage.needsManual ? '（无正文，按保守分计入，需人工复核）' : ''}`],
    ['标注完整度', `${report.metrics.annotateRate}%`, `权重 ${SCORE_WEIGHTS.annotateRate * 100}%（已标注 ${report.consistency.annotatedCount} 道）`],
    ['修订收敛度', `${report.metrics.revisionConvergence}%`, `权重 ${SCORE_WEIGHTS.revisionConvergence * 100}%（当前告警 ${report.revision.lastWarnings} 项）`],
    ['一致性校验', report.consistency.pass ? '通过' : '未通过', `差异 ${report.consistency.diffs.length} 项`],
    ['去重知识点数', report.consistency.kpCount, `配置下限 ${report.consistency.kpMinCount}`],
    ['修订轮次', report.revision.rounds, ''],
    ['生成时间', fmtDateTime(new Date(), true), ''],
  ]
  const wsOverview = xlsx.utils.aoa_to_sheet(overviewAoa)
  wsOverview['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 60 }]
  xlsx.utils.book_append_sheet(wb, wsOverview, '质量总览')

  // ── Sheet 2：一致性校验 ──
  const consistencyAoa = [['序号', '维度', '期望', '实际', '严重度']]
  report.consistency.diffs.forEach((d, i) => {
    consistencyAoa.push([
      i + 1,
      d.dimension || '',
      String(d.expected === undefined ? '' : d.expected),
      String(d.actual === undefined ? '' : d.actual),
      SEVERITY_CN[d.severity] || d.severity || '',
    ])
  })
  if (report.consistency.diffs.length === 0) {
    consistencyAoa.push(['-', '无差异', '-', '-', '-'])
  }
  consistencyAoa.push([])
  consistencyAoa.push(['告警清单'])
  if (report.consistency.warnings.length === 0) {
    consistencyAoa.push(['无告警'])
  } else {
    report.consistency.warnings.forEach((w, i) => consistencyAoa.push([`${i + 1}. ${w}`]))
  }
  const wsConsistency = xlsx.utils.aoa_to_sheet(consistencyAoa)
  wsConsistency['!cols'] = [{ wch: 8 }, { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 10 }]
  xlsx.utils.book_append_sheet(wb, wsConsistency, '一致性校验')

  // ── Sheet 3：覆盖率 ──
  const maxLen = Math.max(report.coverage.covered.length, report.coverage.uncovered.length, 1)
  const coverageAoa = [
    ['源覆盖率', `${report.coverage.coveragePct}%`, '关键点总数', report.coverage.totalKP, '需人工复核', report.coverage.needsManual ? '是' : '否'],
    [],
    ['序号', '已覆盖关键点', '未覆盖关键点'],
  ]
  for (let i = 0; i < maxLen; i++) {
    coverageAoa.push([
      i + 1,
      report.coverage.covered[i] || '',
      report.coverage.uncovered[i] || '',
    ])
  }
  const wsCoverage = xlsx.utils.aoa_to_sheet(coverageAoa)
  wsCoverage['!cols'] = [{ wch: 8 }, { wch: 50 }, { wch: 50 }, { wch: 12 }, { wch: 14 }, { wch: 10 }]
  xlsx.utils.book_append_sheet(wb, wsCoverage, '覆盖率')

  // ── Sheet 4：修订历史 ──
  const historyAoa = [['序号', '轮次', '操作人', '操作类型', '操作内容', '原因', '时间']]
  history.forEach((h, i) => {
    historyAoa.push([
      i + 1,
      h.roundNo,
      h.operatorName || '系统',
      OP_TYPE_CN[h.opType] || h.opType || '',
      h.opContent || '',
      h.reason || '',
      fmtDateTime(h.createdAt, true),
    ])
  })
  if (history.length === 0) {
    historyAoa.push(['-', '-', '-', '-', '暂无修订记录', '-', '-'])
  }
  const wsHistory = xlsx.utils.aoa_to_sheet(historyAoa)
  wsHistory['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 34 }, { wch: 30 }, { wch: 20 }]
  xlsx.utils.book_append_sheet(wb, wsHistory, '修订历史')

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const filename = `质量报告_${mid}.xlsx`

  return { buffer, filename, report }
}

module.exports = {
  // 常量
  DEFAULT_CONFIG,
  BLOOM_LEVELS,
  SCORE_WEIGHTS,
  // 配置
  getConfig,
  saveConfig,
  // 留痕
  logRevision,
  getNextRound,
  getRevisionHistory,
  // 标注
  enrichQuestions,
  extractSourceKeyPoints,
  // 校验
  runConsistencyCheck,
  runCoverageCheck,
  computeQualityScore,
  runQualityCheck,
  getLatestReport,
  // 导出
  exportQualityExcel,
  // 工具（供路由/测试复用）
  parseJsonColumn,
  toStringArray,
  clampDifficulty,
  normalizeBloom,
}
