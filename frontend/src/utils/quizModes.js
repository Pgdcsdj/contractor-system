/**
 * quizModes.js - 答题模式统一枚举与辅助函数
 *
 * 与后端 backend/src/constants/quizCodes.js 的 QUIZ_MODES 语义对齐
 * （前后端各自维护、命名同源，避免拼写漂移）。
 *
 * 模式说明：
 *  - study    学习：揭示答案与解析，不限时（仅统计用时）
 *  - practice 练习：揭示答案与解析，限时但可反复提交
 *  - exam     考试：不揭示答案，限时，倒计时归零自动交卷
 */

// 模式枚举（与后端保持一致）
export const QUIZ_MODES = {
  STUDY: 'study',
  PRACTICE: 'practice',
  EXAM: 'exam',
}

// 模式中文标签
export const MODE_LABELS = {
  study: '学习',
  practice: '练习',
  exam: '考试',
}

// 模式描述
export const MODE_DESC = {
  study: '查看答案与解析',
  practice: '计时练习可反复做',
  exam: '限时考试计成绩',
}

// 模式展示顺序（列表页分组用）
export const MODE_ORDER = [QUIZ_MODES.STUDY, QUIZ_MODES.PRACTICE, QUIZ_MODES.EXAM]

// 允许揭示答案/解析的模式（学习 & 练习）
const REVEALING_MODES = new Set([QUIZ_MODES.STUDY, QUIZ_MODES.PRACTICE])

/**
 * 判断是否为合法模式值
 * @param {string} mode
 * @returns {boolean}
 */
export function isValidMode(mode) {
  return Object.values(QUIZ_MODES).includes(mode)
}

/**
 * 判断该模式是否应揭示答案与解析
 * @param {string} mode
 * @returns {boolean}
 */
export function isRevealing(mode) {
  return REVEALING_MODES.has(mode)
}

/**
 * 获取模式中文标签（非法值回退 exam 标签）
 * @param {string} mode
 * @returns {string}
 */
export function getModeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.exam
}

/**
 * 获取模式描述
 * @param {string} mode
 * @returns {string}
 */
export function getModeDesc(mode) {
  return MODE_DESC[mode] || ''
}

/**
 * 判断是否限时（考试 & 练习为限时，学习不限时）
 * @param {string} mode
 * @returns {boolean}
 */
export function isTimed(mode) {
  return mode === QUIZ_MODES.PRACTICE || mode === QUIZ_MODES.EXAM
}

/**
 * 规范化模式：非法/空值回退到 fallback（默认 exam）
 * 大小写不敏感，与后端 normalizeModeParam 行为对齐（先 toLowerCase 再校验）。
 * @param {string} mode
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeMode(mode, fallback = QUIZ_MODES.EXAM) {
  const v = typeof mode === 'string' ? mode.toLowerCase() : mode
  return isValidMode(v) ? v : (isValidMode(fallback) ? fallback : QUIZ_MODES.EXAM)
}
