<template>
  <div class="grade-page">
    <!-- 加载态 -->
    <div v-if="loading" class="card" style="text-align:center;padding:50px">
      <div class="spinner" style="margin:0 auto"></div>
    </div>

    <template v-else-if="record">
      <!-- 顶部信息卡 -->
      <div class="card info-card">
        <h3 class="page-title">主观题人工评分</h3>
        <div class="info-grid">
          <div class="info-item"><span class="label">姓名</span><strong>{{ record.userName }}</strong></div>
          <div class="info-item"><span class="label">培训</span><strong>{{ record.materialTitle }}</strong></div>
          <div class="info-item"><span class="label">提交时间</span><span>{{ formatTime(record.submittedAt) }}</span></div>
          <div class="info-item"><span class="label">客观题得分</span><strong>{{ objectiveScore }} 分</strong></div>
          <div class="info-item"><span class="label">当前总分</span>
            <strong :class="record.passed ? 'pass' : 'fail'">{{ record.score }}/{{ record.maxScore }}分</strong>
          </div>
          <div class="info-item"><span class="label">及格线</span><span>{{ record.passScore }} 分</span></div>
          <div class="info-item"><span class="label">评分状态</span>
            <span v-if="record.essayGraded" class="badge badge-success">已评</span>
            <span v-else class="badge badge-warning">待评</span>
          </div>
        </div>
        <p class="tip">按每题满分 {{ essayQuestions.length ? essayQuestions[0].score : 0 }} 分给主观题打分，保存后自动重算总分并判定及格。</p>
      </div>

      <!-- 逐题评分 -->
      <div class="card" v-if="essayQuestions.length">
        <div class="essay-list">
          <div v-for="(q, idx) in essayQuestions" :key="q.id" class="essay-item">
            <div class="q-head">
              <span class="q-index">{{ idx + 1 }}</span>
              <span class="q-type">简答 · {{ q.score }}分</span>
              <span v-if="!getAnswer(q.id)" class="badge badge-warning">未作答（计0分）</span>
              <span v-else-if="getAnswer(q.id).manualGraded" class="badge badge-success">已评</span>
            </div>
            <p class="q-text">{{ q.question }}</p>

            <div class="q-block">
              <div class="q-block-title">参考答案</div>
              <pre class="q-content ref">{{ q.answer || '（无）' }}</pre>
            </div>

            <div class="q-block">
              <div class="q-block-title">用户答案</div>
              <pre v-if="getAnswer(q.id)" class="q-content user">{{ getAnswer(q.id).answer || '（空）' }}</pre>
              <pre v-else class="q-content user muted">未作答</pre>
            </div>

            <div v-if="getAnswer(q.id) && getAnswer(q.id).comment" class="q-block">
              <div class="q-block-title">原评语</div>
              <p class="q-content">{{ getAnswer(q.id).comment }}</p>
            </div>

            <div class="grade-row">
              <div class="grade-field">
                <label>得分（0~{{ q.score }}）</label>
                <input type="number" min="0" :max="q.score" step="1"
                       :value="grades[q.id]?.score ?? ''"
                       @input="setScore(q.id, $event.target.value)" />
                <span class="max-hint">/{{ q.score }}</span>
              </div>
              <div class="grade-field grow">
                <label>评语（可选）</label>
                <input type="text" class="comment-input"
                       :value="grades[q.id]?.comment ?? ''"
                       @input="setComment(q.id, $event.target.value)"
                       placeholder="扣分原因 / 批注…" />
              </div>
            </div>
          </div>
        </div>

        <div class="save-bar">
          <button class="btn btn-primary" :disabled="saving" @click="saveGrades">
            {{ saving ? '保存中…' : '保存评分' }}
          </button>
          <button class="btn" :disabled="saving" @click="$router.push('/admin/records')">返回列表</button>
        </div>
      </div>
    </template>

    <div v-else class="card empty-cell">记录不存在或已删除</div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '@/utils/request'

const route = useRoute()
const router = useRouter()

const recordId = Number(route.params.id)
const loading = ref(true)
const saving = ref(false)
const record = ref(null)
const questions = ref([])
const grades = reactive({}) // { [questionId]: { score, comment } }

const essayQuestions = computed(() => questions.value.filter(q => q.type === 'essay'))

const objectiveScore = computed(() => {
  if (!record.value) return 0
  const essayIds = new Set(essayQuestions.value.map(q => q.id))
  return (record.value.answers || [])
    .filter(a => !essayIds.has(a.questionId) && a.isCorrect)
    .reduce((s, a) => s + (Number(a.score) || 0), 0)
})

function getAnswer(qid) {
  return (record.value?.answers || []).find(a => Number(a.questionId) === Number(qid)) || null
}

function setScore(qid, val) {
  if (!grades[qid]) grades[qid] = { score: '', comment: '' }
  grades[qid].score = val === '' ? '' : Math.max(0, Math.min(Number(val) || 0, maxScoreOf(qid)))
}
function setComment(qid, val) {
  if (!grades[qid]) grades[qid] = { score: '', comment: '' }
  grades[qid].comment = val
}
function maxScoreOf(qid) {
  const q = questions.value.find(x => x.id === qid)
  return q ? q.score : 0
}

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

async function fetchDetail() {
  loading.value = true
  try {
    const res = await request.get(`/api/record/${recordId}`)
    record.value = res.data?.data?.record || null
    questions.value = res.data?.data?.questions || []
    // 预填已评分数
    if (record.value) {
      for (const a of record.value.answers || []) {
        if (a.manualGraded && Number.isFinite(Number(a.score))) {
          grades[a.questionId] = { score: Number(a.score), comment: a.comment || '' }
        }
      }
    }
  } catch {}
  loading.value = false
}

async function saveGrades() {
  const answers = []
  for (const [qid, g] of Object.entries(grades)) {
    if (g.score === '' || g.score === null || g.score === undefined) continue
    answers.push({ questionId: Number(qid), score: Number(g.score), comment: g.comment || undefined })
  }
  if (!answers.length) {
    alert('请至少为一道主观题填写得分')
    return
  }
  saving.value = true
  try {
    const res = await request.patch(`/api/record/${recordId}/essay-grade`, { answers })
    const d = res.data?.data
    if (res.data?.success) {
      alert(`评分已保存：新总分 ${d.score}/${d.maxScore} 分，${d.passed ? '已及格' : '未及格'}（及格线 ${d.passScore} 分）`)
      router.push('/admin/records')
    } else {
      alert(res.data?.error || '保存失败，请重试')
    }
  } catch (e) {
    alert(e.response?.data?.error || '保存失败，请重试')
  }
  saving.value = false
}

onMounted(fetchDetail)
</script>

<style scoped>
.grade-page { max-width: 900px; }
.page-title { margin: 0 0 14px; font-size: 17px; }

.info-card { margin-bottom: 14px; }
.info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 20px; }
.info-item { display: flex; flex-direction: column; gap: 4px; }
.info-item .label { font-size: 12px; color: var(--text-secondary); }
.tip { margin: 14px 0 0; font-size: 12px; color: var(--text-secondary); }

.essay-list { display: flex; flex-direction: column; gap: 14px; }
.essay-item { border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.q-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.q-index { width: 24px; height: 24px; border-radius: 50%; background: var(--primary); color: #fff; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; }
.q-type { font-size: 12px; color: var(--text-secondary); }
.q-text { margin: 0 0 10px; font-weight: 500; line-height: 1.6; }

.q-block { margin-bottom: 10px; }
.q-block-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.q-content { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; background: #f8f9fa; border-radius: 8px; padding: 10px; }
.q-content.ref { border-left: 3px solid var(--primary); }
.q-content.user { border-left: 3px solid var(--warning); }
.q-content.muted { color: var(--text-secondary); }

.grade-row { display: flex; gap: 14px; align-items: flex-end; margin-top: 6px; flex-wrap: wrap; }
.grade-field { display: flex; flex-direction: column; gap: 5px; }
.grade-field.grow { flex: 1; min-width: 220px; }
.grade-field label { font-size: 12px; color: var(--text-secondary); }
.grade-field input[type="number"] { width: 90px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }
.grade-field input[type="number"]:focus { outline: none; border-color: var(--primary); }
.max-hint { font-size: 12px; color: var(--text-secondary); margin-left: 6px; }
.comment-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
.comment-input:focus { outline: none; border-color: var(--primary); }

.save-bar { display: flex; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.pass { color: var(--success); }
.fail { color: var(--danger); }
.empty-cell { text-align: center; padding: 40px; color: var(--text-secondary); }
</style>
