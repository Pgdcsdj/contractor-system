/**
 * Word 试卷解析服务（甲方监督 / 石油工程类考试试卷）
 *
 * 能力：
 *  - 读取「试题卷.docx」与「参考答案.docx」两个 Word 文件（docx 即 zip，用 adm-zip 解 document.xml）。
 *  - 按章节标题（一、选择题 / 二、判断题 / 三、简答题 / 四、案例分析题 …）推断题型与每题分值。
 *  - 解析每题的题干、选项（单选/多选）、参考答案：
 *      · 客观题答案归一化：字母 A-D；判断题 √/× → 正确/错误；括号内的解析文字存入 analysis。
 *      · 主观题（简答/问答/论述/案例/分析）整段参考答案存入 answer（TEXT，不受长度限制）。
 *  - 返回结构化题目数组 + 校验报告，供 quizImport 路由写入 t_question。
 *
 * 设计约束：
 *  - 不引入新依赖（adm-zip 已在 package.json；xml 直接用正则抽取，避免 xml2js 异步开销）。
 *  - 解析失败不抛异常中断整批，单题问题进入 failList；尽量多解析。
 */

const AdmZip = require('adm-zip')

// ─── 低层：docx buffer → 段落文本数组 ────────────────────────────────────────
function extractParagraphs(buffer) {
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry('word/document.xml')
  if (!entry) throw new Error('无效的 Word 文档（缺少 word/document.xml）')
  const xml = entry.getData().toString('utf8')
  const paras = []
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>/g
  let m
  let pGuard = 0
  while ((m = pRe.exec(xml))) {
    if (++pGuard > 1000000) throw new Error('extractParagraphs pRe loop guard hit')
    const pXml = m[0]
    let text = ''
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tm
    while ((tm = tRe.exec(pXml))) text += unescapeXml(tm[1])
    // 制表符 / 换行
    text = text.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    paras.push(text)
  }
  return paras
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ─── 章节识别 ───────────────────────────────────────────────────────────────
const HEADER_RE = /^([一二三四五六七八九十]+)、\s*(.+)/
const Q_RE = /^(\d+)[.、．。]\s*(.+)/
// 仅当标题含题型关键字时才视为「顶层章节」，避免把案例分析题内的
// 子标题（如「一、事件处置流程」「二、后续重点监督事项」）误判为新章节
const SECTION_KW = /选择题|判断题|简答题|问答|论述|案例|分析题|填空|主观|作文|单选|多选/

function detectType(title) {
  if (/多选/.test(title)) return 'multiple'
  if (/选择/.test(title)) return 'single'
  if (/判断/.test(title)) return 'judgment'
  if (/简答|问答|论述|案例|分析|主观|作文/.test(title)) return 'essay'
  return 'single'
}

function detectScore(title) {
  let m = title.match(/每题\s*(\d+)\s*分/)
  if (m) return Number(m[1])
  m = title.match(/共\d+\s*题[，,、]?\s*(\d+)\s*分/)
  if (m) return Number(m[1])
  return null // 调用方按题型给默认值
}

const DEFAULT_SCORE = { single: 2, multiple: 2, judgment: 1, essay: 10 }

// 把一批段落按章节切开
function splitSections(paras) {
  const sections = []
  let cur = null
  for (const line of paras) {
    const h = line.match(HEADER_RE)
    if (h && SECTION_KW.test(h[2])) {
      const title = h[2].trim()
      cur = {
        cn: h[1],
        title,
        type: detectType(title),
        score: detectScore(title) || DEFAULT_SCORE[detectType(title)],
        lines: [],
      }
      sections.push(cur)
    } else if (cur) {
      const t = line.trim()
      if (t) cur.lines.push(t)
    }
  }
  return sections
}

// 章节内按题号切块（无题号的整段视为单题，如案例分析题）
function splitQuestionBlocks(lines) {
  const blocks = []
  let cur = null
  for (const line of lines) {
    // 遇到答题纸 / 题号清单 / 姓名行 → 结束当前题块
    if (/答题纸|题号\s*\d+|^\s*姓名\s*[:：]/.test(line)) {
      cur = null
      continue
    }
    const q = line.match(Q_RE)
    if (q) {
      cur = { num: parseInt(q[1], 10), stem: q[2].trim(), body: [line] }
      blocks.push(cur)
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (blocks.length === 0 && lines.length > 0) {
    blocks.push({ num: 1, stem: lines[0], body: lines })
  }
  return blocks
}

// 从题块中抽取选项（单行内联或多行均可）
function parseOptions(block) {
  const opts = {}
  const optRe = /([A-D])[.、．]\s*([\s\S]*?)(?=\s+[A-D][.、．]|$)/g
  for (const line of block.body) {
    for (const m of line.matchAll(optRe)) {
      const letter = m[1]
      const content = m[2].trim()
      if (content) opts[letter] = content
    }
  }
  return opts
}

// 抽取括号内的解析文字
function extractParen(s) {
  const m = s.match(/[（(]([\s\S]*?)[）)]/)
  return m ? m[1].trim() : ''
}

function stripTrailingScore(s) {
  return s.replace(/\s*[（(]\s*\d+\s*分\s*分?\s*[）)]?\s*$/, '').trim()
}

// 题干行内若嵌有选项（如「…专业技术人员。   A. 施工单位 …」），截掉选项部分只留题干
function stripInlineOptions(s) {
  const cut = s.search(/\s+[A-D][.、．]/)
  return cut >= 0 ? s.slice(0, cut).trim() : s.trim()
}

// 解析参考答案文档中某个题块
function parseAnswerBlock(block, type) {
  const firstLine = block.body[0] || ''
  if (type === 'judgment') {
    const ans = firstLine.replace(/^\d+[.、．。]\s*/, '')
    const mark = ans.trim()[0]
    const std = mark === '√' || mark === '✔' || mark === '正确' ? '正确' : '错误'
    return { answer: std, analysis: extractParen(ans.slice(1)) }
  }
  if (type === 'single' || type === 'multiple') {
    const ans = firstLine.replace(/^\d+[.、．。]\s*/, '')
    const lm = ans.match(/[A-D]+/)
    const std = lm ? lm[0].toUpperCase() : ''
    const rest = lm ? ans.slice(ans.indexOf(lm[0]) + lm[0].length) : ans
    return { answer: std, analysis: rest.trim() }
  }
  // essay：整段参考答案（去掉题号前缀）
  const text = block.body
    .map((l) => l.replace(/^\d+[.、．。]\s*/, ''))
    .join('\n')
    .trim()
  return { answer: text, analysis: '' }
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────
function parseExamPaper(questionsBuffer, answersBuffer) {
  const qParas = extractParagraphs(questionsBuffer)
  const aParas = answersBuffer ? extractParagraphs(answersBuffer) : []

  const qSections = splitSections(qParas)
  const aSections = aSectionsSafe(aParas)

  const questions = []
  const failList = []
  const perType = { single: 0, multiple: 0, judgment: 0, essay: 0 }

  const nSec = Math.max(qSections.length, aSections.length)
  for (let si = 0; si < nSec; si++) {
    const qs = qSections[si]
    const as = aSections[si]
    if (!qs) {
      failList.push({ section: si + 1, error: '参考答案存在但试题卷缺少对应章节' })
      continue
    }
    const qBlocks = splitQuestionBlocks(qs.lines)
    const aBlocks = as ? splitQuestionBlocks(as.lines) : []

    for (let i = 0; i < qBlocks.length; i++) {
      const qb = qBlocks[i]
      const ab = aBlocks[i]
      const type = qs.type
      let questionText = qb.stem
      if (type === 'essay') {
        const cont = qb.body.slice(1).join('\n').trim()
        questionText = cont ? `${qb.stem}\n${cont}` : qb.stem
      } else if (type === 'single' || type === 'multiple') {
        questionText = stripInlineOptions(qb.stem)
      }
      questionText = stripTrailingScore(questionText)
      if (!questionText) {
        failList.push({ section: si + 1, question: i + 1, error: '题干为空' })
        continue
      }

      const options = type === 'single' || type === 'multiple' ? parseOptions(qb) : null
      let answer = ''
      let analysis = ''
      if (ab) {
        const pa = parseAnswerBlock(ab, type)
        answer = pa.answer
        analysis = pa.analysis
      } else {
        failList.push({ section: si + 1, question: i + 1, error: '缺少参考答案' })
      }

      // 校验
      if (type !== 'essay' && !answer) {
        failList.push({ section: si + 1, question: i + 1, error: '客观题缺少答案' })
      }
      if ((type === 'single' || type === 'multiple') && Object.keys(options || {}).length < 2) {
        failList.push({ section: si + 1, question: i + 1, error: '选项不足 2 个' })
      }

      questions.push({
        type,
        question: questionText,
        options: options && Object.keys(options).length ? options : null,
        answer,
        analysis,
        score: qs.score,
        sort_order: questions.length + 1,
      })
      perType[type]++
    }
  }

  return {
    questions,
    validation: {
      total: questions.length,
      perType,
      fail: failList.length,
      failPreview: failList.slice(0, 20),
    },
  }
}

// 参考答案可能为空（仅主观题或无答案文件）
function aSectionsSafe(aParas) {
  if (!aParas.length) return []
  return splitSections(aParas)
}

module.exports = { parseExamPaper, extractParagraphs }
