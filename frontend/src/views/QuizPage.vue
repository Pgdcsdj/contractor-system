<template>
  <div class="quiz-page">
    <!-- 顶部状态栏 -->
    <div class="quiz-topbar">
      <button class="back-btn" @click="confirmExit">←</button>
      <div class="quiz-progress">
        <span>{{ currentIndex + 1 }} / {{ questions.length }}</span>
        <div class="progress-bar" style="width:80px">
          <div class="progress-fill" :style="{ width: ((currentIndex + 1) / questions.length * 100) + '%' }"></div>
        </div>
      </div>
      <div class="mode-badge" :class="'mode-' + mode">{{ MODE_LABELS[mode] }}</div>
      <div class="timer" :class="{ warning: timerWarning }">
        ⏱ {{ timerText }}
      </div>
    </div>

    <!-- 恢复进度提示 -->
    <div v-if="resumed" class="resume-banner">
      ✅ 已恢复上次作答进度，可继续答题
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载题目中…</span>
    </div>

    <!-- 加载失败（仅题库未加载成功时整页报错；提交失败仍停留答题页由 submit-error 提示） -->
    <div v-else-if="errorMsg && !quiz" class="error-state">
      <div class="icon">⚠️</div>
      <p>{{ errorMsg }}</p>
      <button class="btn btn-primary" @click="$router.go(0)">刷新重试</button>
    </div>

    <!-- 答题区 -->
    <div v-else-if="quiz" class="quiz-body">
      <!-- 提交失败/网络异常提示条（提交未成功时明确告知，避免"假成功"） -->
      <p v-if="errorMsg" class="submit-error">{{ errorMsg }}</p>
      <!-- 学习/练习模式：本次答错题数提醒（让"点交卷入库"不可能被错过） -->
      <p v-if="isRevealMode && wrongAnsweredCount > 0" class="wrong-hint">
        ⚠️ 本次练习已答错 <b>{{ wrongAnsweredCount }}</b> 题，记得点底部「交卷」录入错题库
      </p>
      <!-- 题目卡片 -->
      <div class="question-card" style="background:#fff; color:#0f172a;">
        <div class="question-index" style="color:#475569;">
          第 {{ currentIndex + 1 }} 题 · {{ questionTypeLabel }}
          <span class="badge badge-warning" style="margin-left:6px">{{ currentQuestion.score }}分</span>
        </div>

        <!-- 题目配图 -->
        <div v-if="currentQuestion.imageUrl" class="question-image-wrapper" @click="showImageModal = true">
          <img :src="currentQuestion.imageUrl" class="question-image" alt="题目配图" />
          <span class="image-hint">👆 点击图片放大查看</span>
        </div>
        <div v-if="showImageModal && currentQuestion.imageUrl" class="image-modal" @click.self="showImageModal = false">
          <img :src="currentQuestion.imageUrl" class="image-modal-img" alt="题目配图" />
          <button class="image-modal-close" @click="showImageModal = false">✕</button>
        </div>

        <div class="question-text" v-if="currentQuestion.question" style="color:#0f172a; background:#fff;">{{ currentQuestion.question }}</div>
        <div v-else class="question-empty">⚠️ 题目内容为空（id={{ currentQuestion.id }}）</div>

        <!-- 多选题已选数量提示 -->
        <div v-if="isMultiple" class="multi-hint">
          已选择 <b>{{ multiSelectedCount }}</b> 个选项
        </div>

        <!-- 单选题 -->
        <div v-if="currentQuestion.type === 'single' || currentQuestion.type === 'choice'" class="options">
          <div v-if="!hasOptions" class="question-empty">⚠️ 该单选题暂无选项</div>
          <div
            v-for="(opt, idx) in currentQuestion.options"
            :key="idx"
            :class="['option-item', selectedCls(idx), revealCls(idx)]"
            @click="setAnswer(idx)"
          >
            <div class="option-radio"></div>
            <span class="option-text">{{ letterOf(idx) }}. {{ opt }}</span>
          </div>
        </div>

        <!-- 多选题 -->
        <div v-else-if="currentQuestion.type === 'multiple' || currentQuestion.type === 'multi'" class="options">
          <div v-if="!hasOptions" class="question-empty">⚠️ 该多选题暂无选项</div>
          <div
            v-for="(opt, idx) in currentQuestion.options"
            :key="idx"
            :class="['option-item', selectedCls(idx), revealCls(idx)]"
            @click="toggleMulti(idx)"
          >
            <div class="option-checkbox">
              <span v-if="isMultiSelected(idx)">✓</span>
            </div>
            <span class="option-text">{{ letterOf(idx) }}. {{ opt }}</span>
          </div>
        </div>

        <!-- 判断题 -->
        <div v-else-if="currentQuestion.type === 'judgment'" class="options">
          <div
            v-for="opt in ['正确', '错误']"
            :key="opt"
            :class="['option-item', selectedCls(opt), revealCls(opt)]"
            @click="quizStore.setAnswer(currentQuestion.id, opt)"
          >
            <div class="option-radio"></div>
            <span class="option-text">{{ opt }}</span>
          </div>
        </div>

        <!-- 简答题 -->
        <div v-else-if="currentQuestion.type === 'essay' || currentQuestion.type === 'subjective'">
          <textarea
            class="answer-textarea"
            :placeholder="'请输入您的答案…'"
            :value="quizStore.answers[currentQuestion.id] || ''"
            @input="setSubjectiveAnswer($event.target.value)"
            maxlength="1000"
          ></textarea>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px;text-align:right">
            {{ (quizStore.answers[currentQuestion.id] || '').length }}/1000
          </p>
        </div>

        <!-- 题型未识别兜底 -->
        <div v-else class="question-empty">
          ⚠️ 题型数据异常：{{ currentQuestion.type || '空' }}（id={{ currentQuestion.id }}）
        </div>

        <!-- 答案解析（学习/练习模式，作答后展示） -->
        <div v-if="revealActive" class="reveal-block">
          <div class="reveal-answer">
            <span class="reveal-icon">✅</span>
            <span>正确答案：<b>{{ correctAnswerDisplay }}</b></span>
          </div>
          <div v-if="currentQuestion.analysis" class="reveal-analysis">
            <span class="reveal-icon">📖</span>
            <span>{{ currentQuestion.analysis }}</span>
          </div>
        </div>
      </div>

      <!-- 导航按钮 -->
      <div class="nav-btns">
        <button class="btn btn-outline" :disabled="currentIndex === 0" @click="prevQuestion">
          ← 上一题
        </button>

        <button
          class="btn btn-primary"
          :disabled="currentIndex >= questions.length - 1"
          @click="nextQuestion"
        >
          下一题 →
        </button>

        <button
          class="btn"
          :class="mode === QUIZ_MODES.STUDY ? 'btn-success' : 'btn-primary'"
          :disabled="!quiz || submitting"
          @click="mode === QUIZ_MODES.STUDY ? handleFinishStudy() : handleSubmit()"
        >
          {{ submitButtonLabel }}
        </button>
      </div>

      <!-- 题目进度缩略 -->
      <div class="q-dots">
        <div
          v-for="(q, idx) in questions"
          :key="q.id"
          :class="['q-dot', {
            active: idx === currentIndex,
            answered: !!quizStore.answers[q.id] && !isRight(q) && !isWrong(q),
            right: isRight(q),
            wrong: isWrong(q),
            current: idx === currentIndex
          }]"
          @click="currentIndex = idx"
        ></div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuizStore } from '@/stores/quiz'
import {
  QUIZ_MODES, MODE_LABELS, isRevealing, normalizeMode,
} from '@/utils/quizModes'
import { loadProgress, saveProgress, clearProgress } from '@/utils/progressStorage'

const route = useRoute()
const router = useRouter()
const quizStore = useQuizStore()

const quiz = ref(null)
const questions = ref([])
const currentIndex = ref(0)
const loading = ref(true)
const submitting = ref(false)
const errorMsg = ref('')
const showImageModal = ref(false)
const resumed = ref(false)

// 当前有效模式（请求/回退得到的 study|practice|exam）
const mode = ref(QUIZ_MODES.EXAM)
// 已用时（秒），所有模式统一累加；仅考试模式据此推导倒计时
const elapsedSec = ref(0)
// 提交次数（练习可反复提交，用于后端记录 attemptNo）
const attemptNo = ref(1)
let timerInterval = null

const trainingId = route.params.id  // 数字字符串 或 'wrong'（错题练习）

// ── 模式相关计算 ──────────────────────────────────────────────
const isRevealMode = computed(() => isRevealing(mode.value))

// 顶部计时文案：学习/练习仅累计用时（永不过期）；仅考试显示倒计时
const timerText = computed(() => {
  if (mode.value === QUIZ_MODES.STUDY || mode.value === QUIZ_MODES.PRACTICE) {
    return '用时 ' + formatTime(elapsedSec.value)
  }
  const limit = (quiz.value?.timeLimit || 0) * 60
  return formatTime(Math.max(0, limit - elapsedSec.value))
})
const timerWarning = computed(() => {
  // 学习/练习永不过期、无警告；仅考试最后 60 秒变红提醒
  if (mode.value !== QUIZ_MODES.EXAM) return false
  const limit = (quiz.value?.timeLimit || 0) * 60
  return limit - elapsedSec.value < 60
})

const currentQuestion = computed(() => questions.value[currentIndex.value] || {})

const questionTypeLabel = computed(() => {
  const map = {
    single: '单选题', choice: '单选题',
    multiple: '多选题', multi: '多选题',
    judgment: '判断题',
    essay: '简答题', subjective: '简答题',
  }
  return map[currentQuestion.value.type] || '单选题'
})

// 是否已作答当前题
const hasAnsweredCurrent = computed(() => {
  const ans = quizStore.answers[currentQuestion.value?.id]
  if (Array.isArray(ans)) return ans.length > 0
  return ans != null && ans !== ''
})

// 某题是否答错（仅学习/练习模式有即时反馈；比对用户答案与正确答案）
// 用于底部进度圆点显示红色（答错的题一目了然，便于重点复习）
function isWrong(q) {
  if (!isRevealMode.value) return false
  const ans = quizStore.answers[q.id]
  if (ans == null || ans === '') return false
  const correct = q.correctAnswer
  if (correct == null) return false
  const norm = (s) => String(s ?? '').toUpperCase().replace(/\s/g, '')
  if (q.type === 'multiple') {
    const a = norm(ans).split('').sort().join('')
    const b = norm(correct).split('').sort().join('')
    return a.length > 0 && a !== b
  }
  return norm(ans) !== norm(correct)
}

// 某题是否答对（仅学习/练习模式有即时反馈；用于底部进度圆点显示绿色）
function isRight(q) {
  if (!isRevealMode.value) return false
  const ans = quizStore.answers[q.id]
  if (ans == null || ans === '') return false
  const correct = q.correctAnswer
  if (correct == null) return false
  const norm = (s) => String(s ?? '').toUpperCase().replace(/\s/g, '')
  if (q.type === 'multiple') {
    const a = norm(ans).split('').sort().join('')
    const b = norm(correct).split('').sort().join('')
    return a.length > 0 && a === b
  }
  return norm(ans) === norm(correct)
}

// 学习/练习模式下，作答后显示答案与解析
const revealActive = computed(() => isRevealMode.value && hasAnsweredCurrent.value)

// 本次练习已答错的题数（用于提醒"点交卷入库"，仅学习/练习模式，避免考试模式剧透）
const wrongAnsweredCount = computed(() => {
  if (!isRevealMode.value) return 0
  return questions.value.filter(q => quizStore.answers[q.id] && isWrong(q)).length
})

// ── 选项状态辅助 ──────────────────────────────────────────────
function letterOf(key) {
  if (/^\d+$/.test(String(key))) return String.fromCharCode(65 + parseInt(key, 10))
  return String(key)
}

// 判断某选项索引/键是否为正确答案（兼容字母与数字下标）
function isOptionCorrect(key) {
  const q = currentQuestion.value
  if (!q || q.correctAnswer == null) return false
  const ca = String(q.correctAnswer)
  if (q.type === 'multiple' || q.type === 'multi') {
    const set = ca.split(/[\s,]+/).filter(Boolean).map(s => s.trim())
    const k = String(key)
    return set.includes(k) || set.map(s => s.toUpperCase()).includes(k.toUpperCase())
  }
  // 单选 / 判断
  const s = ca.trim().toUpperCase()
  const k = String(key).trim().toUpperCase()
  if (s === k) return true
  const letter = /^[A-Z]$/.test(s) ? s.charCodeAt(0) - 65 : -1
  const idx = /^\d+$/.test(k) ? parseInt(k, 10) : -1
  if (letter >= 0 && idx >= 0) return letter === idx
  return false
}

// 用户是否选了该选项
function isUserOption(key) {
  const q = currentQuestion.value
  if (!q) return false
  const ua = quizStore.answers[q.id]
  if (Array.isArray(ua)) return ua.map(String).includes(String(key))
  return ua != null && String(ua) === String(key)
}

// 选项样式：correct / wrong
function optionState(key) {
  if (!revealActive.value) return ''
  if (isOptionCorrect(key)) return 'correct'
  if (isUserOption(key)) return 'wrong'
  return ''
}
function revealCls(key) {
  const st = optionState(key)
  return st ? 'opt-' + st : ''
}
function selectedCls(key) {
  const q = currentQuestion.value
  const ua = quizStore.answers[q?.id]
  if (Array.isArray(ua)) return ua.map(String).includes(String(key)) ? 'selected' : ''
  return ua === key ? 'selected' : ''
}

// 正确答案展示文本
const correctAnswerDisplay = computed(() => {
  const q = currentQuestion.value
  if (!q || q.correctAnswer == null) return '—'
  const opts = q.options || {}
  const entries = Object.entries(opts)
  const correctKeys = entries.filter(([k]) => isOptionCorrect(k)).map(([k]) => k)
  if (!correctKeys.length) return String(q.correctAnswer)
  return correctKeys.map(k => `${letterOf(k)}. ${opts[k]}`).join('、')
})

// 当前题是否为多选题
const isMultiple = computed(() => {
  const t = currentQuestion.value?.type
  return t === 'multiple' || t === 'multi'
})

// 当前客观题是否有非空选项（兼容对象/数组）
const hasOptions = computed(() => {
  const opts = currentQuestion.value?.options
  if (Array.isArray(opts)) return opts.length > 0
  if (opts && typeof opts === 'object') return Object.keys(opts).length > 0
  return false
})

// 多选题已选数量（用于「已选 X 项」提示）
const multiSelectedCount = computed(() => {
  const q = currentQuestion.value
  if (!q) return 0
  const val = quizStore.answers[q.id]
  return Array.isArray(val) ? val.length : 0
})

// ── 作答交互 ──────────────────────────────────────────────────
function setAnswer(optionIdx) {
  quizStore.setAnswer(currentQuestion.value.id, optionIdx)
  persistProgress()
}

function isMultiSelected(idx) {
  const val = quizStore.answers[currentQuestion.value.id]
  if (!val) return false
  return Array.isArray(val) ? val.includes(idx) : false
}

function toggleMulti(idx) {
  const qid = currentQuestion.value.id
  const cur = quizStore.answers[qid] || []
  const arr = Array.isArray(cur) ? [...cur] : []
  const pos = arr.indexOf(idx)
  if (pos >= 0) arr.splice(pos, 1)
  else arr.push(idx)
  quizStore.setAnswer(qid, arr)
  persistProgress()
}

function setSubjectiveAnswer(text) {
  quizStore.setAnswer(currentQuestion.value.id, text)
  persistProgress()
}

function prevQuestion() {
  if (currentIndex.value > 0) currentIndex.value--
}
function nextQuestion() {
  if (currentIndex.value < questions.value.length - 1) currentIndex.value++
}

// ── 空格键快捷跳题（仅学习/练习模式） ────────────────────────────
const isKeyShortcutMode = computed(() => mode.value === QUIZ_MODES.STUDY || mode.value === QUIZ_MODES.PRACTICE)

// 提交按钮文案：随答题模式与提交状态变化（学习→完成学习 / 考试→提交答卷 / 练习→交卷）
const submitButtonLabel = computed(() => {
  if (submitting.value) return '提交中…'
  if (mode.value === QUIZ_MODES.STUDY) return '完成学习'
  if (mode.value === QUIZ_MODES.EXAM) return '提交答卷'
  return '交卷'
})

function onGlobalKeydown(e) {
  if (e.code !== 'Space' && e.key !== ' ') return
  const t = e.target
  // 输入框/文本域/可编辑区域聚焦时不触发（简答题输入空格不应跳题）
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  // 聚焦在按钮上时交给浏览器原生行为（避免空格被双重触发而连跳两题）
  if (t && t.tagName === 'BUTTON') return
  // 图片放大弹层打开时不触发
  if (showImageModal.value) return
  if (!isKeyShortcutMode.value) return
  if (currentIndex.value >= questions.value.length - 1) return
  e.preventDefault()
  nextQuestion()
}

// ── 计时器 ────────────────────────────────────────────────────
function startTimer() {
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = setInterval(() => {
    elapsedSec.value++
    // 每 5 秒持久化一次，降低 localStorage 写入频率
    if (elapsedSec.value % 5 === 0) persistProgress()
    // 仅考试模式限时：倒计时归零自动交卷；学习/练习只累计用时，永不过期
    if (mode.value === QUIZ_MODES.EXAM) {
      const limit = (quiz.value?.timeLimit || 0) * 60
      if (limit > 0 && elapsedSec.value >= limit) {
        clearInterval(timerInterval)
        timerInterval = null
        handleSubmit() // 考试倒计时归零自动交卷
      }
    }
  }, 1000)
}

function formatTime(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ── 断点续做持久化 ────────────────────────────────────────────
function persistProgress() {
  if (!quiz.value || !trainingId || !mode.value) return
  saveProgress(trainingId, mode.value, {
    answers: { ...quizStore.answers },
    currentIndex: currentIndex.value,
    elapsedSec: elapsedSec.value,
  })
}

// 答案或题号变化都即时保存
watch(currentIndex, () => persistProgress())
watch(() => quizStore.answers, () => persistProgress(), { deep: true })

// ── 提交 / 退出 ───────────────────────────────────────────────
async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true
  errorMsg.value = ''
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }

  const result = await quizStore.submitQuiz(trainingId, {
    mode: mode.value,
    attemptNo: attemptNo.value,
    durationSec: elapsedSec.value,
  })

  submitting.value = false

  if (result.ok) {
    clearProgress(trainingId, mode.value) // 提交成功清除断点
    attemptNo.value += 1
    router.replace(`/result/${trainingId}`)
  } else if (result.offline) {
    // 网络失败：保留断点、恢复计时、明确提示，不静默跳转（避免"假成功"导致错题不记录）
    startTimer()
    errorMsg.value = '⚠️ 提交失败（网络异常），答案未上传服务器，错题不会被记录。请检查网络后点击「交卷」重试。'
  } else {
    startTimer()
    errorMsg.value = result.error || '提交失败，请检查网络后重试'
  }
}

// 学习模式：提交（记录进度）后返回列表
async function handleFinishStudy() {
  if (submitting.value) return
  submitting.value = true
  errorMsg.value = ''
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }

  const result = await quizStore.submitQuiz(trainingId, {
    mode: mode.value,
    attemptNo: attemptNo.value,
    durationSec: elapsedSec.value,
  })
  submitting.value = false

  if (result.ok) {
    clearProgress(trainingId, mode.value)
    router.replace('/quiz')
  } else {
    startTimer()
    errorMsg.value = result.offline
      ? '⚠️ 提交失败（网络异常），学习进度已保留。请检查网络后点击「完成学习」重试。'
      : (result.error || '提交失败，请检查网络后重试')
  }
}

// 返回/退出：保存进度并提示可继续作答
function confirmExit() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  const dirty = elapsedSec.value > 0 || Object.keys(quizStore.answers).length > 0
  if (dirty) {
    persistProgress()
    alert('已保存进度，可继续作答')
  }
  router.replace('/quiz')
}

onMounted(async () => {
  const timer = setTimeout(() => { loading.value = false }, 10000)
  try {
    // 运行模式严格取自路由 ?mode=，非法/缺失值由 normalizeMode 兜底为 exam；
    // 不依赖素材默认 mode（解决"默认模式"与"运行时模式"被混淆的根因）。
    mode.value = normalizeMode(route.query.mode, QUIZ_MODES.EXAM)
    // 错题练习模式：透传筛选条件（来自错题库页「练习筛选结果」）
    const extra = {}
    if (route.query.type) extra.type = route.query.type
    if (route.query.materialId) extra.materialId = route.query.materialId
    if (route.query.minWrong) extra.minWrong = route.query.minWrong
    const data = await quizStore.fetchQuiz(trainingId, mode.value, extra)
    clearTimeout(timer)

    if (data && data.questions && data.questions.length) {
      quiz.value = data
      questions.value = data.questions
      // 注：此处 mode 已来自路由 query，不再回退到 data.mode（素材默认模式）

      // 恢复断点进度（按 materialId + mode 独立续做）
      quizStore.resetAnswers()
      const progress = loadProgress(trainingId, mode.value)
      if (progress) {
        Object.assign(quizStore.answers, progress.answers || {})
        currentIndex.value = progress.currentIndex || 0
        elapsedSec.value = progress.elapsedSec || 0
        resumed.value = true
      }
      startTimer()
    } else if (data === null) {
      errorMsg.value = '加载失败：服务器无响应或登录已过期，请检查网络后刷新重试'
    } else {
      errorMsg.value = '该题库暂无可用题目'
    }
  } catch (err) {
    clearTimeout(timer)
    console.error('[QuizPage] 加载失败', err)
    errorMsg.value = err?.response?.data?.error || err.message || '加载失败，请检查网络后刷新重试'
  } finally {
    clearTimeout(timer)
    loading.value = false
  }
  window.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<style scoped>
.quiz-page { min-height: 100dvh; background: var(--bg); }

.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  gap: 16px;
}
.error-state .icon { font-size: 48px; }
.error-state p { color: var(--danger); font-size: 15px; line-height: 1.5; }

.quiz-topbar {
  background: var(--primary);
  color: #fff;
  padding: 10px 14px;
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 10px;
}
.back-btn {
  background: rgba(255,255,255,0.2);
  border: none;
  color: #fff;
  width: 34px; height: 34px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  font-size: 16px;
  flex-shrink: 0;
}
.quiz-progress {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
}
.timer {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.timer.warning { color: #ff6b6b; animation: blink 1s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }

/* 模式徽章 */
.mode-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
  background: rgba(255,255,255,0.2);
}
.mode-badge.mode-study { background: rgba(255,255,255,0.9); color: #155A96; }
.mode-badge.mode-practice { background: #FBF1E0; color: #C2740B; }
.mode-badge.mode-exam { background: #FCE9E9; color: #DC2626; }

.resume-banner {
  background: var(--c-blue-50, #EAF3FB);
  color: #155A96;
  font-size: 13px;
  padding: 8px 14px;
  text-align: center;
}

.quiz-body { padding: 16px 12px 180px; }

.question-card {
  background: var(--c-surface, #fff);
  border: 1px solid var(--c-border, #e6eaf0);
  border-radius: var(--r-lg, 16px);
  padding: 18px 16px;
  min-height: 200px;
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(15,23,42,.06));
}

.question-index {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-2, #475569);
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.question-text {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.7;
  color: var(--c-text, #0f172a);
  margin: 12px 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.question-empty {
  margin-top: 14px;
  padding: 16px;
  border-radius: var(--r, 12px);
  background: var(--c-warning-bg, #fbf1e0);
  color: var(--c-warning, #c2740b);
  font-size: 14px;
  line-height: 1.6;
  text-align: center;
}

.nav-btns {
  display: flex;
  gap: 10px;
  padding: 16px 12px;
  position: fixed;
  bottom: 110px;
  left: 0; right: 0;
  background: var(--bg);
  z-index: 11;
}
.nav-btns .btn { flex: 1; white-space: nowrap; }

/* 提交失败提示条 */
.submit-error {
  margin: 10px 12px 0;
  padding: 10px 14px;
  background: var(--c-danger-bg, #FCE9E9);
  color: var(--c-danger, #DC2626);
  border: 1px solid rgba(220,38,38,.25);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
}

/* 本次答错题数提醒（学习/练习模式） */
.wrong-hint {
  margin: 10px 12px 0;
  padding: 10px 14px;
  background: #FFF8E1;
  color: #B7791F;
  border: 1px solid #F6E05E;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
}
.wrong-hint b {
  color: #C05621;
  font-size: 15px;
  margin: 0 2px;
}

.q-dots {
  position: fixed;
  bottom: 0;
  left: 0; right: 0;
  background: #fff;
  padding: 10px 12px 16px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  border-top: 1px solid var(--border);
  max-height: 110px;
  overflow-y: auto;
  z-index: 10;
}
.q-dot {
  width: 28px; height: 28px;
  border-radius: 50%;
  background: var(--border);
  font-size: 10px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  color: var(--text-secondary);
  font-weight: 600;
}
.q-dot.active { border: 2px solid var(--primary); }
.q-dot.answered { background: var(--primary); color: #fff; }
.q-dot.current { background: var(--primary); color: #fff; }
.q-dot.wrong { background: #dc2626; color: #fff; border-color: #dc2626; }
.q-dot.right { background: #16a34a; color: #fff; border-color: #16a34a; }

/* ── 选项通用基样式（整行可点、移动端防误触） ── */
.options { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }

.option-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 14px;
  min-height: 54px;
  background: var(--c-surface, #FFFFFF);
  border: 1px solid var(--c-border, #E6EAF0);
  border-radius: var(--r, 12px);
  cursor: pointer;
  transition: background .18s ease, border-color .18s ease, box-shadow .18s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.option-item:active { transform: translateY(1px); }

/* 单选圆点 */
.option-radio {
  position: relative;
  width: 24px; height: 24px;
  flex-shrink: 0;
  border: 2px solid var(--c-border-strong, #D4DAE3);
  border-radius: 50%;
  background: var(--c-surface, #FFFFFF);
  transition: border-color .18s ease, background .18s ease;
}
.option-radio::after {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  width: 9px; height: 9px;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity .15s ease;
}

/* 多选方框（加大到 24×24，选中实心主题色 + 加粗白勾） */
.option-checkbox {
  width: 24px; height: 24px;
  flex-shrink: 0;
  border: 2px solid var(--c-border-strong, #D4DAE3);
  border-radius: 6px;
  background: var(--c-surface, #FFFFFF);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 900;
  font-size: 16px;
  line-height: 1;
  transition: border-color .18s ease, background .18s ease;
}

.option-text {
  flex: 1;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--c-text, #0F172A);
}

/* ── 选中态：整行高亮（浅主题色背景 + 主题色边框） ── */
.option-item.selected {
  background: var(--c-primary-bg, #EAF3FB);
  border-color: var(--primary, #1D6FB8);
}
.option-item.selected .option-radio,
.option-item.selected .option-checkbox {
  border-color: var(--primary, #1D6FB8);
  background: var(--primary, #1D6FB8);
}
.option-item.selected .option-radio::after,
.option-item.selected .option-checkbox span {
  opacity: 1;
  color: #fff;
}

/* ── 正误揭示态（学习/练习模式作答后，优先级高于选中态） ── */
.option-item.opt-correct {
  border-color: var(--c-success, #16A34A);
  background: var(--c-success-bg, #E7F6EC);
}
.option-item.opt-correct .option-radio,
.option-item.opt-correct .option-checkbox {
  border-color: var(--c-success, #16A34A);
  background: var(--c-success, #16A34A);
  color: #fff;
}
.option-item.opt-correct .option-radio::after { opacity: 1; }
.option-item.opt-wrong {
  border-color: var(--c-danger, #DC2626);
  background: var(--c-danger-bg, #FCE9E9);
}
.option-item.opt-wrong .option-radio {
  border-color: var(--c-danger, #DC2626);
  background: var(--c-danger, #DC2626);
  color: #fff;
}
.option-item.opt-wrong .option-radio::after { opacity: 1; }

/* ── 多选题「已选 X 项」提示 ── */
.multi-hint {
  margin-top: 12px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--c-text-2, #475569);
  background: var(--c-surface-2, #F8FAFC);
  border: 1px dashed var(--c-border-strong, #D4DAE3);
  border-radius: var(--r-sm, 8px);
}
.multi-hint b {
  color: var(--primary, #1D6FB8);
  font-size: 15px;
  padding: 0 2px;
}

/* 答案解析块 */
.reveal-block {
  margin-top: 14px;
  border: 1px dashed var(--c-success, #16A34A);
  background: var(--c-success-bg, #E7F6EC);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
}
.reveal-answer { display: flex; gap: 6px; align-items: flex-start; color: var(--c-success, #16A34A); font-weight: 600; }
.reveal-analysis { display: flex; gap: 6px; align-items: flex-start; margin-top: 8px; color: var(--text-primary, #0F172A); line-height: 1.6; }
.reveal-icon { flex-shrink: 0; }

/* ── 题目配图 ── */
.question-image-wrapper {
  margin: 0 0 12px;
  text-align: center;
  cursor: pointer;
}
.question-image {
  max-width: 100%;
  max-height: 260px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: contain;
}
.image-hint {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.image-modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.85);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.image-modal-img {
  max-width: 100%;
  max-height: 90vh;
  border-radius: 8px;
  object-fit: contain;
}
.image-modal-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px; height: 40px;
  border-radius: 50%;
  background: rgba(255,255,255,0.2);
  border: none;
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
