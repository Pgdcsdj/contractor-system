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

    <!-- 答题区（左右滑动翻题：左滑下一题 / 右滑上一题） -->
    <div
      v-else-if="quiz"
      class="quiz-body"
      :style="{ paddingBottom: dotsExpanded ? '262px' : '150px' }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
      <!-- 提交失败/网络异常提示条（提交未成功时明确告知，避免"假成功"） -->
      <p v-if="errorMsg" class="submit-error">{{ errorMsg }}</p>
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

      <!-- 手动翻题提示：滑动或点「上一题」后关闭自动跳题，避免回看已答对的题被强制弹走 -->
      <p v-if="autoAdvanceOff" class="auto-off-tip">
        🔒 已关闭「答对自动跳下一题」，可自由回看；重新进入答题自动恢复
      </p>

      <!-- 导航按钮（底部位置随题号区展开/收起自适应） -->
      <div class="nav-btns" :style="{ bottom: dotsExpanded ? '170px' : '58px' }">
        <button class="btn btn-outline" :disabled="currentIndex === 0" @click="goPrev">
          ← 上一题
        </button>

        <button
          class="btn btn-primary"
          :disabled="currentIndex >= questions.length - 1"
          @click="goNext"
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

      <!-- 题号圆点区：默认收起，点开关展开/收起 -->
      <div class="dots-bar">
        <button
          class="dots-toggle"
          type="button"
          :aria-expanded="dotsExpanded ? 'true' : 'false'"
          @click="dotsExpanded = !dotsExpanded"
        >
          <span class="dots-toggle-arrow">{{ dotsExpanded ? '🔽' : '🔼' }}</span>
          <span>题号 {{ currentIndex + 1 }} / {{ questions.length }}</span>
          <span class="dots-toggle-hint">{{ dotsExpanded ? '收起' : '展开' }}</span>
        </button>

        <div v-show="dotsExpanded" class="q-dots">
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
            @click="jumpTo(idx)"
          ></div>
        </div>
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
import { loadProgress, saveProgress, clearProgress, fetchServerProgress, saveServerProgress, clearServerProgress } from '@/utils/progressStorage'
import { isChoiceAnswerCorrect, isMultipleType, splitAnswerTokens, letterOf as letterOfKey } from '@/utils/answerJudge'

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

// 题号圆点区是否展开（默认收起，点开关切换）
const dotsExpanded = ref(false)

// 手动翻题标志：一旦滑动翻页或点「上一题」即置 true，
// 此后关闭「答对自动跳下一题」（否则右滑回看已答对的题会被强制弹走）。
// 重新进入答题（组件重新挂载）时随 ref 初始值自动重置为 false。
const manualNavActive = ref(false)

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

// 可自动判分的客观题类型（简答题由人工/AI 批改，不参与圆点正误着色）
const JUDGABLE_TYPES = new Set(['single', 'choice', 'multiple', 'multi', 'judgment'])

// 某题是否已作答（多选为数组，其余为字符串；空数组视为未作答）
function hasAnswer(q) {
  const ans = quizStore.answers[q?.id]
  if (Array.isArray(ans)) return ans.length > 0
  return ans != null && ans !== ''
}

// 是否可对本题做自动正误判定（揭示模式 + 客观题 + 已作答 + 有标准答案）
function canJudge(q) {
  return !!q && isRevealMode.value && JUDGABLE_TYPES.has(q.type) && hasAnswer(q)
    && q.correctAnswer != null && q.correctAnswer !== ''
}

// 某题是否答错（仅学习/练习模式有即时反馈；用于底部进度圆点显示红色，便于重点复习）
// 判定统一走 utils/answerJudge，避免「数组转字符串带出逗号」导致多选题误判为错。
function isWrong(q) {
  if (!canJudge(q)) return false
  return !isChoiceAnswerCorrect(q.type, quizStore.answers[q.id], q.correctAnswer)
}

// 某题是否答对（仅学习/练习模式有即时反馈；用于底部进度圆点显示绿色）
function isRight(q) {
  if (!canJudge(q)) return false
  return isChoiceAnswerCorrect(q.type, quizStore.answers[q.id], q.correctAnswer)
}

// 学习/练习模式下，作答后显示答案与解析
const revealActive = computed(() => isRevealMode.value && hasAnsweredCurrent.value)

// 学习/练习模式：答对后自动跳下一题（答错停留看解析；考试模式不跳）
// 互斥逻辑：用户一旦手动翻过题（滑动 或 点「上一题」/「下一题」/点圆点跳题），
// 就永久关闭本次答题会话的自动跳题，避免回看已答对的题时被强制弹走。
const autoAdvanceOff = computed(() => isRevealMode.value && manualNavActive.value)

let autoAdvanceTimer = null
watch(
  () => [quizStore.answers[currentQuestion.value?.id], currentIndex.value],
  () => {
    if (!isRevealMode.value) return
    if (manualNavActive.value) return             // 已手动翻过题 → 不再自动跳
    const q = currentQuestion.value
    if (!q || !hasAnsweredCurrent.value) return
    if (!isRight(q)) return                       // 答错：停留，便于看解析/改答案
    if (currentIndex.value >= questions.value.length - 1) return  // 最后一题不跳
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer)
    autoAdvanceTimer = setTimeout(() => {
      // 跳前复核：仍答对且仍是当前题、且非末题，避免期间改答案误跳
      if (
        isRevealMode.value &&
        !manualNavActive.value &&
        currentIndex.value < questions.value.length - 1 &&
        hasAnsweredCurrent.value &&
        isRight(currentQuestion.value)
      ) {
        nextQuestion()
      }
    }, 800)
  }
)

// ── 选项状态辅助 ──────────────────────────────────────────────
function letterOf(key) {
  if (/^\d+$/.test(String(key))) return String.fromCharCode(65 + parseInt(key, 10))
  return String(key)
}

// 判断某选项索引/键是否为正确答案（兼容字母与数字下标）
// 多选题答案可能写成 "AC" / "A,C" / "A，C"，统一按 token 拆分后再比对，
// 否则 "AC" 这种无分隔符写法会让所有选项都匹配不上，揭示态不显示正确项。
function isOptionCorrect(key) {
  const q = currentQuestion.value
  if (!q || q.correctAnswer == null) return false
  const k = letterOfKey(key)
  if (isMultipleType(q.type)) {
    const set = new Set(splitAnswerTokens(q.correctAnswer).map(letterOfKey))
    return set.has(k)
  }
  // 单选 / 判断
  const s = String(q.correctAnswer).trim().toUpperCase()
  if (s === k) return true
  const letter = /^[A-Z]$/.test(s) ? s.charCodeAt(0) - 65 : -1
  const idx = /^\d+$/.test(String(key).trim()) ? parseInt(String(key).trim(), 10) : -1
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

// 纯跳转（不含手动标志）：自动跳题、空格键等内部调用走这里
function prevQuestion() {
  if (currentIndex.value > 0) currentIndex.value--
}
function nextQuestion() {
  if (currentIndex.value < questions.value.length - 1) currentIndex.value++
}

// 用户主动翻题：置位手动标志 → 关闭「答对自动跳下一题」
function goPrev() {
  manualNavActive.value = true
  prevQuestion()
}
function goNext() {
  manualNavActive.value = true
  nextQuestion()
}
// 点题号圆点跳题同样视为手动导航（跳过去后不该被自动跳走）
function jumpTo(idx) {
  manualNavActive.value = true
  if (idx >= 0 && idx < questions.value.length) currentIndex.value = idx
}

// ── 滑动翻题（原生 touch 事件，无第三方依赖）────────────────────────────
// 规则：横向位移 > 50px 且横向位移大于纵向位移（避免与页面滚动冲突）
//       左滑（dx < 0）→ 下一题；右滑（dx > 0）→ 上一题
const SWIPE_THRESHOLD = 50
let touchStartX = 0
let touchStartY = 0

function onTouchStart(e) {
  const t = e.changedTouches?.[0] || e.touches?.[0]
  if (!t) return
  touchStartX = t.clientX
  touchStartY = t.clientY
}

function onTouchEnd(e) {
  // 图片放大弹层打开时不响应滑动（此时手势用于查看大图）
  if (showImageModal.value || !quiz.value) return
  const t = e.changedTouches?.[0] || e.touches?.[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  if (Math.abs(dx) < SWIPE_THRESHOLD) return          // 位移太小：视为点击，不翻题
  if (Math.abs(dx) <= Math.abs(dy)) return            // 纵向为主：视为滚动，不翻题
  if (dx < 0) goNext()                                // 左滑 → 下一题
  else goPrev()                                       // 右滑 → 上一题
}

function onTouchMove(e) {
  // 图片放大弹层打开时不拦截（手势用于查看大图）
  if (showImageModal.value || !quiz.value) return
  const t = e.changedTouches?.[0] || e.touches?.[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  // 横向滑动为主 → 拦截浏览器默认手势，避免触发系统/浏览器的"左右滑动返回"
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
    e.preventDefault()
  }
}

function onTouchCancel() {
  touchStartX = 0
  touchStartY = 0
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
  goNext() // 与点击「下一题」一致：视为手动导航，关闭自动跳题避免连跳
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

// ── 断点续做持久化（localStorage 即时 + 服务端防抖，跨设备/重登可用）──
let serverSaveTimer = null
function persistProgress() {
  if (!quiz.value || !trainingId || !mode.value) return
  const snapshot = {
    answers: { ...quizStore.answers },
    currentIndex: currentIndex.value,
    elapsedSec: elapsedSec.value,
  }
  // 1) 本地即时保存（离线快取，瞬时可用）
  saveProgress(trainingId, mode.value, snapshot)
  // 2) 服务端防抖保存（避免每次按键都请求；1.5s 合并）
  if (serverSaveTimer) clearTimeout(serverSaveTimer)
  serverSaveTimer = setTimeout(() => {
    serverSaveTimer = null
    saveServerProgress(trainingId, mode.value, snapshot)
  }, 1500)
}

// 立即把待保存的进度刷到服务端（退出/卸载时调用，避免丢失最后一次改动）
async function flushServerProgress() {
  if (serverSaveTimer) { clearTimeout(serverSaveTimer); serverSaveTimer = null }
  if (!quiz.value || !trainingId || !mode.value) return
  await saveServerProgress(trainingId, mode.value, {
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
    clearProgress(trainingId, mode.value) // 提交成功清除本地断点
    clearServerProgress(trainingId, mode.value) // 清除服务端断点
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
    clearServerProgress(trainingId, mode.value)
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
    // 立即把进度刷到服务端，确保关门重登也能续上
    flushServerProgress()
    alert('已保存进度，可继续作答')
  }
  router.replace('/quiz')
}

onMounted(async () => {
  // 重新进入答题（重新加载）时重置会话级状态：
  // 手动翻题标志复位 → 恢复「答对自动跳下一题」；题号区复位为收起。
  manualNavActive.value = false
  dotsExpanded.value = false
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
      // 优先从服务端读取（跨设备/重登可用），失败回退本地 localStorage 缓存。
      quizStore.resetAnswers()
      let progress = null
      try {
        progress = await fetchServerProgress(trainingId, mode.value)
      } catch (e) {
        console.warn('[QuizPage] 服务端进度读取失败，回退本地', e)
      }
      if (!progress) {
        progress = loadProgress(trainingId, mode.value)
      } else if (progress.answers && Object.keys(progress.answers).length) {
        // 服务端有数据则同步回本地缓存，保证离线也能续
        saveProgress(trainingId, mode.value, progress)
      }

      // 仅当存在真实进度（答过题 / 不在第一题 / 已用时）才标记"已恢复"，
      // 避免空进度误弹"已恢复上次作答进度"的虚假提示。
      const hasReal = progress &&
        ((progress.answers && Object.keys(progress.answers).length > 0) ||
         (progress.currentIndex > 0) || (progress.elapsedSec > 0))
      if (hasReal) {
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
  if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer)
  if (serverSaveTimer) { clearTimeout(serverSaveTimer); serverSaveTimer = null }
  // 卸载前尽量把进度刷到服务端（不 await：卸载钩子不宜长等待，失败由本地缓存兜底）
  flushServerProgress()
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

/* padding-bottom 由内联样式按题号区展开状态动态设置（收起 110px / 展开 222px），此处仅为兜底 */
.quiz-body { padding: 16px 12px 110px; overscroll-behavior-x: contain; touch-action: pan-y; }

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
  bottom: 58px; /* 由内联样式按题号区展开状态覆盖：收起 58px / 展开 170px */
  left: 0; right: 0;
  background: var(--bg);
  z-index: 11;
  transition: bottom .2s ease;
}
.nav-btns .btn { flex: 1; white-space: nowrap; }

/* 关闭自动跳题的提示条（仅学习/练习模式，手动翻题后出现） */
.auto-off-tip {
  margin: 0 0 10px;
  padding: 8px 12px;
  background: var(--c-surface-2, #F8FAFC);
  border: 1px dashed var(--c-border-strong, #D4DAE3);
  border-radius: var(--r-sm, 8px);
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-2, #475569);
}

/* ── 底部题号区（可折叠，默认收起）── */
.dots-bar {
  position: fixed;
  bottom: 0;
  left: 0; right: 0;
  background: #fff;
  border-top: 1px solid var(--border);
  z-index: 12;
  padding-bottom: env(safe-area-inset-bottom, 0);
}
.dots-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 11px 12px;
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-2, #475569);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dots-toggle:active { background: var(--c-surface-2, #F8FAFC); }
.dots-toggle-arrow { font-size: 11px; line-height: 1; }
.dots-toggle-hint {
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
}

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

.q-dots {
  background: #fff;
  padding: 4px 12px 14px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  max-height: 110px;
  overflow-y: auto;
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
