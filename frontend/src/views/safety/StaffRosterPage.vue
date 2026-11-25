<template>
  <div class="roster-page">
    <div class="page-head">
      <div>
        <h2>人员清单报送</h2>
        <p class="sub">每月报送本单位在场人员（含分包人员）。安全员报送后需管理员审核，审核通过才更新人员库。</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-outline" @click="downloadTemplate">下载报送模板</button>
      </div>
    </div>

    <!-- 报送卡 -->
    <div class="card submit-card">
      <div class="card-title">新增报送</div>
      <div class="form-row">
        <label>报送单位</label>
        <select v-model="submitForm.unitId" class="input" disabled>
          <option v-if="!submitForm.unitId" value="">未绑定单位（请联系管理员）</option>
          <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
        </select>
        <label>报送月份</label>
        <input v-model="submitForm.month" type="month" class="input" />
        <label>人员清单</label>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" class="file-input" @change="onFile" />
        <button class="btn btn-primary" :disabled="uploading || !submitForm.month || !submitForm.file" @click="doSubmit">
          {{ uploading ? '报送中…' : '提交报送' }}
        </button>
      </div>
      <p class="tips">
        模板列：<b>报送动作</b>（新增/保留/移除）、姓名、身份证号、所属单位（未填则归到本单位）、岗位、手机号。
        「移除」的人不会从系统删除，审核通过后只调离通南巴项目部、仍保留在普光分公司人员库。
      </p>
      <div v-if="result" class="result-box">
        <div class="result-title">{{ result.message }}</div>
        <div class="result-stats">
          <span>共 {{ result.total }} 人</span>
          <span>新增 {{ result.addCount }}</span>
          <span>保留 {{ result.keepCount }}</span>
          <span>移除 {{ result.removeCount }}</span>
          <span v-if="result.failList?.length" class="bad">失败 {{ result.failList.length }}</span>
        </div>
        <ul v-if="result.failList?.length" class="fail-list">
          <li v-for="(f, i) in result.failList" :key="i">第 {{ f.row }} 行：{{ f.error }}</li>
        </ul>
      </div>
    </div>

    <!-- 历史批次 -->
    <div class="card">
      <div class="card-title">报送记录</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>报送月份</th><th>报送单位</th><th>人数</th><th>新增/保留/移除</th>
            <th>状态</th><th>报送人</th><th>报送时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="8" class="empty">加载中…</td></tr>
          <tr v-else-if="!batches.length"><td colspan="8" class="empty">暂无报送记录</td></tr>
          <tr v-for="b in batches" :key="b.id">
            <td><b>{{ b.report_month }}</b></td>
            <td>{{ b.unit_name }}</td>
            <td>{{ b.total_count }}</td>
            <td>{{ b.add_count }} / {{ b.total_count - b.add_count - b.remove_count }} / {{ b.remove_count }}</td>
            <td><span class="badge" :class="statusClass(b.status)">{{ statusText(b.status) }}</span></td>
            <td>{{ b.submitted_by_name || '-' }}</td>
            <td>{{ fmtTime(b.submitted_at) }}</td>
            <td><button class="btn btn-sm btn-outline" @click="openDetail(b)">查看明细</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 明细弹窗 -->
    <div v-if="detailOpen" class="mask" @click.self="detailOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>报送明细 · {{ detail.batch?.report_month }}</h3>
          <button class="close" @click="detailOpen = false">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="detail.batch?.status === 2" class="reject-note">驳回原因：{{ detail.batch.review_note }}</div>
          <table class="data-table">
            <thead><tr><th>动作</th><th>姓名</th><th>身份证</th><th>单位</th><th>岗位</th><th>库中现状</th></tr></thead>
            <tbody>
              <tr v-for="it in detail.items" :key="it.id">
                <td><span class="badge" :class="actionClass(it.action)">{{ actionText(it.action) }}</span></td>
                <td>{{ it.name }}</td>
                <td class="mono">{{ maskId(it.id_card) }}</td>
                <td>{{ it.unit_name }}</td>
                <td>{{ it.position || '-' }}</td>
                <td class="small">{{ it.exists_in_db ? (it.current_supervising || '在库') : '库中无' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { request } from '@/utils/request'

const units = ref([])
const batches = ref([])
const loading = ref(true)
const uploading = ref(false)
const result = ref(null)
const detailOpen = ref(false)
const detail = ref({ batch: null, items: [] })
const fileInput = ref(null)

// 默认月份 = 上个月
function lastMonth() {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const submitForm = ref({ unitId: '', month: lastMonth(), file: null })

onMounted(async () => {
  await Promise.all([loadUnits(), loadBatches()])
})

async function loadUnits() {
  try {
    const res = await request.get('/api/staff-roster/units')
    units.value = res.data?.data || []
    if (units.value.length) submitForm.value.unitId = units.value[0].id
  } catch {}
}

async function loadBatches() {
  loading.value = true
  try {
    const res = await request.get('/api/staff-roster/mine')
    batches.value = res.data?.data || []
  } catch {}
  loading.value = false
}

function onFile(e) {
  submitForm.value.file = e.target.files?.[0] || null
}

async function downloadTemplate() {
  try {
    const res = await request.get('/api/staff-roster/template', { responseType: 'blob' })
    const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '承包商人员清单报送模板.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    alert('下载模板失败')
  }
}

async function doSubmit() {
  if (!submitForm.value.file) return
  uploading.value = true
  result.value = null
  try {
    const fd = new FormData()
    fd.append('file', submitForm.value.file)
    fd.append('month', submitForm.value.month)
    const res = await request.post('/api/staff-roster/submit', fd)
    result.value = res.data?.data || {}
    await loadBatches()
    if (fileInput.value) fileInput.value.value = ''
    submitForm.value.file = null
  } catch (e) {
    result.value = { message: '报送失败：' + (e.response?.data?.error || e.message), failList: [] }
  }
  uploading.value = false
}

async function openDetail(b) {
  try {
    const res = await request.get(`/api/staff-roster/batches/${b.id}`)
    detail.value = res.data?.data || { batch: b, items: [] }
    detailOpen.value = true
  } catch {}
}

function statusText(s) { return ({ 0: '待审核', 1: '已通过', 2: '已驳回' })[s] || s }
function statusClass(s) { return ({ 0: 'warn', 1: 'ok', 2: 'bad' })[s] || '' }
function actionText(a) { return ({ add: '新增', keep: '保留', remove: '移除' })[a] || a }
function actionClass(a) { return ({ add: 'ok', keep: '', remove: 'bad' })[a] || '' }
function maskId(v) { const s = String(v || ''); return s.length > 8 ? s.slice(0, 6) + '********' + s.slice(-4) : s }
function fmtTime(v) { if (!v) return '-'; const d = new Date(v); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
</script>

<style scoped>
.roster-page { max-width: 1100px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; gap: 12px; }
.page-head h2 { margin: 0 0 6px; font-size: 20px; }
.sub, .tips { color: var(--text-secondary); font-size: 13px; margin: 0; line-height: 1.6; }
.card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
.submit-card { border-left: 3px solid #d32f2f; }
.form-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.form-row label { font-size: 13px; color: var(--text-secondary); }
.input, .file-input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
.input[type=month] { width: 150px; }
.btn { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: #fff; cursor: pointer; font-size: 13px; }
.btn-primary { background: #d32f2f; color: #fff; border-color: #d32f2f; }
.btn-outline { background: #fff; }
.btn-sm { padding: 5px 10px; font-size: 12px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.tips { margin-top: 8px; }
.result-box { margin-top: 14px; padding: 12px 14px; background: #f5f8ff; border-radius: 8px; }
.result-title { font-weight: 600; margin-bottom: 6px; }
.result-stats { display: flex; gap: 18px; font-size: 13px; flex-wrap: wrap; }
.fail-list { margin: 8px 0 0; padding-left: 20px; color: #b71c1c; font-size: 12px; }
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
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
.modal { background: #fff; border-radius: 12px; width: 100%; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eee; }
.modal-head h3 { margin: 0; font-size: 16px; }
.close { border: none; background: #f0f0f0; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; }
.modal-body { padding: 16px 18px; overflow-y: auto; }
.reject-note { padding: 10px 12px; background: #ffebee; color: #b71c1c; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
</style>
