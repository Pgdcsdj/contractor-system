// 容器内：针对「来源=文档名」的条目，从 content 提取真正的标准名+条款号前置到 basis
// 只补正文里确有标准编号的；已有的《标准名》不重复加
try { require('/app/node_modules/dotenv').config({ path: '/app/.env', quiet: true }) } catch (e) {}
const { pool } = require('/app/src/db/db')
const DRY = process.argv.includes('--dry')
// 明确的「文档名来源」前缀（这些是我们批量导入时以文档名当 source 的）
const DOC_PREFIX = ['检查表（督查室第一版修）','普光气田环保管理手册','附件143-7 井控检查标准',
  '中原油田和中原工程一体化HSE检查细则','普光钻井工程HSE检查细则']
const isDocSource = b => DOC_PREFIX.some(p => String(b||'').includes(p))
// 正文中标准模式：GB/SY/AQ/SH/TSG/Q/SH 编号（可带《》），或《标准名》
const STD_RE = /(GB\/T|GB|AQ\/T|AQ|SY\/T|SY|SH\/T|SH|TSG|Q\/SH|QSH|JJG|JGJ)\s*\d{3,5}(?:[.\-—]\d+)*\s*《?([^》\s，,。；;]{0,40})》?|《(中华人民共和国[^》]{2,40}|中国石化[^》]{2,40}|石油天然气[^》]{2,40}|钻井[^》]{2,40}|硫化氢[^》]{2,40}|[^》]{2,40}(?:规范|规程|标准|规定|办法|指南|手册))》/gi
const CLAUSE = /^[\s、，,；;:：]*((?:第[一二三四五六七八九十百\d]+条(?:第[一二三四五六七八九十\d]+款)?)|(?:\d{1,2}(?:\.\d{1,3}){1,4}))/

function extract(content) {
  const s = String(content||'')
  const out = []
  for (const m of s.matchAll(STD_RE)) {
    let name
    if (m[1]) { // 编号在前
      const no = m[1].replace(/\s+/g,'')
      const tail = m[2] ? m[2].replace(/[《》]/g,'').trim() : ''
      name = tail && /[\u4e00-\u9fa5]/.test(tail) ? `${no}《${tail}》` : no
    } else { // 书名
      name = `《${m[3].trim()}》`
    }
    let rest = s.slice(m.index + m[0].length)
    // 跳过紧跟标准名后的括号编号，如 （SY_T6444-2018）
    rest = rest.replace(/^[\s（(]\s*(?:GB\/T|GB|SY\/T|SY|AQ|SH\/T|TSG|Q\/SH)\s*[\d.\-—_]{3,15}\s*[）)]\s*/i, '')
    const cm = rest.match(CLAUSE)
    out.push({ name, clause: cm ? cm[1] : '' })
  }
  return out
}

;(async () => {
  const [rows] = await pool.execute('SELECT id, code, content, basis FROM t_violation')
  const updates = []
  const skip = { notDoc:0, noStd:0 }
  for (const r of rows) {
    if (!isDocSource(r.basis)) { skip.notDoc++; continue }
    // 若文档名之前已有《标准名》或标准编号，说明上一轮已补过，跳过
    const docPos = Math.min(...DOC_PREFIX.map(p=>String(r.basis).indexOf(p)).filter(i=>i>=0))
    const beforeDoc = String(r.basis).slice(0, docPos)
    if (/《[^》]{3,}》|(?:GB\/T|GB|SY\/T|SY|AQ|SH\/T|TSG|Q\/SH)\s*\d{3,5}/i.test(beforeDoc)) { skip.alreadyFilled=(skip.alreadyFilled||0)+1; continue }
    const found = extract(r.content)
    if (!found.length) { skip.noStd++; continue }
    const pick = found.find(f => f.clause) || found[0]
    const stdText = pick.clause ? `${pick.name} ${pick.clause}` : pick.name
    const oldBasis = String(r.basis||'').trim()
    if (oldBasis.includes(pick.name)) continue // 已有该标准名
    const newBasis = `${stdText}｜${oldBasis}`.slice(0,990)
    updates.push({ id:r.id, code:r.code, newBasis, oldBasis, stdText })
  }
  console.log('文档名来源条目待补', updates.length, '非文档来源', skip.notDoc, '正文无标准', skip.noStd)
  console.log('\n--- 样例 ---')
  updates.slice(0,12).forEach(u=>console.log(`  ${u.code}\n    旧: ${u.oldBasis.slice(0,60)}\n    新: ${u.newBasis.slice(0,115)}`))
  const d = updates.find(u=>u.code==='HSE92B2D02829')
  if (d) console.log('\n截图条目新来源:', d.newBasis)
  if (DRY) { console.log('\n[DRY RUN]'); process.exit(0) }
  const conn = await pool.getConnection()
  let done=0
  try {
    await conn.beginTransaction()
    for (const u of updates) { await conn.execute('UPDATE t_violation SET basis=? WHERE id=?',[u.newBasis,u.id]); done++ }
    await conn.commit()
  } catch(e) { await conn.rollback(); throw e } finally { conn.release() }
  console.log('\n已更新', done)
  process.exit(0)
})().catch(e=>{console.error('ERR',e.message);process.exit(1)})
