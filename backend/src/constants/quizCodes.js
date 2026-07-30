/**
 * 学员端答题模块 - 共享枚举与错误码
 *
 * 与前端 frontend/src/utils/quizModes.js 保持语义一致（前后端各自维护、命名同源）。
 * 仅放「纯数据常量」，不依赖任何运行时模块，便于 require。
 */

// 规范题型（与导入 TYPE_MAP 对齐）
const QUIZ_TYPES = {
  SINGLE: 'single',
  MULTIPLE: 'multiple',
  JUDGMENT: 'judgment',
  ESSAY: 'essay',
}

// 历史别名 -> 规范值（导入 / 渲染层收敛）
const TYPE_ALIAS_MAP = {
  choice: 'single',
  multi: 'multiple',
  subjective: 'essay',
}

// 含选项的题型（前端渲染分支用，后端评分时亦参考）
const HAS_OPTIONS = ['single', 'multiple', 'judgment']

// 模式
const QUIZ_MODES = {
  STUDY: 'study',
  PRACTICE: 'practice',
  EXAM: 'exam',
}

// 结构化错误码 -> { http 状态码, 中文 message }
// 约定：后端 4xx 必须返回 { code, error }，前端按 code 渲染精确提示。
const ERROR_CODES = {
  MATERIAL_NOT_FOUND:    { http: 404, message: '题库不存在' },
  NOT_PUBLISHED:         { http: 403, message: '该题库尚未发布' },
  NO_ENABLED_QUESTIONS:  { http: 409, message: '题库暂无可用题目' },
  EMPTY_ANSWERS:         { http: 400, message: '答题内容不能为空' },
  ATTEMPT_LIMIT_EXCEEDED: { http: 409, message: '考试次数已用尽' },
  NO_RECORD:             { http: 404, message: '暂无答题记录' },
  INTERNAL_ERROR:        { http: 500, message: '服务器异常，请稍后重试' },
}

module.exports = { QUIZ_TYPES, TYPE_ALIAS_MAP, HAS_OPTIONS, QUIZ_MODES, ERROR_CODES }
