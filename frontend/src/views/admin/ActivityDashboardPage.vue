<template>
  <div class="dash-page">
    <div class="page-head">
      <div>
        <h2 class="page-section-title">安全活动看板</h2>
        <p class="sub">按月统计各施工单位「周一安全活动 / 周三学习活动」完成情况；单位、队别、井号可自行设置，施工队伍变动时改名单即可。</p>
      </div>
      <div class="head-actions">
        <select v-model="month" class="filter-input" @change="load">
          <option v-for="m in months" :key="m" :value="m">{{ m }}</option>
        </select>
        <button class="btn btn-outline" @click="openSettings"><Icon name="settings" :size="16" /> 受控单位名单</button>
        <button class="btn btn-primary" :disabled="loading" @click="doExport"><Icon name="download" :size="16" /> 导出 Excel</button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card"><div class="stat-num">{{ totalUnits }}</div><div class="stat-lbl">受控单位</div></div>
      <div class="stat-card"><div class="stat-num">{{ totalPeriods }}</div><div class="stat-lbl">本月期数（周一+周三）</div></div>
      <div class="stat-card ok"><div class="stat-num">{{ totalReported }}</div><div class="stat-lbl">已报次数</div></div>
      <div class="stat-card warn"><div class="stat-num">{{ totalMissing }}</div><div class="stat-lbl">缺报次数</div></div>
      <div class="stat-card"><div class="stat-num">{{ totalRate }}%</div><div class="stat-lbl">整体完成率</div></div>
    </div>

    <div v-for="blk in blocks" :key="blk.key" class="card table-card">
      <div class="table-toolbar">
        <span class="table-title">{{ blk.title }}</span>
        <span class="blk-meta">
          本期 {{ blk.data.periods.length }} 期 · 单位 {{ blk.data.rows.length }} 家 · 应报
          {{ blk.data.rows.length * blk.data.periods.length }} 次
        </span>
        <span class="spacer"></span>
        <span class="blk-rate">完成率 {{ blk.data.totals?.rate || 0 }}%</span>
      </div>

      <div v-if="!blk.data.periods.length" class="empty-cell">该月暂无{{ blk.title }}期次，换个月份看看。</div>
      <div v-else class="table-scroll">
        <table class="data-table stat-table">
          <thead>
            <tr>
              <th>序号</th>
              <th class="col-unit">单位名称</th>
              <th>队别</th>
              <th>井号</th>
              <th v-for="p in blk.data.periods" :key="p.id">{{ mdLabel(p.date) }}</th>
              <th>已报</th>
              <th>缺少</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in blk.data.rows" :key="r.id">
              <td>{{ r.seq_no }}</td>
              <td class="col-unit"><strong>{{ r.unit_name }}</strong></td>
              <td>{{ r.team_name || '-' }}</td>
              <td>{{ r.well_no || '-' }}</td>
              <td v-for="(c, i) in r.cells" :key="i" class="mark" :class="c ? 'ok' : 'miss'">{{ c ? '√' : '' }}</td>
              <td class="ok-text">{{ r.reported }}</td>
              <td :class="{ 'warn-text': r.missing > 0 }">{{ r.missing }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="sum-row">
              <td colspan="4">合计</td>
              <td v-for="(t, i) in colTotals(blk.data)" :key="i">{{ t }}</td>
              <td>{{ blk.data.totals?.reported || 0 }}</td>
              <td>{{ blk.data.totals?.missing || 0 }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- 受控单位名单设置 -->
    <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
      <div class="modal wide">
        <h3><Icon name="settings" :size="19" /> 受控单位名单设置</h3>
        <p class="modal-hint">
          这张名单就是月度统计表的行。施工队伍变动时在此增删；同一单位有多个队/井，可加多行分别填写队别与井号。
        </p>
        <div class="table-scroll settings-scroll">
          <table class="data-table compact">
            <thead><tr><th>序号</th><th>单位名称</th><th>队别</th><th>井号</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in editRows" :key="i">
                <td>{{ i + 1 }}</td>
                <td>
                  <select v-model.number="r.unit_id" class="form-input" @change="onPickUnit(r)">
                    <option :value="null">— 手工填写 —</option>
                    <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
                  </select>
                  <input v-if="!r.unit_id" v-model="r.unit_name" class="form-input mt4" placeholder="手工填单位名称" />
                </td>
                <td><input v-model="r.team_name" class="form-input" placeholder="如 ZY-70717" /></td>
                <td><input v-model="r.well_no" class="form-input" placeholder="如 马308-1HTNB" /></td>
                <td><button class="action-link danger" @click="editRows.splice(i, 1)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="settings-actions">
          <button class="btn btn-outline" @click="addRow">+ 添加一行</button>
          <span class="spacer"></span>
          <button class="btn btn-outline" @click="showSettings = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="doSave">{{ saving ? '保存中…' : '保存名单' }}</button>
        </div>
      </div>
    </div>

    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import { fmtDate } from '@/utils/datetime'
import {
  getActivityDashboard, getActivityStatUnits, saveActivityStatUnits,
  exportActivityDashboard, getActivityUnits,
} from '@/api/activity'

const month = ref('')
const months = ref([])
const loading = ref(false)
const emptyBlock = () => ({ periods: [], rows: [], totals: { units: 0, periodCount: 0, reported: 0, missing: 0, rate: 0 } })
const monday = ref(emptyBlock())
const wednesday = ref(emptyBlock())

const blocks = computed(() => [
  { key: 'monday', title: '周一安全活动', data: monday.value },
  { key: 'wednesday', title: '周三学习活动', data: wednesday.value },
])

const totalUnits = computed(() => Math.max(monday.value.rows.length, wednesday.value.rows.length))
const totalPeriods = computed(() => (monday.value.periods.length + wednesday.value.periods.length))
const totalReported = computed(() => (monday.value.totals?.reported || 0) + (wednesday.value.totals?.reported || 0))
const totalMissing = computed(() => (monday.value.totals?.missing || 0) + (wednesday.value.totals?.missing || 0))
const totalRate = computed(() => {
  const all = totalReported.value + totalMissing.value
  return all ? Math.round((totalReported.value / all) * 100) : 0
})

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg; toast.type = type; toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}
function errMsg(e) { return e.response?.data?.error || e.message || '操作失败' }

/** 期次表头：11/2 */
function mdLabel(d) {
  const s = fmtDate(d)
  if (!s) return ''
  const [, m, dd] = s.split('-')
  return `${Number(m)}/${Number(dd)}`
}
function colTotals(block) {
  return (block.periods || []).map((_, i) => (block.rows || []).filter((r) => r.cells?.[i]).length)
}

async function load() {
  loading.value = true
  try {
    const res = await getActivityDashboard(month.value)
    const d = res.data?.data || {}
    months.value = d.months?.length ? d.months : []
    month.value = d.month || month.value
    monday.value = d.monday || emptyBlock()
    wednesday.value = d.wednesday || emptyBlock()
  } catch (e) { showToast(errMsg(e), 'error') }
  loading.value = false
}

// ── 受控单位名单设置 ─────────────────────────────────────────────────────
const showSettings = ref(false)
const saving = ref(false)
const units = ref([])
const editRows = ref([])

async function openSettings() {
  try {
    const [uRes, sRes] = await Promise.all([getActivityUnits(''), getActivityStatUnits()])
    units.value = uRes.data?.data || []
    editRows.value = (sRes.data?.data || []).map((r) => ({
      unit_id: r.unit_id ? Number(r.unit_id) : null,
      unit_name: r.unit_name || '',
      team_name: r.team_name || '',
      well_no: r.well_no || '',
    }))
    showSettings.value = true
  } catch (e) { showToast(errMsg(e), 'error') }
}
function onPickUnit(r) {
  const u = units.value.find((x) => Number(x.id) === Number(r.unit_id))
  if (u) r.unit_name = u.unit_name
}
function addRow() {
  editRows.value.push({ unit_id: null, unit_name: '', team_name: '', well_no: '' })
}
async function doSave() {
  const rows = editRows.value
    .filter((r) => String(r.unit_name || '').trim())
    .map((r, i) => ({
      unit_id: r.unit_id || null, seq_no: i + 1,
      unit_name: String(r.unit_name).trim(), team_name: r.team_name || '', well_no: r.well_no || '',
    }))
  if (!rows.length) return showToast('名单不能为空', 'error')
  saving.value = true
  try {
    await saveActivityStatUnits(rows)
    showToast('名单已保存', 'success')
    showSettings.value = false
    await load()
  } catch (e) { showToast(errMsg(e), 'error') }
  saving.value = false
}

async function doExport() {
  if (!month.value) return
  try {
    await exportActivityDashboard(month.value)
    showToast('统计表已导出', 'success')
  } catch (e) { showToast(errMsg(e), 'error') }
}

onMounted(load)
</script>

<style scoped>
.dash-page { display: flex; flex-direction: column; gap: 14px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-section-title { font-size: 20px; font-weight: 700; color: var(--c-text); margin: 0; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 0 0 auto; }
.head-actions .btn { width: auto; flex: 0 0 auto; }
.head-actions .filter-input { width: auto; min-width: 118px; padding: 9px 10px; }
.sub { font-size: 12.5px; color: var(--c-text-3); margin: 6px 0 0; max-width: 760px; line-height: 1.6; }

.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.stat-card { background: var(--c-surface, #fff); border: 1px solid var(--c-border, #E6EAF0); border-radius: 12px; padding: 16px; text-align: center; }
.stat-card.ok { border-color: var(--c-success, #1d9e75); }
.stat-card.warn { border-color: var(--c-warning, #ba7517); }
.stat-num { font-size: 24px; font-weight: 700; color: var(--c-text); }
.stat-lbl { font-size: 12px; color: var(--c-text-3); margin-top: 4px; }

.table-card { padding: 0; overflow: hidden; }
.table-toolbar { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--c-border, #E6EAF0); flex-wrap: wrap; }
.table-title { font-size: 14px; font-weight: 700; color: var(--c-text); }
.blk-meta { font-size: 12px; color: var(--c-text-3); }
.blk-rate { font-size: 12px; color: var(--c-primary, #1D6FB8); font-weight: 600; }
.spacer { flex: 1; }
.table-scroll { overflow-x: auto; }
.stat-table { width: 100%; font-size: 13px; }
.stat-table th, .stat-table td { padding: 8px 10px; border-bottom: 1px solid var(--c-border, #E6EAF0); text-align: center; white-space: nowrap; }
.stat-table th { background: var(--c-surface-2, #f7f8fa); font-weight: 600; color: var(--c-text-2); font-size: 12.5px; }
.stat-table .col-unit { text-align: left; min-width: 220px; white-space: normal; }
.stat-table td.mark { font-weight: 700; font-size: 14px; }
.stat-table td.mark.ok { color: var(--c-success, #1d9e75); }
.stat-table td.mark.miss { background: #fdf5f5; }
.sum-row td { background: var(--c-surface-2, #f7f8fa); font-weight: 600; }
.ok-text { color: var(--c-success, #1d9e75); font-weight: 600; }
.warn-text { color: var(--c-warning, #ba7517); font-weight: 600; }
.empty-cell { text-align: center; color: var(--c-text-3); padding: 30px; font-size: 13px; }

.modal-overlay { position: fixed; inset: 0; background: rgba(10, 19, 34, .55); display: flex; align-items: center; justify-content: center; z-index: 400; padding: 20px; }
.modal { width: 620px; max-width: 100%; max-height: 90vh; overflow-y: auto; background: var(--c-surface, #fff); border-radius: 14px; padding: 22px; }
.modal.wide { width: 900px; }
.modal h3 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0 0 10px; color: var(--c-text); }
.modal-hint { font-size: 12.5px; color: var(--c-text-2); line-height: 1.6; margin: 0 0 14px; }
.form-input { padding: 7px 9px; border: 1px solid var(--c-border, #E6EAF0); border-radius: 8px; font-size: 12.5px; background: var(--c-surface, #fff); color: var(--c-text); width: 100%; box-sizing: border-box; }
.mt4 { margin-top: 4px; }
.settings-scroll { max-height: 52vh; }
.settings-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.action-link { border: none; background: none; color: var(--c-primary, #1D6FB8); font-size: 12.5px; cursor: pointer; padding: 2px 4px; }
.action-link.danger { color: var(--c-danger, #c0392b); }
.toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); background: #1d9e75; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; z-index: 500; }
.toast.error { background: #c0392b; }

@media (max-width: 768px) { .stat-row { grid-template-columns: repeat(2, 1fr); } }
</style>
