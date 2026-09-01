/**
 * 视频督查导入：xlsx 内嵌图片前端压缩参数（唯一真源）。
 * 架构师设计 §3.1 / §7.6 —— 禁止在组件内散落魔法数字。
 */

/** 压缩降级档位（整体多轮收敛到 TARGET_BYTES）：边最长 + JPEG 质量 */
export const COMPRESS_PROFILES = [
  { maxEdge: 1600, quality: 0.72 }, // 第 1 轮
  { maxEdge: 1280, quality: 0.60 }, // 第 2 轮（第 1 轮后仍超限）
  { maxEdge: 1024, quality: 0.50 }, // 第 3 轮
  { maxEdge: 800, quality: 0.45 }, // 第 4 轮
  { maxEdge: 640, quality: 0.40 }, // 第 5 轮
  { maxEdge: 480, quality: 0.35 }, // 第 6 轮
  { maxEdge: 360, quality: 0.30 }, // 第 7 轮（地板档：保证整体能压到 <5MB）
]

/**
 * 单图上限收敛档位：compressOne 压完仍 > MAX_IMAGE_BYTES 时逐档加码，
 * 直到达标或到达地板档。作为"唯一真源"导出（设计 §3.1）。
 */
export const PER_IMAGE_PROFILES = [
  { maxEdge: 900, quality: 0.60 },
  { maxEdge: 700, quality: 0.50 },
  { maxEdge: 520, quality: 0.42 },
  { maxEdge: 400, quality: 0.35 },
  { maxEdge: 300, quality: 0.30 }, // 地板档：仍超则接受，避免死循环
]

/** 单张图片硬上限：每张图压完必须 ≤ 200KB */
export const MAX_IMAGE_BYTES = 200 * 1024

/** 目标体积：留 0.4MB 给 multipart 边界开销（< 5MB 红线） */
export const TARGET_BYTES = 4.6 * 1024 * 1024

/** 后端 multer 红线（硬上限） */
export const HARD_LIMIT = 5 * 1024 * 1024

/** 小于此值的图不压（图标 / 签章等） */
export const MIN_IMAGE_BYTES = 80 * 1024

/** xlsx 内嵌媒体路径前缀 */
export const MEDIA_PREFIX = 'xl/media/'

/** 单行最多关联截图数（后端一致） */
export const MAX_PHOTO_PER_ROW = 6
