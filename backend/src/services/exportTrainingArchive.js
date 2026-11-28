/**
 * 培训档案导出（六类导出物，应对上级检查）
 *
 * 制度依据：中原油勘制〔2024〕39号 3.10.1「一期一档」、3.10.2「一人一档」
 *
 * ⛔ 数据真实性红线：《生产经营单位安全培训规定》第31条规定，编造安全培训记录、
 *    档案的，警告、吊销安全资格证书并处 3 万元罚款。因此：
 *    · 未录入的学时一律显示 0，不做估算填充；
 *    · 签到签名栏留空，由本人现场手签；
 *    · 附件缺失项如实标注「待补」，不虚构成「已归档」。
 */

const xlsx = require('xlsx')
const { APP_VERSION, BUILD_DATE } = require('../version')
const { CHECKLIST_KEYS } = require('./trainingArchiveService')

const today = () => new Date().toLocaleDateString('zh-CN')
const pad = (n) => String(n).padStart(2, '0')

function fmtTime(v) {
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDate(v) {
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v).slice(0, 10)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function pct(a, b) {
  return b > 0 ? Math.round((a / b) * 1000) / 10 + '%' : '-'
}
function fmtDuration(sec) {
  const s = Number(sec) || 0
  if (s < 60) return `${s}秒`
  return `${Math.floor(s / 60)}分${s % 60}秒`
}
function fmtSize(bytes) {
  const b = Number(bytes) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 单位兜底：t_user.unit 有 89 人（约占 12%）为空且无承包商关联，
 * 直接输出空串在档案里像漏项，统一标「未填」并提示补录。
 */
function unitText(v) {
  const s = String(v || '').trim()
  return s || '未填'
}

/** 统一页脚：制表人 / 制表日期 / 系统版本，便于溯源 */
function footerRows(extra) {
  return [
    [],
    ['制表人', '', '制表日期', today(), ...(extra || [])],
    ['系统版本', APP_VERSION, '数据来源', '通南巴承包商安全培训与隐患整改闭环系统'],
  ]
}

function setCols(ws, widths) {
  ws['!cols'] = widths.map((w) => ({ wch: w }))
}

/* ───────────────────────── ① 一期一档合集（6 Sheet） ───────────────────────── */

function buildSessionPack({ session, roster, scores }) {
  const s = session
  const sum = roster.summary
  const sc = scores.summary
  const wb = xlsx.utils.book_new()

  // Sheet1 培训基本情况表
  const basic = [
    [`${s.title || ''} · 培训档案`],
    [],
    ['项目', '内容', '备注'],
    ['培训名称', s.title || '', ''],
    ['培训类别', s.category_name || '', ''],
    ['培训时间', `${fmtDate(s.session_date)} ${s.time_range || ''}`.trim(), ''],
    ['培训地点', s.location || '', ''],
    ['主讲人', s.lecturer || '', s.lecturer_unit || ''],
    ['培训学时', Number(s.hours || 0), '人工录入，作为学时台账依据'],
    ['培训方式', s.train_mode || '', ''],
    ['组织单位', s.organizer || '', ''],
    ['参训范围', s.target_desc || '', ''],
    ['应参人数', sum.expected, '按试卷目标人群统计'],
    ['实参人数', sum.actual, '以正式考试记录认定'],
    ['参训率', pct(sum.actual, sum.expected), ''],
    ['考核方式', s.assessment_type || '', '8学时以上须组织考核'],
    ['合格人数', sc.passed, ''],
    ['合格率', pct(sc.passed, sc.rows), ''],
    ['平均得分率', sc.avgRate ? sc.avgRate + '%' : '-', ''],
    ['档案状态', s.status === 'archived' ? '已归档' : s.status === 'done' ? '已完成' : '计划中', ''],
    ...footerRows(),
  ]
  const ws1 = xlsx.utils.aoa_to_sheet(basic)
  setCols(ws1, [16, 46, 34])
  xlsx.utils.book_append_sheet(wb, ws1, '1-基本情况')

  // Sheet2 参训人员签到表（签名留空）
  const signHead = ['序号', '姓名', '单位', '岗位', '联系电话', '签到时间', '本人签名']
  const signRows = roster.list.map((p, i) => [
    i + 1, p.name || '', unitText(p.unit), p.position || '', p.phone || '',
    p.firstSubmit ? fmtTime(p.firstSubmit) : '（未参加）', '',
  ])
  const ws2 = xlsx.utils.aoa_to_sheet([
    [`培训签到表 —— ${s.title || ''}`],
    [`时间：${fmtDate(s.session_date)} ${s.time_range || ''}　地点：${s.location || ''}　主讲人：${s.lecturer || ''}`],
    [],
    signHead,
    ...signRows,
    [],
    ['合计', `${signRows.length} 人`, '', '', '', '', ''],
    ...footerRows(),
  ])
  setCols(ws2, [6, 12, 26, 14, 15, 20, 18])
  xlsx.utils.book_append_sheet(wb, ws2, '2-签到表')

  // Sheet3 考核成绩表
  const scoreHead = ['序号', '姓名', '单位', '岗位', '试卷', '得分', '满分', '得分率', '是否合格', '用时', '提交时间', '提交方式', '记录编号', '签名校验']
  const scoreRows = scores.list.map((r, i) => [
    i + 1, r.name || '', unitText(r.unit), r.position || '', r.material_title || '',
    Number(r.score), Number(r.max_score), (r.rate || 0) + '%', r.passed ? '合格' : '不合格',
    fmtDuration(r.duration_sec), fmtTime(r.submitted_at), r.is_offline ? '离线上传' : '在线提交',
    r.record_id, r.hash ? '有效' : '无',
  ])
  const ws3 = xlsx.utils.aoa_to_sheet([
    [`考核成绩表 —— ${s.title || ''}`],
    [`考试时间：${fmtDate(s.session_date)}　应参 ${sum.expected} 人 / 实参 ${sum.actual} 人 / 合格 ${sc.passed} 人`],
    [],
    scoreHead,
    ...scoreRows,
    [],
    ['说明', '「签名校验」为系统对答题记录的防篡改签名，可用于证明成绩记录未被修改。'],
    ...footerRows(),
  ])
  setCols(ws3, [6, 10, 24, 14, 30, 7, 7, 9, 9, 10, 18, 10, 10, 9])
  xlsx.utils.book_append_sheet(wb, ws3, '3-成绩表')

  // Sheet4 培训内容与课时安排
  const mats = s.materials || []
  const contentRows = mats.map((m, i) => [
    i + 1, m.title || '', m.question_cnt || 0, Number(m.pass_score) || 0,
    m.target_type === 'all' ? '全体' : m.target_type === 'unit' ? '按单位' : m.target_type === 'position' ? '按岗位' : '指定人员',
  ])
  const ws4 = xlsx.utils.aoa_to_sheet([
    [`培训内容与课时安排 —— ${s.title || ''}`],
    [],
    ['培训学时', Number(s.hours || 0), '培训方式', s.train_mode || '', '主讲人', s.lecturer || ''],
    [],
    ['序号', '试卷/题库名称', '题量', '及格分', '考核对象'],
    ...contentRows,
    [],
    ['备注', '具体授课内容以课件为准，本表仅列考核题库范围，作为培训内容的量化佐证。'],
    ...footerRows(),
  ])
  setCols(ws4, [6, 46, 8, 8, 14, 14, 14])
  xlsx.utils.book_append_sheet(wb, ws4, '4-内容与课时')

  // Sheet5 培训效果评估
  const dist = { 优秀: 0, 良好: 0, 合格: 0, 不合格: 0 }
  for (const r of scores.list) {
    const rate = Number(r.rate || 0)
    if (!r.passed) dist.不合格++
    else if (rate >= 90) dist.优秀++
    else if (rate >= 80) dist.良好++
    else dist.合格++
  }
  const ws5 = xlsx.utils.aoa_to_sheet([
    [`培训效果评估 —— ${s.title || ''}`],
    [],
    ['评估指标', '数值', '说明'],
    ['应参人数', sum.expected, ''],
    ['实参人数', sum.actual, ''],
    ['参训率', pct(sum.actual, sum.expected), '参训率低于 100% 须说明原因并组织补训'],
    ['考核人次', sc.rows, '一人多卷按多次计'],
    ['合格人次', sc.passed, ''],
    ['合格率', pct(sc.passed, sc.rows), ''],
    ['平均得分率', sc.avgRate ? sc.avgRate + '%' : '-', ''],
    [],
    ['成绩分布', '人次', '占比'],
    ['优秀（≥90%）', dist.优秀, pct(dist.优秀, sc.rows)],
    ['良好（80-89%）', dist.良好, pct(dist.良好, sc.rows)],
    ['合格（60-79%）', dist.合格, pct(dist.合格, sc.rows)],
    ['不合格（<60%）', dist.不合格, pct(dist.不合格, sc.rows)],
    [],
    ['评估结论', sum.actual >= sum.expected && sc.passed === sc.rows && sc.rows > 0 ? '培训覆盖到位，考核全部合格' : '存在未参训或考核不合格人员，需组织补训补考'],
    ['改进措施', ''],
    ['评估人', ''],
    ['评估日期', ''],
    ...footerRows(),
  ])
  setCols(ws5, [20, 12, 50])
  xlsx.utils.book_append_sheet(wb, ws5, '5-效果评估')

  // Sheet6 附件清单（勾选状态 + 实际上传文件）
  let checklist = s.doc_checklist
  if (typeof checklist === 'string') { try { checklist = JSON.parse(checklist) } catch { checklist = {} } }
  checklist = checklist || {}
  const atts = s.attachments || []
  const catLabel = Object.fromEntries(CHECKLIST_KEYS)
  const checklistRows = CHECKLIST_KEYS.map(([k, label], i) => {
    const files = atts.filter((a) => a.category === k)
    const status = files.length ? '已上传' : checklist[k] ? '已勾选未上传' : '待补'
    const note = files.length
      ? files.map((f) => f.original_name).join('、')
      : checklist[k] ? '已勾选但未见上传原件，建议补传' : '请在「培训档案」页面上传或勾选到位后重新导出'
    return [i + 1, label, status, note]
  })
  const attachmentRows = atts.length
    ? atts.map((a, i) => [
        i + 1, catLabel[a.category] || '其他', a.original_name || '', fmtSize(a.file_size),
        a.uploaded_by_name || '', fmtTime(a.uploaded_at), a.cos_url || '',
      ])
    : [['—', '—', '（暂无已上传附件）', '', '', '', '']]
  const ws6 = xlsx.utils.aoa_to_sheet([
    [`培训档案附件清单 —— ${s.title || ''}`],
    [],
    ['一、归档材料到位情况'],
    ['序号', '归档材料', '状态', '备注'],
    ...checklistRows,
    [],
    ['二、实际上传附件明细'],
    ['序号', '材料类别', '文件名', '大小', '上传人', '上传时间', '下载地址'],
    ...attachmentRows,
    [],
    ['说明', '按《中原油田安全生产教育和培训管理细则》3.10.1「一期一档」要求，上述材料应齐全后装订成册。'],
    ['', '下载地址为腾讯云 COS 公网直链；单个附件不超过 20M，支持 PDF/Word/RAR/图片等格式。'],
    ['', '每期培训班结束 10 个工作日内须导入中国石化安全管理信息系统（3.10.3）。'],
    ...footerRows(),
  ])
  setCols(ws6, [6, 18, 34, 12, 14, 18, 60])
  xlsx.utils.book_append_sheet(wb, ws6, '6-附件清单')

  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/* ───────────────────────── ② 空白签到表 ───────────────────────── */

function buildSignSheet({ session, roster }) {
  const s = session
  const rows = roster.list.map((p, i) => [
    i + 1, p.name || '', unitText(p.unit), p.position || '', p.phone || '', '', '',
  ])
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([
    [`${s.title || ''} 培训签到表`],
    [`培训时间：${fmtDate(s.session_date)} ${s.time_range || ''}`],
    [`培训地点：${s.location || ''}`],
    [`主 讲 人：${s.lecturer || ''}　　学时：${Number(s.hours || 0)} 学时`],
    [],
    ['序号', '姓名', '单位', '岗位', '联系电话', '签到时间', '本人签名'],
    ...rows,
    [],
    ['应到', `${roster.summary.expected} 人`, '实到', '____ 人', '缺席', '____ 人'],
    ...footerRows(),
  ])
  setCols(ws, [6, 12, 28, 14, 15, 16, 20])
  xlsx.utils.book_append_sheet(wb, ws, '签到表')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/* ───────────────────────── ③ 成绩表 ───────────────────────── */

function buildScoreSheet({ session, scores }) {
  const s = session
  const rows = scores.list.map((r, i) => [
    i + 1, r.name || '', unitText(r.unit), r.position || '', r.material_title || '',
    Number(r.score), Number(r.max_score), (r.rate || 0) + '%', r.passed ? '合格' : '不合格',
    fmtDuration(r.duration_sec), fmtTime(r.submitted_at), r.is_offline ? '离线上传' : '在线提交',
  ])
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([
    [`${s.title || ''} 考核成绩表`],
    [`培训日期：${fmtDate(s.session_date)}　应参 ${scores.summary.rows ? session.expected_count || '' : ''} 人　合格 ${scores.summary.passed} 人次`],
    [],
    ['序号', '姓名', '单位', '岗位', '试卷', '得分', '满分', '得分率', '是否合格', '用时', '提交时间', '提交方式'],
    ...rows,
    ...footerRows(),
  ])
  setCols(ws, [6, 10, 24, 14, 28, 7, 7, 9, 9, 10, 18, 10])
  xlsx.utils.book_append_sheet(wb, ws, '成绩表')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/* ───────────────────────── ④ 一人一档 ───────────────────────── */

function buildPersonArchive(person) {
  const u = person.user
  const sum = person.summary
  const rows = person.records.map((r, i) => [
    i + 1,
    r.session_date ? fmtDate(r.session_date) : fmtTime(r.submitted_at),
    r.session_title || r.material_title || '',
    r.category_name || '',
    r.session_id ? Number(r.hours || 0) : 0,
    r.material_title || '',
    r.assessment_type || '闭卷考试',
    Number(r.score),
    Number(r.max_score),
    r.passed ? '合格' : '不合格',
  ])
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([
    ['个人安全培训档案（一人一档）'],
    [],
    ['姓名', u.name || '', '单位', unitText(u.unit)],
    ['岗位', u.position || '', '身份证号', u.id_card || ''],
    ['主管单位', u.supervising_unit || '', '联系电话', u.phone || ''],
    [],
    ['序号', '培训时间', '培训名称', '培训类别', '学时', '考核项目', '考核方式', '得分', '满分', '结果'],
    ...rows,
    [],
    ['本年度累计学时', sum.totalHours, '岗位学时标准', sum.standard, '是否达标', sum.qualified ? '达标' : `未达标（差 ${sum.gap} 学时）`],
    ['考核项目数', sum.total, '合格数', sum.passed],
    [],
    ['说明', '学时标准依据《中国石化安全生产教育和培训管理办法》3.3.4.3：基层员工≥20学时/年，班组长≥24学时/年。'],
    ...footerRows(),
  ])
  setCols(ws, [6, 14, 34, 16, 8, 30, 12, 8, 8, 10])
  xlsx.utils.book_append_sheet(wb, ws, '一人一档')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/* ───────────────────────── ⑤ 年度学时统计 ───────────────────────── */

function buildAnnualStats(list, year) {
  const rows = list.map((r, i) => [
    i + 1, r.name || '', unitText(r.unit), r.position || '',
    Number(r.session_cnt || 0), Number(r.total_hours || 0), Number(r.standard),
    Number(r.gap || 0), r.qualified ? '达标' : '未达标',
  ])
  const qualified = list.filter((r) => r.qualified).length
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([
    [`${year} 年度安全培训学时统计表`],
    [],
    ['序号', '姓名', '单位', '岗位', '参训场次', '累计学时', '学时标准', '差额', '达标情况'],
    ...rows,
    [],
    ['合计', `${list.length} 人`, '', '', '', '', '', '', `达标 ${qualified} 人 / 未达标 ${list.length - qualified} 人`],
    [],
    ['标准依据', '《中国石化安全生产教育和培训管理办法》中国石化制〔2024〕24号 3.3.4.3：基层员工≥20学时/年，班组长≥24学时/年'],
    ['说明', '学时由各培训场次录入值累加，同一场次多张试卷不重复计学时。'],
    ...footerRows(),
  ])
  setCols(ws, [6, 12, 26, 14, 10, 10, 10, 8, 12])
  xlsx.utils.book_append_sheet(wb, ws, `${year}学时统计`)
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/* ───────────────────────── ⑥ 培训台账 ───────────────────────── */

function buildLedger(ledger) {
  const rows = ledger.list.map((r, i) => [
    i + 1, fmtDate(r.session_date), r.title || '', r.category_name || '',
    Number(r.hours || 0), r.location || '', r.lecturer || '',
    r.expected_count || 0, r.actual_count || 0,
    pct(r.actual_count, r.expected_count), r.passed_count || 0,
    r.avg_rate ? r.avg_rate + '%' : '-',
    `${r.doc_ready}/${r.doc_total}`,
    r.status === 'archived' ? '已归档' : r.status === 'done' ? '已完成' : '计划中',
  ])
  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.aoa_to_sheet([
    [`${ledger.year} 年度安全培训台账`],
    [`全年共 ${ledger.summary.sessions} 期，累计 ${ledger.summary.totalHours} 学时`],
    [],
    ['序号', '培训日期', '培训名称', '类别', '学时', '地点', '主讲人', '应参', '实参', '参训率', '合格数', '平均得分率', '档案完整度', '状态'],
    ...rows,
    [],
    ['说明', '档案完整度 = 已归档附件数 / 应归档 7 项。'],
    ...footerRows(),
  ])
  setCols(ws, [6, 13, 32, 14, 7, 18, 12, 7, 7, 9, 8, 11, 11, 9])
  xlsx.utils.book_append_sheet(wb, ws, '培训台账')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = {
  buildSessionPack,
  buildSignSheet,
  buildScoreSheet,
  buildPersonArchive,
  buildAnnualStats,
  buildLedger,
  BUILD_DATE,
}
