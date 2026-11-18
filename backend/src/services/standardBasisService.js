/**
 * 问题依据库服务 —— 底层数据现为「安全违章库」（t_violation，895 条）。
 * 原 t_standard_basis 已停用（保留表，不再读取）。
 *
 * 列映射（t_violation → 对外字段，保持下游调用方无需改字段名）：
 *   category       ← 违章分类
 *   standard_basis ← 违章条款具体内容（content）
 *   source         ← 检查依据（basis）
 *   附加：code / place / sub_segment / inspect_object / deduct_level
 *
 * 匹配规则（v2026.11.18.3）：隐患排查项目 + 问题描述联合检索。
 *   全库 895 条载入内存，按 2~4 字字串 + IDF 抑制泛词 + 现场高频问题词加权打分，
 *   返回 top5 候选（含来源条款与命中词），不再因排查项目名对不上就判「未找到」。
 *
 * 对外能力（函数名与旧版一致，hazardLoop / importService / standardBasis 路由无需改动）：
 *   loadBasisLibrary(pool)
 *   matchStandardBasis(lib, {category})        纯函数内存模糊匹配
 *   matchStandardBasisDb(pool, {category})     单条 DB 模糊匹配
 *   listLibrary / getById / create / update / remove   CRUD
 *   importLibrary(rows)                         UPSERT 导入（按 code 幂等）
 *   exportLibrary()                            导出数据
 *   generateLibraryTemplate()                  下载模板（xlsx buffer，8 列）
 */

const XLSX = require('xlsx')
const { pool } = require('../db/db')

// 读取时统一别名，让下游调用方继续用 category / standard_basis / source
const SELECT_COLS = `
  id, code, place, category, sub_segment, inspect_object,
  content AS standard_basis, basis AS source, deduct_level
`

// 现场口语 → 标准术语（2026-11-18 依据《应急部类比排查汇总》35 条人工依据回归调优）
// 顺序敏感：长词在前，避免短词先替换把长词拆碎
const SYNONYMS = [
  ['正压式空气呼吸器', '空气呼吸器'], ['空呼', '空气呼吸器'], ['呼器', '空气呼吸器'],
  ['灭火毯', '消防毯'], ['消防锹', '消防器材'], ['消防桶', '消防器材'],
  ['别针', '销子'], ['插销', '销子'], ['开口销', '销子'],
  ['接地电阻牌', '接地标志'], ['接地标识牌', '接地标志'], ['接地牌', '接地标志'],
  ['防爆格兰头', '电缆引入装置'], ['格兰头', '电缆引入装置'],
  ['生命绳', '安全绳'], ['生命线', '安全绳'], ['保险绳', '安全绳'],
  ['重浆', '加重钻井液'], ['泥浆', '钻井液'],
  ['空压机', '空气压缩机'], ['压风机', '空气压缩机'],
  ['等电位链接', '等电位连接'], ['等电位联结', '等电位连接'],
  ['危化品', '危险化学品'], ['危废', '危险废物'],
  ['低泵冲', '泵冲'], ['低泵速', '泵冲'],
  ['电控柜', '配电箱'], ['控制柜', '配电箱'], ['配电柜', '配电箱'],
  ['循环罐', '钻井液罐'], ['泥浆罐', '钻井液罐'],
  ['地基', '基础'], ['下沉', '沉降'],
  ['过桥', '跨越'], ['梯子', '爬梯'], ['斜梯', '爬梯'],
  ['防喷器', '井控装置'], ['套管头', '井控装置'],
  ['气动绞车', '绞车'], ['液压绞车', '绞车'],
]

// 归一：NFKC + 小写 + 去标点空白 + 口语同义词归一；「标识/标志」视为同义
function norm(s) {
  let t = String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/标识/g, '标志')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  for (const [a, b] of SYNONYMS) if (t.includes(a)) t = t.split(a).join(b)
  return t
}

// 中文无分词：用 2~4 字字串做特征，配合全库 IDF 抑制「安全/生产/措施」等泛词
function textGrams(s) {
  const out = new Set()
  for (const n of [2, 3, 4]) {
    for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n))
  }
  return out
}

// 数字 + 单位：现场依据常靠规格区分（100m / 1500mg/m3 / 35kg / 4mm）
const NUM_RE = /\d+(?:\.\d+)?(?:m3|m³|mg|kg|mm|mpa|米|个|具|台|套|条|根|年|月|小时|分钟|次)?/g

// 现场高频问题词：命中即加权，避免只按泛词排序
const SIGNAL_TERMS = [
  ['孔洞', 18], ['坠落风险', 20], ['作业平台', 18], ['操作平台', 18],
  ['安全警示标志', 15], ['静电接地', 15], ['防静电接地', 15],
  ['液位计', 15], ['盲盖', 15], ['装车', 12], ['护栏', 12], ['安全带', 12],
  ['高处作业', 12], ['动火作业', 12], ['受限空间', 12], ['吊装', 12],
  ['硫化氢', 10], ['防护罩', 10], ['临边', 10],
  // 2026-11-18 补充（对标现场检查与集团通报高频问题）
  ['空气呼吸器', 14], ['消防器材', 10], ['应急演练', 12], ['应急预案', 12],
  ['承包商', 12], ['井控装置', 14], ['钻井液', 10], ['加重钻井液', 12],
  ['防爆', 10], ['雷电防护', 12], ['钢丝绳', 12], ['接地', 8],
]
const MIN_SCORE = 3.5          // 常规描述阈值
const MIN_SCORE_SHORT = 2.0    // 短描述（<12 字）阈值，避免直接判「无结果」
const MAX_CANDIDATES = 8       // 返回候选数（原 5 → 8，便于人工挑选）
const RECALL_POOL = 16         // AI 精排的候选池大小

function rowText(r) {
  return norm([r.category, r.sub_segment, r.inspect_object, r.standard_basis].join(' '))
}

function buildMatchIndex(lib) {
  const rows = Array.isArray(lib) ? lib : []
  const df = new Map()
  const grams = rows.map((r) => {
    const g = textGrams(rowText(r))
    for (const x of g) df.set(x, (df.get(x) || 0) + 1)
    return g
  })
  return { rows, grams, df, total: rows.length }
}

function idf(index, g) {
  return Math.log(1 + index.total / (index.df.get(g) || 1))
}

function scoreLibrary(index, arg = {}) {
  const category = norm(arg && arg.category)
  const description = norm(arg && arg.description)
  const input = norm([category, description].filter(Boolean).join(' '))
  if (!input) return { matched: false, standard_basis: '', source: '', candidates: [] }

  const inputGrams = [...textGrams(input)].filter((g) => index.df.has(g))
  const inputSet = new Set(inputGrams)
  const inputNums = new Set((String((arg && arg.description) || '').match(NUM_RE) || []).map(norm))
  const shortDesc = description.length > 0 && description.length < 12
  // AI 精排模式：先放宽召回（池子更大、阈值更低），再由大模型重排
  const poolMode = !!(arg && arg.pool)
  const limit = poolMode ? Math.max(MAX_CANDIDATES, Number(arg.pool) || RECALL_POOL) : MAX_CANDIDATES
  let minScore = shortDesc ? MIN_SCORE_SHORT : MIN_SCORE
  if (poolMode) minScore = Math.min(minScore, 1.2)

  const out = []
  index.rows.forEach((r, i) => {
    const rg = index.grams[i]
    const rtext = rowText(r)
    const matched = []
    let base = 0
    for (const g of rg) {
      if (!inputSet.has(g)) continue
      base += idf(index, g) * (g.length >= 3 ? 1.4 : 1)
      matched.push(g)
    }
    if (!matched.length) return
    // 长度归一：长条款不因字数多被稀释到无分（2026-11-18 调优）
    base = base / Math.sqrt(Math.max(8, rg.size))
    // 连续命中 4 字以上短语：强相关信号
    let bestRun = 0
    if (matched.length >= 2) {
      const dp = new Array(input.length + 1).fill(0)
      for (let a = 1; a <= rtext.length; a++) {
        let prev = 0
        for (let b = 1; b <= input.length; b++) {
          const t = dp[b]
          if (rtext[a - 1] === input[b - 1]) { dp[b] = prev + 1; if (dp[b] > bestRun) bestRun = dp[b] }
          else dp[b] = 0
          prev = t
        }
      }
    }
    if (bestRun >= 4) base += Math.min(bestRun, 10) * 0.22
    // 稀有词命中（2026-11-18）：全库只有极少数条款出现的词（灭火毯/插销/低泵冲…）
    // 是「这条就是它」的最强证据，长条款被长度归一压低后靠它拉回来
    let rareHit = 0
    for (const g of matched) {
      if (g.length >= 2 && (index.df.get(g) || 1) <= 8) rareHit++
    }
    if (rareHit) base += Math.min(rareHit, 4) * 0.9

    const cat = norm(r.category)
    const sub = norm(r.sub_segment)
    const obj = norm(r.inspect_object)
    const place = norm(r.place)
    if (cat && input.includes(cat)) base += 0.8
    for (const t of String(r.inspect_object || '').split(/\s+/).map(norm).filter((x) => x.length >= 2)) {
      if (input.includes(t)) base += 0.8
    }
    if (sub && input.includes(sub)) base += 0.8
    if (place && input.includes(place)) base += 0.2
    // 数字/规格命中：现场依据常靠规格区分
    if (inputNums.size) {
      const rNums = new Set((String(r.standard_basis || '').match(NUM_RE) || []).map(norm))
      let numHit = 0
      for (const n of inputNums) if (rNums.has(n)) numHit++
      if (numHit) base += Math.min(numHit, 3) * 0.6
    }
    const terms = []
    for (const [term, w] of SIGNAL_TERMS) {
      if (input.includes(term) && rtext.includes(term)) { base += w / 10; terms.push(term) }
    }
    let score = base
    if (cat && category === cat) score += 20
    else if (cat && category && category.includes(cat)) score += 8
    out.push({
      score: Math.round(score * 100) / 100,
      code: r.code || '',
      category: r.category || '',
      sub_segment: r.sub_segment || '',
      inspect_object: r.inspect_object || '',
      standard_basis: r.standard_basis || '',
      source: r.source || '',
      matchedTerms: matched.slice().sort((a, b) => idf(index, b) - idf(index, a)).slice(0, 8),
      signalTerms: terms,
    })
  })
  out.sort((a, b) => b.score - a.score)
  // 同一条款在不同场所会重复入库（如 A1-305 / A8-013），候选里只留一条，给其它问题词让位
  const dedup = []
  const seenBasis = new Set()
  for (const x of out) {
    const key = norm(x.standard_basis)
    if (seenBasis.has(key)) continue
    seenBasis.add(key)
    dedup.push(x)
    if (dedup.length >= limit * 3) break
  }
  let candidates = dedup.filter((x) => x.score >= minScore).slice(0, limit)
  // 兜底（2026-11-18）：一条都不过阈值时不再直接甩「未找到」，改给字面最接近的 3 条并标低置信，
  // 由现场人工确认 —— 原来直接判无结果，是录入人最常见的挫败点。
  let lowConfidence = false
  if (!candidates.length && dedup.length) {
    candidates = dedup.slice(0, Math.min(3, limit))
    lowConfidence = true
  }
  if (!candidates.length) {
    return { matched: false, standard_basis: '', source: '', candidates: [], lowConfidence: false }
  }
  const top = candidates[0]
  return {
    matched: true,
    standard_basis: top.standard_basis,
    source: top.source,
    code: top.code,
    category: top.category,
    score: top.score,
    matchedTerms: top.matchedTerms,
    signalTerms: top.signalTerms,
    candidates,
    lowConfidence,
  }
}

// ─── 加载 / 匹配 ────────────────────────────────────────────────────────────
async function loadBasisLibrary(p) {
  const [rows] = await p.execute(
    `SELECT ${SELECT_COLS}
       FROM t_violation
       WHERE enabled = 1 AND content IS NOT NULL AND content <> ?
       ORDER BY category, id`,
    ['']
  )
  return rows || []
}

/** 纯函数：在已加载的库里匹配（导入 Excel 复用同一份 lib，避免重复查库） */
function matchStandardBasis(lib, arg = {}) {
  if (!Array.isArray(lib)) return { matched: false, standard_basis: '', source: '' }
  return scoreLibrary(buildMatchIndex(lib), arg)
}

let matchIndexCache = { at: 0, index: null }
async function getMatchIndex(p) {
  const now = Date.now()
  if (matchIndexCache.index && now - matchIndexCache.at < 60 * 1000) return matchIndexCache.index
  const lib = await loadBasisLibrary(p)
  const index = buildMatchIndex(lib)
  matchIndexCache = { at: now, index }
  return index
}

// ─── AI 语义精排（可选：字串召回 top12 → 大模型判断哪几条最对应）─────────────
const AI_PROVIDERS = {
  deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  moonshot: { url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-32k' },
}
let aiConfigCache = { at: 0, cfg: null }

async function loadAiConfig(p) {
  // 60 秒缓存，避免每次匹配都读表
  if (aiConfigCache.cfg && Date.now() - aiConfigCache.at < 60 * 1000) return aiConfigCache.cfg
  try {
    const [rows] = await p.execute(
      `SELECT config_value FROM t_system_config WHERE config_key = 'ai_config' LIMIT 1`
    )
    const cfg = rows && rows.length ? JSON.parse(rows[0].config_value) : null
    aiConfigCache = { at: Date.now(), cfg }
    return cfg
  } catch (e) {
    aiConfigCache = { at: Date.now(), cfg: null }
    return null
  }
}

function httpPostJson(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const https = require('https')
      const u = new URL(url)
      const data = JSON.stringify(body)
      const req = https.request(
        {
          host: u.host,
          path: u.pathname + (u.search || ''),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          let s = ''
          res.on('data', (c) => (s += c))
          res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { resolve(null) } })
        }
      )
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.write(data)
      req.end()
    } catch (e) { resolve(null) }
  })
}

function buildRerankPrompt(description, candidates) {
  const list = candidates
    .map((c, i) => `${i + 1}. 条款：${String(c.standard_basis).replace(/\s+/g, ' ').slice(0, 160)}\n   依据：${String(c.source).replace(/\s+/g, ' ').slice(0, 80)}`)
    .join('\n')
  return `你是石油天然气现场 HSE 检查专家。下面是一条隐患描述和若干候选标准依据条款，` +
    `请挑出「隐患整改和上级迎检时能直接引用」的检查依据。\n\n` +
    `【隐患描述】\n${description}\n\n【候选标准依据条款】\n${list}\n\n` +
    `判断要点：\n` +
    `1) 只要约束的是同一类问题（同一设备、同一作业环节、同一风险点），措辞不同也算对应；\n` +
    `2) 注意现场口语与标准术语的差别（空呼=空气呼吸器、泥浆=钻井液、接地牌=接地标志、防爆格兰头=电缆引入装置、重浆=加重钻井液）；\n` +
    `3) 涉及「记录/台账/资料不全」的，优先选要求建立记录或填写内容的条款；\n` +
    `4) 描述里出现数字规格（压力、浓度、距离、数量、年限）时，条款含相同数值的优先；\n` +
    `5) 明显对本不上的（例如讲消防器材却给电气接地条款）不要选；\n` +
    `6) 「员工安全行为规范」「HSE 管理体系手册」这类笼统的管理条款只作兜底，` +
    `若有直接针对该设备/该作业环节的具体技术标准条款，必须优先选具体技术条款。\n` +
    `按相关度从高到低最多给 3 条，序号只能来自上面的候选。只输出 JSON：{"best":[序号],"reason":"不超过30字的理由"}`
}

/** 返回 { best:number[], reason:string } 或 null（AI 不可用时） */
async function aiRerank(p, description, candidates) {
  if (!candidates || candidates.length < 2) return null
  const cfg = await loadAiConfig(p)
  if (!cfg) return null
  const order = [cfg.provider, 'deepseek', 'moonshot'].filter(Boolean)
  for (const name of order) {
    const prov = AI_PROVIDERS[name]
    const key = cfg.apiKeys && cfg.apiKeys[name]
    if (!prov || !key) continue
    const resp = await httpPostJson(
      prov.url,
      { Authorization: `Bearer ${key}` },
      {
        model: prov.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: buildRerankPrompt(description, candidates) }],
      },
      9000
    )
    let parsed = null
    try { parsed = JSON.parse(resp.choices[0].message.content) } catch (e) { parsed = null }
    if (!parsed || !Array.isArray(parsed.best) || !parsed.best.length) continue
    const best = parsed.best.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
    if (!best.length) continue
    return { best: [...new Set(best)].slice(0, 3), reason: String(parsed.reason || '').slice(0, 120), provider: name }
  }
  return null
}

/** DB 版：整库载入内存打分；索引 60 秒缓存。arg.ai=true 时再走大模型精排 */
async function matchStandardBasisDb(p, arg = {}) {
  const category = String((arg && arg.category) || '').trim()
  const description = String((arg && arg.description) || '').trim()
  if (!category && !description) return { matched: false, standard_basis: '', source: '' }
  const wantAi = !!(arg && arg.ai)
  const base = scoreLibrary(await getMatchIndex(p), {
    category,
    description,
    pool: wantAi ? RECALL_POOL : undefined,
  })
  if (!wantAi) return base
  const pool = base.candidates || []
  if (pool.length < 2) return { ...base, aiUsed: false }
  const reranked = await aiRerank(p, description || category, pool)
  if (!reranked) return { ...base, aiUsed: false, aiFallback: true }
  const picked = reranked.best.map((n) => pool[n - 1]).filter(Boolean)
  const rest = pool.filter((c) => !picked.includes(c))
  const candidates = picked.concat(rest).slice(0, MAX_CANDIDATES)
  const top = candidates[0]
  return {
    matched: true,
    standard_basis: top.standard_basis,
    source: top.source,
    code: top.code,
    category: top.category,
    score: top.score,
    matchedTerms: top.matchedTerms,
    signalTerms: top.signalTerms,
    candidates,
    aiUsed: true,
    aiProvider: reranked.provider,
    aiReason: reranked.reason,
    aiPickedCodes: picked.map((c) => c.code),
  }
}

// ─── 筛选项（适用场所 / 违章分类 / 扣分风险等级 去重列表）────────────────────────
async function getFilterOptions() {
  const [placeRows] = await pool.execute(
    `SELECT DISTINCT place FROM t_violation WHERE place IS NOT NULL AND place <> ? ORDER BY place`,
    ['']
  )
  const [catRows] = await pool.execute(
    `SELECT DISTINCT category FROM t_violation WHERE category IS NOT NULL AND category <> ? ORDER BY category`,
    ['']
  )
  const [dedRows] = await pool.execute(
    `SELECT DISTINCT deduct_level FROM t_violation WHERE deduct_level IS NOT NULL AND deduct_level <> ? ORDER BY deduct_level`,
    ['']
  )
  return {
    places: placeRows.map((r) => r.place),
    categories: catRows.map((r) => r.category),
    deductLevels: dedRows.map((r) => r.deduct_level),
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
async function listLibrary({ page = 1, pageSize = 50, keyword = '', place = '', category = '', deductLevel = '' } = {}) {
  const p = Number(page) || 1
  const ps = Math.min(Math.max(Number(pageSize) || 50, 1), 200)
  const offset = (p - 1) * ps
  const where = []
  const params = []
  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim()}%`
    where.push('(code LIKE ? OR place LIKE ? OR category LIKE ? OR sub_segment LIKE ? OR inspect_object LIKE ? OR content LIKE ? OR basis LIKE ? OR deduct_level LIKE ?)')
    params.push(kw, kw, kw, kw, kw, kw, kw, kw)
  }
  if (place && place.trim()) { where.push('place = ?'); params.push(place.trim()) }
  if (category && category.trim()) { where.push('category = ?'); params.push(category.trim()) }
  if (deductLevel && deductLevel.trim()) { where.push('deduct_level = ?'); params.push(deductLevel.trim()) }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLS} FROM t_violation ${whereSql} ORDER BY category, id LIMIT ${ps} OFFSET ${offset}`,
    params
  )
  const [cnt] = await pool.execute(
    `SELECT COUNT(*) AS total FROM t_violation ${whereSql}`,
    params
  )
  return { list: rows, total: cnt[0].total, page: p, pageSize: ps }
}

async function getById(id) {
  const [rows] = await pool.execute(`SELECT ${SELECT_COLS} FROM t_violation WHERE id = ?`, [id])
  return rows[0] || null
}

// 生成手工新增行的唯一 code（uk_code 不可重复）
function genManualCode() {
  return 'M' + Date.now()
}

async function create(patch = {}) {
  const category = String(patch.category == null ? '' : patch.category).trim()
  const content = String(patch.standard_basis == null ? '' : patch.standard_basis).trim()
  const basis = String(patch.source == null ? '' : patch.source).trim()
  if (!category) throw new Error('违章分类不能为空')
  if (!content) throw new Error('违章条款具体内容不能为空')
  const code = (patch.code && String(patch.code).trim()) ? String(patch.code).trim() : genManualCode()
  const [res] = await pool.execute(
    `INSERT INTO t_violation (code, place, category, sub_segment, inspect_object, content, basis, deduct_level, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      code,
      String(patch.place == null ? '' : patch.place).trim(),
      category,
      String(patch.sub_segment == null ? '' : patch.sub_segment).trim(),
      String(patch.inspect_object == null ? '' : patch.inspect_object).trim(),
      content,
      basis,
      String(patch.deduct_level == null ? '' : patch.deduct_level).trim(),
    ]
  )
  return getById(res.insertId)
}

async function update(id, patch = {}) {
  // 字段映射：对外名 → 库列名
  const map = {
    code: 'code', place: 'place', category: 'category', sub_segment: 'sub_segment',
    inspect_object: 'inspect_object', standard_basis: 'content', source: 'basis', deduct_level: 'deduct_level',
  }
  const fields = []
  const params = []
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue
    const v = String(patch[k]).trim()
    if (k === 'category' && !v) throw new Error('违章分类不能为空')
    if (k === 'standard_basis' && !v) throw new Error('违章条款具体内容不能为空')
    fields.push(`${col} = ?`)
    params.push(v)
  }
  if (!fields.length) throw new Error('未提供任何可更新字段')
  params.push(id)
  await pool.execute(`UPDATE t_violation SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params)
  return getById(id)
}

async function remove(id) {
  await pool.execute('DELETE FROM t_violation WHERE id = ?', [id])
  return true
}

// ─── 导入（UPSERT，按 code 幂等）───────────────────────────────────────────────
/**
 * @param {Array} rows  解析后的行对象，字段见 generateLibraryTemplate 表头
 * @returns {Promise<{success:Array, fail:Array}>}
 */
async function importLibrary(rows) {
  const success = []
  const fail = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {}
    const category = String(r.category == null ? '' : r.category).trim()
    const content = String(r.standard_basis == null ? (r.content == null ? '' : r.content) : r.standard_basis).trim()
    const basis = String(r.source == null ? (r.basis == null ? '' : r.basis) : r.source).trim()
    if (!category) { fail.push({ row: i + 2, reason: '违章分类为空', raw: r }); continue }
    if (!content) { fail.push({ row: i + 2, reason: '违章条款具体内容为空', raw: r }); continue }
    const code = (r.code && String(r.code).trim()) ? String(r.code).trim() : 'M' + Date.now() + '_' + i
    try {
      await pool.execute(
        `INSERT INTO t_violation (code, place, category, sub_segment, inspect_object, content, basis, deduct_level, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           place=VALUES(place), category=VALUES(category), sub_segment=VALUES(sub_segment),
           inspect_object=VALUES(inspect_object), content=VALUES(content), basis=VALUES(basis),
           deduct_level=VALUES(deduct_level), updated_at=NOW()`,
        [
          code,
          String(r.place == null ? '' : r.place).trim(),
          category,
          String(r.sub_segment == null ? '' : r.sub_segment).trim(),
          String(r.inspect_object == null ? '' : r.inspect_object).trim(),
          content,
          basis,
          String(r.deduct_level == null ? '' : r.deduct_level).trim(),
        ]
      )
      success.push({ category, code })
    } catch (e) {
      fail.push({ row: i + 2, reason: e.message, raw: r })
    }
  }
  return { success, fail }
}

// ─── 导出 ────────────────────────────────────────────────────────────────────
async function exportLibrary() {
  const [rows] = await pool.execute(
    'SELECT code, place, category, sub_segment, inspect_object, content, basis, deduct_level FROM t_violation ORDER BY category, id'
  )
  return rows || []
}

// ─── 模板 ────────────────────────────────────────────────────────────────────
function generateLibraryTemplate() {
  const headers = ['违章编号', '适用场所', '违章分类', '细分环节', '检查对象', '违章条款具体内容', '检查依据', '扣分风险等级']
  const sample = ['A1-001', '陆上油气场站', '直接作业安全', '动火作业', '作业人员', '动火作业前应办理动火许可证，落实监护与防火措施', 'GB 30871-2022', '扣2分/高风险']
  const ws = XLSX.utils.aoa_to_sheet([headers, sample])
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('安全检查依据模板')
  wb.Sheets['安全检查依据模板'] = ws
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  norm,
  loadBasisLibrary,
  matchStandardBasis,
  matchStandardBasisDb,
  getFilterOptions,
  listLibrary,
  getById,
  create,
  update,
  remove,
  importLibrary,
  exportLibrary,
  generateLibraryTemplate,
}
