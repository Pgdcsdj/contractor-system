// 容器内自测：直接打 localhost:3000，避免 ssh 引号/证书干扰
require('/app/node_modules/dotenv').config({ path: '/app/.env' })
const { signAdminToken } = require('/app/src/services/adminAuth')

const TOK = signAdminToken({ id: 1, username: 'admin', role: 'superadmin' })
const BASE = 'http://127.0.0.1:3000/api/site-permit'
const H = { Authorization: `Bearer ${TOK}` }

async function get(path) {
  const r = await fetch(BASE + path, { headers: H })
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch (e) { j = txt }
  return { status: r.status, body: j }
}

;(async () => {
  for (const p of ['/config', '/stats', '/list?pageSize=2', '/sync-logs']) {
    const r = await get(p)
    console.log(`\n===== ${p}  [HTTP ${r.status}] =====`)
    console.log(JSON.stringify(r.body, null, 1).slice(0, 1500))
  }

  // 筛选用例：按风险 + 日期
  const s = await get('/stats')
  const d = (s.body && s.body.data && s.body.data.date) || ''
  const l = await get(`/list?risk=${encodeURIComponent('橙色')}&pageSize=100`)
  const n = (l.body && l.body.data && l.body.data.list.length) || 0
  console.log(`\n===== 风险=橙色 命中 ${n} 条（统计日 ${d}）=====`)
  console.log((l.body.data.list || []).map((x) => `${x.plan_date} ${x.risk_level} ${x.work_unit} | ${String(x.content).slice(0, 24)}`).join('\n'))

  // 详情
  const one = await get('/list?pageSize=1')
  const id = one.body.data.list[0].id
  const det = await get(`/${id}`)
  console.log(`\n===== 详情 id=${id} =====`)
  console.log(JSON.stringify(det.body.data, null, 1))
})()
