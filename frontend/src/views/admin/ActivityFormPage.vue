<template>
  <div class="activity-page">
    <div class="page-head">
      <div>
        <h2 class="page-section-title">{{ cfg.title }}</h2>
        <p class="sub">{{ cfg.desc }}</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-outline" @click="openSubmitEntry"><Icon name="file" :size="16" /> 打开填报入口</button>
        <button class="btn btn-outline" :disabled="!currentId" @click="exportSummary"><Icon name="download" :size="16" /> 导出汇总</button>
        <button class="btn btn-primary" @click="openCreate"><Icon name="plus" :size="16" /> 新建期次</button>
      </div>
    </div>

    <div class="card period-bar">
      <label class="lbl">当前期次</label>
      <select v-model="currentId" class="filter-input" @change="loadAll">
        <option value="">请选择期次</option>
        <option v-for="p in periods" :key="p.id" :value="p.id">{{ p.title }}{{ p.activity_date ? '（' + fmtDate(p.activity_date) + '）' : '' }}</option>
      </select>
      <span v-if="current" class="period-meta">
        状态：<b :class="current.status === 'open' ? 'st-open' : 'st-closed'">{{ current.status === 'open' ? '进行中' : '已关闭' }}</b>
      </span>
      <button v-if="current" class="btn-ghost" @click="toggleClose">{{ current.status === 'open' ? '关闭期次' : '重新开启' }}</button>
      <button v-if="current" class="btn-ghost danger" @click="removePeriod">删除期次</button>
      <span class="spacer"></span>
      <span class="total-count">共 {{ periods.length }} 个期次</span>
    </div>

    <div v-if="current" class="stat-row">
      <div class="stat-card"><div class="stat-num">{{ detail.stats?.expected || 0 }}</div><div class="stat-lbl">应报单位</div></div>
      <div class="stat-card ok"><div class="stat-num">{{ detail.stats?.reportedCount || 0 }}</div><div class="stat-lbl">已报单位</div></div>
      <div class="stat-card warn"><div class="stat-num">{{ detail.stats?.unreportedCount || 0 }}</div><div class="stat-lbl">未报单位</div></div>
      <div class="stat-card"><div class="stat-num">{{ detail.stats?.fileTotal || 0 }}</div><div class="stat-lbl">附件总数</div></div>
    </div>

    <div class="card table-card">
      <div class="table-toolbar">
        <input v-model="keyword" class="filter-input" placeholder="搜索单位 / 上报人…" @input="filterRecords" />
        <span class="table-title">已上报台账</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>承包商单位</th><th>二级板块</th><th>网格层级</th>
              <th>上报人</th><th>联系电话</th><th>上报时间</th><th>附件</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="8" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td></tr>
            <tr v-else-if="!filteredRecords.length"><td colspan="8" class="empty-cell">本期暂无单位上报，可复制「承包商填报入口」发给各承包商</td></tr>
            <tr v-for="r in filteredRecords" :key="r.id">
              <td><strong>{{ r.unit_name }}</strong></td>
              <td>{{ r.grid_l2 || '-' }}</td>
              <td>{{ r.grid_level || '-' }}</td>
              <td>{{ r.uploader_name || '-' }}</td>
              <td>{{ r.uploader_phone || '-' }}</td>
              <td>{{ r.submitted_at ? fmtDT(r.submitted_at) : '-' }}</td>
              <td>{{ r.file_count || 0 }}</td>
              <td class="op-cell">
                <button class="action-link" @click="openDetail(r)"><Icon name="search" :size="14" /> 查看</button>
                <button class="action-link danger" @click="removeRecord(r)"><Icon name="trash" :size="14" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="current && detail.stats?.unreported?.length" class="card unreported-card">
      <div class="unreported-head" @click="showUnreported = !showUnreported">
        <Icon name="alert" :size="16" />
        <strong>未上报单位（{{ detail.stats.unreported.length }}）</strong>
        <span>{{ showUnreported ? '收起' : '展开查看' }}</span>
      </div>
      <div v-if="showUnreported" class="unreported-list">
        <span v-for="u in detail.stats.unreported" :key="u.id" class="unit-chip">{{ u.unit_name }}<em>{{ u.grid_l2 || '' }}</em></span>
      </div>
    </div>

    <!-- 新建期次 -->
    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h3><Icon name="plus" :size="19" /> 新建{{ cfg.title }}期次</h3>
        <p class="modal-hint">期次即一次活动（如 2026.11.2 周一 HSE 活动）。创建后把「承包商填报入口」发给各承包商，单位下拉自动取自「承包商准入 → 网格化管理」四级网格。</p>
        <div class="form-grid">
          <div class="form-group"><label>期次名称 <i>*</i></label><input v-model="createForm.title" class="form-input" :placeholder="cfg.titlePlaceholder" /></div>
          <div class="form-group"><label>活动日期</label><input v-model="createForm.activity_date" type="date" class="form-input" /></div>
          <div class="form-group full"><label>活动说明 / 要求</label><textarea v-model="createForm.description" class="form-input" rows="2" placeholder="选填，如：请各队按 HSE 活动记录模板填写并附签到表、照片"></textarea></div>
          <div class="form-group full">
            <label>应报单位范围</label>
            <div class="unit-scope">
              <label class="radio-line"><input type="radio" v-model="scopeMode" value="all" /> 全部在册单位（默认）</label>
              <label class="radio-line"><input type="radio" v-model="scopeMode" value="part" /> 指定单位</label>
            </div>
            <div v-if="scopeMode === 'part'" class="scope-box">
              <input v-model="unitKeyword" class="form-input" placeholder="搜索单位" @input="loadUnits" />
              <div class="scope-checks">
                <label v-for="u in units" :key="u.id" class="check-line">
                  <input type="checkbox" :value="u.id" v-model="scopeIds" /> {{ u.unit_name }} <em>{{ u.grid_l2 }}</em>
                </label>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showCreate = false">取消</button>
          <button class="btn btn-primary" :disabled="creating" @click="doCreate">{{ creating ? '创建中…' : '确认创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="showDetail" class="modal-overlay" @click.self="showDetail = false">
      <div class="modal wide">
        <h3><Icon name="clipboard" :size="19" /> {{ detail.record?.unit_name }} · {{ cfg.title }}记录</h3>
        <p class="modal-hint">上报人 {{ detail.record?.uploader_name || '-' }} / {{ detail.record?.uploader_phone || '-' }} · {{ detail.record?.submitted_at ? fmtDT(detail.record.submitted_at) : '' }}</p>
        <div class="detail-grid">
          <div v-for="f in cfg.fields" :key="f.key" class="detail-item" :class="{ full: f.wide }">
            <label>{{ f.label }}</label>
            <div class="detail-value">{{ detail.record?.form?.[f.key] || '—' }}</div>
          </div>
        </div>
        <div v-if="detail.files?.length" class="detail-files">
          <h4>附件（{{ detail.files.length }}）</h4>
          <a v-for="f in detail.files" :key="f.id" :href="f.cos_url" target="_blank" rel="noopener" class="file-link">
            <Icon name="file" :size="14" /> {{ f.category }}：{{ f.original_name }}
          </a>
        </div>
        <div class="modal-actions"><button class="btn btn-outline" @click="showDetail = false">关闭</button></div>
      </div>
    </div>

    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { fmtDT, fmtDate } from '@/utils/datetime'
import { openActivitySubmit } from '@/utils/activityLink'
import {
  getActivityPeriods, getActivityPeriod, createActivityPeriod, updateActivityPeriod,
  deleteActivityPeriod, getActivityUnits, getActivityRecord, deleteActivityRecord,
  exportPeriodSummary,
} from '@/api/activity'

const route = useRoute()
const periodType = computed(() => route.meta.periodType || 'monday')

const CONFIG = {
  monday: {
    title: '周一安全活动',
    desc: '按「HSE 活动（会议）记录」模板结构化填报，含签到表、照片、隐患整改通知单等附件',
    titlePlaceholder: '如：2026.11.2 周一 HSE 活动',
    fields: [
      { key: 'activity_time', label: '活动时间' },
      { key: 'location', label: '活动地点' },
      { key: 'activity_name', label: '会议（活动）名称' },
      { key: 'host', label: '主持人' },
      { key: 'main_content', label: '会议（活动）主要内容', wide: true },
      { key: 'attendees', label: '参加人员', wide: true },
      { key: 'hse_meeting', label: '（一）周一 HSE 例会', wide: true },
      { key: 'training', label: '培训学习情况', wide: true },
      { key: 'hazard_check', label: '隐患排查情况', wide: true },
      { key: 'drill', label: '应急演练情况', wide: true },
      { key: 'next_plan', label: '二、下步重点工作安排', wide: true },
      { key: 'remark', label: '备注', wide: true },
    ],
    categories: ['签到表', '参会人照片', 'HSE隐患整改通知单', '检查问题汇总', '其他附件'],
  },
  wednesday: {
    title: '周三学习活动',
    desc: '按「周三安全培训教育主题活动」模板结构化填报，含学习内容与学习照片',
    titlePlaceholder: '如：2026.11.4 周三安全培训教育主题活动',
    fields: [
      { key: 'study_time', label: '学习时间' },
      { key: 'location', label: '学习地点' },
      { key: 'host', label: '主持人' },
      { key: 'study_content', label: '学习内容', wide: true },
      { key: 'study_detail', label: '学习具体内容', wide: true },
      { key: 'attendees', label: '参加人员', wide: true },
      { key: 'remark', label: '备注', wide: true },
    ],
    categories: ['学习材料', '学习照片', '其他附件'],
  },
}
const cfg = computed(() => CONFIG[periodType.value] || CONFIG.monday)

const periods = ref([])
const currentId = ref('')
const current = ref(null)
const detail = reactive({ stats: {}, record: null, files: [] })
const records = ref([])
const keyword = ref('')
const loading = ref(false)
const showUnreported = ref(false)

const showCreate = ref(false)
const creating = ref(false)
const scopeMode = ref('all')
const scopeIds = ref([])
const unitKeyword = ref('')
const units = ref([])
const createForm = reactive({ title: '', activity_date: '', description: '' })

const showDetail = ref(false)
const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg; toast.type = type; toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}
function errMsg(e) { return e.response?.data?.error || e.message || '操作失败' }

const filteredRecords = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return records.value
  return records.value.filter((r) =>
    [r.unit_name, r.uploader_name, r.uploader_phone, r.grid_l2].some((v) => String(v || '').toLowerCase().includes(k)))
})
function filterRecords() { /* computed 自动 */ }

async function loadPeriods() {
  const res = await getActivityPeriods({ type: periodType.value })
  periods.value = res.data?.data || []
  if (!periods.value.some((p) => String(p.id) === String(currentId.value))) {
    currentId.value = periods.value.length ? periods.value[0].id : ''
  }
}
async function loadAll() {
  if (!currentId.value) { current.value = null; records.value = []; detail.stats = {}; return }
  loading.value = true
  try {
    const [pRes, rRes] = await Promise.all([
      getActivityPeriod(currentId.value),
      getActivityRecords({ period_id: currentId.value }),
    ])
    const d = pRes.data?.data || {}
    current.value = d
    detail.stats = d.stats || {}
    records.value = rRes.data?.data || []
  } catch (e) { showToast(errMsg(e), 'error') }
  loading.value = false
}

async function loadUnits() {
  try {
    const res = await getActivityUnits(unitKeyword.value)
    units.value = res.data?.data || []
  } catch (e) { showToast(errMsg(e), 'error') }
}

function openCreate() {
  const d = new Date()
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  createForm.title = `${local} ${cfg.value.title}`
  createForm.activity_date = local
  createForm.description = ''
  scopeMode.value = 'all'; scopeIds.value = []; unitKeyword.value = ''
  showCreate.value = true
  loadUnits()
}
async function doCreate() {
  if (!createForm.title.trim()) return showToast('请填写期次名称', 'error')
  creating.value = true
  try {
    const form = new FormData()
    form.append('period_type', periodType.value)
    form.append('title', createForm.title.trim())
    form.append('activity_date', createForm.activity_date || '')
    form.append('description', createForm.description || '')
    form.append('remind_days', '3')
    form.append('expected_unit_ids', JSON.stringify(scopeMode.value === 'part' ? scopeIds.value.map(Number) : []))
    await createActivityPeriod(form)
    showToast('期次已创建', 'success')
    showCreate.value = false
    await loadPeriods()
    await loadAll()
  } catch (e) { showToast(errMsg(e), 'error') }
  creating.value = false
}
async function toggleClose() {
  try {
    await updateActivityPeriod(current.value.id, { status: current.value.status === 'open' ? 'closed' : 'open' })
    showToast('状态已更新', 'success')
    await loadPeriods(); await loadAll()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function removePeriod() {
  if (!confirm(`确认删除期次「${current.value.title}」？该期次下所有上报记录、附件将一并删除，不可恢复。`)) return
  try {
    await deleteActivityPeriod(current.value.id)
    showToast('期次已删除', 'success')
    currentId.value = ''
    await loadPeriods(); await loadAll()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function openDetail(r) {
  try {
    const res = await getActivityRecord(r.id)
    const d = res.data?.data || {}
    detail.record = d.record || null
    detail.files = d.files || []
    showDetail.value = true
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function removeRecord(r) {
  if (!confirm(`确认删除「${r.unit_name}」的上报记录？`)) return
  try {
    await deleteActivityRecord(r.id)
    showToast('已删除', 'success')
    await loadAll()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function exportSummary() {
  try {
    await exportPeriodSummary(current.value.id, current.value.title, periodType.value)
    showToast('汇总表已导出', 'success')
  } catch (e) { showToast(errMsg(e), 'error') }
}
function openSubmitEntry() {
  const { url, opened } = openActivitySubmit()
  if (opened) showToast(`已打开填报入口（新窗口）：${url}`, 'success')
  else showToast(`填报入口：${url}（浏览器拦截了新窗口，请手动复制打开）`, 'error')
}

watch(periodType, async () => {
  currentId.value = ''
  await loadPeriods(); await loadAll()
})
onMounted(async () => { await loadPeriods(); await loadAll() })
</script>

<style scoped>
.activity-page { display: flex; flex-direction: column; gap: 16px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-section-title { font-size: 20px; font-weight: 600; color: var(--c-text); margin: 0; }
.sub { font-size: 13px; color: var(--c-text-2); margin: 5px 0 0; }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg, 12px); }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-text); }
.btn:hover { border-color: var(--c-primary); }
.btn-primary { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.btn-outline { background: transparent; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-ghost { border: none; background: none; color: var(--c-primary); cursor: pointer; font-size: 13px; padding: 4px 6px; }
.btn-ghost.danger { color: var(--c-danger, #e24b4a); }

.period-bar { display: flex; align-items: center; gap: 12px; padding: 14px 16px; flex-wrap: wrap; }
.lbl { font-size: 13px; color: var(--c-text-2); }
.filter-input { padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 8px; font-size: 13px; background: var(--c-surface); color: var(--c-text); min-width: 180px; }
.period-meta { font-size: 12.5px; color: var(--c-text-2); }
.st-open { color: var(--c-success, #1d9e75); }
.st-closed { color: var(--c-text-3); }
.spacer { flex: 1; }
.total-count { font-size: 12.5px; color: var(--c-text-3); }

.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat-card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 12px; padding: 16px; text-align: center; }
.stat-card.ok { border-color: var(--c-success, #1d9e75); }
.stat-card.warn { border-color: var(--c-warning, #ba7517); }
.stat-num { font-size: 26px; font-weight: 700; color: var(--c-text); font-variant-numeric: tabular-nums; }
.stat-lbl { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }

.table-card { overflow: hidden; }
.table-toolbar { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--c-border); }
.table-title { font-size: 14px; font-weight: 600; color: var(--c-text); }
.table-scroll { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
.data-table th { background: var(--c-surface-2, #f7f8fa); color: var(--c-text-2); font-weight: 600; }
.data-table td { color: var(--c-text); }
.empty-cell { text-align: center; color: var(--c-text-3); padding: 30px !important; }
.op-cell { white-space: nowrap; }
.action-link { border: none; background: none; color: var(--c-primary); cursor: pointer; font-size: 12.5px; display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px; }
.action-link.danger { color: var(--c-danger, #e24b4a); }
.spinner { width: 22px; height: 22px; border: 2px solid var(--c-border); border-top-color: var(--c-primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.unreported-card { padding: 14px 16px; }
.unreported-head { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--c-warning, #ba7517); }
.unreported-head span { margin-left: auto; color: var(--c-text-3); font-size: 12px; }
.unreported-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.unit-chip { font-size: 12px; padding: 5px 10px; border-radius: 6px; background: var(--c-surface-2, #f7f8fa); border: 1px solid var(--c-border); color: var(--c-text); }
.unit-chip em { font-style: normal; color: var(--c-text-3); margin-left: 6px; font-size: 11px; }

.modal-overlay { position: fixed; inset: 0; background: rgba(10, 19, 34, .55); display: flex; align-items: center; justify-content: center; z-index: 400; padding: 20px; }
.modal { width: 560px; max-width: 100%; max-height: 90vh; overflow-y: auto; background: var(--c-surface); border-radius: 14px; padding: 22px; }
.modal.wide { width: 760px; }
.modal h3 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0 0 10px; color: var(--c-text); }
.modal-hint { font-size: 12.5px; color: var(--c-text-2); line-height: 1.6; margin: 0 0 16px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 5px; }
.form-group.full { grid-column: 1 / -1; }
.form-group label { font-size: 12.5px; color: var(--c-text-2); }
.form-group label i { color: var(--c-danger, #e24b4a); font-style: normal; }
.form-input { padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 8px; font-size: 13px; background: var(--c-surface); color: var(--c-text); font-family: inherit; }
.unit-scope { display: flex; gap: 16px; flex-wrap: wrap; }
.radio-line, .check-line { font-size: 12.5px; color: var(--c-text); display: inline-flex; align-items: center; gap: 5px; }
.scope-box { border: 1px solid var(--c-border); border-radius: 8px; padding: 10px; margin-top: 6px; }
.scope-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 180px; overflow-y: auto; margin-top: 8px; }
.check-line em { font-style: normal; color: var(--c-text-3); font-size: 11px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.detail-item.full { grid-column: 1 / -1; }
.detail-item label { font-size: 12px; color: var(--c-text-3); display: block; margin-bottom: 4px; }
.detail-value { font-size: 13px; color: var(--c-text); line-height: 1.6; white-space: pre-wrap; padding: 8px 10px; background: var(--c-surface-2, #f7f8fa); border-radius: 8px; min-height: 34px; }
.detail-files { margin-top: 16px; }
.detail-files h4 { font-size: 13px; margin: 0 0 8px; color: var(--c-text); }
.file-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--c-primary); text-decoration: none; margin: 0 12px 8px 0; }
.toast { position: fixed; top: 24px; right: 24px; z-index: 500; padding: 11px 18px; border-radius: 9px; font-size: 13px; background: var(--c-success, #1d9e75); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.toast.error { background: var(--c-danger, #e24b4a); }
@media (max-width: 768px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .form-grid, .detail-grid, .scope-checks { grid-template-columns: 1fr; } }
</style>
