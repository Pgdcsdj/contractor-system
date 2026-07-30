/**
 * 隐患 Excel 标准导入引擎（T01–T03）
 *
 * 职责（Service 纯解析 / 校验 / 落库，Router 仅做薄 HTTP 层）：
 *  - generateTemplate(buffer?)  生成标准导入模板（xlsx buffer）
 *  - previewImport(buffer, admin) 多 sheet 读取 → 清洗 → 行级校验 → 预览（不落库）
 *  - commitImport(buffer, admin, filename) 事务批量落库（失败整批回退）
 *
 * 复用既有清洗函数（原 hazardLoop.js 内联实现，已抽到本服务统一复用）：
 *  pad2 / formatDateTime / cleanPhone / normalizeLevel /
 *  editDistance / matchDictOption / autoMatchPhone / parseDate /
 *  locateHeaderRow / buildMapping / mapProgressToStatus。
 *
 * 关键约定（设计 §H）：
 *  - 状态三态 reported / rectifying / closed（本次导入只用这三态）
 *  - 每个 sheet 标题 = 隐患排查项目（hazard_investigation_item）
 *  - D4 进度文本 → 初始状态；映射出 closed 视为已闭环 → 跳过不导（skippedClosed）
 *  - 计划完成时间无法解析 → 置空 + 警告（按 D7，不默认 +7 天）
 */

const xlsx = require('xlsx')
const path = require('path')
const { pool } = require('../db/db')
const { resolveRecorderContext } = require('./permission')
const { LEVELS } = require('../constants/hazardStates')

// ─── 规范字段 → 列名别名（命中优先级：越靠前越优先；buildMapping 中长别名优先）──
const IMPORT_FIELDS = [
  { key: 'unit_name', aliases: ['单位', '承包商单位', '直属单位', '参建单位', '施工单位', '责任单位', '所属单位', '隐患单位', '承包单位', '作业单位', '施工方', '承包方'] },
  { key: 'location', aliases: ['场所站点', '位置', '站点', '场所', '地点', '部位', '区域', '点位', '施工部位', '点位名称', '站点名', '位置点', '井场', '检查地点', '检查位置', '施工位置', '井场位置', '检查点位'] },
  { key: 'hazard_level', aliases: ['隐患等级', '等级', '危险等级', '风险等级', '隐患级别', '不符合等级', '不符合级别', '问题等级'] },
  { key: 'description', aliases: ['问题描述', '隐患描述', '存在问题', '描述', '隐患内容', '隐患情况', '问题', '情况说明', '隐患简述', '不符合描述', '问题隐患', '不符合项', '隐患表述', '存在问题描述', '问题说明', '不符合情况', '隐患事实'] },
  { key: 'rectify_measures', aliases: ['整改措施', '整改方案', '防范措施', '治理措施', '整改要求', '整改内容', '整改举措', '治理方案', '整改办法'] },
  { key: 'responsible_person', aliases: ['整改责任人', '责任人', '负责人', '责任人员', '整改责任', '整改负责人', '迎审人员', '整改人', '承办人', '整改责任', '整改落实人'] },
  { key: 'responsible_phone', aliases: ['责任人电话', '联系电话', '手机', '手机号', '联系方式', '电话', '联系手机'] },
  { key: 'plan_finish_time', aliases: ['计划完成时间', '计划完成日期', '完成时限', '整改时限', '整改期限', '截止时间', '截止日期', '完成时间', '要求完成时间', '完成节点', '截止日', '应完成时间', '建议完成时限', '计划完成', '计划完工', '完工期限', '完工时间', '计划完工时间'] },
  { key: 'business_dept', aliases: ['业务归口', '发现业务室/基层单位', '业务室', '基层单位', '业务部门', '归口部门', '业务主管', '归口单位', '业务/基层单位', '业务口', '归口业务', '业务归口部门'] },
  { key: 'hazard_investigation_item', aliases: ['隐患排查项目', '排查项目', '隐患项目', '排查内容', '排查项目名称'] },
  { key: 'business_dept_head', aliases: ['业务部门负责人', '部门负责人', '业务负责人', '归口部门负责人', '业务归口负责人', '业务口负责人', '归口领导'] },
  { key: 'is_reject_item', aliases: ['是否否决项', '否决项', '是否否决', '否决', '是否否决'] },
  { key: 'deduct_score', aliases: ['扣分', '扣分数', '扣分值', '扣分项'] },
  { key: 'progress', aliases: ['整改进度', '进度', '整改情况', '整改状态', '完成情况', '治理进度', '整改进度', '状态'] },
]

// 字段 key → 中文名（用于表头模糊识别告警展示）
const FIELD_LABELS = {
  unit_name: '责任单位',
  location: '位置/部位',
  hazard_level: '隐患等级',
  description: '问题描述',
  rectify_measures: '整改措施',
  responsible_person: '整改责任人',
  responsible_phone: '责任人电话',
  plan_finish_time: '计划完成时间',
  business_dept: '业务归口部门',
  hazard_investigation_item: '隐患排查项目',
  business_dept_head: '业务部门负责人',
  is_reject_item: '是否否决项',
  deduct_score: '扣分',
  progress: '整改进度',
}

// 数字补零
function pad2(n) {
  return String(n).padStart(2, '0')
}

// Date → 'YYYY-MM-DD HH:mm:ss'
function formatDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// 手机号清洗（按 / 、,; 拆分，仅保留数字，/ 拼接）
function cleanPhone(s) {
  const v = String(s == null ? '' : s).trim()
  if (!v || v === '-') return ''
  return v
    .split(/[\/ 、,;]/)
    .map((seg) => seg.replace(/[^\d]/g, ''))
    .filter(Boolean)
    .join('/')
}

// 隐患等级归一化：返回 { level, defaulted }
// 等级名称与字典/库保持一致（隐患等级 code==name 约定），共 3 项：
//   重大隐患 / 较大隐患 / 一般隐患
// 决策 B：历史「低」等级并入「一般隐患」，故低/较小/四级/轻微 统一归一为「一般隐患」。
function normalizeLevel(v) {
  const s = String(v == null ? '' : v).trim()
  // 等级缺失（如真实台账无「隐患等级」列）→ 默认「一般隐患」，不阻断导入（设计§I9 仅计划时间为硬约束）
  if (!s) return { level: '一般隐患', defaulted: true }
  if (/严重不符合/.test(s)) return { level: '重大隐患', defaulted: false }
  if (/一般不符合/.test(s)) return { level: '一般隐患', defaulted: false }
  if (/不符合/.test(s)) return { level: '一般隐患', defaulted: false }
  if (/重大|特大|一级/.test(s)) return { level: '重大隐患', defaulted: false }
  if (/较大|二级/.test(s)) return { level: '较大隐患', defaulted: false }
  if (/一般|三级|普通/.test(s)) return { level: '一般隐患', defaulted: false }
  // 决策 B：历史「低」等级并入「一般隐患」
  if (/低|较小|四级|轻微/.test(s)) return { level: '一般隐患', defaulted: false }
  return { level: '一般隐患', defaulted: true }
}

// 编辑距离（Levenshtein，DP 实现，一次滚动数组）
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      prev = tmp
    }
  }
  return dp[n]
}

// 字典选项智能匹配：原始值 → 设置项 name（精确 / 包含 / 编辑距离 / 原值）
function matchDictOption(rawValue, options) {
  const raw = String(rawValue == null ? '' : rawValue).trim()
  if (!raw || !Array.isArray(options) || options.length === 0) {
    return { value: raw, matched: false, note: 'no-option' }
  }
  const rawKey = raw.toLowerCase()

  for (const opt of options) {
    const nameKey = String(opt.name ?? '').toLowerCase()
    const codeKey = String(opt.code ?? '').toLowerCase()
    if (rawKey === nameKey || rawKey === codeKey) {
      return { value: String(opt.name ?? ''), matched: true, note: 'exact' }
    }
  }

  let containedName = null
  for (const opt of options) {
    const name = String(opt.name ?? '')
    const nameKey = name.toLowerCase()
    if (!nameKey) continue
    if (rawKey.includes(nameKey) || nameKey.includes(rawKey)) {
      if (containedName === null || name.length > containedName.length) containedName = name
    }
  }
  if (containedName !== null) return { value: containedName, matched: true, note: 'contains' }

  if (raw.length <= 8) {
    let best = null
    let bestDist = 3
    for (const opt of options) {
      const name = String(opt.name ?? '')
      if (name.length === 0 || name.length > 8) continue
      const dd = editDistance(rawKey, name.toLowerCase())
      if (dd > 0 && dd <= 2 && dd < bestDist) {
        bestDist = dd
        best = name
      }
    }
    if (best !== null) return { value: best, matched: true, note: 'edit' }
  }

  return { value: raw, matched: false, note: 'none' }
}

// 责任人手机号自动匹配（responsible_phone 为空时，从 t_user 按姓名/单位匹配）
async function autoMatchPhone(pool, personName, unitName) {
  if (!personName) return ''
  const [rows] = await pool.execute(
    `SELECT phone FROM t_user WHERE name = ? AND (unit = ? OR supervising_unit = ?) AND phone IS NOT NULL AND phone != '' LIMIT 1`,
    [personName, unitName || '', unitName || '']
  )
  if (rows.length > 0 && rows[0].phone) return rows[0].phone
  const [rows2] = await pool.execute(
    `SELECT phone FROM t_user WHERE name LIKE ? AND phone IS NOT NULL AND phone != '' LIMIT 1`,
    [`%${personName}%`]
  )
  if (rows2.length > 0 && rows2[0].phone) return rows2[0].phone
  return ''
}

// 日期解析 → 'YYYY-MM-DD HH:mm:ss' 或 null
// Excel 序列号（数值 >40000，按 1899-12-30 元年换算，避免依赖 SSF）
function parseDate(v) {
  if (v == null || v === '') return null
  if (v instanceof Date || typeof v.getFullYear === 'function') {
    return isNaN(v.getTime()) ? null : formatDateTime(v)
  }
  if (typeof v === 'number') {
    if (v > 40000) {
      const ms = Math.round((v - 25569) * 86400000)
      const d = new Date(ms)
      if (isNaN(d.getTime())) return null
      return formatDateTime(d)
    }
    return null
  }
  const s = String(v).trim()
  if (!s) return null
  const nowYear = new Date().getFullYear()
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:[日\sT]*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const hh = m[4] ? Number(m[4]) : 0
      const mi = m[5] ? Number(m[5]) : 0
      const ss = m[6] ? Number(m[6]) : 0
      return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`
    }
  }
  const m2 = s.match(/^(\d{1,2})月(\d{1,2})日?$/)
  if (m2) {
    const mo = Number(m2[1])
    const d = Number(m2[2])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${nowYear}-${pad2(mo)}-${pad2(d)} 00:00:00`
    }
  }
  const dt = new Date(s)
  if (!isNaN(dt.getTime()) && dt.getFullYear() > 1900 && dt.getFullYear() < 9999) {
    return formatDateTime(dt)
  }
  return null
}

// 前 15 行内定位表头行：统计每行命中关键词（含别名子串）的单元格数，取最多者
function locateHeaderRow(rows) {
  const aliases = []
  IMPORT_FIELDS.forEach((f) => f.aliases.forEach((a) => aliases.push(a.replace(/\s/g, '').toLowerCase())))
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    let score = 0
    for (const cell of rows[i] || []) {
      const norm = String(cell ?? '').replace(/\s/g, '').toLowerCase()
      if (aliases.some((a) => norm.includes(a))) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestIdx
}

// 列映射：对每个规范字段，扫描表头单元格，按最长别名命中确定列号（第一遍静态子串匹配）；
// 第一遍结束后，对「第一遍完全没认出」的表头单元格追加编辑距离模糊兜底（保守阈值，宁可不匹配）。
// 返回 { mapping, notes }（notes 为智能识别告警，供预览 warnings 通道展示）。
function buildMapping(headerRow) {
  const mapping = {}
  const assignedCols = new Set()
  // 第一遍：静态别名子串包含匹配（最长别名优先）
  for (let ci = 0; ci < headerRow.length; ci++) {
    const norm = String(headerRow[ci] ?? '').replace(/\s/g, '').toLowerCase()
    if (!norm) continue
    let bestField = null
    let bestLen = 0
    for (const f of IMPORT_FIELDS) {
      if (mapping[f.key] !== undefined) continue
      for (const alias of f.aliases) {
        const aNorm = alias.replace(/\s/g, '').toLowerCase()
        if (norm.includes(aNorm) && aNorm.length > bestLen) {
          bestLen = aNorm.length
          bestField = f.key
        }
      }
    }
    // 复合表头分词增强（T5）：整单元格未命中时，按分隔符切分逐 token 复用子串最长优先匹配
    if (!bestField) {
      const tokens = norm.split(/[\/、\s\-·]+/).filter(Boolean)
      for (const token of tokens) {
        let bestFieldT = null
        let bestLenT = 0
        for (const f of IMPORT_FIELDS) {
          if (mapping[f.key] !== undefined) continue
          for (const alias of f.aliases) {
            const aNorm = alias.replace(/\s/g, '').toLowerCase()
            if (token.includes(aNorm) && aNorm.length > bestLenT) {
              bestLenT = aNorm.length
              bestFieldT = f.key
            }
          }
        }
        if (bestFieldT) {
          bestField = bestFieldT
          break
        }
      }
    }
    if (bestField) {
      mapping[bestField] = ci
      assignedCols.add(ci)
    }
  }

  // 第二遍：对第一遍未分配任何字段的表头单元格，做编辑距离模糊兜底
  const notes = []
  for (let ci = 0; ci < headerRow.length; ci++) {
    if (assignedCols.has(ci)) continue // 已确认高置信匹配，不覆盖
    const rawText = String(headerRow[ci] ?? '').trim()
    const norm = rawText.replace(/\s/g, '').toLowerCase()
    if (!norm) continue
    let bestField = null
    let bestDist = Infinity
    for (const f of IMPORT_FIELDS) {
      if (mapping[f.key] !== undefined) continue // 该字段已被别的列占用
      for (const alias of f.aliases) {
        const aNorm = alias.replace(/\s/g, '').toLowerCase()
        if (!aNorm) continue
        const d = editDistance(norm, aNorm)
        if (d < bestDist) {
          bestDist = d
          bestField = f.key
        }
      }
    }
    if (bestField !== null) {
      // 阈值保守：短别名（≤4 字）只允许 1 编辑距离，否则 2，宁可不匹配也不误匹配
      const threshold = norm.length <= 4 ? 1 : 2
      if (bestDist <= threshold) {
        mapping[bestField] = ci
        assignedCols.add(ci)
        notes.push(`表头「${rawText}」智能识别为「${FIELD_LABELS[bestField] || bestField}」`)
      }
    }
  }

  IMPORT_FIELDS.forEach((f) => {
    if (mapping[f.key] === undefined) mapping[f.key] = -1
  })
  return { mapping, notes }
}

// 进度文本 → 初始状态（D4）：已整改/完成/已闭环 → closed；整改中/施工中/进行 → rectifying；无法/缺列 → reported
function mapProgressToStatus(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return 'reported'
  if (/已整改|完成整改|已完成|已闭环|整改完成|闭环|验收通过|已销项|销项/.test(s)) return 'closed'
  if (/整改中|施工中|进行中|正在整改|正在施工|整改过程|进行|治理中/.test(s)) return 'rectifying'
  if (/无法整改|无法判断|不能整改|暂不整改|未整改|未开始|未启动|未开展/.test(s)) return 'reported'
  // 未命中的未知整改进度：保守落入 reported（待核实），不误判为已闭环
  return 'reported'
}

// 责任人拆分（\n / 顿号 / 空格 / 逗号切分），返回数组
function splitResponsible(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\n、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 签名行识别（含 项目部领导：/业务部门：/责任单位：/编制：/审核：/批准： 等）
function isSignatureRow(row) {
  const joined = row.map((c) => String(c ?? '')).join(' ')
  return /项目部领导|业务部门：|责任单位：|编制：|审核：|批准：|填报人|填报单位/.test(joined)
}

// ─── 读取工作簿为 Workbook（xlsx / xls / csv 统一）────────────────────────────
function readWorkbook(buffer, originalname = '') {
  const ext = path.extname(originalname).toLowerCase()
  if (ext === '.csv') {
    const text = buffer.toString('utf8').replace(/^﻿/, '')
    return xlsx.read(text, { type: 'string', cellDates: true })
  }
  return xlsx.read(buffer, { type: 'buffer', cellDates: true })
}

// 责任单位智能匹配：原始值（简称/别名/包含全称的子串/近似写法）→ 解析出 t_contractor_unit 全称与 id
// unitList 元素：{ id, full, short, unit_name }（full/short 已归一化小写去空格）
// 返回 { matched, id, unit_name, method? }，method ∈ 'exact'|'short'|'contains'|'edit'
function resolveUnit(raw, unitList) {
  const norm = String(raw ?? '').trim().replace(/\s/g, '').toLowerCase()
  if (!norm || !Array.isArray(unitList) || !unitList.length) {
    return { matched: false, id: null, unit_name: String(raw ?? '').trim() }
  }
  // 1) 精确全称
  for (const u of unitList) {
    if (u.full && u.full === norm) return { matched: true, id: u.id, unit_name: u.unit_name, method: 'exact' }
  }
  // 2) 精确简称
  for (const u of unitList) {
    if (u.short && u.short === norm) return { matched: true, id: u.id, unit_name: u.unit_name, method: 'short' }
  }
  // 3) 包含（双向）：取 full 最长者（最具体），避免「钻井」泛匹配误中
  let containsHit = null
  for (const u of unitList) {
    const hit =
      (u.full && (u.full.includes(norm) || norm.includes(u.full))) ||
      (u.short && (u.short.includes(norm) || norm.includes(u.short)))
    if (hit) {
      if (!containsHit || u.unit_name.length > containsHit.unit_name.length) containsHit = u
    }
  }
  if (containsHit) {
    return { matched: true, id: containsHit.id, unit_name: containsHit.unit_name, method: 'contains' }
  }
  // 4) 编辑距离兜底（仅短串，阈值 2，避免长全称被误匹配）
  if (norm.length <= 8) {
    let best = null
    let bestDist = 3
    for (const u of unitList) {
      for (const cand of [u.full, u.short]) {
        if (!cand || cand.length === 0 || cand.length > 8) continue
        const d = editDistance(norm, cand)
        if (d > 0 && d <= 2 && d < bestDist) {
          bestDist = d
          best = u
        }
      }
    }
    if (best) return { matched: true, id: best.id, unit_name: best.unit_name, method: 'edit' }
  }
  return { matched: false, id: null, unit_name: String(raw ?? '').trim() }
}

// ─── 单行清洗 + 校验（异步：含责任人电话自动匹配）────────────────────────────
async function cleanRow(row, mapping, ctx) {
  const { unitMap, unitList, bdRows, bhRows, sheetName, sheetNames } = ctx
  const getVal = (field) => {
    const idx = mapping[field]
    return idx >= 0 ? String(row[idx] ?? '').trim() : ''
  }
  const getRawVal = (field) => {
    const idx = mapping[field]
    return idx >= 0 ? row[idx] ?? '' : ''
  }

  const errors = []
  const warnings = []
  const rec = {}

  const rawDesc = getVal('description')
  const rawLevel = getVal('hazard_level')
  const rawPerson = getVal('responsible_person')
  const rawPhone = getVal('responsible_phone')
  const rawPlan = getRawVal('plan_finish_time')

  // 责任单位：列值为空时，尝试从责任人单元格切出「单位前缀」
  let rawUnit = getVal('unit_name')
  if (!rawUnit) {
    const parts = splitResponsible(rawPerson)
    for (const p of parts) {
      const key = p.replace(/\s/g, '').toLowerCase()
      if (unitMap.has(key)) {
        rawUnit = unitMap.get(key).unit_name
        warnings.push(`已从责任人单元格识别责任单位：${rawUnit}`)
        break
      }
    }
  }

  // 必填校验：问题描述 / 责任人为硬必填；隐患等级缺失→默认「一般」，责任单位缺失→置空软告警，均不阻断导入
  // （设计§A.1：系统即为导入通南巴整改台账而设计，真实台账 9 个 sheet 无「隐患等级」列、4 个 sheet 无「责任单位」列）
  if (!rawDesc) errors.push('缺少问题描述')
  if (!rawPerson) errors.push('缺少整改责任人')
  if (!rawUnit) warnings.push('缺少责任单位，已置空待人工补')

  // 单位解析（智能匹配：简称/别名/包含/近似 → 全称 id）
  let contractor_unit_id = null
  let unit_name = rawUnit
  if (rawUnit) {
    const m = resolveUnit(rawUnit, unitList)
    if (m.matched) {
      contractor_unit_id = m.id
      unit_name = m.unit_name
      if (m.method !== 'exact') {
        const tag = m.method === 'short' ? '简称匹配' : m.method === 'contains' ? '包含匹配' : '近似匹配'
        warnings.push(`责任单位智能匹配：「${rawUnit}」→「${m.unit_name}」（${tag}）`)
      }
    } else {
      warnings.push(`单位未匹配：${rawUnit}`)
    }
  }

  // 等级归一化
  const { level, defaulted } = normalizeLevel(rawLevel)
  if (defaulted && rawLevel) warnings.push(`等级无法识别，已默认一般：${rawLevel}`)
  rec.hazard_level = level

  // 责任人与电话
  const personParts = splitResponsible(rawPerson)
  rec.responsible_person = personParts.join('、')
  let phone = cleanPhone(rawPhone)
  if (!phone) {
    phone = await autoMatchPhone(pool, rec.responsible_person, unit_name)
    if (!phone) warnings.push(`责任人电话未填且未匹配到：${rec.responsible_person}`)
  }
  rec.responsible_phone = phone

  // 计划完成时间（I9：无法解析 → 置空 + 警告，不默认 +7 天）
  let planTime = parseDate(rawPlan)
  if (!planTime) {
    if (String(rawPlan).trim()) warnings.push(`计划完成时间无法解析：${String(rawPlan).trim()}，已置空待人工补`)
    planTime = ''
  }
  rec.plan_finish_time = planTime

  rec.location = getVal('location')
  rec.rectify_measures = getVal('rectify_measures')

  // 业务部门 / 业务部门负责人（字典智能匹配，未命中保留原值并告警）
  const rawBizDeptPart = getVal('business_dept')
  const mBizDept = matchDictOption(rawBizDeptPart, bdRows)
  let businessDeptValue = mBizDept.matched ? mBizDept.value : rawBizDeptPart
  if (rawBizDeptPart && !mBizDept.matched) {
    warnings.push(`业务部门未匹配到设置项，已保留原值：${rawBizDeptPart}`)
  }
  rec.business_dept = businessDeptValue

  const mBizHead = matchDictOption(getVal('business_dept_head'), bhRows)
  if (getVal('business_dept_head') && !mBizHead.matched) {
    warnings.push(`业务部门负责人未匹配到设置项，已保留原值：${getVal('business_dept_head')}`)
  }
  rec.business_dept_head = mBizHead.value

  // 是否否决项 / 扣分
  const rawReject = getVal('is_reject_item')
  rec.is_reject_item = /^(是|1|true|yes|对|y)$/i.test(rawReject.trim()) ? 1 : 0
  rec.deduct_score = getVal('deduct_score')

  // 进度 → 状态（D4）
  const progress = getVal('progress')
  const status = mapProgressToStatus(progress)
  rec.progress = progress
  rec.status = status
  rec.rectify_status = status === 'closed' ? '已完成' : status === 'rectifying' ? '整改中' : '未整改'

  // 隐患排查项目 = sheet 标题（多 sheet 覆盖列值；单 sheet 优先列值，空回退 sheet 名）
  let invItem = getVal('hazard_investigation_item')
  if (sheetNames.length === 1) {
    if (!invItem) invItem = sheetName
  } else {
    invItem = sheetName
  }
  rec.hazard_investigation_item = invItem

  rec.description = rawDesc

  // 责任单位解析结果写回（修复 Bug B：unit_name / contractor_unit_id 计算后未落库）
  rec.unit_name = unit_name
  rec.contractor_unit_id = contractor_unit_id

  return { rec, errors, warnings }
}

/**
 * 解析整个工作簿为结构化预览数据（preview / commit 共用，保证两次解析一致）。
 * @returns {Promise<{summary,sheets,rows,mapping,warnings}>}
 */
async function parseWorkbook(buffer, originalname = '') {
  const wb = readWorkbook(buffer, originalname)
  const sheetNames = wb.SheetNames || []

  // 预加载：承包商单位（单位匹配，含 short_name 用于智能匹配）、业务部门 / 负责人字典（智能匹配）
  const [unitRows] = await pool.execute('SELECT id, unit_name, short_name FROM t_contractor_unit')
  const unitMap = new Map()
  const unitList = unitRows.map((u) => ({
    id: u.id,
    full: String(u.unit_name ?? '').replace(/\s/g, '').toLowerCase(),
    short: String(u.short_name ?? '').replace(/\s/g, '').toLowerCase(),
    unit_name: u.unit_name,
  }))
  unitList.forEach((u) => {
    if (u.full) unitMap.set(u.full, { id: u.id, unit_name: u.unit_name })
  })
  const [bdRows] = await pool.execute("SELECT code,name FROM t_hazard_dict WHERE type='business_dept' AND enabled=1")
  const [bhRows] = await pool.execute("SELECT code,name FROM t_hazard_dict WHERE type='business_dept_head' AND enabled=1")

  const sheets = []
  const rows = []
  const warnings = []
  const allNotes = []
  let totalRows = 0
  let valid = 0
  let error = 0
  let skippedClosed = 0
  let firstMapping = {}

  for (const sheetName of sheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const sheetRows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' })
    const headerIdx = locateHeaderRow(sheetRows)
    if (headerIdx < 0) {
      warnings.push(`工作表「${sheetName}」未识别到表头行，已跳过`)
      sheets.push({ sheetName, rowCount: 0, valid: 0, error: 0, skippedClosed: 0 })
      continue
    }
    const headerRow = sheetRows[headerIdx].map((c) => String(c ?? '').trim())
    const { mapping, notes } = buildMapping(headerRow)
    if (!firstMapping || !Object.keys(firstMapping).length) firstMapping = mapping
    if (notes && notes.length) {
      for (const n of notes) {
        if (warnings.length < 100 && !warnings.includes(n)) warnings.push(n)
        if (allNotes.length < 100 && !allNotes.includes(n)) allNotes.push(n)
      }
    }

    const dataRows = sheetRows.slice(headerIdx + 1)
    let sheetValid = 0
    let sheetError = 0
    let sheetSkipped = 0

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i]
      if (!Array.isArray(row) || row.every((c) => !String(c ?? '').trim())) continue
      if (isSignatureRow(row)) continue

      const rowNo = headerIdx + i + 2 // 1-based 绝对行号
      const { rec, errors, warnings: rowWarnings } = await cleanRow(row, mapping, {
        unitMap, unitList, bdRows, bhRows, sheetName, sheetNames,
      })

      let rowStatus
      if (rec.status === 'closed') {
        rowStatus = 'skippedClosed'
        sheetSkipped++
        skippedClosed++
      } else if (errors.length > 0) {
        rowStatus = 'error'
        sheetError++
        error++
      } else {
        rowStatus = 'valid'
        sheetValid++
        valid++
      }

      // 行级警告并入全局（限长避免响应过大）
      if (rowWarnings.length) {
        for (const w of rowWarnings) {
          if (warnings.length < 100 && !warnings.includes(w)) warnings.push(w)
        }
      }

      rows.push({
        index: rows.length,
        sheetName,
        rowNo,
        status: rowStatus,
        data: {
          hazard_investigation_item: rec.hazard_investigation_item,
          unit_name: rec.unit_name,
          location: rec.location,
          hazard_level: rec.hazard_level,
          description: rec.description,
          rectify_measures: rec.rectify_measures,
          responsible_person: rec.responsible_person,
          responsible_phone: rec.responsible_phone,
          plan_finish_time: rec.plan_finish_time,
          status: rec.status,
          business_dept: rec.business_dept,
          business_dept_head: rec.business_dept_head,
          is_reject_item: rec.is_reject_item,
          deduct_score: rec.deduct_score,
          rectify_status: rec.rectify_status,
        },
        errors,
        warnings: rowWarnings,
      })
    }

    totalRows += sheetValid + sheetError + sheetSkipped
    sheets.push({
      sheetName,
      rowCount: sheetValid + sheetError + sheetSkipped,
      valid: sheetValid,
      error: sheetError,
      skippedClosed: sheetSkipped,
    })
  }

  // 回显映射（仅返回曾识别到的字段名）
  const echo = {}
  Object.keys(firstMapping).forEach((k) => {
    echo[k] = firstMapping[k] >= 0 ? k : null
  })

  return {
    summary: { totalSheets: sheetNames.length, totalRows, valid, error, skippedClosed },
    sheets,
    rows,
    mapping: echo,
    warnings,
    notes: allNotes,
  }
}

/**
 * 上传并返回预览（不落库）。
 * @param {Buffer} buffer 文件 buffer
 * @param {object} admin  JWT 解析出的 admin（preview 暂不需要，保留签名一致）
 */
async function previewImport(buffer, admin) {
  const parsed = await parseWorkbook(buffer)
  return {
    previewToken: 'ignored',
    summary: parsed.summary,
    sheets: parsed.sheets,
    rows: parsed.rows,
    mapping: parsed.mapping,
    warnings: parsed.warnings,
    notes: parsed.notes || [],
  }
}

// 连接级生成下一个隐患编号（事务内使用同一连接，保证一致性）
async function genCode(conn) {
  const year = new Date().getFullYear()
  const [rows] = await conn.execute(
    `SELECT MAX(CAST(SUBSTRING_INDEX(hazard_code, '-', -1) AS UNSIGNED)) AS maxSeq
       FROM t_hazard
      WHERE YEAR(report_time) = ? AND hazard_code LIKE ?`,
    [year, `YH-${year}-%`]
  )
  const maxSeq = Number(rows[0]?.maxSeq || 0)
  return `YH-${year}-${String(maxSeq + 1).padStart(4, '0')}`
}

/**
 * 事务批量落库（仅 valid 行；closed 已跳过；error 不导）。
 * 任一 INSERT 失败 → 整批 ROLLBACK，库零变更。
 * @param {Buffer} buffer
 * @param {object} admin
 * @param {string} filename
 */
async function commitImport(buffer, admin, filename = '') {
  const parsed = await parseWorkbook(buffer)
  const validRows = parsed.rows.filter((r) => r.status === 'valid').map((r) => r.data)
  const failList = parsed.rows
    .filter((r) => r.status !== 'valid')
    .map((r) => ({
      sheetName: r.sheetName,
      rowNo: r.rowNo,
      reason:
        r.status === 'error'
          ? r.errors.join('；') || '校验失败'
          : '已闭环（D3），跳过导入',
    }))

  // ─── 门禁（容错策略）：存在校验错误行（status==='error'）则整批拒绝 ───
  // 仅 error 行触发门禁；skippedClosed（已闭环 D3）不触发门禁。
  // 门禁命中时根本不开启事务、不落库任何行（含 valid 行一并拒绝），库零变更。
  if (parsed.summary.error > 0) {
    const e = new Error('存在校验错误行，已整批拒绝，请修正 Excel 后重新上传')
    e.rejected = true
    e.failList = failList
    throw e
  }

  let conn = null
  let inserted = 0
  let failAtRow = null
  try {
    conn = await pool.getConnection()
    await conn.beginTransaction()
    const recorderCtx = await resolveRecorderContext(admin)

    const INSERT_SQL = `INSERT INTO t_hazard
        (hazard_code, contractor_unit_id, unit_name, location, description, hazard_level,
         rectify_measures, responsible_person,
         plan_finish_time, business_dept, hazard_investigation_item, business_dept_head, status,
         reported_by, reported_by_name, report_time, photo_url, rectify_status,
         recorder_id, recorder_name, recorder_unit_id, recorder_unit_name, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, NULL)`

    for (const rec of validRows) {
      const hazard_code = await genCode(conn)
      const planFinish = rec.plan_finish_time ? rec.plan_finish_time : null
      await conn.execute(INSERT_SQL, [
        hazard_code,
        rec.contractor_unit_id ? Number(rec.contractor_unit_id) : null,
        rec.unit_name || '',
        rec.location || '',
        rec.description || '',
        rec.hazard_level || '',
        rec.rectify_measures || '',
        rec.responsible_person || '',
        planFinish,
        rec.business_dept || '',
        rec.hazard_investigation_item || '',
        rec.business_dept_head || '',
        rec.status || 'reported',
        admin && admin.id != null ? admin.id : null,
        admin && admin.username ? admin.username : '',
        '',
        rec.rectify_status || '未整改',
        recorderCtx.recorder_id,
        recorderCtx.recorder_name,
        recorderCtx.recorder_unit_id,
        recorderCtx.recorder_unit_name,
      ])
      inserted++
    }

    // 写导入日志
    const [logRes] = await conn.execute(
      `INSERT INTO t_import_log (filename, total_rows, success_rows, fail_rows, fail_detail, imported_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        filename || '',
        parsed.summary.totalRows,
        inserted,
        failList.length,
        JSON.stringify(failList),
        admin && admin.id != null ? admin.id : 0,
      ]
    )

    await conn.commit()
    return {
      importLogId: logRes.insertId,
      summary: {
        total: parsed.summary.totalRows,
        inserted,
        error: parsed.summary.error,
        skippedClosed: parsed.summary.skippedClosed,
      },
      failList,
      warnings: parsed.warnings,
      rollback: false,
    }
  } catch (e) {
    failAtRow = e && e.rowNo != null ? e.rowNo : null
    try {
      if (conn) await conn.rollback()
    } catch (_) {
      /* 忽略回滚异常 */
    }
    const err = new Error('导入失败，已整批回退，库未变更。原因：' + (e && e.message ? e.message : '未知错误'))
    err.rollback = true
    err.failAtRow = failAtRow
    err.original = e
    // 门禁拒绝（err.rejected）由本函数上方的 throw 直接抛出到路由层 catch，
    // 不会进入此事务回退分支；此分支仅处理真实的 DB 事务异常。
    throw err
  } finally {
    if (conn) conn.release()
  }
}

/**
 * 生成标准导入模板（单 sheet，列见设计 §E）。
 * @returns {Buffer} xlsx buffer
 */
function generateTemplate() {
  const headers = [
    '隐患排查项目', '责任单位', '场所站点', '隐患分类', '隐患等级', '问题描述',
    '整改措施', '整改责任人', '责任人电话', '计划完成时间', '业务归口',
    '业务部门负责人', '是否否决项', '扣分', '初始状态',
  ]
  const sample = [
    '主题交流会问题', '产销厂', '马10脱水井场', '设备', '一般',
    '示例：阀门法兰渗漏，需更换密封垫', '更换密封垫，紧固螺栓', '田海川',
    '13800000000', '2026-07-20', '生产服务中心', '', '否', '', '整改中',
  ]
  const aoa = [headers, sample]
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  wb.SheetNames.push('隐患导入模板')
  wb.Sheets['隐患导入模板'] = ws
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  generateTemplate,
  previewImport,
  commitImport,
  // 导出纯函数便于单元测试 / 复用
  parseDate,
  normalizeLevel,
  matchDictOption,
  mapProgressToStatus,
  resolveUnit,
  buildMapping,
  editDistance,
}
