/**
 * progressStorage.js - 答题断点续做（localStorage 持久化）
 *
 * Key 约定：tnb_quiz_progress_${materialId}_${mode}
 * 存储内容：{ answers, currentIndex, elapsedSec, updatedAt }
 *
 * 设计要点：
 *  - answers 直接复用 quiz store 中 answers 对象结构（{ [questionId]: answer }），
 *    因此恢复时可直接 Object.assign 回 store。
 *  - elapsedSec 为已用时（秒），由答题页计时器累加，用于恢复倒计时/计费用时。
 *  - 仅依赖 localStorage（与 offlineDb 的内存实现解耦，断点续做不依赖网络）。
 */

const PROGRESS_PREFIX = 'tnb_quiz_progress_'

/** 构造存储 key */
function buildKey(materialId, mode) {
  return `${PROGRESS_PREFIX}${materialId}_${mode}`
}

/** 安全 JSON 解析，失败返回 null */
function safeParse(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 读取某题库某模式的断点进度
 * @param {number|string} materialId
 * @param {string} mode
 * @returns {{answers: object, currentIndex: number, elapsedSec: number, updatedAt?: number} | null}
 */
export function loadProgress(materialId, mode) {
  if (!materialId || !mode) return null
  const raw = localStorage.getItem(buildKey(materialId, mode))
  if (!raw) return null
  const data = safeParse(raw)
  if (!data || typeof data !== 'object') return null
  return {
    answers: data.answers && typeof data.answers === 'object' ? data.answers : {},
    currentIndex: Number.isFinite(data.currentIndex) ? data.currentIndex : 0,
    elapsedSec: Number.isFinite(data.elapsedSec) ? data.elapsedSec : 0,
    updatedAt: data.updatedAt || 0,
  }
}

/**
 * 保存断点进度
 * @param {number|string} materialId
 * @param {string} mode
 * @param {{answers?: object, currentIndex?: number, elapsedSec?: number}} progress
 */
export function saveProgress(materialId, mode, progress) {
  if (!materialId || !mode) return
  const payload = {
    answers: (progress && progress.answers) || {},
    currentIndex: progress && Number.isFinite(progress.currentIndex) ? progress.currentIndex : 0,
    elapsedSec: progress && Number.isFinite(progress.elapsedSec) ? progress.elapsedSec : 0,
    updatedAt: Date.now(),
  }
  try {
    localStorage.setItem(buildKey(materialId, mode), JSON.stringify(payload))
  } catch (e) {
    // 配额满/隐私模式等场景静默失败，不影响答题主流程
    console.warn('[progressStorage] 保存失败', e)
  }
}

/**
 * 清除某题库某模式的断点进度（提交成功后调用）
 * @param {number|string} materialId
 * @param {string} mode
 */
export function clearProgress(materialId, mode) {
  if (!materialId || !mode) return
  localStorage.removeItem(buildKey(materialId, mode))
}

/**
 * 列出所有未完成的断点进度摘要，供列表页显示"继续作答"
 * @returns {Array<{materialId:number, mode:string, answersCount:number, currentIndex:number, elapsedSec:number, updatedAt:number}>}
 */
export function listInProgress() {
  const result = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(PROGRESS_PREFIX)) continue
    const matched = key.slice(PROGRESS_PREFIX.length).match(/^(\d+)_(study|practice|exam)$/)
    if (!matched) continue
    const data = safeParse(localStorage.getItem(key))
    if (!data) continue
    const answersCount = data.answers && typeof data.answers === 'object'
      ? Object.keys(data.answers).length
      : 0
    result.push({
      materialId: Number(matched[1]),
      mode: matched[2],
      answersCount,
      currentIndex: Number.isFinite(data.currentIndex) ? data.currentIndex : 0,
      elapsedSec: Number.isFinite(data.elapsedSec) ? data.elapsedSec : 0,
      updatedAt: data.updatedAt || 0,
    })
  }
  // 按最近更新时间倒序
  result.sort((a, b) => b.updatedAt - a.updatedAt)
  return result
}

/**
 * 判断某题库某模式是否存在进度（用于列表页"继续作答"判断）
 * @param {number|string} materialId
 * @param {string} mode
 * @returns {boolean}
 */
export function hasProgress(materialId, mode) {
  const p = loadProgress(materialId, mode)
  if (!p) return false
  const answered = p.answers && Object.keys(p.answers).length > 0
  return !!(answered || p.currentIndex > 0 || p.elapsedSec > 0)
}
