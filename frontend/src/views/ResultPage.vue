<template>
  <div class="result-page">
    <div class="page-header">
      <button class="back-btn" @click="$router.replace('/quiz')">←</button>
      <h1>答题结果</h1>
      <span v-if="result" class="mode-badge" :class="'mode-' + resultMode">{{ MODE_LABELS[resultMode] }}</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中…</span>
    </div>

    <!-- 结果展示 -->
    <div v-else-if="result" class="result-body">

      <!-- ① 得分卡片 -->
      <div class="score-card card">
        <div class="score-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="44" fill="none" stroke="#e0e0e0" stroke-width="8"/>
            <circle
              cx="50" cy="50" r="44" fill="none"
              :stroke="result.passed ? '#34a853' : '#ea4335'"
              stroke-width="8"
              stroke-linecap="round"
              :stroke-dasharray="circumference"
              :stroke-dashoffset="dashOffset"
              transform="rotate(-90 50 50)"
              style="transition: stroke-dashoffset 1s ease"
            />
          </svg>
          <div class="score-text">
            <span class="score-num">{{ result.score }}</span>
            <span class="score-denom">/{{ result.maxScore }}</span>
          </div>
        </div>

        <div class="score-info">
          <h2 :class="result.passed ? 'pass' : 'fail'">
            {{ result.passed ? '🎉 考试通过' : '❌ 未通过' }}
          </h2>
          <p class="score-desc">
            得分率 {{ result.passRate }}%
            <span v-if="!result.passed">（及格需 {{ result.passScore }}%）</span>
          </p>
          <div class="record-meta">
            <span>⏱ {{ formatTime(result.submittedAt) }}</span>
            <span style="margin-left:12px">
              ✅ {{ correctCount }} 题 · ❌ {{ wrongCount }} 题
            </span>
          </div>
        </div>
      </div>

      <!-- ② 操作按钮 -->
      <div class="result-actions">
        <button class="btn btn-outline" @click="$router.replace('/quiz')">
          ← 返回列表
        </button>
        <button class="btn btn-primary" @click="retakeQuiz">
          🔄 重新答题
        </button>
      </div>

      <!-- ③ 逐题回顾 -->
      <div class="review-section" :class="{ 'is-revealing': isReveal }">
        <div class="review-title">📖 逐题回顾</div>

        <div
          v-for="(item, idx) in result.reviewList"
          :key="item.id"
          :class="['review-item', item.isCorrect ? 'correct' : 'wrong']"
        >
          <!-- 题号 + 对错标记 -->
          <div class="review-header">
            <span class="review-index">第 {{ idx + 1 }} 题</span>
            <span class="review-type">{{ typeLabel(item.type) }}</span>
            <span class="review-score">{{ item.score }}分</span>
            <span :class="['review-badge', item.isCorrect ? 'badge-correct' : 'badge-wrong']">
              {{ item.isCorrect ? '✓ 正确' : '✗ 错误' }}
            </span>
          </div>

          <!-- 题目配图 -->
          <div v-if="item.imageUrl" class="review-image-wrapper">
            <img :src="item.imageUrl" class="review-image" alt="违章现场图" />
          </div>

          <!-- 题目内容 -->
          <div class="review-question">{{ item.question }}</div>

          <!-- 选择题选项（带高亮） -->
          <div v-if="hasOptions(item.type)" class="review-options">
            <div
              v-for="(opt, oi) in item.options"
              :key="oi"
              :class="['review-option', optionClass(item, oi)]"
            >
              <span class="opt-label">{{ String.fromCharCode(65 + oi) }}</span>
              <span class="opt-text">{{ opt }}</span>
              <span v-if="isUserAnswer(item, oi)" class="opt-tag user-tag">我的答案</span>
              <span v-if="isCorrectAnswer(item, oi)" class="opt-tag correct-tag">正确答案</span>
            </div>
          </div>

          <!-- 判断题 -->
          <div v-else-if="item.type === 'judgment'" class="review-judge">
            <div :class="['judge-opt', item.userAnswer === '正确' ? 'judge-selected' : '']">
              正确
              <span v-if="item.userAnswer === '正确'" class="opt-tag user-tag">我选</span>
              <span v-if="item.correctAnswer === '正确'" class="opt-tag correct-tag">✓</span>
            </div>
            <div :class="['judge-opt', item.userAnswer === '错误' ? 'judge-selected' : '']">
              错误
              <span v-if="item.userAnswer === '错误'" class="opt-tag user-tag">我选</span>
              <span v-if="item.correctAnswer === '错误'" class="opt-tag correct-tag">✓</span>
            </div>
          </div>

          <!-- 简答题 -->
          <div v-else class="review-essay">
            <div class="essay-row">
              <span class="essay-label">我的答案：</span>
              <span class="essay-content">{{ item.userAnswer || '（未作答）' }}</span>
            </div>
            <div class="essay-row">
              <span class="essay-label">参考答案：</span>
              <span class="essay-content ref">{{ item.correctAnswer }}</span>
            </div>
          </div>

          <!-- 解析 -->
          <div v-if="item.analysis" class="review-analysis">
            <span class="analysis-label">💡 解析：</span>
            <span class="analysis-content">{{ item.analysis }}</span>
          </div>
        </div>
      </div>

    </div>

    <!-- 无记录 -->
    <div v-else class="empty-state">
      <div class="icon">❓</div>
      <p>未找到答题记录</p>
      <button class="btn btn-primary" style="margin-top:16px" @click="$router.replace('/quiz')">
        返回列表
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MODE_LABELS, QUIZ_MODES, isRevealing } from '@/utils/quizModes'

const route  = useRoute()
const router = useRouter()
const trainingId = parseInt(route.params.trainingId)

const loading = ref(true)
const result  = ref(null)

// 模式严格来源于返回的答题记录（result.mode），不依赖素材默认 mode
const resultMode = computed(() => result.value?.mode || QUIZ_MODES.EXAM)
// 回顾页为交卷后的复盘场景，答案与解析始终展示（isRevealing 仅用于信息标记）
const isReveal = computed(() => isRevealing(resultMode.value))

const circumference = 2 * Math.PI * 44

const dashOffset = computed(() => {
  if (!result.value) return circumference
  return circumference - (result.value.passRate / 100) * circumference
})

const correctCount = computed(() =>
  result.value?.reviewList?.filter(r => r.isCorrect).length ?? 0
)
const wrongCount = computed(() =>
  result.value?.reviewList?.filter(r => !r.isCorrect).length ?? 0
)

onMounted(async () => {
  try {
    const res = await fetch(`/api/quiz/${trainingId}/result`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('tnb_token')}` },
    })
    const json = await res.json()
    if (json.success && json.data) {
      result.value = json.data
    }
  } catch (err) {
    console.error('[ResultPage] 加载失败', err)
  }
  loading.value = false
})

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function typeLabel(type) {
  const map = { single: '单选', choice: '单选', multiple: '多选', multi: '多选', judgment: '判断', essay: '简答', subjective: '简答' }
  return map[type] || '单选'
}

function hasOptions(type) {
  return ['single','choice','multiple','multi'].includes(type)
}

// 判断某个选项索引是否是用户的答案
function isUserAnswer(item, oi) {
  const ua = item.userAnswer
  if (Array.isArray(ua)) return ua.includes(oi)
  return ua === oi
}

// 判断某个选项索引是否是正确答案
function isCorrectAnswer(item, oi) {
  const ca = item.correctAnswer
  // 正确答案可能是数字索引（0,1,2...）或字母（A,B,C...）或数组
  if (Array.isArray(ca)) {
    return ca.includes(oi) || ca.includes(String.fromCharCode(65 + oi))
  }
  const num = Number(ca)
  if (!isNaN(num)) return num === oi
  // 字母
  if (typeof ca === 'string' && ca.length === 1) {
    return ca.toUpperCase().charCodeAt(0) - 65 === oi
  }
  return false
}

// 选项样式
function optionClass(item, oi) {
  const uAns = isUserAnswer(item, oi)
  const cAns = isCorrectAnswer(item, oi)
  if (cAns) return 'opt-correct'
  if (uAns && !cAns) return 'opt-wrong'
  return ''
}

// 重新答题：跳转回答题页并携带原模式（后端已支持覆盖式提交）
function retakeQuiz() {
  router.push(`/quiz/${trainingId}?mode=${resultMode.value}`)
}
</script>

<style scoped>
.result-page { min-height: 100dvh; background: var(--bg); padding-bottom: 32px; }

.page-header { justify-content: center; gap: 16px; }
.page-header h1 { font-size: 18px; }
.mode-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 999px;
  flex-shrink: 0;
}
.mode-badge.mode-study    { background: #EAF3FB; color: #155A96; }
.mode-badge.mode-practice { background: #FBF1E0; color: #C2740B; }
.mode-badge.mode-exam     { background: #FCE9E9; color: #DC2626; }
.back-btn {
  position: absolute;
  left: 14px;
  background: rgba(255,255,255,0.2);
  border: none;
  color: #fff;
  width: 34px; height: 34px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  font-size: 16px;
}

.score-card {
  display: flex;
  align-items: center;
  gap: 20px;
  margin: 16px 12px;
}

.score-ring {
  position: relative;
  width: 96px; height: 96px;
  flex-shrink: 0;
}
.score-ring svg { width: 100%; height: 100%; }
.score-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.score-num { font-size: 28px; font-weight: 700; }
.score-denom { font-size: 12px; color: var(--text-secondary); }

.score-info h2 { font-size: 17px; margin-bottom: 4px; }
.score-info h2.pass { color: var(--success); }
.score-info h2.fail { color: var(--danger); }
.score-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
.record-meta { font-size: 12px; color: var(--text-secondary); }

/* 操作按钮 */
.result-actions {
  display: flex;
  gap: 10px;
  padding: 0 12px 16px;
}
.result-actions .btn { flex: 1; }

/* 逐题回顾 */
.review-section { padding: 0 12px; }
.review-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  padding: 8px 0 4px;
  border-bottom: 2px solid var(--border);
}

.review-item {
  border-radius: 10px;
  border: 1px solid var(--border);
  margin-bottom: 12px;
  overflow: hidden;
}
.review-item.correct { border-color: #34a853; }
.review-item.wrong   { border-color: #ea4335; }

.review-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #f9f9f9;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.review-item.correct .review-header { background: #f0faf3; }
.review-item.wrong   .review-header { background: #fff3f3; }

.review-index { font-weight: 600; }
.review-type  { color: var(--text-secondary); margin-left: 2px; }
.review-score { color: var(--text-secondary); margin-left: auto; }

.review-badge {
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}
.badge-correct { background: #34a853; color: #fff; }
.badge-wrong   { background: #ea4335; color: #fff; }

.review-question {
  padding: 10px 12px 6px;
  font-size: 14px;
  line-height: 1.6;
  font-weight: 500;
}

/* 题目配图 */
.review-image-wrapper {
  padding: 8px 12px 0;
  text-align: center;
}
.review-image {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: contain;
}

/* 选项 */
.review-options { padding: 0 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.review-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: #fafafa;
  border: 1px solid var(--border);
  font-size: 13px;
  position: relative;
}
.review-option.opt-correct {
  background: #f0faf3;
  border-color: #34a853;
}
.review-option.opt-wrong {
  background: #fff3f3;
  border-color: #ea4335;
}
.opt-label {
  font-weight: 700;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}
.opt-text { flex: 1; line-height: 1.5; }
.opt-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.user-tag    { background: #e3f2fd; color: #1565c0; }
.correct-tag { background: #e8f5e9; color: #2e7d32; font-weight: 700; }

/* 判断题 */
.review-judge { display: flex; gap: 10px; padding: 8px 12px 12px; }
.judge-opt {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: #fafafa;
  border: 1px solid var(--border);
  font-size: 13px;
}
.judge-opt.judge-selected {
  background: #fff3f3;
  border-color: #ea4335;
}

/* 简答题 */
.review-essay { padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.essay-row { display: flex; gap: 8px; font-size: 13px; }
.essay-label { flex-shrink: 0; color: var(--text-secondary); font-weight: 600; }
.essay-content { flex: 1; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; }
.essay-content.ref { color: #2e7d32; font-weight: 500; }

/* 解析 */
.review-analysis {
  display: flex;
  gap: 6px;
  padding: 10px 12px 12px;
  font-size: 13px;
  line-height: 1.7;
  background: #f7f9fc;
  border-top: 1px dashed var(--border);
}
.analysis-label { flex-shrink: 0; font-weight: 600; color: #1565c0; }
.analysis-content { flex: 1; color: var(--text-primary); white-space: pre-wrap; }
</style>
