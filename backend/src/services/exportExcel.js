/**
 * Excel 导出服务
 * 导出答题记录为 .xlsx
 */

const xlsx = require('xlsx')

/**
 * 将答题记录列表导出为 Excel Buffer
 * @param {Array} records
 * @returns {Buffer}
 */
function exportRecordsToExcel(records) {
  const MODE_TEXT = { exam: '考试', practice: '练习', study: '学习' }
  // 默认只导出考试记录；勾选「含练习/学习记录」后导出会混入非考试记录，
  // 练习/学习不抽题、满分可能不是 100（如 260），故单列「模式」列供人工辨识。
  const rows = records.map((r, idx) => ({
    序号:     idx + 1,
    姓名:     r.user_name,
    承包商:   r.unit,
    主管单位: r.supervising_unit || '',
    题库名称: r.material_title,
    模式:     MODE_TEXT[r.mode] || (r.mode || '-'),
    得分:     r.score,
    满分:     r.max_score,
    通过率:   r.max_score > 0 ? `${Math.round(r.score / r.max_score * 100)}%` : '-',
    答题耗时: `${r.duration_sec}秒`,
    提交时间: r.submitted_at ? new Date(r.submitted_at).toLocaleString('zh-CN') : '',
    上传方式: r.is_offline ? '离线上传' : '在线提交',
  }))

  const wb = xlsx.utils.book_new()
  const ws = xlsx.utils.json_to_sheet(rows)

  // 设置列宽
  ws['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 25 }, { wch: 20 }, { wch: 30 }, { wch: 8 },
    { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 },
    { wch: 20 }, { wch: 12 },
  ]

  xlsx.utils.book_append_sheet(wb, ws, '答题记录')
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = { exportRecordsToExcel }
