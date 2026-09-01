/**
 * answerJudge.js —— 前端答案判定统一工具
 *
 * 背景（多选题圆点显示红色的根因）：
 *   答题页多选题的用户答案存的是「选项 key 数组」，如 ['A','C']；
 *   而后端下发的正确答案 q.correctAnswer 是字符串，可能是 "AC"、"A,C"、"A，C" 等写法。
 *   旧逻辑直接 String(['A','C']) → "A,C"，再 split('') 逐字符排序比较，
 *   数组转字符串带出的逗号 ',' 会被当成「一个答案字符」参与比较，
 *   于是 ",AC" 永远不等于 "AC" → 多选永远判错（底部圆点显示红色）。
 *   单选题用户答案是单个字符串，没有逗号，所以不受影响 —— 这正好解释了
 *   「单选正常、只有多选显示不对」的现象。
 *
 * 约定：所有比较都先把两边归一化为「排序后的大写选项集合串」再比对，
 * 忽略顺序、分隔符、大小写与重复项。与后端 routes/quiz.js 的
 * splitAnswerTokens + normalizeAnswer 保持同源语义。
 */

/**
 * 是否为多选题类型（兼容历史别名 multi）
 * @param {string} type
 * @returns {boolean}
 */
export function isMultipleType(type) {
  return type === 'multiple' || type === 'multi'
}

/**
 * 把选项 key 统一成大写字母
 *  - 数字下标（options 为数组时 v-for 给出的是 '0','1'…）→ 转成 'A','B'…
 *  - 已是字母的（options 为对象 {A:'…'} 时 v-for 给出 key 'A'）→ 去空格转大写
 * @param {string|number} key
 * @returns {string}
 */
export function letterOf(key) {
  const s = String(key ?? '').trim()
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    return n >= 0 && n <= 25 ? String.fromCharCode(65 + n) : s.toUpperCase()
  }
  return s.toUpperCase()
}

/**
 * 把任意写法的答案拆成大写选项 token 数组。
 * 兼容 "AB" / "A,B" / "A，B" / "A、B" / "A B" / "A/B" / "A;B" 以及 ['A','B']。
 * @param {string|number|Array} raw
 * @returns {string[]}
 */
export function splitAnswerTokens(raw) {
  if (raw == null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const part of list.map(v => String(v ?? '')).join(',').toUpperCase().split(/[^A-Z0-9]+/)) {
    if (!part) continue
    // 字母连写（如 "AC"）逐字符展开为 A、C，保证与 "A,C" 写法等价；
    // 纯数字视为选项下标，保持整体（"12" 代表第 12 个选项，不是第 1、2 个）
    if (/^[A-Z]+$/.test(part) && part.length > 1) out.push(...part.split(''))
    else out.push(part)
  }
  return out
}

/**
 * 把用户答案 / 标准答案归一化为「排序后的大写字母集合串」
 * 例：['A','C'] → 'AC'；'C,A' → 'AC'；'AC' → 'AC'；['0','2'] → 'AC'
 * @param {string|number|Array} raw
 * @returns {string}
 */
export function normalizeChoiceSet(raw) {
  const tokens = splitAnswerTokens(raw).map(letterOf)
  return [...new Set(tokens)].sort().join('')
}

/**
 * 单选题 / 判断题的归一化：去空格 + 转大写；纯数字下标映射为字母
 * @param {*} v
 * @returns {string}
 */
function normalizeSingle(v) {
  const s = String(Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim().toUpperCase()
  return /^\d+$/.test(s) ? String.fromCharCode(65 + parseInt(s, 10)) : s
}

/**
 * 判断客观题（单选 / 多选 / 判断）是否答对
 * @param {string} type            题目类型
 * @param {string|Array|number} userAnswer    用户答案
 * @param {string|Array} correctAnswer        标准答案
 * @returns {boolean}
 */
export function isChoiceAnswerCorrect(type, userAnswer, correctAnswer) {
  if (userAnswer == null || userAnswer === '') return false
  if (Array.isArray(userAnswer) && userAnswer.length === 0) return false
  if (correctAnswer == null || correctAnswer === '') return false

  if (isMultipleType(type)) {
    const u = normalizeChoiceSet(userAnswer)
    const s = normalizeChoiceSet(correctAnswer)
    // 两边都非空且集合完全一致才算对（防止空集 == 空集误判为正确）
    return u.length > 0 && u === s
  }
  const u = normalizeSingle(userAnswer)
  const s = normalizeSingle(correctAnswer)
  return u.length > 0 && u === s
}
