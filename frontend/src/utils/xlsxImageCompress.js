/**
 * 视频督查 xlsx 图片压缩：主线程 API。
 *
 * 把重活交给 Web Worker（fflate + OffscreenCanvas），主线程只收进度、最终拿回压缩后的 File。
 * 设计 §3.1：
 *   compressXlsxImages(file, onProgress) → CompressResult
 *   - 非 .xlsx 或无内嵌图 → skipped=true，原文件直出（不压、不阻塞上传）。
 *   - overLimit=true → 压缩后仍 > 5MB 红线，调用方应阻断上传并提示拆分。
 *   - 返回的 file 与原始同名，可直接作为 FormData 的 'file' 字段上传。
 *
 * 两次上传（预览 / 确认）必须是「同一个」压缩后 File（设计 §7.8），调用方负责缓存本结果。
 */

import CompressorWorker from '@/workers/xlsxCompress.worker.js?worker'

/**
 * @typedef {Object} CompressResult
 * @property {File}   file            压缩后的新 File（同名，可直接上传）
 * @property {number} originalSize    原始字节数
 * @property {number} finalSize       压缩后字节数
 * @property {number} imageCount      内嵌图片数
 * @property {number} compressedCount 实际被压缩（体积变小）的张数
 * @property {number} rounds          实际迭代轮数
 * @property {boolean} overLimit      压缩后仍 > HARD_LIMIT（5MB）
 * @property {boolean} skipped        非 .xlsx / 无内嵌图，原文件直出
 */

/**
 * 压缩 xlsx 内嵌图片（前置到上传之前调用）。
 * @param {File} file 用户选择的原始 xlsx
 * @param {(p:{phase:'unzip'|'compress'|'zip', done:number, total:number})=>void} [onProgress]
 * @returns {Promise<CompressResult>}
 */
export async function compressXlsxImages(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new CompressorWorker()
    worker.onmessage = (ev) => {
      const data = ev.data || {}
      if (data.type === 'progress') {
        if (onProgress) onProgress(data)
      } else if (data.type === 'done') {
        worker.terminate()
        resolve(data.result)
      } else if (data.type === 'error') {
        worker.terminate()
        reject(new Error(data.message || '压缩失败'))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(e instanceof Error ? e : new Error('Worker 异常'))
    }
    file
      .arrayBuffer()
      .then((buf) => {
        worker.postMessage({ buffer: buf, fileName: file.name }, [buf])
      })
      .catch(reject)
  })
}

/** 是否需要对本文件做压缩（仅视频督查导入的 .xlsx） */
export function shouldCompress(file, importType) {
  return importType === 'video_supervision' && !!file && /\.xlsx$/i.test(file.name)
}

/** 字节数 → MB 字符串（保留 2 位） */
export function toMB(bytes) {
  if (!bytes && bytes !== 0) return '-'
  return (bytes / (1024 * 1024)).toFixed(2) + 'MB'
}
