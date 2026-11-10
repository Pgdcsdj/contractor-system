// 补充验证：导出 xlsx 与「测试连通」在未配置凭据时的行为
require('/app/node_modules/dotenv').config({ path: '/app/.env' })
const { signAdminToken } = require('/app/src/services/adminAuth')

const TOK = signAdminToken({ id: 1, username: 'admin', role: 'superadmin' })
const BASE = 'http://127.0.0.1:3000/api/site-permit'
const H = { Authorization: `Bearer ${TOK}` }

;(async () => {
  // 1) 导出
  const r = await fetch(`${BASE}/export?risk=${encodeURIComponent('橙色')}`, { headers: H })
  const buf = Buffer.from(await r.arrayBuffer())
  console.log(`导出: HTTP ${r.status} | Content-Type ${r.headers.get('content-type')}`)
  console.log(`  Content-Disposition: ${r.headers.get('content-disposition')}`)
  console.log(`  字节数: ${buf.length} | ZIP 头: ${buf.slice(0, 2).toString('hex')}`)
  const XLSX = require('/app/node_modules/xlsx')
  const wb = XLSX.read(buf, { type: 'buffer' })
  console.log('  可被 xlsx 解析:', !!wb.SheetNames.length, '| 工作表:', wb.SheetNames)
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
  console.log('  行数:', aoa.length, '（含表头）')
  console.log('  表头:', JSON.stringify(aoa[0]))
  console.log('  首行:', JSON.stringify(aoa[1]).slice(0, 240))

  // 2) 未配置凭据时 /test 应返回可读错误而非 500
  const t = await fetch(`${BASE}/test`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}',
  })
  const tj = await t.json()
  console.log(`\n测试连通（未配置凭据）: HTTP ${t.status} | success=${tj.success} | error=${tj.error}`)

  // 3) 保存配置 → 掩码 → 恢复
  const p1 = await fetch(`${BASE}/config`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cronHour: 22, cronMinute: 0, rangeEnd: 'q300' }),
  })
  const pj = await p1.json()
  console.log(`\n保存配置: HTTP ${p1.status} | rangeEnd 规范化=${pj.data.rangeEnd} | cron=${pj.data.cronHour}:${pj.data.cronMinute}`)

  // 4) 非法 rangeEnd
  const p2 = await fetch(`${BASE}/config`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rangeEnd: '!!!' }),
  })
  const p2j = await p2.json()
  console.log(`脏 rangeEnd 回退: ${p2j.data.rangeEnd}`)

  // 5) 越界 cron
  const p3 = await fetch(`${BASE}/config`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cronHour: 99, cronMinute: 99 }),
  })
  const p3j = await p3.json()
  console.log(`越界 cron 修正: ${p3j.data.cronHour}:${p3j.data.cronMinute}`)

  // 6) 恢复默认
  await fetch(`${BASE}/config`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cronHour: 22, cronMinute: 0, rangeEnd: 'Q300' }),
  })
  console.log('\n已恢复 cronHour=22 cronMinute=0 rangeEnd=Q300')
})()
