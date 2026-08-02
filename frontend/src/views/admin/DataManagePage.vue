<template>
  <div class="data-manage-page">
    <!-- 备份区 -->
    <div class="card">
      <div class="header">
        <h2>数据备份</h2>
      </div>
      <div class="backup-area">
        <button class="btn btn-primary backup-btn" @click="handleBackup" :disabled="backingUp">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
          </svg>
          {{ backingUp ? '备份中…' : '立即备份' }}
        </button>
        <div v-if="lastBackup" class="backup-result">
          <p class="backup-info">✅ 备份文件：<strong>{{ lastBackup.filename }}</strong></p>
          <p class="backup-info">记录数：<strong>{{ lastBackup.count }}</strong> 条</p>
          <p class="backup-info">备份时间：<strong>{{ lastBackup.time }}</strong></p>
        </div>
        <div v-if="backups.length > 0" class="backup-history">
          <h4>历史备份</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th>记录数</th>
                <th>备份时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in backups" :key="b.id || b.filename">
                <td class="mono">{{ b.filename }}</td>
                <td>{{ b.count || '-' }}</td>
                <td class="mono" style="font-size:12px">{{ fmtDate(b.created_at) }}</td>
              </tr>
              <tr v-if="backups.length === 0">
                <td colspan="3" class="empty-cell">暂无备份记录</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 导出区 -->
    <div class="card">
      <div class="header">
        <h2>数据导出</h2>
      </div>

      <!-- 时间范围 -->
      <div class="export-section">
        <div class="range-group">
          <label>时间范围</label>
          <div class="range-btns">
            <button
              v-for="r in RANGE_OPTIONS"
              :key="r.value"
              class="range-btn"
              :class="{ active: exportRange === r.value }"
              @click="onRangeChange(r.value)"
            >{{ r.label }}</button>
          </div>
          <div v-if="exportRange === 'custom'" class="custom-range">
            <label>开始日期</label>
            <input v-model="customStart" type="date" class="form-input date-input" />
            <label>结束日期</label>
            <input v-model="customEnd" type="date" class="form-input date-input" />
          </div>
        </div>

        <!-- 筛选条件 -->
        <div class="filter-group">
          <label>筛选条件</label>
          <div class="filter-grid">
            <div class="filter-item">
              <span class="filter-label">隐患排查项目</span>
              <div class="multi-select" :class="{ open: investigationOpen }" ref="investigationSelectRef">
                <div class="multi-select-trigger" @click="investigationOpen = !investigationOpen">
                  <span v-if="filterInvestigationItem.length === 0" class="placeholder">请选择</span>
                  <span v-else class="selected-text">{{ investigationSelectedText }}</span>
                  <span class="arrow">▼</span>
                </div>
                <div v-if="investigationOpen" class="multi-select-panel">
                  <label class="multi-option all-option">
                    <input type="checkbox" :checked="isAllInvestigationSelected" @change="toggleAllInvestigation">
                    <span>全部</span>
                  </label>
                  <label v-for="o in investigationItemOptions" :key="o.value" class="multi-option">
                    <input type="checkbox" :value="o.value" v-model="filterInvestigationItem">
                    <span>{{ o.label }}</span>
                  </label>
                  <div v-if="investigationItemOptions.length === 0" class="multi-empty">暂无数据</div>
                </div>
              </div>
            </div>
            <div class="filter-item">
              <span class="filter-label">状态</span>
              <select v-model="filterStatus" class="form-input">
                <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <div class="filter-item">
              <span class="filter-label">业务归口</span>
              <select v-model="filterBusinessDept" class="form-input">
                <option v-for="o in businessDeptOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <div class="filter-item">
              <span class="filter-label">整改单位</span>
              <input v-model="filterRectifyUnit" type="text" class="form-input" placeholder="模糊匹配" />
            </div>
            <div class="filter-item">
              <span class="filter-label">位置</span>
              <input v-model="filterLocation" type="text" class="form-input" placeholder="模糊匹配" />
            </div>
            <div class="filter-item">
              <span class="filter-label">隐患等级</span>
              <select v-model="filterLevel" class="form-input">
                <option v-for="o in levelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 字段勾选 -->
        <div class="fields-group">
          <label>导出字段</label>
          <div class="field-grid">
            <label v-for="f in FIELD_OPTIONS" :key="f.value" class="field-checkbox">
              <input type="checkbox" :value="f.value" v-model="selectedFields" />
              <span>{{ f.label }}</span>
            </label>
          </div>
          <div class="field-actions">
            <button class="btn btn-ghost" @click="selectAllFields">全选</button>
            <button class="btn btn-ghost" @click="deselectAllFields">清空</button>
          </div>
        </div>

        <!-- 导出按钮 -->
        <div class="export-actions">
          <button class="btn btn-primary" @click="handleExport('ledger')" :disabled="exporting">
            {{ exporting ? '导出中…' : '导出台账' }}
          </button>
          <button class="btn btn-outline" @click="handleExport('weekly')" :disabled="exporting">
            导出周报
          </button>
          <button class="btn btn-outline" @click="handleExport('monthly')" :disabled="exporting">
            导出月报
          </button>
        </div>
      </div>
    </div>

    <!-- 导入记录 -->
    <div class="card">
      <div class="header">
        <h2>导入记录</h2>
        <button class="btn btn-ghost" @click="loadImportLogs" :disabled="loadingImportLogs">
          {{ loadingImportLogs ? '加载中…' : '刷新' }}
        </button>
      </div>
      <table class="data-table" v-if="importLogs.length">
        <thead>
          <tr>
            <th>文件名</th>
            <th>导入时间</th>
            <th>总数</th>
            <th>成功</th>
            <th>失败/跳过</th>
            <th>明细</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in importLogs" :key="log.id">
            <td class="mono">{{ log.filename }}</td>
            <td class="mono" style="font-size:12px">{{ fmtDate(log.createdAt) }}</td>
            <td>{{ log.totalRows }}</td>
            <td class="ok">{{ log.successRows }}</td>
            <td>{{ log.failRows }}</td>
            <td>
              <button class="action-link" v-if="log.failDetail && log.failDetail.length" @click="toggleLogDetail(log.id)">
                {{ expandedLogId === log.id ? '收起' : '查看(' + log.failDetail.length + ')' }}
              </button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-hint">暂无导入记录</p>

      <div v-for="log in importLogs" :key="'d' + log.id">
        <div v-if="expandedLogId === log.id && log.failDetail && log.failDetail.length" class="log-detail">
          <div v-for="(f, i) in log.failDetail" :key="i" class="log-detail-item">
            [{{ f.sheetName }}] 第 {{ f.rowNo }} 行：{{ f.reason }}
          </div>
        </div>
      </div>
    </div>

    <!-- toast -->
    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { triggerBackup, exportHazards, listBackups, getInvestigationItems } from '@/api/safety'
import { getHazardDict, getImportLogs } from '@/api/hazard'

const RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'this_week', label: '本周' },
  { value: 'this_month', label: '本月' },
  { value: 'custom', label: '自定义' },
]

const FIELD_OPTIONS = [
  { value: 'hazard_code', label: '隐患编号' },
  { value: 'hazard_level', label: '隐患等级' },
  { value: 'location', label: '位置' },
  { value: 'description', label: '问题描述' },
  { value: 'rectify_unit', label: '整改单位' },
  { value: 'unit_name', label: '责任单位' },
  { value: 'hazard_investigation_item', label: '隐患排查项目' },
  { value: 'business_dept', label: '业务归口' },
  { value: 'responsible_person', label: '整改责任人' },
  { value: 'recorder_name', label: '录入人' },
  { value: 'status', label: '状态' },
  { value: 'created_at', label: '上报时间' },
  { value: 'plan_finish_time', label: '计划完成时间' },
  { value: 'closed_at', label: '闭环时间' },
]

// 备份状态
const backingUp = ref(false)
const lastBackup = ref(null)
const backups = ref([])

// 导入记录（t_import_log）
const importLogs = ref([])
const loadingImportLogs = ref(false)
const expandedLogId = ref(null)

// 导出状态
const exportRange = ref('this_week')
const customStart = ref('')
const customEnd = ref('')
const selectedFields = ref(FIELD_OPTIONS.map((f) => f.value))
const exporting = ref(false)

// 导出筛选条件
const filterInvestigationItem = ref([])
const filterStatus = ref('')
const filterBusinessDept = ref('')
const filterRectifyUnit = ref('')
const filterLocation = ref('')
const filterLevel = ref('')
const businessDeptOptions = ref([])
const levelOptions = ref([])
const investigationItemOptions = ref([])
const investigationOpen = ref(false)
const investigationSelectRef = ref(null)
const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'reported', label: '已上报' },
  { value: 'assigned', label: '已分派' },
  { value: 'rectifying', label: '整改中' },
  { value: 'verifying', label: '待验收' },
  { value: 'closed', label: '已闭环' },
]

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}

function fmtDate(v) {
  if (!v) return '-'
  return String(v).slice(0, 16).replace('T', ' ')
}

const investigationSelectedText = computed(() => {
  if (filterInvestigationItem.value.length === 0) return '请选择'
  if (filterInvestigationItem.value.length === investigationItemOptions.value.length) return '全部'
  const names = filterInvestigationItem.value.map((v) =>
    investigationItemOptions.value.find((o) => o.value === v)?.label || v
  )
  return names.join('、')
})

const isAllInvestigationSelected = computed(() => {
  return investigationItemOptions.value.length > 0 && filterInvestigationItem.value.length === investigationItemOptions.value.length
})

function toggleAllInvestigation() {
  if (isAllInvestigationSelected.value) {
    filterInvestigationItem.value = []
  } else {
    filterInvestigationItem.value = investigationItemOptions.value.map((o) => o.value)
  }
}

function onDocumentClick(e) {
  if (investigationSelectRef.value && !investigationSelectRef.value.contains(e.target)) {
    investigationOpen.value = false
  }
}

function getDateRange(range) {
  if (range === 'all') return { all: true }
  const now = new Date()
  let start, end
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()

  if (range === 'this_week') {
    const day = now.getDay() || 7 // Sunday=0 → 7
    const monday = new Date(now)
    monday.setDate(d - day + 1)
    start = fmtDateISO(monday)
    end = fmtDateISO(now)
  } else if (range === 'this_month') {
    start = `${y}-${String(m + 1).padStart(2, '0')}-01`
    end = fmtDateISO(now)
  } else if (range === 'custom') {
    start = customStart.value
    end = customEnd.value
  }
  return { start, end }
}

function fmtDateISO(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function onRangeChange(val) {
  exportRange.value = val
  if (val === 'custom' && !customStart.value) {
    const now = new Date()
    customEnd.value = fmtDateISO(now)
    const start = new Date(now)
    start.setDate(start.getDate() - 30)
    customStart.value = fmtDateISO(start)
  }
}

function selectAllFields() {
  selectedFields.value = FIELD_OPTIONS.map((f) => f.value)
}

function deselectAllFields() {
  selectedFields.value = []
}

// ─── 备份 ──────────────────────────────────────────────────────────
async function handleBackup() {
  backingUp.value = true
  try {
    const res = await triggerBackup()
    const data = res.data?.data || res.data
    const now = new Date()
    lastBackup.value = {
      filename: data.filename || 'unknown',
      count: data.count || 0,
      time: fmtDate(now.toISOString()),
    }
    showToast('备份成功', 'success')
    loadBackups()
  } catch (e) {
    showToast(e.response?.data?.error || '备份失败', 'error')
  } finally {
    backingUp.value = false
  }
}

async function loadBackups() {
  try {
    const res = await listBackups()
    backups.value = res.data?.data?.list || res.data?.data || []
  } catch {
    backups.value = []
  }
}

// ─── 导出 ──────────────────────────────────────────────────────────
async function handleExport(type) {
  const range = getDateRange(exportRange.value)
  if (exportRange.value === 'custom' && (!range.start || !range.end)) {
    return showToast('请选择开始和结束日期', 'error')
  }
  if (selectedFields.value.length === 0) {
    return showToast('请至少选择一个导出字段', 'error')
  }

  exporting.value = true
  try {
    const payload = {
      type,
      fields: [...selectedFields.value],
      range,
      filters: {
        hazard_investigation_item: filterInvestigationItem.value.length ? filterInvestigationItem.value : undefined,
        status: filterStatus.value,
        business_dept: filterBusinessDept.value,
        rectify_unit: filterRectifyUnit.value,
        location: filterLocation.value,
        hazard_level: filterLevel.value,
      },
    }
    const res = await exportHazards(payload)
    // 触发浏览器下载
    const blob = new Blob([res.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const filename = `隐患${type}_${range.start || ''}_${range.end || ''}.xlsx`
    link.setAttribute('download', filename)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
    showToast(`「${type}」导出成功`, 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '导出失败', 'error')
  } finally {
    exporting.value = false
  }
}

async function loadImportLogs() {
  loadingImportLogs.value = true
  try {
    const res = await getImportLogs()
    importLogs.value = res.data?.data?.list || []
  } catch {
    importLogs.value = []
  } finally {
    loadingImportLogs.value = false
  }
}

function toggleLogDetail(id) {
  expandedLogId.value = expandedLogId.value === id ? null : id
}

onMounted(() => {
  loadBackups()
  loadDictOptions()
  loadImportLogs()
  document.addEventListener('click', onDocumentClick)
  // 默认本周
  const now = new Date()
  customEnd.value = fmtDateISO(now)
  const start = new Date(now)
  start.setDate(start.getDate() - 30)
  customStart.value = fmtDateISO(start)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})

// 加载筛选下拉字典（业务归口 / 隐患等级 / 隐患排查项目）
async function loadDictOptions() {
  try {
    const [biz, lvl, itemRes] = await Promise.all([
      getHazardDict('business_dept'),
      getHazardDict('level'),
      getInvestigationItems(),
    ])
    const bizList = biz?.data?.data?.list || biz?.data?.data || []
    const lvlList = lvl?.data?.data?.list || lvl?.data?.data || []
    // /api/data/investigation-items 返回 { data: { list: [...] } }
    const itemList = itemRes?.data?.data?.list || itemRes?.data?.data || []
    businessDeptOptions.value = [{ value: '', label: '全部' }, ...bizList.map((d) => ({ value: d.code || d.name, label: d.name }))]
    levelOptions.value = [{ value: '', label: '全部' }, ...lvlList.map((d) => ({ value: d.code || d.name, label: d.name }))]
    investigationItemOptions.value = itemList.map((name) => ({ value: name, label: name }))
  } catch {
    businessDeptOptions.value = [{ value: '', label: '全部' }]
    levelOptions.value = [{ value: '', label: '全部' }]
    investigationItemOptions.value = []
  }
}
</script>

<style scoped>
.data-manage-page { max-width: 960px; }

.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header h2 { font-size: 18px; font-weight: 700; color: var(--c-text); }

.backup-area { padding: 4px 0; }
.backup-btn { min-width: 180px; }
.backup-result {
  margin-top: 16px; padding: 16px; background: var(--c-success-bg);
  border-radius: var(--r); line-height: 1.8;
}
.backup-info { font-size: 14px; color: var(--c-text); }

.backup-history { margin-top: 20px; }
.backup-history h4 { font-size: 15px; font-weight: 600; margin-bottom: 10px; color: var(--c-text); }

.export-section { padding: 4px 0; }

.range-group { margin-bottom: 20px; }
.range-group > label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 8px; }

.filter-group { margin-bottom: 20px; }
.filter-group > label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 8px; }
.filter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.filter-item { display: flex; flex-direction: column; gap: 4px; }
.filter-label { font-size: 12px; color: var(--c-text-2); }
.filter-item .form-input { width: 100%; }

.range-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.range-btn {
  padding: 8px 18px; border: 1px solid var(--c-border-strong); border-radius: 999px;
  background: var(--c-surface); color: var(--c-text-2); cursor: pointer;
  font-size: 13px; font-weight: 500; transition: all .15s ease;
}
.range-btn:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.range-btn.active { background: var(--c-blue-600); border-color: var(--c-blue-600); color: #fff; }

.custom-range {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px; background: var(--c-surface-2); border-radius: var(--r);
}
.custom-range label { font-size: 13px; color: var(--c-text-2); }
.date-input { width: 160px; }

.fields-group { margin-bottom: 20px; }
.fields-group > label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 8px; }

.field-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px; margin-bottom: 8px;
}
.field-checkbox {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--c-text); cursor: pointer; padding: 4px 0;
}
.field-checkbox input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }

.field-actions { display: flex; gap: 8px; }
.field-actions .btn { width: auto; font-size: 12px; padding: 6px 14px; }

.export-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.export-actions .btn { width: auto; min-width: 140px; }

.toast {
  position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
  z-index: 2000; padding: 12px 20px; border-radius: 12px;
  font-size: 14px; font-weight: 600; color: #fff;
  box-shadow: var(--shadow-lg); max-width: 90vw;
}
.toast.success { background: var(--c-success); }
.toast.error { background: var(--c-danger); }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, -12px); }

.empty-hint { font-size: 13px; color: var(--c-text-2); padding: 12px 0; }
.muted { color: var(--c-text-2); }
.ok { color: var(--c-success); font-weight: 600; }
.log-detail { margin: 8px 0 18px; padding: 10px 12px; background: #f8f9fa; border: 1px solid var(--c-border); border-radius: 8px; }
.log-detail-item { font-size: 12px; line-height: 1.9; color: var(--c-text-2); }

/* 多选下拉 */
.multi-select { position: relative; }
.multi-select-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; min-height: 36px; padding: 7px 10px;
  border: 1px solid var(--c-border-strong); border-radius: var(--r);
  background: var(--c-surface); color: var(--c-text); font-size: 13px;
  cursor: pointer; transition: border-color .15s ease;
}
.multi-select-trigger:hover { border-color: var(--c-blue-600); }
.multi-select.open .multi-select-trigger { border-color: var(--c-blue-600); }
.multi-select-trigger .placeholder { color: var(--c-text-3); }
.multi-select-trigger .selected-text {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.multi-select-trigger .arrow { font-size: 10px; color: var(--c-text-3); transition: transform .15s ease; }
.multi-select.open .arrow { transform: rotate(180deg); }
.multi-select-panel {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 100;
  max-height: 220px; overflow-y: auto;
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r);
  box-shadow: var(--shadow-lg); padding: 6px 0;
}
.multi-option {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; font-size: 13px; color: var(--c-text);
  cursor: pointer; transition: background .12s ease;
}
.multi-option:hover { background: var(--c-blue-50); }
.multi-option input[type="checkbox"] { width: 15px; height: 15px; flex-shrink: 0; cursor: pointer; }
.multi-option.all-option { font-weight: 600; border-bottom: 1px solid var(--c-border); margin-bottom: 4px; padding-bottom: 10px; }
.multi-empty { padding: 12px; font-size: 12px; color: var(--c-text-3); text-align: center; }
</style>
