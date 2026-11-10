/**
 * 钉钉文档读取服务（直接作业预约报备 · 数据来源）
 *
 * 业务背景：直接作业预约报备数据目前由各队在「通南巴直接作业」钉钉群的在线表格里填写，
 * 要求每天 22:00 把数据同步到本系统。钉钉**没有**"拉取群历史消息"的开放接口，
 * 所以唯一可行的自动化路径是读那份**在线表格**本身。
 *
 * 支持两类载体（配置项 sourceType）：
 *   - workbook：钉钉表格（类 Excel 的在线表格）→ doc API
 *       GET /v1.0/doc/workbooks/{workbookId}/sheets
 *       GET /v1.0/doc/workbooks/{workbookId}/sheets/{sheetId}/ranges/{range}
 *   - notable ：智能表格 / AI 表格（多维表）→ notable API
 *       POST /v1.0/notable/bases/{baseId}/sheets/{sheetId}/records/list
 *
 * 两者都需要「企业内部应用」的 accessToken + 一个 operatorId（操作人 unionId）。
 * operatorId 决定权限判定：接口是以「这个人」的身份去读表，
 * 所以这个人必须是该表格的协作者，否则报 The operator has no permission。
 *
 * 官方文档：
 *   https://open.dingtalk.com/document/orgapp/obtain-all-worksheets
 *   https://open.dingtalk.com/document/orgapp/get-cell-properties
 *   https://open.dingtalk.com/document/development/common-problems-with-tables
 */

const API = 'https://api.dingtalk.com'
const TOKEN_URL = `${API}/v1.0/oauth2/accessToken`

// accessToken 有效期 7200s，缓存并按 appKey 区分，提前 5 分钟刷新
let tokenCache = { key: '', token: '', expireAt: 0 }

function cfgError(msg) {
  const e = new Error(msg)
  e.code = 'CONFIG_MISSING'
  return e
}

function assertConfig(cfg) {
  const type = cfg.sourceType === 'notable' ? 'notable' : 'workbook'
  if (!cfg.appKey || !cfg.appSecret) throw cfgError('未配置钉钉应用 AppKey / AppSecret')
  if (!cfg.operatorId) throw cfgError('未配置 operatorId（操作人 unionId），接口需要以某个有表格权限的人的身份读取')
  if (type === 'workbook' && !cfg.workbookId) throw cfgError('未配置 workbookId（钉钉表格文档 ID）')
  if (type === 'notable' && !cfg.baseId) throw cfgError('未配置 baseId（智能表格 ID）')
  return type
}

/** 取企业内部应用 accessToken（带缓存） */
async function getAccessToken(cfg) {
  const now = Date.now()
  if (tokenCache.token && tokenCache.key === cfg.appKey && tokenCache.expireAt > now + 5 * 60 * 1000) {
    return tokenCache.token
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
  })
  const text = await res.text()
  let j = {}
  try { j = JSON.parse(text) } catch (e) { /* 非 JSON */ }
  if (!j.accessToken) {
    const tip = j.code === 'invalidClientIdOrSecret'
      ? '（AppKey/AppSecret 不对，或该应用不是「企业内部应用」）'
      : ''
    throw new Error(`钉钉 accessToken 获取失败：${j.code || res.status} ${j.message || text.slice(0, 120)}${tip}`)
  }
  tokenCache = { key: cfg.appKey, token: j.accessToken, expireAt: now + (Number(j.expireIn) || 7200) * 1000 }
  return j.accessToken
}

async function dingGet(cfg, path) {
  const token = await getAccessToken(cfg)
  const res = await fetch(`${API}${path}`, {
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let j = {}
  try { j = JSON.parse(text) } catch (e) { /* ignore */ }
  if (!res.ok) {
    const msg = j.message || text.slice(0, 200)
    const hint = /no permission/i.test(msg)
      ? '（operatorId 对应的人没有该表格权限：请确认他已被加为表格协作者，且应用已开通「钉钉表格读权限」）'
      : ''
    throw new Error(`钉钉接口 ${res.status}：${j.code || ''} ${msg}${hint}`)
  }
  return j
}

async function dingPost(cfg, path, body) {
  const token = await getAccessToken(cfg)
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let j = {}
  try { j = JSON.parse(text) } catch (e) { /* ignore */ }
  if (!res.ok) {
    throw new Error(`钉钉接口 ${res.status}：${j.code || ''} ${(j.message || text).slice(0, 200)}`)
  }
  return j
}

/** 列出钉钉表格内所有工作表 → [{ id, name }] */
async function listSheets(cfg) {
  const wb = encodeURIComponent(cfg.workbookId)
  const op = encodeURIComponent(cfg.operatorId)
  const j = await dingGet(cfg, `/v1.0/doc/workbooks/${wb}/sheets?operatorId=${op}`)
  const arr = Array.isArray(j.value) ? j.value : (Array.isArray(j.sheets) ? j.sheets : [])
  return arr.map((s) => ({ id: s.id || s.sheetId, name: s.name || s.title || s.id }))
}

/**
 * 读一片区域 → 二维数组
 * @returns {{ values: any[][], displayValues: string[][] }}
 */
async function getRange(cfg, sheetId, rangeAddress) {
  const wb = encodeURIComponent(cfg.workbookId)
  const sid = encodeURIComponent(sheetId)
  const rng = encodeURIComponent(rangeAddress)
  const op = encodeURIComponent(cfg.operatorId)
  const j = await dingGet(
    cfg,
    `/v1.0/doc/workbooks/${wb}/sheets/${sid}/ranges/${rng}?select=values,displayValues&operatorId=${op}`
  )
  return {
    values: Array.isArray(j.values) ? j.values : [],
    displayValues: Array.isArray(j.displayValues) ? j.displayValues : [],
  }
}

/** 智能表格：列出全部记录（自动翻页）→ [{ fields: {...} }] */
async function listNotableRecords(cfg, sheetIdOrName) {
  const base = encodeURIComponent(cfg.baseId)
  const sid = encodeURIComponent(sheetIdOrName)
  const op = encodeURIComponent(cfg.operatorId)
  const out = []
  let nextToken = ''
  for (let i = 0; i < 20; i++) {   // 最多 20 页 × 100 条，足够日常预约量
    const body = { maxResults: 100 }
    if (nextToken) body.nextToken = nextToken
    const j = await dingPost(cfg, `/v1.0/notable/bases/${base}/sheets/${sid}/records/list?operatorId=${op}`, body)
    const list = Array.isArray(j.records) ? j.records : []
    out.push(...list)
    nextToken = j.nextToken || ''
    if (!nextToken || !list.length) break
  }
  return out
}

/** 智能表格：所有数据表 → [{ id, name }] */
async function listNotableSheets(cfg) {
  const base = encodeURIComponent(cfg.baseId)
  const op = encodeURIComponent(cfg.operatorId)
  const j = await dingGet(cfg, `/v1.0/notable/bases/${base}/sheets?operatorId=${op}`)
  const arr = Array.isArray(j.value) ? j.value : (Array.isArray(j.sheets) ? j.sheets : [])
  return arr.map((s) => ({ id: s.id || s.name, name: s.name || s.id }))
}

/**
 * 统一入口：按配置拉取整份数据
 * @returns {{ sourceType:string, sheets:Array<{name:string, rows:any[][]}>, raw?:any }}
 *   行数据统一成二维数组（第一行是表头所在位置由上层识别）
 */
async function fetchAll(cfg) {
  const type = assertConfig(cfg)
  if (type === 'workbook') {
    const all = await listSheets(cfg)
    const wanted = Array.isArray(cfg.sheetNames) && cfg.sheetNames.length
      ? all.filter((s) => cfg.sheetNames.includes(s.name) || cfg.sheetNames.includes(s.id))
      : all
    const rangeEnd = cfg.rangeEnd || 'Q300'
    const sheets = []
    for (const s of wanted) {
      const r = await getRange(cfg, s.id, `A1:${rangeEnd}`)
      // displayValues 优先（日期/数字格式已按界面呈现），缺失时退回 values
      const rows = r.displayValues.length >= r.values.length ? r.displayValues : r.values
      sheets.push({ name: s.name, rows })
    }
    return { sourceType: type, sheets }
  }
  // 智能表格
  const all = await listNotableSheets(cfg)
  const wanted = Array.isArray(cfg.sheetNames) && cfg.sheetNames.length
    ? all.filter((s) => cfg.sheetNames.includes(s.name))
    : all
  const sheets = []
  for (const s of wanted) {
    const recs = await listNotableRecords(cfg, s.id)
    const keys = []
    for (const r of recs) for (const k of Object.keys(r.fields || {})) if (!keys.includes(k)) keys.push(k)
    const rows = [keys, ...recs.map((r) => keys.map((k) => fmtNotableCell(r.fields?.[k])))]
    sheets.push({ name: s.name, rows })
  }
  return { sourceType: type, sheets }
}

/** 智能表格字段值 → 展示字符串 */
function fmtNotableCell(v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => fmtNotableCell(x)).filter(Boolean).join('、')
  if (typeof v === 'object') return v.name || v.text || v.title || JSON.stringify(v)
  return String(v)
}

module.exports = { getAccessToken, listSheets, getRange, listNotableSheets, listNotableRecords, fetchAll, assertConfig }
