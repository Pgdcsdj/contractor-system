/**
 * progressStorage.js - 答题断点续做持久化
 *
 * 双层存储：
 *  1) localStorage（设备本地，瞬时可用、支持离线快取）：Key = tnb_quiz_progress_${materialId}_${mode}
 *  2) 服务端（绑定登录用户，跨设备/重登可用）：/api/quiz/progress/...
 *
 * 设计要点：
 *  - answers 直接复用 quiz store 中 answers 对象结构（{ [questionId]: answer }），
 *    恢复时可直接 Object.assign 回 store。
 *  - 服务端为主、localStorage 为缓存：恢复时优先读服务端，失败回退本地；
 *    保存时本地即时写、服务端防抖写（由调用方触发）。
 *  - 服务端同步使用独立 axios 实例（不带 401 重定向拦截），避免后台保存偶发 401
 *    把正在答题的用户强制踢回登录页。
 */

import axios from 'axios'

// 独立实例：仅自动带员工 token，不挂载 401 重定向拦截
const progressApi = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})
progressApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('tnb_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
// 注意：故意不挂 response 拦截 → 任何错误（含 401）都静默失败，仅回退本地缓存。

/** 把 trainingId 映射到服务端 scope/materialId（'wrong' → 错题练习） */
function mapTarget(trainingId) {
  if (String(trainingId) === 'wrong') return { path: 'wrong', scope: 'wrong', materialId: 0 }
  return { path: String(trainingId), scope: 'material', materialId: Number(trainingId) }
}

/**
 * 从服务端读取断点进度（主来源）。失败/无进度返回 null。
 * @returns {{answers:object,currentIndex:number,elapsedSec:number}|null}
 */
export async function fetchServerProgress(trainingId, mode) {
  try {
    const { path } = mapTarget(trainingId)
    const res = await progressApi.get(`/api/quiz/progress/${path}`, { params: { mode } })
    if (res.data?.success && res.data?.data) return res.data.data
    return null
  } catch {
    return null
  }
}

/**
 * 保存断点进度到服务端（覆盖式）。失败静默。
 */
export async function saveServerProgress(trainingId, mode, progress) {
  try {
    const { path } = mapTarget(trainingId)
    await progressApi.put(`/api/quiz/progress/${path}`, {
      mode,
      answers: (progress && progress.answers) || {},
      currentIndex: progress?.currentIndex || 0,
      elapsedSec: progress?.elapsedSec || 0,
    })
  } catch {
    /* 静默失败：本地缓存已保底 */
  }
}

/**
 * 清除服务端断点进度（提交成功后）。
 */
export async function clearServerProgress(trainingId, mode) {
  try {
    const { path } = mapTarget(trainingId)
    await progressApi.delete(`/api/quiz/progress/${path}`, { params: { mode } })
  } catch {
    /* 静默失败 */
  }
}


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
