/**
 * 未整改隐患周报服务（隐患闭环模块三 / 需求 2、3）
 *
 * 能力：
 *   1) queryUnclosedHazards(pool)：查询全部「未闭环 + 未软删」隐患。
 *   2) buildUnclosedExcel(pool)：  用 SheetJS 生成「未整改隐患清单」xlsx buffer，
 *      内置中文状态映射 / 是否超期 / 超期天数 / 列宽，返回 { buffer, count, overdueCount }。
 *   3) sendWeeklyUnclosedToDingtalk(pool)：生成 Excel → 传 COS → 发钉钉 markdown
 *      统计 + 下载链接（群机器人不能直接传文件，故走 COS 中转）。
 *
 * 运行时持久化走 MySQL/COS，本模块不写任何生产文件。
 * 每周三 01:00 由 hazardScheduler.sendWeeklyExcel 触发；后台下载路由直接复用 buildUnclosedExcel。
 */

const xlsx = require('xlsx')
const { uploadFile } = require('./cosUpload')
const { sendHazardNotification } = require('./dingtalk/notify')
const schedulerConfig = require('./schedulerConfig')

/** 隐患状态 → 中文（模块三约定：reported=待分派，verifying=验收中；closed 仅兜底，查询已排除） */
const STATUS_CN = {
  reported: '待分派',
  assigned: '已分派',
  rectifying: '整改中',
  verifying: '验收中',
  closed: '已闭环',
}

/** 格式化 Date / 字符串 为 YYYY-MM-DD HH:mm(:ss)（非法输入返回 ''） */
function fmtDateTime(v, withSeconds = false) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base
}

/**
 * 查询全部未闭环隐患（status <> 'closed' 且未软删）
 * @param {Object} pool
 * @returns {Promise<Array<Object>>}
 */
async function queryUnclosedHazards(pool) {
  const [rows] = await pool.query(
    `SELECT hazard_code, unit_name, hazard_investigation_item, location, description,
            hazard_level, responsible_person, business_dept_head, plan_finish_time,
            status, report_time, contractor_unit_id
       FROM t_hazard
      WHERE status <> 'closed'
        AND deleted_at IS NULL
      ORDER BY plan_finish_time IS NULL ASC, plan_finish_time ASC, id ASC`
  )
  return rows
}

/**
 * 生成「未整改隐患清单」Excel buffer
 * @param {Object} pool
 * @returns {Promise<{buffer:Buffer, count:number, overdueCount:number}>}
 */
async function buildUnclosedExcel(pool) {
  const rows = await queryUnclosedHazards(pool)
  const now = Date.now()
  let overdueCount = 0

  const header = [
    '序号', '隐患编号', '单位', '排查项目', '场所', '隐患描述', '级别',
    '整改责任人', '业务口负责人', '计划完成时间', '状态', '是否超期', '超期天数', '上报时间',
  ]
  const body = rows.map((r, idx) => {
    let isOverdue = false
    let overdueDays = 0
    if (r.plan_finish_time) {
      const plan = r.plan_finish_time instanceof Date ? r.plan_finish_time : new Date(r.plan_finish_time)
      if (!Number.isNaN(plan.getTime())) {
        const planMs = plan.getTime()
        isOverdue = planMs < now
        if (isOverdue) {
          overdueDays = Math.max(0, Math.floor((now - planMs) / 86400000))
          overdueCount++
        }
      }
    }
    return [
      idx + 1,
      r.hazard_code || '',
      r.unit_name || '',
      r.hazard_investigation_item || '',
      r.location || '',
      r.description || '',
      r.hazard_level || '',
      r.responsible_person || '',
      r.business_dept_head || '',
      fmtDateTime(r.plan_finish_time),
      STATUS_CN[r.status] || r.status || '',
      isOverdue ? '是' : '否',
      isOverdue ? overdueDays : '',
      fmtDateTime(r.report_time),
    ]
  })

  const aoa = [header, ...body]
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [
    { wch: 6 },   // 序号
    { wch: 14 },  // 隐患编号
    { wch: 24 },  // 单位
    { wch: 20 },  // 排查项目
    { wch: 20 },  // 场所
    { wch: 40 },  // 隐患描述
    { wch: 10 },  // 级别
    { wch: 12 },  // 整改责任人
    { wch: 14 },  // 业务口负责人
    { wch: 18 },  // 计划完成时间
    { wch: 10 },  // 状态
    { wch: 10 },  // 是否超期
    { wch: 10 },  // 超期天数
    { wch: 18 },  // 上报时间
  ]

  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '未整改隐患清单')
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return { buffer, count: rows.length, overdueCount }
}

/**
 * 生成并发送「未整改隐患周报」：Excel 传 COS，钉钉发 markdown 统计 + 下载链接
 * @param {Object} pool
 * @returns {Promise<{ok:boolean, url:string, count:number, overdueCount:number}>}
 */
async function sendWeeklyUnclosedToDingtalk(pool) {
  const now = new Date()
  const date = fmtDateTime(now).slice(0, 10)
  const fileDate = date.replace(/-/g, '')
  const { buffer, count, overdueCount } = await buildUnclosedExcel(pool)

  // 群机器人不能直接传文件 → Excel 传 COS，正文给下载链接
  const { url } = await uploadFile(buffer, `未整改隐患周报_${fileDate}.xlsx`, 'hazard-reports')

  await sendHazardNotification('WEEKLY_EXCEL', {
    date,
    count,
    overdueCount,
    url,
    atMobiles: schedulerConfig.safetyOfficeMobiles,
  })

  return { ok: true, url, count, overdueCount }
}

module.exports = {
  queryUnclosedHazards,
  buildUnclosedExcel,
  sendWeeklyUnclosedToDingtalk,
  fmtDateTime,
}
