// 容器内：从 content 提取《标准名》+条款号，补进缺标准出处的 basis（来源）字段
// 保守策略：只补能明确提取到标准名的；条款号只在紧邻标准名后才拼；保留原来源
try { require('/app/node_modules/dotenv').config({ path: '/app/.env', quiet: true }) } catch (e) {}
const { pool } = require('/app/src/db/db')
const DRY = process.argv.includes('--dry')
const norm = s => String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim()

// 标准名模式：《xxx》 或 GB/T xxxx / SY/T xxxx / AQ xxxx / SH/T / Q/SH 等
const STD_RE = /《([^》]{3,60})》|(GB\/T|GB|AQ\/T|AQ|SY\/T|SY|SH\/T|SH|Q\/SH|QSH|DB\d+|JJG|JGJ)\s*\d{3,5}(?:[.\-—]\d+)*/gi
// 条款号：紧跟标准名后面的 "1.4.2" / "第X条" / "X.X.X.X"
const CLAUSE_AFTER = /^[\s、，,；;:：]*((?:第[一二三四五六七八九十百\d]+条(?:第[一二三四五六七八九十\d]+款)?)|(?:\d{1,2}(?:\.\d{1,3}){1,4}))/
const hasStdInBasis = b => /(《[^》]{2,}》|(?:GB\/T|GB|AQ\/T|AQ|SY\/T|SY|SH\/T|SH|JT\/T|JT|Q\/SH|QSH|DB\d+|ISO|IEC)\s*\d{3,5})/i.test(String(b||''))

function extract(content) {
  const s = String(content||'')
  const out = []
  for (const m of s.matchAll(STD_RE)) {
    let name = m[1] ? `《${m[1].trim()}》` : m[0].replace(/\s+/g,'')
    // 标准号在前、书名在后相邻（如 SY/T 6586-2020《石油天然气钻采设备...》）→ 合并显示
    if (!m[1]) {
      const after = s.slice(m.index + m[0].length)
      const bm = after.match(/^\s*《([^》]{3,60})》/)
      if (bm) name = `${m[0].replace(/\s+/g,'')}${bm[0]}`
    }
    // 书名在前、标准号在后相邻（如 《石油天然气钻采设备...》(SY/T 6586-2020)）→ 合并
    if (m[1]) {
      const after = s.slice(m.index + m[0].length)
      const nm = after.match(/^\s*[（(]\s*((?:GB\/T|GB|SY\/T|SY|AQ|SH\/T|Q\/SH)\s*\d{3,5}(?:[.\-—]\d+)*)\s*[）)]/)
      if (nm) name = `${name}（${nm[1].replace(/\s+/g,'')}）`
    }
    const rest = s.slice(m.index + m[0].length)
    const cm = rest.match(CLAUSE_AFTER)
    out.push({ name, clause: cm ? cm[1] : '' })
  }
  return out
}

;(async () => {
  const [rows] = await pool.execute('SELECT id, code, content, basis FROM t_violation')
  const updates = []
  const skip = { hasStd:0, noStd:0, noClause:0 }
  for (const r of rows) {
    if (hasStdInBasis(r.basis)) { skip.hasStd++; continue }
    const found = extract(r.content)
    if (!found.length) { skip.noStd++; continue }
    // 取第一个带条款号的；没有条款号则取第一个标准名
    const pick = found.find(f => f.clause) || found[0]
    const stdText = pick.clause ? `${pick.name} ${pick.clause}` : pick.name
    const oldBasis = String(r.basis||'').trim()
    // 新来源：标准出处前置 + 原来源（去重避免重复）
    const newBasis = oldBasis && oldBasis !== '/' && !oldBasis.includes(stdText)
      ? `${stdText}｜${oldBasis}`.slice(0,990)
      : stdText.slice(0,990)
    updates.push({ id:r.id, code:r.code, newBasis, oldBasis, stdText })
  }
  console.log('待更新', updates.length, '跳过(已有标准)', skip.hasStd, '跳过(正文无标准)', skip.noStd)
  console.log('\n--- 更新样例（前15）---')
  updates.slice(0,15).forEach(u=>console.log(`  ${u.code}\n    旧: ${u.oldBasis.slice(0,70)}\n    新: ${u.newBasis.slice(0,110)}`))
  if (DRY) { console.log('\n[DRY RUN] 未写库'); process.exit(0) }
  const conn = await pool.getConnection()
  let done=0
  try {
    await conn.beginTransaction()
    for (const u of updates) {
      await conn.execute('UPDATE t_violation SET basis = ? WHERE id = ?', [u.newBasis, u.id])
      done++
    }
    await conn.commit()
  } catch(e) { await conn.rollback(); throw e } finally { conn.release() }
  console.log('\n已更新', done, '条')
  process.exit(0)
})().catch(e=>{console.error('ERR',e.message);process.exit(1)})
