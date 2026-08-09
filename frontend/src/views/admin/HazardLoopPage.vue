<template>
  <div class="hazard-loop-page">
    <div class="card">
      <h2 class="page-section-title">隐患闭环</h2>
      <p class="sub">隐患从上报到闭环的全流程状态跟踪</p>

      <!-- 状态流程条 -->
      <div class="status-flow">
        <template v-for="(s, i) in statusFlow" :key="s.key">
          <div class="flow-step done">
            <span class="step-icon"><Icon :name="s.icon" :size="22" /></span>
            <div class="step-text">
              <div class="step-label">{{ s.label }}</div>
              <div class="step-en">{{ s.en }}</div>
            </div>
          </div>
          <span v-if="i < statusFlow.length - 1" class="step-connector"><Icon name="chevronRight" :size="18" /></span>
        </template>
      </div>

      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="search-wrap">
          <input v-model="filters.keyword" class="filter-input" placeholder="搜索单位 / 分类 / 责任人…" @input="onFilterChange" />
          <select v-model="filters.unit_name" class="filter-input" @change="onFilterChange">
            <option value="">全部单位</option>
            <option v-for="u in units" :key="u.value" :value="u.value">{{ u.label }}</option>
          </select>
          <select v-model="filters.level" class="filter-input" @change="onFilterChange">
            <option value="">全部等级</option>
            <option v-for="l in levels" :key="l.code" :value="l.name">{{ l.name }}</option>
          </select>
          <div class="multi-select" :class="{ open: investigationOpen }" ref="investigationSelectRef">
            <div class="multi-select-trigger" @click="investigationOpen = !investigationOpen">
              <span v-if="filters.investigationItems.length === 0" class="placeholder">隐患项目</span>
              <span v-else class="selected-text">{{ investigationSelectedText }}</span>
              <span class="arrow">▼</span>
            </div>
            <div v-if="investigationOpen" class="multi-select-panel">
              <label class="multi-option all-option">
                <input type="checkbox" :checked="isAllInvestigationSelected" @change="toggleAllInvestigation" />
                <span>全部</span>
              </label>
              <label v-for="o in investigationItemOptions" :key="o.value" class="multi-option">
                <input type="checkbox" :value="o.value" v-model="filters.investigationItems" @change="onFilterChange" />
                <span>{{ o.label }}</span>
              </label>
              <div v-if="investigationItemOptions.length === 0" class="multi-empty">暂无数据</div>
            </div>
          </div>
        </div>
        <div class="toolbar-right">
          <span class="total-count">共 {{ total }} 条</span>
          <button class="btn btn-danger" :disabled="!selectedIds.length || deleting" @click="handleBatchDelete">
            <Icon name="trash" :size="16" /> 批量删除
          </button>
          <button class="btn btn-danger" :disabled="!selectedIds.length || notifying" @click="handleOverdueNotify">
            <Icon name="alert" :size="16" /> 触发超期通知
          </button>
        </div>
      </div>

      <!-- 状态 Tab -->
      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ active: activeTab === t.key }"
          @click="onTabChange(t.key)"
        >
          {{ t.label }}
          <span class="tab-count" :class="{ danger: t.key === 'overdue' && tabCount(t.key) > 0 }">{{ tabCount(t.key) }}</span>
        </button>
      </div>

      <!-- 表格 -->
      <div class="table-card">
        <table class="data-table">
          <colgroup>
            <col class="c-check" />
            <col class="c-code" />
            <col class="c-invest" />
            <col class="c-unit" />
            <col class="c-dept" />
            <col class="c-bizhead" />
            <col class="c-loc" />
            <col class="c-desc" />
            <col class="c-remark" />
            <col class="c-level" />
            <col class="c-person" />
            <col class="c-plan" />
            <col class="c-status" />
            <col class="c-action" />
          </colgroup>
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" :checked="allSelectedOnPage" @change="toggleSelectAll" />
              </th>
              <th>编号</th>
              <th>隐患排查项目</th>
              <th>责任单位</th>
              <th>业务归口</th>
              <th>业务部门负责人</th>
              <th>场所</th>
              <th>问题描述</th>
              <th>备注</th>
              <th>等级</th>
              <th>责任人</th>
              <th>计划完成</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="14" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="14" class="empty-cell">暂无隐患数据</td>
            </tr>
            <tr
              v-for="h in list"
              :key="h.id"
              :class="{ 'overdue-row': h.is_overdue }"
              @click="openDetail(h)"
            >
              <td class="col-check" @click.stop>
                <input type="checkbox" :checked="isSelected(h.id)" @change="toggleSelect(h.id)" />
              </td>
              <td class="mono">{{ h.hazard_code }}</td>
              <td>{{ h.hazard_investigation_item || '-' }}</td>
              <td>{{ h.unit_name || '-' }}</td>
              <td>{{ h.business_dept || '-' }}</td>
              <td>{{ h.business_dept_head || '-' }}</td>
              <td>{{ h.location || '-' }}</td>
              <td class="desc-cell" :title="h.description">{{ h.description || '-' }}</td>
              <td class="desc-cell" :title="h.remark">{{ h.remark || '-' }}</td>
              <td><span :class="['badge', levelBadge(h.hazard_level)]">{{ h.hazard_level || '-' }}</span></td>
              <td>{{ h.responsible_person || '-' }}</td>
              <td class="mono sm">{{ fmtDate(h.plan_finish_time) }}</td>
              <td>
                <span :class="['badge', statusBadge(h.status)]">{{ statusLabel(h.status) }}</span>
                <span v-if="h.is_overdue" class="badge badge-danger" style="margin-left:6px">超期</span>
              </td>
              <td>
                <button class="action-link" @click.stop="openDetail(h)">查看</button>
                <button class="action-link" @click.stop="openEdit(h)">编辑</button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="pagination" v-if="totalPages > 1">
          <button class="pg-btn" :disabled="page === 1" @click="page--">‹</button>
          <span class="pg-info">{{ page }} / {{ totalPages }}</span>
          <button class="pg-btn" :disabled="page === totalPages" @click="page++">›</button>
        </div>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <HazardDetailDrawer
      :show="showDetail"
      :hazard="detail"
      @close="showDetail = false"
      @updated="onDrawerUpdated"
    />

    <!-- 编辑抽屉（按需动态加载） -->
    <component
      v-if="editDrawerComp"
      :is="editDrawerComp"
      :show="showEdit"
      :hazard-id="editId"
      @close="showEdit = false"
      @updated="onEditUpdated"
    />

    <!-- toast -->
    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import HazardDetailDrawer from '@/views/admin/components/HazardDetailDrawer.vue'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'
import {
  getHazards,
  getHazardDetail,
  getHazardDict,
  getContractorUnits,
  getHazardsUnitNames,
  triggerOverdueNotify,
  deleteHazards,
} from '@/api/hazard'
import { getInvestigationItems } from '@/api/safety'

const statusFlow = [
  { key: 'reported', label: '已上报', en: 'Reported', icon: 'hazard' },
  { key: 'assigned', label: '已分派', en: 'Assigned', icon: 'users' },
  { key: 'rectifying', label: '整改中', en: 'Rectifying', icon: 'settings' },
  { key: 'verifying', label: '待验收', en: 'Verifying', icon: 'check' },
  { key: 'closed', label: '已闭环', en: 'Closed', icon: 'shield' },
]

const tabs = [
  { key: 'all', label: '全部' },
  { key: 'reported', label: '已上报' },
  { key: 'assigned', label: '已分派' },
  { key: 'rectifying', label: '整改中' },
  { key: 'verifying', label: '待验收' },
  { key: 'closed', label: '已闭环' },
  { key: 'overdue', label: '超期' },
]

const activeTab = ref('all')
const filters = reactive({ keyword: '', unit_name: '', level: '', investigationItems: [] })
const page = ref(1)
const pageSize = 15

const list = ref([])
const total = ref(0)
const summary = ref({ byStatus: {}, overdue: 0 })
const loading = ref(false)
const units = ref([])
const levels = ref([])
const investigationItemOptions = ref([])
const investigationOpen = ref(false)
const investigationSelectRef = ref(null)

const selectedIds = ref([])
const notifying = ref(false)
const deleting = ref(false)

const showDetail = ref(false)
const detail = ref(null)

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

function tabCount(key) {
  const s = summary.value
  if (!s) return 0
  if (key === 'all') return Object.values(s.byStatus || {}).reduce((a, b) => a + (b || 0), 0)
  if (key === 'overdue') return s.overdue || 0
  return (s.byStatus && s.byStatus[key]) || 0
}

function fmtDate(v) {
  if (!v) return '-'
  return String(v).slice(0, 16).replace('T', ' ')
}

function buildParams() {
  const p = { page: page.value, pageSize }
  if (filters.unit_name) p.unit_name = filters.unit_name
  if (filters.level) p.level = filters.level
  if (filters.investigationItems.length) p.hazard_investigation_item = filters.investigationItems.join(',')
  const kw = filters.keyword.trim()
  if (kw) p.keyword = kw
  if (activeTab.value === 'overdue') p.is_overdue = '1'
  else if (activeTab.value !== 'all') p.status = activeTab.value
  return p
}

const investigationSelectedText = computed(() => {
  if (filters.investigationItems.length === 0) return '隐患项目'
  if (filters.investigationItems.length === investigationItemOptions.value.length) return '全部'
  const names = filters.investigationItems.map((v) =>
    investigationItemOptions.value.find((o) => o.value === v)?.label || v
  )
  return names.join('、')
})

const isAllInvestigationSelected = computed(() => {
  return (
    investigationItemOptions.value.length > 0 &&
    filters.investigationItems.length === investigationItemOptions.value.length
  )
})

function toggleAllInvestigation() {
  if (isAllInvestigationSelected.value) {
    filters.investigationItems = []
  } else {
    filters.investigationItems = investigationItemOptions.value.map((o) => o.value)
  }
  onFilterChange()
}

function onDocumentClick(e) {
  if (investigationSelectRef.value && !investigationSelectRef.value.contains(e.target)) {
    investigationOpen.value = false
  }
}

async function fetchList() {
  loading.value = true
  try {
    const res = await getHazards(buildParams())
    const d = res.data?.data
    list.value = d?.list || []
    total.value = d?.total || 0
    summary.value = d?.summary || { byStatus: {}, overdue: 0 }
    selectedIds.value = selectedIds.value.filter((id) => list.value.some((h) => h.id === id))
  } catch (e) {
    list.value = []
    total.value = 0
    summary.value = { byStatus: {}, overdue: 0 }
  } finally {
    loading.value = false
  }
}

function onTabChange(key) {
  activeTab.value = key
  page.value = 1
  fetchList()
}
function onFilterChange() {
  page.value = 1
  fetchList()
}
watch(page, fetchList)

// 选择
function isSelected(id) { return selectedIds.value.includes(id) }
function toggleSelect(id) {
  const i = selectedIds.value.indexOf(id)
  if (i >= 0) selectedIds.value.splice(i, 1)
  else selectedIds.value.push(id)
}
const allSelectedOnPage = computed(
  () => list.value.length > 0 && list.value.every((h) => isSelected(h.id))
)
function toggleSelectAll() {
  if (allSelectedOnPage.value) selectedIds.value = []
  else selectedIds.value = list.value.map((h) => h.id)
}

// 详情抽屉
async function openDetail(h) {
  try {
    const res = await getHazardDetail(h.id)
    detail.value = res.data?.data || null
    showDetail.value = true
  } catch (e) {
    showToast(e.response?.data?.error || '详情加载失败', 'error')
  }
}
async function onDrawerUpdated(id) {
  try {
    const res = await getHazardDetail(id)
    detail.value = res.data?.data || null
  } catch { /* 忽略 */ }
  fetchList()
}

// 编辑抽屉（动态 import，首次打开时加载组件）
const showEdit = ref(false)
const editId = ref(null)
const editDrawerComp = ref(null)
async function openEdit(h) {
  if (!editDrawerComp.value) {
    const mod = await import('@/views/admin/components/HazardEditDrawer.vue')
    editDrawerComp.value = mod.default
  }
  editId.value = h.id
  showEdit.value = true
}
async function onEditUpdated(id) {
  showToast('隐患修改已保存', 'success')
  showEdit.value = false
  await fetchList()
}

// 批量删除
async function handleBatchDelete() {
  if (!selectedIds.value.length) return
  if (!confirm(`确认删除选中的 ${selectedIds.value.length} 条隐患？此操作不可恢复。`)) return
  deleting.value = true
  try {
    const res = await deleteHazards([...selectedIds.value])
    const d = res.data?.data
    showToast(`已删除 ${d?.deleted ?? selectedIds.value.length} 条隐患`, 'success')
    selectedIds.value = []
    await fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '删除失败', 'error')
  } finally {
    deleting.value = false
  }
}

// 超期通知
async function handleOverdueNotify() {
  if (!selectedIds.value.length) return
  notifying.value = true
  try {
    const res = await triggerOverdueNotify([...selectedIds.value])
    const d = res.data?.data
    showToast(`超期通知已发送 ${d.sent} 条，跳过 ${d.skipped} 条`, 'success')
    selectedIds.value = []
    await fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '通知失败', 'error')
  } finally {
    notifying.value = false
  }
}

async function loadFilterOptions() {
  try {
    const [uRes, lRes, itemRes] = await Promise.all([
      getHazardsUnitNames(),
      getHazardDict('level'),
      getInvestigationItems(),
    ])
    units.value = (uRes.data?.data?.list || []).map((x) => ({ value: x.unit_name, label: x.unit_name }))
    levels.value = lRes.data?.data || []
    // /api/data/investigation-items 返回 { data: { list: [...] } }（字符串数组）
    const itemList = itemRes?.data?.data?.list || itemRes?.data?.data || []
    investigationItemOptions.value = itemList.map((name) => ({ value: name, label: name }))
  } catch { /* 静默 */ }
}

onMounted(() => {
  loadFilterOptions()
  fetchList()
  document.addEventListener('click', onDocumentClick)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<style scoped>
.hazard-loop-page { max-width: 1760px; width: 100%; }
.page-section-title { font-size: 22px; font-weight: 700; color: var(--c-text); }
.sub { font-size: 14px; color: var(--c-text-2); margin-top: 4px; margin-bottom: 22px; }

.status-flow {
  display: flex; align-items: center; gap: 4px;
  padding: 22px 20px; background: var(--c-surface-2);
  border: 1px solid var(--c-border); border-radius: var(--r-lg); margin-bottom: 20px; flex-wrap: wrap;
}
.flow-step { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 140px; }
.step-icon {
  width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, var(--c-blue-500), var(--c-blue-700));
}
.step-text { display: flex; flex-direction: column; line-height: 1.3; }
.step-label { font-size: 14px; font-weight: 600; color: var(--c-text); }
.step-en { font-size: 11px; color: var(--c-text-3); letter-spacing: .5px; }
.step-connector { color: var(--c-border-strong); display: flex; align-items: center; flex-shrink: 0; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 14px; flex-wrap: wrap;
}
.search-wrap { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
.filter-input {
  padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); min-width: 140px;
}
.filter-input:focus { outline: none; border-color: var(--c-blue-600); }

/* 多选下拉（隐患项目） */
.multi-select { position: relative; min-width: 160px; }
.multi-select-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; min-height: 38px; padding: 8px 12px;
  border: 1px solid var(--c-border-strong); border-radius: var(--r);
  background: var(--c-surface); color: var(--c-text); font-size: 14px;
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
  max-height: 240px; overflow-y: auto;
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

.toolbar-right { display: flex; align-items: center; gap: 12px; }
.total-count { font-size: 13px; color: var(--c-text-2); white-space: nowrap; }
.toolbar-right .btn { width: auto; }

.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.tab {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px; border: 1px solid var(--c-border-strong); border-radius: 999px;
  background: var(--c-surface); color: var(--c-text-2); cursor: pointer;
  font-size: 13.5px; font-weight: 600; transition: all .15s ease;
}
.tab:hover { border-color: var(--c-blue-600); color: var(--c-blue-700); }
.tab.active { background: var(--c-blue-600); border-color: var(--c-blue-600); color: #fff; }
.tab-count {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--c-surface-2); color: var(--c-text-2);
  font-size: 11px; display: inline-flex; align-items: center; justify-content: center;
}
.tab.active .tab-count { background: rgba(255,255,255,.25); color: #fff; }
.tab-count.danger { background: var(--c-danger-bg); color: var(--c-danger); }

.table-card { padding: 0; overflow-x: auto; }
.data-table { width: 100%; min-width: 980px; border-collapse: collapse; table-layout: auto; }

/* 紧凑列给最小宽度兜底，不锁死 */
.data-table colgroup col.c-check { width: 44px; min-width: 44px; }
.data-table colgroup col.c-code { min-width: 120px; }
.data-table colgroup col.c-unit { min-width: 90px; }
.data-table colgroup col.c-dept { min-width: 110px; }
.data-table colgroup col.c-invest { min-width: 120px; }
.data-table colgroup col.c-bizhead { min-width: 110px; }
.data-table colgroup col.c-loc { min-width: 80px; }
.data-table colgroup col.c-level { min-width: 70px; }
.data-table colgroup col.c-remark { min-width: 160px; }
.data-table colgroup col.c-person { min-width: 80px; }
.data-table colgroup col.c-plan { min-width: 110px; }
.data-table colgroup col.c-status { min-width: 80px; }
.data-table colgroup col.c-action { min-width: 130px; }

/* 所有单元格：紧凑列不换行 + 溢出隐藏防重叠 */
.data-table th, .data-table td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
.data-table th.col-check, .data-table td.col-check { text-align: center; }
.data-table td { cursor: pointer; }

/* 问题描述列：独占剩余空间、折行显示全文 */
.desc-cell {
  white-space: normal;
  word-break: break-word;
  line-height: 1.45;
  max-width: 480px;
}

.data-table th:last-child, .data-table td:last-child { position: sticky; right: 0; background: var(--c-surface); z-index: 1; }
.overdue-row td:first-child { box-shadow: inset 3px 0 0 var(--c-danger); }
.overdue-row td { background: var(--c-danger-bg) !important; }
.mono.sm { font-size: 12px; }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 16px; border-top: 1px solid var(--c-border); }
.pg-btn {
  width: 34px; height: 34px; border: 1px solid var(--c-border-strong); border-radius: var(--r-sm);
  background: var(--c-surface); cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;
  color: var(--c-text-2);
}
.pg-btn:hover:not(:disabled) { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.pg-btn:disabled { opacity: .4; cursor: default; }
.pg-info { font-size: 13px; color: var(--c-text-2); }

.toast {
  position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
  z-index: 2000; padding: 12px 20px; border-radius: 12px;
  font-size: 14px; font-weight: 600; color: #fff; box-shadow: var(--shadow-lg); max-width: 90vw;
}
.toast.success { background: var(--c-success); }
.toast.error { background: var(--c-danger); }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, -12px); }

@media (max-width: 1280px) {
  .data-table { font-size: 13px; }
  .data-table th, .data-table td { padding-left: 10px; padding-right: 10px; }
  .desc-cell { max-width: 280px; }
}
@media (max-width: 768px) {
  .status-flow { flex-direction: column; align-items: stretch; gap: 10px; }
  .step-connector { transform: rotate(90deg); align-self: center; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar-right { justify-content: space-between; }
}
</style>
