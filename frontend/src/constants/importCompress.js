/**
 * 视频督查导入：xlsx 内嵌图片前端压缩参数（唯一真源）。
 * 架构师设计 §3.1 / §7.6 —— 禁止在组件内散落魔法数字。
 */

/** 压缩降级档位（最多 3 轮）：边最长 + JPEG 质量 */
export const COMPRESS_PROFILES = [
  { maxEdge: 1600, quality: 0.72 }, // 第 1 轮
  { maxEdge: 1280, quality: 0.6 }, // 第 2 轮（第 1 轮后仍超限）
  { maxEdge: 1024, quality: 0.5 }, // 第 3 轮（最后一搏）
]

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
