/**
 * 视频督查 xlsx 压缩 Worker（实现体）
 *
 * 在 Web Worker 中执行重活：
 *   ① fflate.unzipSync 解包 xlsx（zip）
 *   ② 仅处理 xl/media/* 图片：createImageBitmap + OffscreenCanvas 逐张压成 JPEG
 *   ③ 多轮降级：第 1 轮后仍 > TARGET_BYTES 则按 COMPRESS_PROFILES 降档重压（最多 3 轮，达标即停）
 *   ④ fflate.zipSync 重打包（其余条目字节级原样写回）
 *   ⑤ 构造新 File 回传主线程（同名，可直接上传）
 *
 * 非 .xlsx / 无 xl/media/ → skipped，原样返回。
 * 依赖：fflate（前端唯一新增依赖，~8KB gzip，纯 JS）。
 *
 * 说明：设计 §3.1 建议 media 用 Store(level 0)、xml 用 level 6。本实现用 zipSync 全局
 * level 6 —— 媒体已是有损/无损压缩过的图，deflate 对其几乎无收益，最终体积等价；
 * 全局 level 换取实现可靠性（规避逐条目 level 的流式 API 边界问题），Excel/WPS 读取无差异。
 */

import { unzipSync, zipSync } from 'fflate'
import {
  COMPRESS_PROFILES,
  TARGET_BYTES,
  HARD_LIMIT,
  MIN_IMAGE_BYTES,
  MEDIA_PREFIX,
  MAX_IMAGE_BYTES,
  PER_IMAGE_PROFILES,
} from '@/constants/importCompress'

const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

function isImageEntry(name) {
  return name.startsWith(MEDIA_PREFIX) && !name.endsWith('/') && /\.(png|jpe?g|gif|bmp|webp)$/i.test(name)
}

function mimeFromName(name) {
  const m = name.toLowerCase().match(/\.(\w+)$/)
  return MIME_MAP[m ? m[1] : ''] || 'image/png'
}

/**
 * 按某 profile 把一张图压成 JPEG Uint8Array（等比缩放 + 指定质量）。
 * 内部小函数，被 compressOne 复用（主档 + 单图上限兜底档共用同一套编码逻辑）。
 * @param {Uint8Array} bytes 原始图片字节
 * @param {{maxEdge:number, quality:number}} profile 缩放/质量参数
 * @param {string} mime 原图 MIME
 * @returns {Promise<Uint8Array>}
 */
async function encode(bytes, profile, mime) {
  const blob = new Blob([bytes], { type: mime })
  const bmp = await createImageBitmap(blob)
  try {
    const w0 = bmp.width || 1
    const h0 = bmp.height || 1
    const scale = Math.min(1, profile.maxEdge / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('OffscreenCanvas 2d context 不可用')
    ctx.drawImage(bmp, 0, 0, w, h)
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: profile.quality })
    return new Uint8Array(await out.arrayBuffer())
  } finally {
    if (typeof bmp.close === 'function') bmp.close()
  }
}

/**
 * 压缩单张图：先用主 profile 编码，再始终应用单图上限。
 * 若主档压完仍 > MAX_IMAGE_BYTES，用 PER_IMAGE_PROFILES 逐档加码重压，
 * 直到 ≤ MAX_IMAGE_BYTES 或走完地板档（300/0.30 仍超也接受，不再循环）。
 * @param {Uint8Array} bytes 原始图片字节
 * @param {{maxEdge:number, quality:number}} profile 主压缩档（来自 COMPRESS_PROFILES 当前轮）
 * @param {string} mime 原图 MIME
 * @returns {Promise<Uint8Array>}
 */
async function compressOne(bytes, profile, mime) {
  let out = await encode(bytes, profile, mime)
  // 单图上限必须在每一轮都生效（第 1 轮 1600px 也可能单图 >200KB）
  if (out.length > MAX_IMAGE_BYTES) {
    for (let i = 0; i < PER_IMAGE_PROFILES.length; i++) {
      out = await encode(bytes, PER_IMAGE_PROFILES[i], mime)
      if (out.length <= MAX_IMAGE_BYTES) break // 达标即停
      // 否则继续下一更激进档位；走完地板档仍超则接受（避免死循环）
    }
  }
  return out
}

/**
 * 多轮降级压缩一组媒体条目（达标即停）。
 * @param {Array<{name:string, bytes:Uint8Array}>} media
 * @param {number} nonMediaSize  其余条目总字节（用于估算打包后体积，避免反复 zipSync）
 * @returns {{ entries: Record<string,Uint8Array>, compressedCount:number, rounds:number }}
 */
async function compressMedia(media, nonMediaSize) {
  let chosen = null
  let compressedCount = 0
  let rounds = 0
  for (let i = 0; i < COMPRESS_PROFILES.length; i++) {
    rounds++
    const profile = COMPRESS_PROFILES[i]
    const compressed = {}
    let estMedia = 0
    for (const { name, bytes } of media) {
      if (bytes.length < MIN_IMAGE_BYTES) {
        compressed[name] = bytes
        estMedia += bytes.length
        continue
      }
      try {
        compressed[name] = await compressOne(bytes, profile, mimeFromName(name))
      } catch (e) {
        // 单张失败（如 bmp 不被 createImageBitmap 支持）：保留原图
        compressed[name] = bytes
      }
      estMedia += compressed[name].length
    }
    chosen = compressed
    // 估算打包后体积（zip 中央目录开销相对 MB 可忽略）
    const estFinal = nonMediaSize + estMedia
    if (estFinal <= TARGET_BYTES) break
  }
  for (const { name, bytes } of media) {
    const c = chosen[name]
    if (c && c.length < bytes.length) compressedCount++
  }
  return { entries: chosen, compressedCount, rounds }
}

function post(msg) {
  self.postMessage(msg)
}

self.onmessage = async (ev) => {
  const { buffer, fileName } = ev.data || {}
  try {
    const arr = new Uint8Array(buffer)
    let entries
    try {
      entries = unzipSync(arr)
    } catch (e) {
      // 非 zip（.xls/.csv/损坏）→ 原样返回
      const f = new File([arr], fileName, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      return post({
        type: 'done',
        result: {
          file: f,
          originalSize: arr.length,
          finalSize: arr.length,
          imageCount: 0,
          compressedCount: 0,
          rounds: 0,
          overLimit: false,
          skipped: true,
        },
      })
    }

    const mediaNames = Object.keys(entries).filter(isImageEntry)
    if (mediaNames.length === 0) {
      const f = new File([arr], fileName, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      return post({
        type: 'done',
        result: {
          file: f,
          originalSize: arr.length,
          finalSize: arr.length,
          imageCount: 0,
          compressedCount: 0,
          rounds: 0,
          overLimit: false,
          skipped: true,
        },
      })
    }

    const mediaSet = new Set(mediaNames)
    let nonMediaSize = 0
    for (const name of Object.keys(entries)) {
      if (!mediaSet.has(name)) nonMediaSize += entries[name].length
    }
    const media = mediaNames.map((name) => ({ name, bytes: entries[name] }))
    const imageCount = mediaNames.length

    post({ type: 'progress', phase: 'compress', done: 0, total: media.length })
    const { entries: compressed, compressedCount, rounds } = await compressMedia(media, nonMediaSize)

    post({ type: 'progress', phase: 'zip', done: media.length, total: media.length })
    // 重打包：仅替换媒体条目，其余字节级原样写回
    const next = { ...entries }
    for (const name of mediaNames) next[name] = compressed[name]
    const zipped = zipSync(next, { level: 6 })

    const finalSize = zipped.length
    const overLimit = finalSize > HARD_LIMIT
    const f = new File([zipped], fileName, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      lastModified: Date.now(),
    })

    post({
      type: 'done',
      result: {
        file: f,
        originalSize: arr.length,
        finalSize,
        imageCount,
        compressedCount,
        rounds,
        overLimit,
        skipped: false,
      },
    })
  } catch (e) {
    post({ type: 'error', message: e && e.message ? e.message : '压缩失败' })
  }
}
