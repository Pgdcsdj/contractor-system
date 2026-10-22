<template>
  <div class="records-page">
    <!-- 筛选栏 -->
    <div class="toolbar card">
      <div class="filter-row">
        <input v-model="filters.keyword" class="filter-input" placeholder="姓名/手机…" @input="debounceFetch" />
        <select v-model="filters.training" class="filter-select" @change="fetchRecords">
          <option value="">全部培训</option>
          <option v-for="t in trainings" :key="t.id" :value="t.id">{{ t.title }}</option>
        </select>
        <select v-model="filters.passed" class="filter-select" @change="fetchRecords">
          <option value="">全部结果</option>
          <option value="1">及格</option>
          <option value="0">不及格</option>
        </select>
        <input v-model="filters.startDate" type="date" class="filter-input date-input" @change="fetchRecords" />
        <span class="date-sep">至</span>
        <input v-model="filters.endDate" type="date" class="filter-input date-input" @change="fetchRecords" />
      </div>
      <div class="toolbar-right">
        <span class="total-count">{{ total }} 条记录</span>
        <button class="btn btn-primary" style="width:auto" @click="exportExcel">
          📥 导出 Excel
        </button>
      </div>
    </div>

    <!-- 记录表格 -->
    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th>姓名</th><th>单位</th><th>培训</th><th>得分</th><th>结果</th>
            <th>提交时间</th><th>来源</th><th>签名状态</th><th>人工评分</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="10" style="text-align:center;padding:30px"><div class="spinner" style="margin:0 auto"></div></td>
          </tr>
          <tr v-else-if="records.length === 0">
            <td colspan="10" class="empty-cell">暂无答题记录</td>
          </tr>
          <tr v-for="r in records" :key="r.id">
            <td><strong>{{ r.user_name }}</strong></td>
            <td class="unit-cell">{{ r.unit || r.supervising_unit || '-' }}</td>
            <td class="title-cell" :title="r.material_title">{{ r.material_title || '-' }}</td>
            <!-- 得分可点击：弹出该次答题逐题明细 -->
            <td>
              <button class="score-btn" :class="r.passed ? 'pass' : 'fail'" @click="openDetail(r.id)">
                {{ r.score }}/{{ r.max_score }}分
              </button>
            </td>
            <td><span :class="['badge', r.passed ? 'badge-success' : 'badge-danger']">{{ r.passed ? '及格' : '不及格' }}</span></td>
            <td class="time-cell">{{ formatTime(r.submitted_at) }}</td>
            <td><span :class="['badge', r.is_offline === 0 ? 'badge-success' : 'badge-warning']">{{ r.is_offline === 0 ? '在线' : '离线' }}</span></td>
            <td>
              <span class="badge badge-success" v-if="r.hash">✓</span>
              <span class="badge badge-danger" v-else>✗</span>
            </td>
            <td>
              <span v-if="r.needs_grading">
                <span class="badge badge-success" v-if="r.essay_graded">已评</span>
                <span class="badge badge-warning" v-else>待评</span>
              </span>
              <span v-else class="text-muted">-</span>
            </td>
            <td>
              <button class="btn btn-sm btn-primary" @click="openDetail(r.id)">明细</button>
              <button v-if="r.needs_grading" class="btn btn-sm btn-outline" style="margin-left:6px" @click="goGrade(r.id)">评分</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 分页 -->
      <div class="pagination" v-if="totalPages > 1">
        <button class="pg-btn" :disabled="page === 1" @click="page--; fetchRecords()">‹</button>
        <span class="pg-info">{{ page }} / {{ totalPages }}</span>
        <button class="pg-btn" :disabled="page === totalPages" @click="page++; fetchRecords()">›</button>
      </div>
    </div>

    <!-- 答题逐题明细弹窗 -->
    <div class="detail-mask" v-if="detailOpen" @click.self="closeDetail">
      <div class="detail-panel">
        <div class="detail-head">
          <div class="detail-title">答题明细</div>
          <button class="detail-close" @click="closeDetail">✕</button>
        </div>

        <div class="detail-body" v-if="detailData">
          <!-- 概览 -->
          <div class="detail-overview">
            <div class="ov-item"><span>姓名</span><b>{{ detailData.record.userName }}</b></div>
            <div class="ov-item"><span>单位</span><b>{{ detailData.record.unit || detailData.record.supervisingUnit || '-' }}</b></div>
            <div class="ov-item ov-full"><span>培训</span><b :title="detailData.record.materialTitle">{{ detailData.record.materialTitle || '-' }}</b></div>
            <div class="ov-item">
              <span>得分</span>
              <b :class="detailData.record.passed ? 'pass' : 'fail'">
                {{ detailData.record.score }}/{{ detailData.record.maxScore }} 分
              </b>
            </div>
            <div class="ov-item"><span>结果</span><b :class="detailData.record.passed ? 'pass' : 'fail'">{{ detailData.record.passed ? '及格' : '不及格' }}</b></div>
            <div class="ov-item"><span>正确/总题</span><b>{{ detailData.totalCorrect }}/{{ detailData.totalCount }}</b></div>
            <div class="ov-item"><span>提交时间</span><b>{{ formatTime(detailData.record.submittedAt) }}</b></div>
            <div class="ov-item"><span>耗时</span><b>{{ formatDuration(detailData.record.durationSec) }}</b></div>
            <div class="ov-item"><span>模式</span><b>{{ modeLabel(detailData.record.mode) }}</b></div>
          </div>

          <!-- 逐题 -->
          <div v-if="detailLoading" class="detail-loading"><div class="spinner" style="margin:20px auto"></div></div>
          <div v-else class="q-list">
            <div class="q-item" v-for="q in detailData.detail" :key="q.questionId">
              <div class="q-head">
                <span class="q-no">第 {{ q.index }} 题</span>
                <span class="q-type" :class="'qt-' + q.type">{{ typeLabel(q.type) }}</span>
                <span class="q-score" :class="q.isCorrect ? 'pass' : 'fail'">
                  {{ q.isCorrect ? '+' + q.score : '0' }} / {{ q.maxScore }}分
                </span>
                <span class="q-result" :class="q.isCorrect ? 'pass' : 'fail'">{{ q.isCorrect ? '✓ 正确' : '✗ 错误' }}</span>
              </div>
              <div class="q-stem">{{ q.question }}</div>
              <img v-if="q.imageUrl" :src="q.imageUrl" class="q-img" @click="zoomImg = q.imageUrl" alt="题目配图" />

              <!-- 选项（单选/多选） -->
              <div class="q-options" v-if="q.options && (q.type === 'single' || q.type === 'multiple')">
                <div
                  class="opt"
                  v-for="(val, key) in q.options"
                  :key="key"
                  :class="optClass(key, q)"
                >
                  <span class="opt-key">{{ key }}</span>
                  <span class="opt-val">{{ val }}</span>
                  <span class="opt-tag" v-if="isUserChoice(key, q) && isCorrectChoice(key, q)">你的答案</span>
                  <span class="opt-tag wrong" v-else-if="isUserChoice(key, q) && !isCorrectChoice(key, q)">你的答案(错)</span>
                  <span class="opt-tag correct" v-else-if="!isUserChoice(key, q) && isCorrectChoice(key, q)">正确答案</span>
                </div>
              </div>

              <!-- 判断题答案对比 -->
              <div class="q-judge" v-else-if="q.type === 'judgment'">
                <div class="judge-row"><span>你的答案</span><b :class="q.isCorrect ? 'pass' : 'fail'">{{ q.userAnswer || '-' }}</b></div>
                <div class="judge-row"><span>正确答案</span><b class="pass">{{ q.correctAnswer || '-' }}</b></div>
              </div>

              <!-- 简答/其他 -->
              <div class="q-essay" v-else>
                <div class="judge-row"><span>你的答案</span><b>{{ q.userAnswer || '-' }}</b></div>
                <div class="judge-row" v-if="q.correctAnswer"><span>参考答案</span><b>{{ q.correctAnswer }}</b></div>
                <div class="judge-row" v-if="q.comment"><span>批改评语</span><b>{{ q.comment }}</b></div>
              </div>

              <div class="q-analysis" v-if="q.analysis">
                <span class="an-label">解析</span>{{ q.analysis }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 配图放大 -->
    <div class="img-zoom" v-if="zoomImg" @click="zoomImg = null">
      <img :src="zoomImg" alt="放大查看" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { request } from '@/utils/request'

const router = useRouter()
const records = ref([])
const trainings = ref([])
const loading = ref(true)
const total = ref(0)
const page = ref(1)
const pageSize = 20

const filters = ref({
  keyword: '', training: '', passed: '',
  startDate: '', endDate: '',
})

// 明细弹窗状态
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailData = ref(null)
const zoomImg = ref(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

function debounceFetch() {
  clearTimeout(debounceFetch._t)
  debounceFetch._t = setTimeout(fetchRecords, 300)
}

// 后端参数映射：training→materialId、startDate→dateFrom、endDate→dateTo、keyword/passed 透传
function buildParams() {
  const params = { page: page.value, pageSize }
  if (filters.value.keyword)   params.keyword = filters.value.keyword
  if (filters.value.training)  params.materialId = filters.value.training
  if (filters.value.passed !== '') params.passed = filters.value.passed
  if (filters.value.startDate) params.dateFrom = filters.value.startDate
  if (filters.value.endDate)   params.dateTo = filters.value.endDate
  return params
}

async function fetchRecords() {
  loading.value = true
  try {
    const res = await request.get('/api/record/list', { params: buildParams() })
    records.value = res.data?.data?.list || []
    total.value = res.data?.data?.total || 0
  } catch {}
  loading.value = false
}

// 培训下拉数据源：/api/material/list（后端 queryRecords 不返回 trainings）
async function fetchTrainings() {
  try {
    const res = await request.get('/api/material/list', { params: { pageSize: 500 } })
    const list = res.data?.data?.list || res.data?.data || []
    trainings.value = Array.isArray(list) ? list : []
  } catch {}
}

// 打开答题明细：拉取 /api/record/:id/detail
async function openDetail(id) {
  detailOpen.value = true
  detailLoading.value = true
  detailData.value = null
  try {
    const res = await request.get(`/api/record/${id}/detail`)
    detailData.value = res.data?.data || null
  } catch (e) {
    detailData.value = { record: { userName: '-', materialTitle: '加载失败' }, detail: [], totalCorrect: 0, totalCount: 0 }
  }
  detailLoading.value = false
}

function closeDetail() {
  detailOpen.value = false
  detailData.value = null
  zoomImg.value = null
}

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function formatDuration(sec) {
  sec = Number(sec) || 0
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m <= 0) return `${s}秒`
  return `${m}分${s}秒`
}

function typeLabel(t) {
  return ({ single: '单选', multiple: '多选', judgment: '判断', essay: '简答' })[t] || '其他'
}
function modeLabel(m) {
  return ({ exam: '考试', practice: '练习', study: '学习' })[m] || (m || '-')
}

// 选项判断辅助
function letters(str) {
  return (str || '').split('').filter(c => /[A-Za-z]/.test(c)).map(c => c.toUpperCase())
}
function isUserChoice(key, q) { return letters(q.userAnswer).includes(String(key).toUpperCase()) }
function isCorrectChoice(key, q) { return letters(q.correctAnswer).includes(String(key).toUpperCase()) }
function optClass(key, q) {
  const user = isUserChoice(key, q)
  const correct = isCorrectChoice(key, q)
  if (user && correct) return 'opt-user-correct'
  if (user && !correct) return 'opt-user-wrong'
  if (!user && correct) return 'opt-correct-miss'
  return ''
}

function goGrade(id) {
  router.push(`/admin/records/${id}`)
}

function exportExcel() {
  const params = new URLSearchParams(buildParams()).toString()
  const token = localStorage.getItem('tnb_admin_token')
  window.open(`/api/record/export?${params}&token=${token}`, '_blank')
}

onMounted(() => {
  fetchRecords()
  fetchTrainings()
})
</script>

<style scoped>
.records-page { max-width: 1280px; }

.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1; }
.filter-input {
  padding: 8px 10px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px;
}
.filter-input:focus { outline: none; border-color: var(--primary); }
.date-input { width: 140px; }
.date-sep { font-size: 13px; color: var(--text-secondary); }
.filter-select {
  padding: 8px 10px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px; background: #fff;
}
.toolbar-right { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.total-count { font-size: 13px; color: var(--text-secondary); }

.table-card { padding: 0; overflow: hidden; }

.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th {
  text-align: left; padding: 11px 14px;
  background: #f8f9fa; color: var(--text-secondary);
  font-weight: 500; font-size: 13px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.data-table td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: #f8f9fa; }
.title-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unit-cell { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-secondary); }
.time-cell { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.pass { color: var(--success); }
.fail { color: var(--danger); }
.text-muted { color: var(--text-secondary); font-size: 13px; }
.empty-cell { text-align: center; padding: 40px; color: var(--text-secondary); }

.btn-sm { padding: 4px 10px; font-size: 13px; border-radius: 6px; }
.btn-outline { border: 1px solid var(--border); background: #fff; }

/* 得分可点击按钮 */
.score-btn {
  border: none; background: none; cursor: pointer;
  font: inherit; font-weight: 700; padding: 2px 6px; border-radius: 6px;
  text-decoration: underline; text-underline-offset: 2px;
}
.score-btn:hover { background: rgba(0,0,0,.05); }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; border-top: 1px solid var(--border); }
.pg-btn { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; }
.pg-btn:disabled { opacity: 0.4; cursor: default; }
.pg-info { font-size: 13px; color: var(--text-secondary); }

/* ── 明细弹窗 ── */
.detail-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 16px; z-index: 1000; overflow-y: auto;
}
.detail-panel {
  background: #fff; width: 100%; max-width: 860px; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25); display: flex; flex-direction: column;
  max-height: 88vh; overflow: hidden;
}
.detail-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: #fff; z-index: 2;
}
.detail-title { font-size: 16px; font-weight: 600; }
.detail-close { border: none; background: #f0f0f0; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 14px; }
.detail-close:hover { background: #e0e0e0; }
.detail-body { padding: 16px 18px; overflow-y: auto; }

.detail-overview {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 16px;
  background: #f8f9fa; border-radius: 10px; padding: 14px 16px; margin-bottom: 16px;
}
.ov-item { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.ov-item span { color: var(--text-secondary); font-size: 12px; }
.ov-item b { font-size: 14px; font-weight: 600; word-break: break-all; }
.ov-full { grid-column: 1 / -1; }

.detail-loading { text-align: center; padding: 20px; }

.q-list { display: flex; flex-direction: column; gap: 14px; }
.q-item {
  border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px;
  background: #fff;
}
.q-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.q-no { font-weight: 600; font-size: 13px; color: var(--text-secondary); }
.q-type { font-size: 12px; padding: 2px 8px; border-radius: 20px; background: #eef2ff; color: #3b5bdb; }
.qt-judgment { background: #fff4e6; color: #e8590c; }
.qt-multiple { background: #e6fcf5; color: #0ca678; }
.qt-essay { background: #f3f0ff; color: #7048e8; }
.q-score { font-size: 13px; font-weight: 600; margin-left: auto; }
.q-result { font-size: 13px; font-weight: 600; }
.q-stem { font-size: 15px; line-height: 1.6; margin-bottom: 10px; white-space: pre-wrap; }
.q-img { max-width: 100%; max-height: 280px; border-radius: 8px; cursor: zoom-in; margin-bottom: 10px; display: block; }

.q-options { display: flex; flex-direction: column; gap: 6px; }
.opt {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px; font-size: 14px;
}
.opt-key { font-weight: 700; width: 20px; }
.opt-val { flex: 1; }
.opt-tag { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: #f1f3f5; color: var(--text-secondary); }
.opt-user-correct { background: #ebfbee; border-color: #51cf66; }
.opt-user-correct .opt-tag { background: #d3f9d8; color: #2b8a3e; }
.opt-user-wrong { background: #fff5f5; border-color: #ff8787; }
.opt-user-wrong .opt-tag { background: #ffe3e3; color: #c92a2a; }
.opt-correct-miss { border-color: #51cf66; border-style: dashed; }
.opt-correct-miss .opt-tag { background: #d3f9d8; color: #2b8a3e; }

.q-judge, .q-essay { display: flex; flex-direction: column; gap: 6px; }
.judge-row { display: flex; gap: 10px; font-size: 14px; align-items: baseline; }
.judge-row span { color: var(--text-secondary); font-size: 13px; min-width: 60px; }

.q-analysis {
  margin-top: 10px; padding: 10px 12px; background: #f8f9fa;
  border-radius: 8px; font-size: 13px; line-height: 1.6; color: #495057;
}
.an-label { font-weight: 600; color: var(--primary); margin-right: 6px; }

.img-zoom {
  position: fixed; inset: 0; background: rgba(0,0,0,.8);
  display: flex; align-items: center; justify-content: center; z-index: 1100; cursor: zoom-out;
}
.img-zoom img { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
</style>
