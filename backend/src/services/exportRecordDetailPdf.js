/**
 * 单条答题明细 PDF 导出
 *
 * 数据源：复用 GET /api/record/:id/detail 组装好的
 *         { record, totalCorrect, totalCount, detail }
 * 字体：assets/fonts/NotoSansCJKsc-Regular.ttf（单字体）
 *       按题库/人员/固定文案实际用字裁剪的精简子集，随后端镜像发布。
 *       标题与强调改用字号、颜色区分，不再嵌入第二套粗体，以压缩 PDF 体积。
 *
 * 说明：题干/选项/标准答案/解析来自题库实时数据；用户答案/得分/对错/评语来自
 *       t_record.answers 快照。本服务不查库，只负责排版成可归档的 PDF。
 */
const PDFDocument = require('pdfkit')
const path = require('path')
const fs = require('fs')

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts')
const FONT_REG = path.join(FONT_DIR, 'NotoSansCJKsc-Regular.ttf')

const TYPE_LABEL = { single: '单选题', multiple: '多选题', judgment: '判断题', essay: '简答题' }
const MODE_LABEL = { exam: '正式考试', practice: '练习', study: '学习' }

function pad2(n) { return String(n).padStart(2, '0') }

function fmtTime(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function fmtDuration(sec) {
  sec = Number(sec) || 0
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

function letters(v) {
  return String(v == null ? '' : v).toUpperCase().match(/[A-Z]/g) || []
}

function answerLabel(v, type) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return '（未作答）'
  if (type === 'judgment') {
    const up = s.toUpperCase()
    if (['A', 'TRUE', 'T', '1'].includes(up) || ['正确', '对'].includes(s)) return '正确'
    if (['B', 'FALSE', 'F', '0'].includes(up) || ['错误', '错'].includes(s)) return '错误'
  }
  return s
}

function safeFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40)
}

// 字体子集未覆盖的字形统一替换，避免 PDF 出现缺字方块（例如 H₂S → H2S）
const UNSUPPORTED_GLYPHS = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '·': '-', '✓': '', '✗': '',
}
function clean(text) {
  return String(text == null ? '' : text).replace(/[₀-₉·✓✗]/g, (ch) => UNSUPPORTED_GLYPHS[ch] || ch)
}

/**
 * @param {{record:object,totalCorrect:number,totalCount:number,detail:Array}} data
 * @returns {Promise<Buffer>}
 */
function generateRecordDetailPdf(data) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FONT_REG)) {
      return reject(new Error('PDF 中文字体缺失：' + FONT_DIR))
    }

    const doc = new PDFDocument({
      size: 'A4',
      compress: true,          // 内容流 Flate 压缩，实测可降约一半体积
      bufferPages: true,
      margins: { top: 58, bottom: 62, left: 46, right: 46 },
      info: { Title: '答题明细报告', Author: '中石化中原油田普光分公司通南巴项目部' },
    })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    doc.registerFont('cn', FONT_REG)
    // 只用一套字形：原粗体处改由字号与颜色区分层次，避免重复嵌入一套字体
    const FONT_STRONG = 'cn'

    const W = doc.page.width - 92
    const LEFT = 46
    const exportedAt = fmtTime(new Date())
    const r = data.record || {}
    const detail = Array.isArray(data.detail) ? data.detail : []

    function pageHeader() {
      doc.font(FONT_STRONG).fontSize(9.5).fillColor('#1a73e8')
        .text('通南巴项目部 - 培训考试答题明细报告', LEFT, 28, { width: W, lineBreak: false })
      doc.moveTo(LEFT, 46).lineTo(LEFT + W, 46).strokeColor('#c9d6e5').lineWidth(0.8).stroke()
      doc.y = 62
    }

    // 所有新增页（含 pdfkit 自动分页）统一自动补页眉
    doc.on('pageAdded', pageHeader)

    function ensure(height) {
      if (doc.y + height > doc.page.height - 76) {
        doc.addPage()
      }
    }

    // 两栏信息行（手动维护 y，避免 pdfkit 对 continued 的换行差异）
    function infoRow(label, value, y) {
      doc.font(FONT_STRONG).fontSize(9.5).fillColor('#64748b')
        .text(label, LEFT, y, { width: 86, lineBreak: false })
      doc.font('cn').fontSize(10).fillColor('#1f2937')
        .text(clean(value == null || value === '' ? '-' : value), LEFT + 92, y,
              { width: W - 92, height: 14, ellipsis: true, lineBreak: false })
    }

    function line(text, key, color, indent) {
      doc.font(key).fontSize(10).fillColor(color || '#1f2937')
        .text(clean(text), LEFT + (indent || 0), doc.y, { width: W - (indent || 0), lineGap: 2 })
    }

    pageHeader()

    // ── 标题 ─────────────────────────────────────────────────────────────────
    doc.font(FONT_STRONG).fontSize(18).fillColor('#1a73e8')
      .text('答题明细报告', LEFT, doc.y, { width: W, align: 'center' })
    doc.moveDown(1.2)

    // ── 基本信息 ─────────────────────────────────────────────────────────────
    const maxScore = Number(r.maxScore) || 0
    const score = Number(r.score) || 0
    const passRate = maxScore > 0 ? Math.round(score / maxScore * 100) : 0
    const accurate = (Number(data.totalCount) || 0) > 0
      ? Math.round((Number(data.totalCorrect) || 0) / Number(data.totalCount) * 100) : 0

    const rows = [
      ['姓名', r.userName || '-'],
      ['所属单位', r.unit || r.supervisingUnit || '未填'],
      ['主管单位', r.supervisingUnit || '-'],
      ['试卷名称', r.materialTitle || '-'],
      ['作答模式', MODE_LABEL[r.mode] || r.mode || '-'],
      ['提交时间', fmtTime(r.submittedAt)],
      ['答题耗时', fmtDuration(r.durationSec)],
      ['成绩 / 满分', `${score} / ${maxScore} 分`],
      ['及格线', `${r.passScore || 0} 分`],
      ['考试结果', r.passed ? '及格' : '不及格'],
      ['答对题数', `${data.totalCorrect || 0} / ${data.totalCount || 0} 题（正确率 ${accurate}%）`],
      ['主观题评分', r.essayGraded ? '已人工评分' : '无主观题 / 待评分'],
    ]
    rows.forEach(([k, v]) => {
      ensure(22)
      const y = doc.y
      infoRow(k, v, y)
      doc.y = y + 19
    })

    doc.moveDown(0.5)
    ensure(24)
    doc.rect(LEFT, doc.y - 2, W, 24).fill('#eef4fb')
    doc.font(FONT_STRONG).fontSize(10).fillColor('#1a73e8')
      .text(`得分率 ${passRate}%　|　满分 ${maxScore} 分　|　共 ${data.totalCount || 0} 题`, LEFT + 10, doc.y + 3,
            { width: W - 20, lineBreak: false })
    doc.y += 28

    // ── 逐题明细 ─────────────────────────────────────────────────────────────
    doc.moveDown(0.6)
    ensure(26)
    doc.font(FONT_STRONG).fontSize(12).fillColor('#1f2937').text('逐题作答明细', { width: W })
    doc.moveDown(0.5)

    detail.forEach((q) => {
      ensure(78)
      const headY = doc.y
      doc.font(FONT_STRONG).fontSize(10.5).fillColor('#1a73e8')
        .text(`第 ${q.index} 题  ${TYPE_LABEL[q.type] || '其他'}`, LEFT, headY, { width: W * 0.55, lineBreak: false })
      doc.font(FONT_STRONG).fontSize(10).fillColor(q.isCorrect ? '#1d9e75' : '#d64545')
        .text(`${q.score || 0} / ${q.maxScore || 0} 分   ${q.isCorrect ? '正确' : '错误'}`,
              LEFT + W * 0.55, headY, { width: W * 0.45, align: 'right', lineBreak: false })
      doc.y = headY + 18

      line(String(q.question || ''), 'cn', '#1f2937')

      if (q.imageUrl) {
        line(`题目配图：${q.imageUrl}`, 'cn', '#94a3b8')
      }

      // 单选 / 多选：列出选项并标记用户答案与正确答案
      if (q.options && typeof q.options === 'object' && (q.type === 'single' || q.type === 'multiple')) {
        const user = letters(q.userAnswer)
        const correct = letters(q.correctAnswer)
        Object.keys(q.options).sort().forEach((k) => {
          const kk = String(k).toUpperCase()
          let mark = ''
          let color = '#334155'
          if (user.includes(kk) && correct.includes(kk)) { mark = '   [你的答案-正确]'; color = '#1d9e75' }
          else if (user.includes(kk)) { mark = '   [你的答案-错误]'; color = '#d64545' }
          else if (correct.includes(kk)) { mark = '   [正确答案]'; color = '#1d9e75' }
          ensure(18)
          line(`${kk}. ${q.options[k]}${mark}`, 'cn', color, 14)
        })
      }

      // 判断题
      if (q.type === 'judgment') {
        line(`你的答案：${answerLabel(q.userAnswer, q.type)}　 正确答案：${answerLabel(q.correctAnswer, q.type)}`,
             'cn', '#334155', 14)
      }

      // 简答题：用户作答 / 参考答案 / 人工评语
      if (q.type === 'essay' || (!q.options && q.type !== 'judgment')) {
        line(`你的答案：${answerLabel(q.userAnswer, q.type)}`, 'cn', '#334155', 14)
        if (q.correctAnswer) line(`参考答案：${q.correctAnswer}`, 'cn', '#64748b', 14)
        if (q.comment) line(`批改评语：${q.comment}`, 'cn', '#b45309', 14)
      }

      if (q.analysis) {
        line(`解析：${q.analysis}`, 'cn', '#64748b', 14)
      }

      ensure(14)
      doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + W, doc.y + 4).strokeColor('#e2e8f0').lineWidth(0.6).stroke()
      doc.y += 12
    })

    // ── 签收栏 ───────────────────────────────────────────────────────────────
    doc.moveDown(1)
    ensure(60)
    doc.font('cn').fontSize(10).fillColor('#334155')
      .text('考生签名：________________　　考评人签名：________________　　日期：______年____月____日',
            LEFT, doc.y, { width: W, lineBreak: false })
    doc.moveDown(0.8)
    doc.font('cn').fontSize(8).fillColor('#94a3b8')
      .text('说明：本报告由通南巴项目部培训管理系统依据答题记录自动生成；学时认定以培训档案记录为准。',
            LEFT, doc.y, { width: W })

    // ── 页脚页码 ─────────────────────────────────────────────────────────────
    const range = doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i)
      doc.font('cn').fontSize(8).fillColor('#98a2b3')
        .text(`第 ${i - range.start + 1} / ${range.count} 页　　导出时间：${exportedAt}`,
              LEFT, doc.page.height - 54, { width: W, height: 12, align: 'center', lineBreak: false })
    }

    doc.end()
  })
}

function detailPdfFilename(data, id) {
  const name = safeFilename((data.record && data.record.userName) || '考生')
  const title = safeFilename((data.record && data.record.materialTitle) || '试卷')
  return `答题明细_${name}_${title}_${id}.pdf`
}

module.exports = { generateRecordDetailPdf, detailPdfFilename }
