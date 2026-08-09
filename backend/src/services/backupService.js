/**
 * 数据备份与导出服务（模块 D 后端）
 *
 * - backupNow()     全量导出 t_hazard（deleted_at IS NULL）→ backend/backups/hazard_backup_YYYYMMDD_HHMMSS.xlsx
 * - exportReport()  按选中字段 / 时间范围 / 类型（ledger|weekly|monthly）生成 Excel（含汇总行），返回 buffer
 * - listBackups()   列出 backups 目录下的备份文件
 * - pruneBackups()  删除超过保留天数的备份文件
 *
 * 导出字段白名单与中文列头严格对齐设计 §8.7；文件名格式对齐 §8.6。
 * 统计口径（§8.8）：周/月报按 created_at（录入时间）归集"新增数"，并附闭环数 / 超期数 / 责任单位排名。
 */

const fs   = require('fs')
const path = require('path')
const XLSX = require('xlsx')
const { pool } = require('../db/db')

const BACKUPS_DIR = path.resolve(__dirname, '../../backups')

// 导出字段白名单：字段编码 → 中文列头（设计 §8.7，顺序即导出列顺序）
// 注意：t_hazard 表已删除 responsible_phone 列，白名单内不能保留该字段。
const EXPORT_FIELDS = {
  hazard_code:       '隐患编号',
  unit_name:         '责任单位',
  hazard_level:      '隐患等级',
  description:       '隐患描述',
  location:          '场所站点',
  responsible_person: '整改责任人',
  status:            '状态',
  recorder_name:     '录入人',
  recorder_unit_name: '录入人单位',
  plan_finish_time:  '计划完成时间',
  created_at:        '录入时间',
  closed_at:         '闭环时间',
  is_overdue:        '是否超期',
  business_dept:     '业务部门',
  rectify_unit:      '整改单位',
  hazard_investigation_item: '隐患排查项目',
}

// 状态中文映射
const STATUS_LABEL = {
  reported: '已上报',
  assigned: '已分派',
  rectifying: '整改中',
  verifying: '待验收',
  closed: '已闭环',
}

// ─── 工具 ─────────────────────────────────────────────────────────────────
function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true })
  }
}

function pad2(n) { return String(n).padStart(2, '0') }

function ts() {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

// Date / 字符串 → 'YYYY-MM-DD HH:mm:ss'
function fmtDateTime(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`
  const s = String(v)
  return s.replace('T', ' ').slice(0, 19)
}

// 单元格取值（含状态/超期/日期转换）
function cellValue(code, row) {
  const v = row[code]
  if (code === 'status') return STATUS_LABEL[v] || v || ''
  if (code === 'is_overdue') return v ? '是' : '否'
  if (code === 'plan_finish_time' || code === 'created_at' || code === 'closed_at') return fmtDateTime(v)
  if (v == null) return ''
  return v
}

// 校验并过滤前端传入的字段，返回按白名单顺序排列的有效字段数组
function resolveFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  const valid = list.filter((f) => Object.prototype.hasOwnProperty.call(EXPORT_FIELDS, f))
  // 至少保留一个；无有效字段时回退到全部白名单
  return valid.length ? valid : Object.keys(EXPORT_FIELDS)
}

// 构建 AOA 数据（含表头）
function buildAOA(rows, fields) {
  const headers = fields.map((f) => EXPORT_FIELDS[f])
  const data = [headers]
  for (const row of rows) {
    data.push(fields.map((f) => cellValue(f, row)))
  }
  return data
}

// ─── 通用：构建单 Sheet 的 AOA 数据 ─────────────────────────────────────────
// colDefs: [{ key, header, map?, date?, raw?(row) }]
function buildSheetAOA(rows, colDefs) {
  const data = [colDefs.map((c) => c.header)]
  for (const r of rows) {
    data.push(
      colDefs.map((c) => {
        if (c.raw) return c.raw(r)
        if (c.map) return c.map(r[c.key])
        if (c.date) return fmtDateTime(r[c.key])
        const v = r[c.key]
        if (v == null) return ''
        if (typeof v === 'object') return JSON.stringify(v)
        return v
      })
    )
  }
  return data
}

// ─── backupNow：全量备份（多 Sheet：隐患 + 培训 + 开工资料）─────────────────
// 注意：容器内 /app 只读，不能落盘。改为直接返回 buffer，由接口触发浏览器下载。
async function backupNow() {
  const wb = XLSX.utils.book_new()
  let totalCount = 0

  // ── Sheet 1：隐患数据（含照片 URL 文本列）──
  const [hazards] = await pool.query(
    `SELECT id, hazard_code, unit_name, hazard_level, description, location, hazard_investigation_item,
            responsible_person, status, recorder_name, recorder_unit_name,
            plan_finish_time, created_at, closed_at,
            CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END AS is_overdue
       FROM t_hazard
      WHERE deleted_at IS NULL
      ORDER BY id DESC`
  )
  let photoMap = {}
  if (hazards.length) {
    const ids = hazards.map((r) => r.id).filter(Boolean)
    if (ids.length) {
      const [photos] = await pool.query(
        'SELECT hazard_id, photo_url FROM t_hazard_photo WHERE hazard_id IN (?)',
        [ids]
      )
      photos.forEach((p) => {
        if (!photoMap[p.hazard_id]) photoMap[p.hazard_id] = []
        if (p.photo_url) photoMap[p.hazard_id].push(p.photo_url)
      })
    }
  }
  const hazardCols = [
    { key: 'hazard_code', header: '隐患编号' },
    { key: 'unit_name', header: '责任单位' },
    { key: 'hazard_level', header: '隐患等级' },
    { key: 'description', header: '隐患描述' },
    { key: 'location', header: '场所站点' },
    { key: 'hazard_investigation_item', header: '隐患排查项目' },
    { key: 'responsible_person', header: '整改责任人' },
    { key: 'status', header: '状态', map: (v) => STATUS_LABEL[v] || v },
    { key: 'recorder_name', header: '录入人' },
    { key: 'recorder_unit_name', header: '录入人单位' },
    { key: 'plan_finish_time', header: '计划完成时间', date: true },
    { key: 'created_at', header: '录入时间', date: true },
    { key: 'closed_at', header: '闭环时间', date: true },
    { key: 'is_overdue', header: '是否超期', map: (v) => (v ? '是' : '否') },
    { key: 'photo_urls', header: '照片URL' },
  ]
  const hazardData = buildSheetAOA(hazards, hazardCols).map((row, i) => {
    if (i === 0) return row
    const r = hazards[i - 1]
    return row.map((cell, ci) => (hazardCols[ci].key === 'photo_urls' ? (photoMap[r.id] || []).join('\n') : cell))
  })
  wb.SheetNames.push('隐患数据')
  wb.Sheets['隐患数据'] = XLSX.utils.aoa_to_sheet(hazardData)
  totalCount += hazards.length

  // ── 培训：材料 / 题库 / 人员 / 答题记录 ──
  const MAT_STATUS = { 0: '待审核', 1: '已发布', 2: '待审核', 3: '已驳回' }
  const [materials] = await pool.query('SELECT id, title, file_type, file_size, category_id, mode, status, ai_status, question_cnt, pass_score, time_limit, exam_single_num, exam_multiple_num, exam_judgment_num, target_type, target_value, created_by, created_at, content_text FROM t_material ORDER BY id')
  const materialCols = [
    { key: 'id', header: 'ID' },
    { key: 'title', header: '标题' },
    { key: 'file_type', header: '文件类型' },
    { key: 'file_size', header: '文件大小(字节)' },
    { key: 'category_id', header: '分类ID' },
    { key: 'mode', header: '培训模式' },
    { key: 'status', header: '状态', map: (v) => MAT_STATUS[v] ?? v },
    { key: 'ai_status', header: 'AI生成状态' },
    { key: 'question_cnt', header: '题目数' },
    { key: 'pass_score', header: '及格分' },
    { key: 'time_limit', header: '时长(分)' },
    { key: 'exam_single_num', header: '考试单选抽题' },
    { key: 'exam_multiple_num', header: '考试多选抽题' },
    { key: 'exam_judgment_num', header: '考试判断抽题' },
    { key: 'target_type', header: '适用对象类型' },
    { key: 'target_value', header: '适用对象', raw: (r) => (r.target_value ? JSON.stringify(r.target_value) : '') },
    { key: 'created_by', header: '创建人ID' },
    { key: 'created_at', header: '创建时间', date: true },
    { key: 'content_text', header: '内容文本' },
  ]
  wb.SheetNames.push('培训材料')
  wb.Sheets['培训材料'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(materials, materialCols))
  totalCount += materials.length

  const [questions] = await pool.query('SELECT id, material_id, type, question, image_url, options, answer, analysis, score, sort_order, status, difficulty, bloom_level, knowledge_points, created_at FROM t_question ORDER BY id')
  const questionCols = [
    { key: 'id', header: 'ID' },
    { key: 'material_id', header: '材料ID' },
    { key: 'type', header: '题型' },
    { key: 'question', header: '题干' },
    { key: 'image_url', header: '图片URL' },
    { key: 'options', header: '选项', raw: (r) => (r.options ? JSON.stringify(r.options) : '') },
    { key: 'answer', header: '正确答案' },
    { key: 'analysis', header: '解析' },
    { key: 'score', header: '分值' },
    { key: 'sort_order', header: '排序' },
    { key: 'status', header: '状态', map: (v) => (v == 1 ? '启用' : '停用') },
    { key: 'difficulty', header: '难度' },
    { key: 'bloom_level', header: '布鲁姆层次' },
    { key: 'knowledge_points', header: '知识点' },
    { key: 'created_at', header: '创建时间', date: true },
  ]
  wb.SheetNames.push('培训题库')
  wb.Sheets['培训题库'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(questions, questionCols))
  totalCount += questions.length

  const [users] = await pool.query('SELECT id, name, id_card, unit, supervising_unit, phone, status, contractor_unit_id, dingtalk_userid, created_at FROM t_user ORDER BY id')
  const userCols = [
    { key: 'id', header: 'ID' },
    { key: 'name', header: '姓名' },
    { key: 'id_card', header: '身份证号' },
    { key: 'unit', header: '单位' },
    { key: 'supervising_unit', header: '监管单位' },
    { key: 'phone', header: '电话' },
    { key: 'status', header: '状态', map: (v) => (v == 1 ? '启用' : '停用') },
    { key: 'contractor_unit_id', header: '承包商单位ID' },
    { key: 'dingtalk_userid', header: '钉钉ID' },
    { key: 'created_at', header: '创建时间', date: true },
  ]
  wb.SheetNames.push('培训人员')
  wb.Sheets['培训人员'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(users, userCols))
  totalCount += users.length

  const [records] = await pool.query('SELECT id, user_id, material_id, answers, score, max_score, duration_sec, mode, attempt_no, is_offline, submitted_at FROM t_record ORDER BY id')
  const recordCols = [
    { key: 'id', header: 'ID' },
    { key: 'user_id', header: '用户ID' },
    { key: 'material_id', header: '材料ID' },
    { key: 'answers', header: '作答', raw: (r) => (r.answers ? JSON.stringify(r.answers) : '') },
    { key: 'score', header: '得分' },
    { key: 'max_score', header: '满分' },
    { key: 'duration_sec', header: '用时(秒)' },
    { key: 'mode', header: '模式' },
    { key: 'attempt_no', header: '第几次' },
    { key: 'is_offline', header: '是否离线', map: (v) => (v ? '是' : '否') },
    { key: 'submitted_at', header: '提交时间', date: true },
  ]
  wb.SheetNames.push('培训答题记录')
  wb.Sheets['培训答题记录'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(records, recordCols))
  totalCount += records.length

  // ── 开工资料：目录 / 资料包 / 文件 ──
  const [docCatalog] = await pool.query('SELECT id, category, item_name, freq, required_type, sort_order, is_active, created_at FROM t_doc_catalog ORDER BY id')
  const docCatalogCols = [
    { key: 'id', header: 'ID' },
    { key: 'category', header: '类别' },
    { key: 'item_name', header: '资料项名称' },
    { key: 'freq', header: '频率' },
    { key: 'required_type', header: '类型', map: (v) => (v === 'gate' ? '入场必交' : '动态') },
    { key: 'sort_order', header: '排序' },
    { key: 'is_active', header: '启用', map: (v) => (v ? '是' : '否') },
    { key: 'created_at', header: '创建时间', date: true },
  ]
  wb.SheetNames.push('开工资料目录')
  wb.Sheets['开工资料目录'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(docCatalog, docCatalogCols))
  totalCount += docCatalog.length

  const [docPackage] = await pool.query('SELECT id, unit_name, unit_short, project_name, reporter_name, reporter_phone, status, created_at, updated_at FROM t_doc_package ORDER BY id')
  const docPackageCols = [
    { key: 'id', header: 'ID' },
    { key: 'unit_name', header: '单位名称' },
    { key: 'unit_short', header: '单位简称' },
    { key: 'project_name', header: '项目名称' },
    { key: 'reporter_name', header: '上报人' },
    { key: 'reporter_phone', header: '上报人电话' },
    { key: 'status', header: '状态', map: (v) => ({ 0: '待审核', 1: '已通过', 2: '已驳回' }[v] ?? v) },
    { key: 'created_at', header: '创建时间', date: true },
    { key: 'updated_at', header: '更新时间', date: true },
  ]
  wb.SheetNames.push('开工资料包')
  wb.Sheets['开工资料包'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(docPackage, docPackageCols))
  totalCount += docPackage.length

  const [docFile] = await pool.query('SELECT id, package_id, catalog_id, catalog_name, category, original_name, sys_name, cos_key, cos_url, file_ext, file_size, uploader_name, uploader_phone, uploaded_at FROM t_doc_file ORDER BY id')
  const docFileCols = [
    { key: 'id', header: 'ID' },
    { key: 'package_id', header: '资料包ID' },
    { key: 'catalog_id', header: '资料目录ID' },
    { key: 'catalog_name', header: '资料项名称' },
    { key: 'category', header: '类别' },
    { key: 'original_name', header: '原文件名' },
    { key: 'sys_name', header: '系统文件名' },
    { key: 'cos_key', header: 'COS路径' },
    { key: 'cos_url', header: 'COS链接' },
    { key: 'file_ext', header: '扩展名' },
    { key: 'file_size', header: '文件大小(字节)' },
    { key: 'uploader_name', header: '上传人' },
    { key: 'uploader_phone', header: '上传人电话' },
    { key: 'uploaded_at', header: '上传时间', date: true },
  ]
  wb.SheetNames.push('开工资料文件')
  wb.Sheets['开工资料文件'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(docFile, docFileCols))
  totalCount += docFile.length

  // ── 承包商单位 ──
  const [units] = await pool.query('SELECT id, unit_name, short_name, supervising_unit, contact_name, contact_phone, safety_officer_name, safety_officer_phone, party_a_division, party_a_contact_name, party_a_contact_phone, is_active, created_at FROM t_contractor_unit ORDER BY id')
  const unitCols = [
    { key: 'id', header: 'ID' },
    { key: 'unit_name', header: '单位名称' },
    { key: 'short_name', header: '简称' },
    { key: 'supervising_unit', header: '监管单位' },
    { key: 'contact_name', header: '联系人' },
    { key: 'contact_phone', header: '联系电话' },
    { key: 'safety_officer_name', header: '安全员' },
    { key: 'safety_officer_phone', header: '安全员电话' },
    { key: 'party_a_division', header: '甲方部门' },
    { key: 'party_a_contact_name', header: '甲方联系人' },
    { key: 'party_a_contact_phone', header: '甲方联系电话' },
    { key: 'is_active', header: '启用', map: (v) => (v ? '是' : '否') },
    { key: 'created_at', header: '创建时间', date: true },
  ]
  wb.SheetNames.push('承包商单位')
  wb.Sheets['承包商单位'] = XLSX.utils.aoa_to_sheet(buildSheetAOA(units, unitCols))
  totalCount += units.length

  const filename = `full_backup_${ts()}.xlsx`
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return { filename, count: totalCount, buffer }
}

// ─── exportReport：选字段 / 周报 / 月报导出 ─────────────────────────────────
async function exportReport(opts = {}) {
  const type = ['ledger', 'weekly', 'monthly'].includes(opts.type) ? opts.type : 'ledger'
  const fields = resolveFields(opts.fields)
  const where = ['deleted_at IS NULL']
  const params = []

  // ── 时间范围（全部类型统一）──
  const range = opts.range || {}
  if (!range.all) {
    if (range.start) {
      where.push('created_at >= ?')
      params.push(String(range.start) + ' 00:00:00')
    }
    if (range.end) {
      where.push('created_at <= ?')
      params.push(String(range.end) + ' 23:59:59')
    }
  }

  // ── 筛选条件 ──
  const filters = opts.filters || {}
  const TEXT_FILTERS = ['rectify_unit', 'location'] // 模糊匹配
  const EXACT_FILTERS = ['status', 'business_dept', 'hazard_level'] // 精确匹配
  const ARRAY_FILTERS = ['hazard_investigation_item'] // 前端多选，支持数组 IN 或单值精确匹配
  for (const k of TEXT_FILTERS) {
    const v = filters[k]
    if (v != null && String(v).trim() !== '') {
      where.push(`${k} LIKE ?`)
      params.push('%' + String(v).trim() + '%')
    }
  }
  for (const k of EXACT_FILTERS) {
    const v = filters[k]
    if (v != null && String(v).trim() !== '') {
      where.push(`${k} = ?`)
      params.push(String(v).trim())
    }
  }
  for (const k of ARRAY_FILTERS) {
    const v = filters[k]
    if (Array.isArray(v) && v.length) {
      where.push(`${k} IN (?)`)
      params.push(v)
    } else if (v != null && String(v).trim() !== '') {
      where.push(`${k} = ?`)
      params.push(String(v).trim())
    }
  }

  // 选择列：白名单字段 + is_overdue 计算（status/unit_name 已在白名单内，足以支撑汇总）
  const selectList = Object.keys(EXPORT_FIELDS).map((code) =>
    code === 'is_overdue'
      ? `CASE WHEN status <> 'closed' AND plan_finish_time IS NOT NULL AND plan_finish_time < NOW() THEN 1 ELSE 0 END AS is_overdue`
      : code
  ).join(', ')

  const [rows] = await pool.query(
    `SELECT ${selectList} FROM t_hazard WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    params
  )

  const aoa = buildAOA(rows, fields)

  // 周/月报：末尾追加汇总行（设计 §8.8）
  if (type !== 'ledger') {
    const newCount = rows.length
    const closedCount = rows.filter((r) => r.status === 'closed').length
    const overdueCount = rows.filter((r) => r.is_overdue === 1).length
    const unitRank = {}
    rows.forEach((r) => {
      const u = r.unit_name || '未标注'
      unitRank[u] = (unitRank[u] || 0) + 1
    })
    const ranked = Object.entries(unitRank).sort((a, b) => b[1] - a[1]).slice(0, 10)

    const blank = new Array(fields.length).fill('')
    const withLabel = (label, val) => {
      const row = new Array(fields.length).fill('')
      row[0] = label
      row[1] = val
      return row
    }
    aoa.push(blank)
    aoa.push(withLabel('新增隐患数', newCount))
    aoa.push(withLabel('闭环隐患数', closedCount))
    aoa.push(withLabel('超期隐患数', overdueCount))
    ranked.forEach(([u, c], i) => aoa.push(withLabel(`责任单位排名${i + 1}`, `${u}：${c} 条`)))
  }

  const wb = XLSX.utils.book_new()
  const sheetName = type === 'ledger' ? '隐患台账' : type === 'weekly' ? '隐患周报' : '隐患月报'
  wb.SheetNames.push(sheetName)
  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(aoa)
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  // 文件名（设计 §8.6）
  let filename
  const fmt = (s) => {
    if (!s) return ts()
    const d = new Date(String(s).replace(' ', 'T'))
    return isNaN(d.getTime()) ? String(s).replace(/[^0-9]/g, '').slice(0, 8) : `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  }
  if (type === 'ledger') {
    filename = `隐患台账_${ts()}.xlsx`
  } else if (type === 'weekly') {
    filename = `隐患周报_${fmt(range.start)}_${fmt(range.end)}.xlsx`
  } else {
    const d = range.start ? new Date(String(range.start).replace(' ', 'T')) : new Date()
    const ym = isNaN(d.getTime()) ? ts() : `${d.getFullYear()}${pad2(d.getMonth() + 1)}`
    filename = `隐患月报_${ym}.xlsx`
  }

  return { buffer, filename, count: rows.length }
}

// ─── listBackups：列出备份文件 ─────────────────────────────────────────────
function listBackups() {
  ensureBackupsDir()
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.xlsx'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f))
        return { filename: f, size: stat.size, created_at: fmtDateTime(stat.mtime) }
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    return files
  } catch {
    return []
  }
}

// ─── pruneBackups：清理超过保留天数的备份（P2）─────────────────────────────
function pruneBackups(retentionDays = 30) {
  ensureBackupsDir()
  const cutoff = Date.now() - Number(retentionDays) * 86400000
  let removed = 0
  try {
    const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.xlsx'))
    for (const f of files) {
      const fp = path.join(BACKUPS_DIR, f)
      const stat = fs.statSync(fp)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp)
        removed++
      }
    }
  } catch (e) {
    console.error('[backup] 清理备份失败（已忽略）:', e.message)
  }
  return removed
}

module.exports = { backupNow, exportReport, listBackups, pruneBackups }
