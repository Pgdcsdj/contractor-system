<template>
  <div class="review-page">
    <div class="page-head">
      <div>
        <h2>人员清单报送审核</h2>
        <p class="sub">安全员报送的人员清单需在此审核。审核通过后才会更新人员库；「移除」的人只调离通南巴项目部，仍保留在普光分公司大库。</p>
      </div>
    </div>

    <div class="card">
      <div class="filter-row">
        <select v-model="filters.status" class="input" @change="fetchBatches">
          <option value="">全部状态</option>
          <option value="0">待审核</option>
          <option value="1">已通过</option>
          <option value="2">已驳回</option>
        </select>
        <input v-model="filters.month" type="month" class="input" @change="fetchBatches" />
        <button class="btn btn-outline" @click="reset">清除筛选</button>
        <span class="total">共 {{ batches.length }} 个批次</span>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>月份</th><th>报送单位</th><th>人数</th><th>新增/保留/移除</th>
            <th>状态</th><th>报送人</th><th>报送时间</th><th>审核</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="9" class="empty">加载中…</td></tr>
          <tr v-else-if="!batches.length"><td colspan="9" class="empty">暂无报送批次</td></tr>
          <tr v-for="b in batches" :key="b.id">
            <td><b>{{ b.report_month }}</b></td>
            <td>{{ b.unit_name }}</td>
            <td>{{ b.total_count }}</td>
            <td>{{ b.add_count }} / {{ b.total_count - b.add_count - b.remove_count }} / {{ b.remove_count }}</td>
            <td><span class="badge" :class="statusClass(b.status)">{{ statusText(b.status) }}</span></td>
            <td>{{ b.submitted_by_name || '-' }}</td>
            <td>{{ fmtTime(b.submitted_at) }}</td>
            <td class="small">{{ b.reviewed_by_name ? b.reviewed_by_name + ' · ' + fmtTime(b.reviewed_at) : '-' }}</td>
            <td>
              <button class="btn btn-sm btn-primary" @click="openDetail(b)">审核明细</button>
              <button v-if="b.status === 0" class="btn btn-sm btn-danger" style="margin-left:6px" @click="rejectBatch(b)">驳回</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="detailOpen" class="mask" @click.self="detailOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>审核明细 · {{ detail.batch?.unit_name }} {{ detail.batch?.report_month }}</h3>
          <button class="close" @click="detailOpen = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="summary">
            <span>共 {{ detail.items.length }} 条</span>
            <span>待处理 {{ pendingCount }} 条</span>
            <span>已剔除 {{ skippedCount }} 条</span>
            <span>已应用 {{ appliedCount }} 条</span>
          </div>
          <table class="data-table">
            <thead>
              <tr><th>动作</th><th>姓名</th><th>身份证</th><th>单位</th><th>岗位</th><th>库中现状</th><th>处理</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="it in detail.items" :key="it.id" :class="{ 'row-skipped': it.apply_status === 'skipped' }">
                <td><span class="badge" :class="actionClass(it.action)">{{ actionText(it.action) }}</span></td>
                <td>{{ it.name }}</td>
                <td class="mono">{{ maskId(it.id_card) }}</td>
                <td>{{ it.unit_name }}</td>
                <td>{{ it.position || '-' }}</td>
                <td class="small">{{ it.exists_in_db ? (it.current_supervising || '在库') : '库中无' }}</td>
                <td class="small">{{ it.apply_note || '待审核' }}</td>
                <td>
                  <button v-if="it.apply_status === 'pending' && detail.batch.status === 0" class="btn btn-sm btn-outline" @click="skipItem(it)">剔除</button>
                  <span v-else class="small">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot">
          <span class="warn-text" v-if="detail.batch?.status === 0">审核通过后将立即更新人员库，请核对无误后操作。</span>
          <div>
            <button class="btn btn-outline" @click="detailOpen = false">关闭</button>
            <button v-if="detail.batch?.status === 0" class="btn btn-primary" :disabled="approving" @click="approveBatch">
              {{ approving ? '处理中…' : '审核通过并应用' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { request } from '@/utils/request'

const batches = ref([])
const loading = ref(true)
const detailOpen = ref(false)
const detail = ref({ batch: null, items: [] })
const approving = ref(false)
const filters = ref({ status: '', month: '' })

const pendingCount = computed(() => detail.value.items.filter(i => i.apply_status === 'pending').length)
const skippedCount = computed(() => detail.value.items.filter(i => i.apply_status === 'skipped').length)
const appliedCount = computed(() => detail.value.items.filter(i => i.apply_status === 'applied').length)

onMounted(fetchBatches)

async function fetchBatches() {
  loading.value = true
  try {
    const params = {}
    if (filters.value.status !== '') params.status = filters.value.status
    if (filters.value.month) params.month = filters.value.month
    const res = await request.get('/api/staff-roster/admin/batches', { params })
    batches.value = res.data?.data || []
  } catch {}
  loading.value = false
}

function reset() { filters.value = { status: '', month: '' }; fetchBatches() }

async function openDetail(b) {
  try {
    const res = await request.get(`/api/staff-roster/admin/batches/${b.id}`)
    detail.value = res.data?.data || { batch: b, items: [] }
    detailOpen.value = true
  } catch {}
}

async function approveBatch() {
  if (!confirm(`确认审核通过？将对 ${pendingCount.value} 人执行变更（移除的人调离通南巴，仍保留在大库）。`)) return
  approving.value = true
  try {
    const res = await request.post(`/api/staff-roster/admin/batches/${detail.value.batch.id}/approve`)
    alert(res.data?.message || '审核完成')
    detailOpen.value = false
    await fetchBatches()
  } catch (e) {
    alert('审核失败：' + (e.response?.data?.error || e.message))
  }
  approving.value = false
}

async function rejectBatch(b) {
  const note = prompt('驳回原因（可留空）：') 
  if (note === null) return
  try {
    await request.post(`/api/staff-roster/admin/batches/${b.id}/reject`, { note })
    await fetchBatches()
  } catch (e) { alert('驳回失败：' + (e.response?.data?.error || e.message)) }
}

async function skipItem(it) {
  if (!confirm(`确认剔除 ${it.name}？该人员本次报送将不应用到人员库。`)) return
  try {
    await request.post(`/api/staff-roster/admin/items/${it.id}/skip`)
    const res = await request.get(`/api/staff-roster/admin/batches/${detail.value.batch.id}`)
    detail.value = res.data?.data || detail.value
  } catch (e) { alert('剔除失败：' + (e.response?.data?.error || e.message)) }
}

function statusText(s) { return ({ 0: '待审核', 1: '已通过', 2: '已驳回' })[s] || s }
function statusClass(s) { return ({ 0: 'warn', 1: 'ok', 2: 'bad' })[s] || '' }
function actionText(a) { return ({ add: '新增', keep: '保留', remove: '移除' })[a] || a }
function actionClass(a) { return ({ add: 'ok', keep: '', remove: 'bad' })[a] || '' }
function maskId(v) { const s = String(v || ''); return s.length > 8 ? s.slice(0, 6) + '********' + s.slice(-4) : s }
function fmtTime(v) { if (!v) return '-'; const d = new Date(v); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
</script>

<style scoped>
.review-page { max-width: 1280px; }
.page-head { margin-bottom: 16px; }
.page-head h2 { margin: 0 0 6px; font-size: 20px; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0; line-height: 1.6; }
.card { background: #fff; border-radius: 12px; padding: 18px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
.filter-row { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.total { margin-left: auto; font-size: 13px; color: var(--text-secondary); }
.input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
.btn { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: #fff; cursor: pointer; font-size: 13px; }
.btn-primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
.btn-danger { background: #fff; color: #b71c1c; border-color: #ef9a9a; }
.btn-outline { background: #fff; }
.btn-sm { padding: 5px 10px; font-size: 12px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 9px 10px; border-bottom: 1px solid #eee; text-align: left; }
.data-table th { background: #fafafa; font-weight: 600; }
.empty { text-align: center; color: var(--text-secondary); padding: 24px; }
.badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; background: #eee; }
.badge.ok { background: #e8f5e9; color: #1b5e20; }
.badge.warn { background: #fff3e0; color: #e65100; }
.badge.bad { background: #ffebee; color: #b71c1c; }
.mono { font-family: monospace; }
.small { font-size: 12px; color: var(--text-secondary); }
.row-skipped { opacity: .5; text-decoration: line-through; }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
.modal { background: #fff; border-radius: 12px; width: 100%; max-width: 1100px; max-height: 88vh; display: flex; flex-direction: column; }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eee; }
.modal-head h3 { margin: 0; font-size: 16px; }
.close { border: none; background: #f0f0f0; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; }
.modal-body { padding: 16px 18px; overflow-y: auto; }
.modal-foot { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-top: 1px solid #eee; gap: 12px; }
.modal-foot > div { display: flex; gap: 8px; }
.warn-text { font-size: 12px; color: #e65100; }
.summary { display: flex; gap: 20px; margin-bottom: 12px; font-size: 13px; color: var(--text-secondary); }
</style>
