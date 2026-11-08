/**
 * 场所 → 中心站 归属解析服务
 *
 * 隐患记录 t_hazard.location 是自由文本（如「马4井场（马302）」「马305-2井」「马113-1井压裂施工」），
 * 与字典名称（如「马101TNB」）完全对不上。本服务把任意场所文本归一成匹配键，再按
 * t_station_rule（由运维明细表导入 + 人工维护）解析出所属中心站 / 场站。
 *
 * 导出：normalizeStationKey / loadRules / resolveStation / resolveMany / invalidateCache / CENTER_STATIONS
 *
 * 归属判定原则：宁可空也不要错 —— 不确定时返回 null，统计里体现为「未归属」，绝不瞎猜。
 */

const { pool } = require('../db/db')

// 四个中心站（排名考核口径，固定）
const CENTER_STATIONS = ['马103中心站', '马1-11中心站', '马10中心站', '马3中心站']

// 尾缀剥离表（从长到短，每轮只剥一个）
const TAIL_SUFFIXES = [
  '井口操作台',
  '方井池',
  '钻井工程',
  '钻前工程',
  '动土作业警戒带',
  '压裂施工',
  '脱水井场',
  '脱水站',
  '集气站',
  '井场',
  '现场',
  '井',
  '站',
]

/**
 * 把任意场所文本归一成匹配键。
 * @param {*} raw
 * @returns {string}
 */
function normalizeStationKey(raw) {
  let s = String(raw == null ? '' : raw).normalize('NFKC')
  // 去括号及其内容（中英文/各类括号）
  s = s.replace(/[（(【\[〔][^）)】\]〕]*[）)】\]〕]/g, '')
  // 删除所有空白字符
  s = s.replace(/\s+/g, '')
  // 去掉尾随的斜杠等分隔噪声（如「马10中心站/」）
  s = s.replace(/[\/]+$/g, '')
  // 去掉开头的序号前缀（如 "1." "2、" "3)"）
  s = s.replace(/^\d+[.、,，)）:：]\s*/, '')
  // 中心站：整串直接作为 key，跳过尾缀剥离（避免「马103中心站」变成「马103中心」）
  if (/中心站$/.test(s)) return s.toUpperCase()
  // 循环剥离尾缀（长度从长到短，每轮只剥一个，最多 6 轮；剥后长度 < 2 则回退）
  let guard = 0
  let changed = true
  while (changed && guard < 6) {
    changed = false
    for (const suf of TAIL_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) {
        const next = s.slice(0, s.length - suf.length)
        if (next.length >= 2) {
          s = next
          changed = true
          break
        }
      }
    }
    guard++
  }
  return s.toUpperCase()
}

// 模块级缓存：{ at, list, map }
const RULES_TTL_MS = 5 * 60 * 1000
let _cache = { at: 0, list: [], map: new Map() }

/**
 * 从 t_station_rule 载入规则到内存缓存（5 分钟 TTL）。
 * @param {boolean} force 强制刷新
 * @returns {Promise<{at:number,list:Array,map:Map}>}
 */
async function loadRules(force = false) {
  if (!force && _cache.at && Date.now() - _cache.at < RULES_TTL_MS) {
    return _cache
  }
  const [rows] = await pool.execute(
    `SELECT match_key, raw_name, kind, center_station_name, gas_station_name, source
       FROM t_station_rule`
  )
  const list = []
  const map = new Map()
  for (const r of rows) {
    const key = String(r.match_key || '').toUpperCase()
    if (!key) continue
    const rule = {
      key,
      raw_name: r.raw_name || '',
      kind: r.kind || 'well',
      center_station_name: r.center_station_name || '',
      gas_station_name: r.gas_station_name || '',
      source: r.source || 'excel',
    }
    list.push(rule)
    map.set(key, rule)
  }
  _cache = { at: Date.now(), list, map }
  return _cache
}

/** 清空规则缓存 */
function invalidateCache() {
  _cache = { at: 0, list: [], map: new Map() }
}

function pick(rule) {
  if (!rule) return null
  return {
    center_station_name: rule.center_station_name || '',
    gas_station_name: rule.gas_station_name || '',
  }
}

/**
 * 解析单个场所文本 → { center_station_name, gas_station_name } 或 null。
 * 同步函数，使用内存缓存（调用前应确保已 await loadRules()）。
 * @param {string} location
 */
function resolveStation(location) {
  const key = normalizeStationKey(location)
  if (!key) return null
  const { map, list } = _cache

  // 1. 精确命中
  if (map.has(key)) return pick(map.get(key))

  // 2. 前缀命中：key 是某规则 key 的前缀，且规则 key 长度 ≤ key.length+3
  const tryPrefix = (k) => {
    const hits = []
    for (const r of list) {
      if (r.key.length > k.length && r.key.length <= k.length + 3 && r.key.startsWith(k)) {
        hits.push(r)
      }
    }
    if (!hits.length) return null
    const centers = [...new Set(hits.map((h) => h.center_station_name).filter(Boolean))]
    if (centers.length === 1) return pick(hits[0])
    // 多条且中心站不唯一 → 取最短的那条
    hits.sort((a, b) => a.key.length - b.key.length)
    return pick(hits[0])
  }

  // 3. 井号族：base = key 去掉尾部 -数字[字母]；若族内中心站去重后唯一 → 命中（gas 留空）
  const tryFamily = (k) => {
    const base = k.replace(/-[0-9]+[A-Z]*$/, '')
    if (base === k) return null
    const fam = list.filter((r) => r.key.startsWith(base))
    if (!fam.length) return null
    const centers = [...new Set(fam.map((h) => h.center_station_name).filter(Boolean))]
    if (centers.length === 1 && centers[0]) {
      return { center_station_name: centers[0], gas_station_name: '' }
    }
    return null
  }

  let r = tryPrefix(key)
  if (r) return r
  r = tryFamily(key)
  if (r) return r

  // 4. 去 TNB 后再走 2/3 步
  if (/TNB$/.test(key)) {
    const k2 = key.replace(/TNB$/, '')
    if (map.has(k2)) return pick(map.get(k2))
    r = tryPrefix(k2)
    if (r) return r
    r = tryFamily(k2)
    if (r) return r
  }

  // 5. 中心站直配
  for (const c of CENTER_STATIONS) {
    if (normalizeStationKey(c) === key) {
      return { center_station_name: c, gas_station_name: '' }
    }
  }

  // 6. 都不中
  return null
}

/**
 * 批量解析，先 loadRules() 一次。
 * @param {string[]} locations
 * @returns {Promise<Map<string, object|null>>}
 */
async function resolveMany(locations) {
  await loadRules()
  const out = new Map()
  for (const loc of locations) out.set(loc, resolveStation(loc))
  return out
}

module.exports = {
  normalizeStationKey,
  loadRules,
  resolveStation,
  resolveMany,
  invalidateCache,
  CENTER_STATIONS,
}
