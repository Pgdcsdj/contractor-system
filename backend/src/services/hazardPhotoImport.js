/**
 * 视频督查截图落库编排服务（hazardPhotoImport）
 *
 * 职责：事务提交「之后」调用 —— 把 xlsxImageExtractor 解析出的图片
 *   ① 并发上传 COS（network IO，绝不在 MySQL 事务内）
 *   ② 批量写入 t_hazard_photo（photo_type='report'）
 *   ③ 回填主表首图 t_hazard.photo_url
 * 失败不影响已导入隐患（弱一致 / 尽力而为）：整段被 commitImport 的 try/catch 包裹，
 * 本服务自身也不向外抛，只把失败计入 warnings。
 *
 * 设计约束（§3.3 / §7）：
 *   - 并发度 4（手写 p-limit，零新增依赖）
 *   - COS：subdir='hazards/import'，不改 cosUpload（key 内部生成）
 *   - t_hazard_photo：photo_type 恒为 'report'
 *   - 首图回填条件：AND (photo_url IS NULL OR photo_url='')
 */

const { pool } = require('../db/db')
const cosUpload = require('./cosUpload')

/** 并发上限 */
const CONCURRENCY = 4

/**
 * 受限并发 map（手写，零依赖）。
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function limitedMap(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        results[i] = { error: e }
      }
    }
  }
  const n = Math.min(limit, items.length)
  const workers = []
  for (let i = 0; i < n; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/**
 * 把图片按行关联上传 COS 并写入 t_hazard_photo。
 * @param {Map<string, Array<{sheetName:string, anchorRow:number, entryName:string, ext:string, buffer:Buffer, seq:number}>>} byRowKey
 *         rowKey = `${sheetName}#${rowNo}`
 * @param {Map<string, number>} rowKeyToHazardId  commitImport 事务内回收的 rowKey -> 新隐患 id
 * @param {object} [ctx]  可选上下文，{ orphan } 用于补全返回体中的 orphan 计数
 * @returns {Promise<{uploaded:number, failed:number, orphan:number, warnings:string[]}>}
 */
async function uploadAndBind(byRowKey, rowKeyToHazardId, ctx = {}) {
  const warnings = []
  let uploaded = 0
  let failed = 0

  const rowKeys = Array.from(byRowKey.keys())
  const allPhotoRows = [] // [hazardId, url, 'report']
  const firstPhotoUpdates = [] // [url, hazardId]

  await limitedMap(rowKeys, CONCURRENCY, async (rowKey) => {
    const hazardId = rowKeyToHazardId.get(rowKey)
    const imgs = byRowKey.get(rowKey)
    if (!hazardId || !imgs || !imgs.length) return
    const urls = []
    for (const img of imgs) {
      try {
        const safeName = `${rowKey.replace(/[#\s]+/g, '_')}_${img.seq}${img.ext}`
        const { url } = await cosUpload.uploadFile(img.buffer, safeName, 'hazards/import')
        urls.push(url)
        uploaded++
      } catch (e) {
        failed++
        warnings.push(`截图上传失败（${rowKey} 第${img.seq}张）：${e && e.message ? e.message : '未知错误'}`)
      }
    }
    if (urls.length) {
      urls.forEach((u) => allPhotoRows.push([hazardId, u, 'report']))
      firstPhotoUpdates.push([urls[0], hazardId])
    }
  })

  // 批量写 t_hazard_photo
  if (allPhotoRows.length) {
    try {
      await pool.query('INSERT INTO t_hazard_photo (hazard_id, photo_url, photo_type) VALUES ?', [allPhotoRows])
    } catch (e) {
      failed += allPhotoRows.length
      warnings.push(`截图写入 t_hazard_photo 失败：${e && e.message ? e.message : '未知错误'}`)
    }
  }

  // 回填主表首图（仅当主表该隐患尚无图）
  for (const [url, hid] of firstPhotoUpdates) {
    try {
      await pool.execute(
        "UPDATE t_hazard SET photo_url = ? WHERE id = ? AND (photo_url IS NULL OR photo_url = '')",
        [url, hid]
      )
    } catch (e) {
      warnings.push(`主表首图回填失败（隐患 #${hid}）：${e && e.message ? e.message : '未知错误'}`)
    }
  }

  return {
    uploaded,
    failed,
    orphan: ctx.orphan || 0,
    warnings,
  }
}

module.exports = {
  uploadAndBind,
  limitedMap,
}
