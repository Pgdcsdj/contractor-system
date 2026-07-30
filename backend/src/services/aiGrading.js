/**
 * 简答题 AI 评分服务（P0：打通调用链，但默认关闭）
 *
 * 设计：
 *  - 对外暴露 gradeShortAnswer(question, reference, userAnswer, maxScore)。
 *  - 仅当题库 material.ai_grading = 1 时被 quiz.js 的 submit 调用（见 routes/quiz.js）。
 *  - 当前为安全占位实现：未配置可用 AI 后端时返回 null，由调用方降级为
 *    「记 0 分 + 提示人工批改」，避免引入新依赖或抛出异常导致 502。
 *
 * 后续接入真实大模型评分（P1 T08）时，只需在此实现调用逻辑并返回：
 *   { score:number, maxScore:number, correctPoints:string[], missingPoints:string[], encouragement:string }
 *
 * @param {{ question:string, reference:string, userAnswer:string, maxScore:number }} params
 * @returns {Promise<object|null>} 评分结果；无法评分（未配置）时返回 null
 */
async function gradeShortAnswer({ question, reference, userAnswer, maxScore }) {
  // TODO(P1): 接入真实 AI 评分后端（读取 ai-config），当前无可用后端 → 返回 null 触发人工批改降级
  return null
}

module.exports = { gradeShortAnswer }
