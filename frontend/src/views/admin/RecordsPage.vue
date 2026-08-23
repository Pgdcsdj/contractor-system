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
            <th>姓名</th><th>培训</th><th>得分</th><th>结果</th>
            <th>提交时间</th><th>来源</th><th>签名状态</th><th>人工评分</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="9" style="text-align:center;padding:30px"><div class="spinner" style="margin:0 auto"></div></td>
          </tr>
          <tr v-else-if="records.length === 0">
            <td colspan="9" class="empty-cell">暂无答题记录</td>
          </tr>
          <tr v-for="r in records" :key="r.id">
            <td><strong>{{ r.user_name }}</strong></td>
            <td class="title-cell" :title="r.material_title">{{ r.material_title || '-' }}</td>
            <td><strong :class="r.passed ? 'pass' : 'fail'">{{ r.score }}/{{ r.max_score }}分</strong></td>
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
              <button v-if="r.needs_grading" class="btn btn-sm btn-primary" @click="goGrade(r.id)">评分</button>
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

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
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
.time-cell { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.pass { color: var(--success); }
.fail { color: var(--danger); }
.text-muted { color: var(--text-secondary); font-size: 13px; }
.empty-cell { text-align: center; padding: 40px; color: var(--text-secondary); }

.btn-sm { padding: 4px 10px; font-size: 13px; border-radius: 6px; }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; border-top: 1px solid var(--border); }
.pg-btn { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; }
.pg-btn:disabled { opacity: 0.4; cursor: default; }
.pg-info { font-size: 13px; color: var(--text-secondary); }
</style>
