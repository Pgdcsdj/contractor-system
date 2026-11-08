/**
 * 隐患字典路由（Sprint 2 / P1-1）
 *
 * GET /api/hazard-dict?type=level   返回种子字典（等级），供下拉使用
 *
 * 鉴权：管理员 token（与 hazard.js / contractorUnit.js 同款内联 adminAuth）
 */

const express = require('express')
const multer  = require('multer')
const xlsx   = require('xlsx')
const { pool } = require('../db/db')
const { verifyAdminToken } = require('../services/adminAuth')
const { DICT_TYPES, VALID_TYPES } = require('../constants/hazardStates')
const {
  normalizeStationKey,
  loadRules,
  resolveStation,
  invalidateCache,
} = require('../services/stationResolver')

const router = express.Router()

// ─── 位置字典导入：multer 内存存储 ─────────────────────────────────────
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      /\.(xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    cb(ok ? null : new Error('只支持 .xlsx / .xls 文件'), ok)
  },
})

// ─── JWT 鉴权中间件（与既有路由约定一致）─────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ success: false, error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── GET /api/hazard-dict?type=level ────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  const { type } = req.query

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }

  try {
    const [rows] = await pool.execute(
      `SELECT id, type, code, name, parent_code, default_level, sort_order,
              center_station_name, gas_station_name
         FROM t_hazard_dict
        WHERE type = ? AND enabled = 1
        ORDER BY sort_order ASC, id ASC`,
      [type]
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    res.status(500).json({ success: false, error: '字典查询失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict ──────────────────────────────────────────────────
// body: { type, code, name, parent_code?, default_level?, sort_order? }
router.post('/', adminAuth, async (req, res) => {
  const {
    type,
    code,
    name,
    parent_code = '',
    default_level = '',
    sort_order = 0,
    center_station_name = '',
    gas_station_name = '',
  } = req.body || {}

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!code || !String(code).trim() || !name || !String(name).trim()) {
    return res.status(400).json({ success: false, error: '编码(code)与名称(name)均不能为空' })
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO t_hazard_dict
         (type, code, name, parent_code, default_level, sort_order, center_station_name, gas_station_name, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        type,
        String(code).trim(),
        String(name).trim(),
        String(parent_code || ''),
        String(default_level || ''),
        Number(sort_order) || 0,
        String(center_station_name || '').trim(),
        String(gas_station_name || '').trim(),
      ]
    )
    res.json({ success: true, data: { id: result.insertId } })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    if (err.errno === 1062) {
      return res.status(409).json({ success: false, error: '该编码已存在' })
    }
    res.status(500).json({ success: false, error: '字典创建失败：' + err.message })
  }
})

// ─── PATCH /api/hazard-dict/:id ─────────────────────────────────────────────
// body: { type, name?, parent_code?, default_level?, sort_order?, enabled? }
// 动态拼接 UPDATE，仅更新传入字段；WHERE id=? AND type=?（type 必带以校验）
router.patch('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const type = req.body?.type || req.query?.type
  const { name, parent_code, default_level, sort_order, enabled, center_station_name, gas_station_name } = req.body || {}

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: '无效的字典 ID' })
  }

  const sets = []
  const values = []
  if (name !== undefined) { sets.push('name = ?'); values.push(String(name).trim()) }
  if (parent_code !== undefined) { sets.push('parent_code = ?'); values.push(String(parent_code || '')) }
  if (default_level !== undefined) { sets.push('default_level = ?'); values.push(String(default_level || '')) }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); values.push(Number(sort_order) || 0) }
  if (enabled !== undefined) { sets.push('enabled = ?'); values.push(enabled ? 1 : 0) }
  if (center_station_name !== undefined) { sets.push('center_station_name = ?'); values.push(String(center_station_name || '').trim()) }
  if (gas_station_name !== undefined) { sets.push('gas_station_name = ?'); values.push(String(gas_station_name || '').trim()) }

  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: '没有可更新的字段' })
  }

  try {
    const [result] = await pool.execute(
      `UPDATE t_hazard_dict SET ${sets.join(', ')} WHERE id = ? AND type = ?`,
      [...values, id, type]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '未找到对应的字典项' })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    if (err.errno === 1062) {
      return res.status(409).json({ success: false, error: '该编码已存在' })
    }
    res.status(500).json({ success: false, error: '字典更新失败：' + err.message })
  }
})

// ─── DELETE /api/hazard-dict/:id ────────────────────────────────────────────
// body 或 query 带 { type }
router.delete('/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  const type = req.body?.type || req.query?.type

  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ success: false, error: '请指定有效的字典类型（level / rectify_unit / business_dept / business_dept_head / center_station / well_site / facility / hazard_investigation_item）' })
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: '无效的字典 ID' })
  }

  try {
    const [result] = await pool.execute(
      `DELETE FROM t_hazard_dict WHERE id = ? AND type = ?`,
      [id, type]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '未找到对应的字典项' })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[hazard-dict]', err.message)
    res.status(500).json({ success: false, error: '字典删除失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict/import-locations —— 导入位置主数据（生产场站/施工点）──
// body: file(.xlsx), replace?(bool)
// 读「生产场站」sheet 第 2 列（跳过表头行）→ INSERT IGNORE 入 center_station（code=name, sort_order=行号）
// 读「施工点」sheet 第 2 列 → well_site；facility 无对应 sheet 不处理。
// 幂等：INSERT IGNORE 防重复；replace=true 时先清空对应 type 再导入。
router.post('/import-locations', adminAuth, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx 文件' })
  }
  const replace = req.body?.replace === 'true' || req.body?.replace === true
  try {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheetNames = wb.SheetNames || []

    const missing = ['生产场站', '施工点'].filter((s) => !sheetNames.includes(s))
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `缺少「${missing.join('」/「')}」sheet 或文件为空`,
      })
    }

    /**
     * 读取某个 sheet 的第 2 列（index 1），跳过表头行，INSERT IGNORE 入指定字典 type。
     * @returns {Promise<{received:number, inserted:number, skipped:number}>}
     */
    async function importSheet(sheetName, type) {
      const ws = wb.Sheets[sheetName]
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' })
      // 跳过表头行（第 1 行），从第 2 行起取第 2 列（index 1）
      const dataRows = rows.slice(1)
      const names = []
      dataRows.forEach((row, i) => {
        const v = row && row[1] != null ? String(row[1]).trim() : ''
        if (v) names.push({ name: v, sortOrder: i + 1 })
      })
      if (replace) {
        await pool.execute('DELETE FROM t_hazard_dict WHERE type = ?', [type])
      }
      let inserted = 0
      for (const n of names) {
        const [r] = await pool.execute(
          `INSERT IGNORE INTO t_hazard_dict (type, code, name, sort_order, enabled) VALUES (?, ?, ?, ?, 1)`,
          [type, n.name, n.name, n.sortOrder]
        )
        if (r.affectedRows > 0) inserted++
      }
      return { received: names.length, inserted, skipped: names.length - inserted }
    }

    const center = await importSheet('生产场站', 'center_station')
    const well = await importSheet('施工点', 'well_site')

    res.json({
      success: true,
      message: `导入完成：生产场站 ${center.inserted} 条、施工点 ${well.inserted} 条`,
      data: {
        sheets: ['生产场站', '施工点'],
        center_station: center,
        well_site: well,
      },
    })
  } catch (err) {
    console.error('[hazard-dict import-locations]', err.message)
    res.status(500).json({ success: false, error: '位置导入失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict/import-station-map ───────────────────────────────
// 按「各中心站运维区域明细表」回填生产场站的「中心站 / 集气站」两列。
// 表格结构（按现场实际模板，容忍表头行位置浮动）：
//   序号 | 中心站名称 | 分序 | 场站（采气井台） | 场内单井 | 地理位置 | 备注
// 中心站列多为合并单元格 → 解析时向下填充；场站列同理（同一场站多口单井）。
// 匹配：字典项 name 去掉 "TNB" 后缀后，与「场内单井」去「井」/「场站名」去尾缀 比对。
router.post('/import-station-map', adminAuth, importUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传 .xlsx 文件' })
  }

  // 归一化：去空白/全角、去 TNB、去常见尾缀（井场/集气站/脱水井场/井/站）
  const norm = (v) =>
    String(v == null ? '' : v)
      .replace(/\s/g, '')
      .replace(/[（）()]/g, '')
      .replace(/TNB$/i, '')
  const normWell = (v) => norm(v).replace(/(井场|集气站|脱水站|脱水井场|站|井)$/g, '')

  try {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) return res.status(400).json({ success: false, error: '文件无有效工作表' })
    const matrix = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' })

    // 定位表头行：同时含「中心站」「场站」关键字
    let headerIdx = -1
    for (let i = 0; i < Math.min(12, matrix.length); i++) {
      const line = (matrix[i] || []).map((c) => norm(c)).join('|')
      if (/中心站/.test(line) && /场站|采气井台/.test(line)) { headerIdx = i; break }
    }
    if (headerIdx < 0) {
      return res.status(400).json({
        success: false,
        error: '未识别到表头行：需要包含「中心站名称」「场站（采气井台）」「场内单井」等列',
      })
    }

    // 按表头文字定位列号
    const header = (matrix[headerIdx] || []).map((c) => norm(c))
    const findCol = (re) => header.findIndex((h) => re.test(h))
    const colCenter = findCol(/中心站/)
    const colStation = findCol(/场站|采气井台/)
    const colWell = findCol(/场内单井|单井|井号/)
    if (colCenter < 0 || colStation < 0) {
      return res.status(400).json({
        success: false,
        error: '表头缺少「中心站名称」或「场站（采气井台）」列，无法回填',
      })
    }

    // 逐行读取 + 向下填充（合并单元格只在首行有值）
    const triples = [] // { center, station, well }
    let curCenter = ''
    let curStation = ''
    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i] || []
      const c = String(row[colCenter] ?? '').trim()
      const st = String(row[colStation] ?? '').trim()
      const w = colWell >= 0 ? String(row[colWell] ?? '').trim() : ''
      if (c) curCenter = c
      if (st) curStation = st
      if (!curCenter) continue
      if (!st && !w) continue
      triples.push({ center: curCenter, station: curStation, well: w })
    }
    if (!triples.length) {
      return res.status(400).json({ success: false, error: '表中没有可用的数据行（中心站/场站/单井均为空）' })
    }

    // 载入现有生产场站字典
    const [dictRows] = await pool.execute(
      "SELECT id, code, name FROM t_hazard_dict WHERE type = 'center_station'"
    )
    // 建立索引：单井名 → 字典项、场站名 → 字典项
    const byWell = new Map()
    const byStation = new Map()
    for (const d of dictRows) {
      const nw = normWell(d.name)
      if (nw && !byWell.has(nw)) byWell.set(nw, d)
      const ns = normWell(d.name.replace(/井场$|集气站$/g, ''))
      if (ns && !byStation.has(ns)) byStation.set(ns, d)
    }

    let matched = 0
    const unmatched = []
    const centerStat = {}
    const seen = new Set()

    for (const t of triples) {
      let hit = t.well ? byWell.get(normWell(t.well)) : null
      if (!hit && t.station) hit = byStation.get(normWell(t.station))
      if (!hit) {
        unmatched.push({ center: t.center, station: t.station, well: t.well })
        continue
      }
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      await pool.execute(
        'UPDATE t_hazard_dict SET center_station_name = ?, gas_station_name = ? WHERE id = ?',
        [t.center, t.station, hit.id]
      )
      matched++
      centerStat[t.center] = (centerStat[t.center] || 0) + 1
    }

    // ── 同时把明细表写成归属规则（t_station_rule）──
    // 幂等：先清掉上次 excel 导入的规则（保留 manual），再重灌；INSERT IGNORE 不覆盖人工规则。
    let rules = { total: 0, byKind: { center: 0, station: 0, well: 0 } }
    await pool.execute("DELETE FROM t_station_rule WHERE source = 'excel'")
    const rank = { center: 0, station: 1, well: 2 }
    const ruleMap = new Map() // match_key -> { raw_name, kind, center, gas }
    const putRule = (name, kind, center, gas) => {
      const key = normalizeStationKey(name)
      if (!key) return
      const prev = ruleMap.get(key)
      if (prev && rank[prev.kind] >= rank[kind]) {
        if (!prev.gas && gas) prev.gas = gas
        return
      }
      ruleMap.set(key, { raw_name: String(name).trim(), kind, center: center || '', gas: gas || '' })
    }
    for (const t of triples) {
      putRule(t.center, 'center', t.center, '')
      if (t.station) putRule(t.station, 'station', t.center, t.station)
      if (t.well) putRule(t.well, 'well', t.center, t.station)
    }
    for (const r of ruleMap.values()) {
      await pool.execute(
        `INSERT IGNORE INTO t_station_rule
           (match_key, raw_name, kind, center_station_name, gas_station_name, source)
         VALUES (?, ?, ?, ?, ?, 'excel')`,
        [normalizeStationKey(r.raw_name), r.raw_name, r.kind, r.center, r.gas]
      )
    }
    invalidateCache()
    {
      const [[totRow]] = await pool.query('SELECT COUNT(*) AS n FROM t_station_rule')
      const [kindRows] = await pool.query('SELECT kind, COUNT(*) AS n FROM t_station_rule GROUP BY kind')
      const byKind = { center: 0, station: 0, well: 0 }
      for (const kr of kindRows) if (byKind[kr.kind] != null) byKind[kr.kind] = Number(kr.n)
      rules = { total: Number(totRow.n), byKind }
    }

    // 统计未归属的字典项（表里没有的）
    const [leftRows] = await pool.execute(
      "SELECT id, name FROM t_hazard_dict WHERE type = 'center_station' AND (center_station_name IS NULL OR center_station_name = '')"
    )

    res.json({
      success: true,
      message: `回填完成：匹配 ${matched} 条，未匹配 ${unmatched.length} 行，仍有 ${leftRows.length} 个场站未归属`,
      data: {
        triples: triples.length,
        matched,
        unmatched: unmatched.slice(0, 50),
        unmatchedCount: unmatched.length,
        byCenter: centerStat,
        stillUnassigned: leftRows.map((r) => r.name),
        rules,
      },
    })
  } catch (err) {
    console.error('[hazard-dict import-station-map]', err.message)
    res.status(500).json({ success: false, error: '回填失败：' + err.message })
  }
})

// ─── 归属规则管理：GET/POST/DELETE /api/hazard-dict/station-rules ────────────
// 规则来源：excel（明细表导入生成，只读）/ manual（人工维护，可删）
router.get('/station-rules', adminAuth, async (req, res) => {
  const { keyword = '', center = '' } = req.query
  try {
    const where = []
    const params = []
    if (keyword && String(keyword).trim()) {
      const kw = `%${String(keyword).trim()}%`
      where.push('(match_key LIKE ? OR raw_name LIKE ?)')
      params.push(kw, kw)
    }
    if (center && String(center).trim()) {
      where.push('center_station_name = ?')
      params.push(String(center).trim())
    }
    const sql = `SELECT id, match_key, raw_name, kind, center_station_name, gas_station_name, source
                   FROM t_station_rule
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY FIELD(kind,'center','station','well'), center_station_name, match_key
                  LIMIT 500`
    const [rows] = await pool.query(sql, params)
    res.json({ success: true, data: { list: rows } })
  } catch (err) {
    console.error('[hazard-dict station-rules list]', err.message)
    res.status(500).json({ success: false, error: '规则查询失败：' + err.message })
  }
})

router.post('/station-rules', adminAuth, async (req, res) => {
  const { raw_name, center_station_name = '', gas_station_name = '' } = req.body || {}
  if (!raw_name || !String(raw_name).trim()) {
    return res.status(400).json({ success: false, error: 'raw_name 不能为空' })
  }
  const key = normalizeStationKey(raw_name)
  if (!key) {
    return res.status(400).json({ success: false, error: '无法归一化该名称，请检查内容' })
  }
  try {
    await pool.execute(
      `INSERT INTO t_station_rule
         (match_key, raw_name, kind, center_station_name, gas_station_name, source)
       VALUES (?, ?, 'manual', ?, ?, 'manual')
       ON DUPLICATE KEY UPDATE
         raw_name = VALUES(raw_name),
         center_station_name = VALUES(center_station_name),
         gas_station_name = VALUES(gas_station_name),
         source = 'manual'`,
      [key, String(raw_name).trim(), String(center_station_name || '').trim(), String(gas_station_name || '').trim()]
    )
    invalidateCache()
    res.json({ success: true, data: { match_key: key } })
  } catch (err) {
    console.error('[hazard-dict station-rules create]', err.message)
    res.status(500).json({ success: false, error: '规则保存失败：' + err.message })
  }
})

router.delete('/station-rules/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, error: '无效的规则 ID' })
  }
  try {
    const [rows] = await pool.execute('SELECT id, source FROM t_station_rule WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ success: false, error: '未找到该规则' })
    if (rows[0].source !== 'manual') {
      return res.status(400).json({
        success: false,
        error: '该规则由明细表导入生成，请重新导入明细表',
      })
    }
    await pool.execute("DELETE FROM t_station_rule WHERE id = ? AND source = 'manual'", [id])
    invalidateCache()
    res.json({ success: true })
  } catch (err) {
    console.error('[hazard-dict station-rules delete]', err.message)
    res.status(500).json({ success: false, error: '规则删除失败：' + err.message })
  }
})

// ─── POST /api/hazard-dict/backfill-hazard-station —— 按场所回填 t_hazard 归属 ──
// body: { force: true|false }
//   force=false（默认）：只处理尚未归属的记录
//   force=true：全表重算（含已归属的）
router.post('/backfill-hazard-station', adminAuth, async (req, res) => {
  const force = req.body?.force === true || req.body?.force === 'true'
  // 明显是垃圾值的场所（时间字符串 / 纯数字 / 空）→ 跳过并计入未归属
  const isGarbage = (loc) => {
    const s = String(loc == null ? '' : loc).trim()
    if (!s) return true
    if (/(GMT|Sept|\bMon\b|\bTue\b|\bWed\b|\bThu\b|\bFri\b|\bSat\b|\bSun\b)/i.test(s)) return true
    if (/^\d+$/.test(s)) return true
    return false
  }
  try {
    await loadRules(true) // 强制刷新，确保使用最新规则

    const where = ['deleted_at IS NULL']
    if (!force) where.push("(center_station_name = '' OR center_station_name IS NULL)")
    const [recs] = await pool.query(
      `SELECT id, location FROM t_hazard WHERE ${where.join(' AND ')}`
    )

    let matched = 0
    let unmatched = 0
    const byCenter = {}
    const byGas = {}
    const unmatchedMap = new Map() // location -> count
    const updates = []
    const bump = (obj, k) => { if (k) obj[k] = (obj[k] || 0) + 1 }

    for (const rec of recs) {
      const loc = rec.location
      if (isGarbage(loc)) {
        unmatched++
        const k = String(loc == null ? '' : loc).trim() || '(空)'
        unmatchedMap.set(k, (unmatchedMap.get(k) || 0) + 1)
        continue
      }
      const st = resolveStation(loc)
      if (st && st.center_station_name) {
        matched++
        bump(byCenter, st.center_station_name)
        bump(byGas, st.gas_station_name)
        updates.push({ id: rec.id, center: st.center_station_name, gas: st.gas_station_name || '' })
      } else {
        unmatched++
        const k = String(loc).trim() || '(空)'
        unmatchedMap.set(k, (unmatchedMap.get(k) || 0) + 1)
      }
    }

    // 分批更新：每批 200 条，批内并发不超过 20
    const BATCH = 200
    const CONCURRENCY = 20
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH)
      for (let j = 0; j < chunk.length; j += CONCURRENCY) {
        const sub = chunk.slice(j, j + CONCURRENCY)
        await Promise.all(
          sub.map((u) =>
            pool.execute(
              'UPDATE t_hazard SET center_station_name = ?, gas_station_name = ? WHERE id = ?',
              [u.center, u.gas, u.id]
            )
          )
        )
      }
    }

    const sampleUnmatched = [...unmatchedMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([location, count]) => ({ location, count }))

    res.json({
      success: true,
      data: { total: recs.length, matched, unmatched, byCenter, byGas, sampleUnmatched },
    })
  } catch (err) {
    console.error('[hazard-dict backfill-hazard-station]', err.message)
    res.status(500).json({ success: false, error: '回填失败：' + err.message })
  }
})

module.exports = router
