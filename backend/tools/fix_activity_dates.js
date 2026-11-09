/**
 * 一次性数据订正：把 t_activity_row.row_json 里各队五花八门的日期写法
 * 统一成 YYYY-MM-DD（与 services/activityService.js 的 cleanCell / normDateText 同口径）。
 *
 * 用法（容器内；必须放在 /app/tools/ 下，脚本按 ../src 引用服务与 db）：
 *   docker cp tools/fix_activity_dates.js tnb-backend:/app/tools/fix_activity_dates.js
 *   docker exec -u root -e DRY=1 tnb-backend node /app/tools/fix_activity_dates.js   # 只统计不改
 *   docker exec -u root         tnb-backend node /app/tools/fix_activity_dates.js     # 实际写库
 */
require('dotenv').config({ path: process.env.ENV_FILE || '/app/.env' })
const { pool } = require('../src/db/db')
const svc = require('../src/services/activityService')

const DRY = String(process.env.DRY || '') === '1'

;(async () => {
  const [rows] = await pool.query('SELECT id, row_json FROM t_activity_row ORDER BY id')
  console.log(`[fix] 共 ${rows.length} 行明细${DRY ? '（DRY RUN）' : ''}`)

  const changes = []
  for (const r of rows) {
    let obj
    try { obj = typeof r.row_json === 'string' ? JSON.parse(r.row_json || '{}') : (r.row_json || {}) } catch (e) { continue }
    if (!obj || typeof obj !== 'object') continue
    let dirty = false
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      // 只处理字符串单元格，非字符串原样保留，避免类型漂移
      const nv = typeof v === 'string' ? svc.cleanCell(v) : v
      out[k] = nv
      if (nv !== v) dirty = true
    }
    if (dirty) changes.push({ id: r.id, before: obj, after: out })
  }

  console.log(`[fix] 需要订正 ${changes.length} 行`)
  for (const c of changes.slice(0, 6)) {
    const diff = Object.keys(c.after).filter((k) => c.after[k] !== c.before[k])
      .map((k) => `${k}: ${JSON.stringify(c.before[k])} -> ${JSON.stringify(c.after[k])}`)
    console.log(`  #${c.id}  ${diff.join(' | ')}`)
  }
  if (changes.length > 6) console.log(`  …… 其余 ${changes.length - 6} 行略`)

  if (DRY) { await pool.end(); return }

  let done = 0
  for (const c of changes) {
    await pool.execute('UPDATE t_activity_row SET row_json = ? WHERE id = ?', [JSON.stringify(c.after), c.id])
    done += 1
  }
  console.log(`[fix] 已更新 ${done} 行`)
  await pool.end()
})().catch((e) => { console.error('[fix] 失败:', e.message); process.exit(1) })
