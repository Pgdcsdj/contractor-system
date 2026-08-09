<template>
  <div class="workbench-page">
    <!-- 欢迎区 -->
    <div class="card welcome-card">
      <div class="welcome-info">
        <h2>欢迎，{{ admin.user?.real_name || '安全员' }}</h2>
        <p class="unit-info">归属单位：{{ admin.user?.unit_name || '-' }}</p>
      </div>
      <div class="welcome-stats">
        <div class="stat-item">
          <span class="stat-num">{{ total }}</span>
          <span class="stat-label">我的隐患总数</span>
        </div>
      </div>
    </div>

    <!-- 快捷入口 -->
    <div class="quick-entries">
      <div class="card entry-card" @click="$router.push('/safety/report')">
        <div class="entry-icon hazard-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div class="entry-text">
          <h3>隐患录入</h3>
          <p>上报新的安全隐患</p>
        </div>
      </div>
      <div class="card entry-card" @click="$router.push('/safety/rectify')">
        <div class="entry-icon rectify-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
        </div>
        <div class="entry-text">
          <h3>整改资料录入</h3>
          <p>录入整改完成资料与照片</p>
        </div>
      </div>
    </div>

    <!-- 我的隐患列表 -->
    <div class="card">
      <div class="section-header">
        <h3>我的隐患列表</h3>
        <div class="header-actions">
          <button class="btn btn-outline import-btn" type="button" @click="openNormalImport">批量导入</button>
          <button class="btn btn-primary import-btn" type="button" @click="openVideoImport">视频督查导入</button>
          <div class="filter-bar">
            <select v-model="statusFilter" class="filter-select" @change="fetchList">
              <option value="">全部状态</option>
              <option value="reported">已上报</option>
              <option value="rectifying">整改中</option>
              <option value="verifying">待验收</option>
              <option value="closed">已闭环</option>
            </select>
          </div>
        </div>
      </div>

      <div class="table-card">
        <table class="data-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>隐患排查项目</th>
              <th>责任单位</th>
              <th>场所</th>
              <th>问题描述</th>
              <th>等级</th>
              <th>状态</th>
              <th>上报时间</th>
              <th class="col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="9" class="empty-cell">暂无隐患记录</td>
            </tr>
            <tr
              v-for="h in list"
              :key="h.id"
              :class="{ 'clickable': true }"
              @click="openDetail(h)"
            >
              <td class="mono">{{ h.hazard_code || '-' }}</td>
              <td class="cell-invest">{{ h.hazard_investigation_item || '-' }}</td>
              <td>{{ h.unit_name || '-' }}</td>
              <td>{{ h.location || '-' }}</td>
              <td class="cell-desc">{{ h.description || '-' }}</td>
              <td><span :class="['badge', levelBadge(h.hazard_level)]">{{ h.hazard_level || '-' }}</span></td>
              <td>
                <span :class="['badge', statusBadge(h.status)]">{{ statusLabel(h.status) }}</span>
                <span v-if="h.is_overdue" class="badge badge-danger" style="margin-left:6px">超期</span>
              </td>
              <td class="mono sm">{{ fmtDate(h.created_at) }}</td>
              <td class="col-action" @click.stop>
                <button class="action-link" @click="openDetail(h)">查看</button>
                <button class="action-link" @click="openEdit(h)">编辑</button>
                <button class="action-link danger" @click="confirmDelete(h)">删除</button>
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

    <!-- 隐患批量导入弹窗（复用管理员端组件，调用走安全员 token） -->
    <HazardImportModal
      :visible="showImport"
      :import-type="importTypeForModal"
      @close="showImport = false"
      @imported="onImported"
    />

    <!-- 详情抽屉 -->
    <transition name="fade">
      <div v-if="detail" class="drawer-overlay" @click.self="closeDetail">
        <aside class="drawer">
          <header class="drawer-head">
            <div>
              <h3>隐患详情</h3>
              <p class="drawer-code mono">{{ detail.hazard_code }}</p>
            </div>
            <button class="drawer-close" type="button" @click="closeDetail" aria-label="关闭">×</button>
          </header>
          <div class="drawer-body">
            <div class="detail-badges">
              <span :class="['badge', levelBadge(detail.hazard_level)]">{{ detail.hazard_level || '-' }}</span>
              <span :class="['badge', statusBadge(detail.status)]">{{ statusLabel(detail.status) }}</span>
              <span v-if="detail.is_overdue" class="badge badge-danger">超期</span>
            </div>
            <dl class="detail-list">
              <div class="detail-row" v-for="item in detailPlain" :key="item.label">
                <dt class="detail-label">{{ item.label }}</dt>
                <dd class="detail-value">{{ item.value }}</dd>
              </div>
            </dl>

            <div v-if="detailLoading" class="detail-photos-loading">加载照片中…</div>
            <div v-else-if="detailPhotos.report.length" class="detail-photos">
              <h4 class="photos-title">上报照片</h4>
              <div class="photo-grid">
                <a v-for="p in detailPhotos.report" :key="p.id" :href="p.photo_url" target="_blank" class="photo-item">
                  <img :src="p.photo_url" alt="上报照片" loading="lazy" />
                </a>
              </div>
            </div>
          </div>
          <footer class="drawer-foot">
            <button class="btn btn-outline" type="button" @click="closeDetail">关闭</button>
            <button class="btn btn-primary" type="button" @click="openEdit(detail)">编辑</button>
          </footer>
        </aside>
      </div>
    </transition>

    <!-- 编辑弹窗 -->
    <div v-if="showEdit" class="modal-overlay" @click.self="showEdit = false">
      <div class="modal edit-modal">
        <h3>编辑隐患</h3>
        <p class="modal-hint">编号：{{ editForm.hazard_code }}</p>

        <div class="edit-form">
          <div class="form-grid">
            <!-- 隐患排查项目 -->
            <div class="form-group">
              <label>隐患排查项目</label>
              <input v-model="editForm.hazard_investigation_item" class="form-input" placeholder="如：集团公司第3期类比排查" />
            </div>

            <!-- 责任单位 -->
            <div class="form-group">
              <label>责任单位 <span class="req">*</span></label>
              <select v-model="editForm.contractor_unit_id" class="form-input" @change="onUnitChange">
                <option value="">请选择责任单位</option>
                <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
              </select>
            </div>

            <!-- 场所站点 -->
            <div class="form-group">
              <label>场所站点</label>
              <input v-model="editForm.location" class="form-input" placeholder="如：3#阀室 / 集气站" />
            </div>

            <!-- 业务部门 -->
            <div class="form-group">
              <label>业务部门</label>
              <select v-model="editForm.business_dept" class="form-input">
                <option value="">请选择业务部门…</option>
                <option v-for="d in businessDepts" :key="d.code" :value="d.name">{{ d.name }}</option>
              </select>
            </div>

            <!-- 业务部门负责人 -->
            <div class="form-group">
              <label>业务部门负责人</label>
              <select v-model="editForm.business_dept_head" class="form-input">
                <option value="">请选择业务部门负责人…</option>
                <option v-for="d in businessDeptHeads" :key="d.code" :value="d.name">{{ d.name }}</option>
              </select>
            </div>

            <!-- 隐患等级 -->
            <div class="form-group">
              <label>隐患等级 <span class="req">*</span></label>
              <select v-model="editForm.hazard_level" class="form-input">
                <option value="">请选择等级</option>
                <option v-for="l in levels" :key="l.code" :value="l.name">{{ l.name }}</option>
              </select>
            </div>

            <!-- 问题描述 -->
            <div class="form-group full">
              <label>问题描述 <span class="req">*</span></label>
              <textarea v-model="editForm.description" class="form-input" rows="3" placeholder="描述隐患具体情况、风险点"></textarea>
            </div>

            <!-- 整改情况（可多次更新） -->
            <div class="form-group full">
              <label>整改情况</label>
              <textarea v-model="editForm.rectify_measures" class="form-input" rows="3" placeholder="填写整改情况（若持续整改中，可多次更新）"></textarea>
            </div>

            <!-- 整改责任人 -->
            <div class="form-group">
              <label>整改责任人 <span class="req">*</span></label>
              <input v-model="editForm.responsible_person" class="form-input" placeholder="责任人姓名" />
            </div>

            <!-- 计划完成时间 -->
            <div class="form-group">
              <label>计划完成时间 <span class="req">*</span></label>
              <input v-model="editForm.plan_finish_time" class="form-input" type="datetime-local" />
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" type="button" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" type="button" @click="submitEdit" :disabled="saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="modal confirm-modal">
        <h3>确认删除</h3>
        <p class="modal-hint">
          确定要删除隐患「<span class="mono">{{ deleteTarget.hazard_code }}</span>」吗？此操作不可撤销。
        </p>
        <div class="modal-actions">
          <button class="btn btn-outline" type="button" @click="deleteTarget = null">取消</button>
          <button class="btn btn-danger" type="button" @click="doDelete" :disabled="deleting">
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
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
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import {
  getHazards,
  deleteHazard,
  updateHazard,
  getContractorUnits,
  getHazardDict,
  getHazardDetail,
} from '@/api/hazard'
import HazardImportModal from '@/views/admin/components/HazardImportModal.vue'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'

const admin = useAdminStore()

const list = ref([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = 15
const statusFilter = ref('')
const showImport = ref(false)
// 传给导入弹窗的预选导入类型：'' = 弹窗内自由选（兜底）；'ledger' = 普通台账导入（锁定）；'video_supervision' = 视频督查导入（锁定）
const importTypeForModal = ref('')

/** 打开普通台账导入弹窗（导入类型锁定为普通台账）。 */
function openNormalImport() {
  importTypeForModal.value = 'ledger'
  showImport.value = true
}

/** 打开视频督查导入弹窗（隐患排查项目为空的行默认填「视频督查」）。 */
function openVideoImport() {
  importTypeForModal.value = 'video_supervision'
  showImport.value = true
}

// 详情抽屉
const detail = ref(null)
const detailLoading = ref(false)
const detailPhotos = ref({ report: [], rectify: [] })

// 编辑弹窗
const showEdit = ref(false)
const saving = ref(false)
const units = ref([])
const levels = ref([])
const businessDepts = ref([])
const businessDeptHeads = ref([])

// 删除确认
const deleteTarget = ref(null)
const deleting = ref(false)

const editForm = reactive({
  id: null,
  hazard_code: '',
  contractor_unit_id: '',
  unit_name: '',
  location: '',
  business_dept: '',
  business_dept_head: '',
  hazard_investigation_item: '',
  hazard_level: '',
  description: '',
  rectify_measures: '',
  responsible_person: '',
  plan_finish_time: '',
})

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

function fmtDate(v) {
  if (!v) return '-'
  return String(v).slice(0, 16).replace('T', ' ')
}

// SQL "YYYY-MM-DD HH:mm:ss" → datetime-local "YYYY-MM-DDTHH:mm"
function sqlToLocal(v) {
  if (!v) return ''
  return String(v).slice(0, 16).replace(' ', 'T')
}

// datetime-local "YYYY-MM-DDTHH:mm" → SQL "YYYY-MM-DD HH:mm:ss"
function toSqlDateTime(v) {
  if (!v) return ''
  return v.replace('T', ' ') + (v.length === 16 ? ':00' : '')
}

function buildParams() {
  const p = { page: page.value, pageSize }
  if (statusFilter.value) p.status = statusFilter.value
  return p
}

async function fetchList() {
  loading.value = true
  try {
    const res = await getHazards(buildParams())
    const d = res.data?.data
    list.value = d?.list || []
    total.value = d?.total || 0
  } catch (e) {
    list.value = []
    total.value = 0
    showToast(e.response?.data?.error || '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

/** 详情抽屉字段（纯文本项，空值显示 -） */
const detailPlain = computed(() => {
  const h = detail.value
  if (!h) return []
  const rows = [
    ['隐患排查项目', h.hazard_investigation_item],
    ['责任单位', h.unit_name],
    ['业务部门', h.business_dept],
    ['业务部门负责人', h.business_dept_head],
    ['场所', h.location],
    ['问题描述', h.description],
    ['整改情况', h.rectify_measures],
    ['整改责任人', h.responsible_person],
    ['计划完成时间', h.plan_finish_time],
    ['上报时间', h.created_at],
    ['录入人', h.recorder_name],
  ]
  return rows.map(([label, value]) => ({ label, value: value || '-' }))
})

async function openDetail(h) {
  detail.value = h
  detailLoading.value = true
  detailPhotos.value = { report: [], rectify: [] }
  try {
    const res = await getHazardDetail(h.id)
    const data = res.data?.data
    if (data) {
      detail.value = data
      detailPhotos.value = data.photos || { report: [], rectify: [] }
    }
  } catch (e) {
    console.error('加载隐患详情照片失败', e)
  } finally {
    detailLoading.value = false
  }
}
function closeDetail() {
  detail.value = null
}

function onUnitChange() {
  const u = units.value.find((x) => String(x.id) === String(editForm.contractor_unit_id))
  editForm.unit_name = u ? u.unit_name : ''
}

function openEdit(h) {
  // 若详情抽屉打开则先关闭，避免遮挡
  detail.value = null
  editForm.id = h.id
  editForm.hazard_code = h.hazard_code || ''
  editForm.contractor_unit_id = h.contractor_unit_id != null ? h.contractor_unit_id : ''
  editForm.unit_name = h.unit_name || ''
  editForm.location = h.location || ''
  editForm.business_dept = h.business_dept || ''
  editForm.business_dept_head = h.business_dept_head || ''
  editForm.hazard_investigation_item = h.hazard_investigation_item || ''
  editForm.hazard_level = h.hazard_level || ''
  editForm.description = h.description || ''
  editForm.rectify_measures = h.rectify_measures || ''
  editForm.responsible_person = h.responsible_person || ''
  editForm.plan_finish_time = sqlToLocal(h.plan_finish_time)
  showEdit.value = true
}

async function submitEdit() {
  if (!editForm.unit_name) return showToast('请选择责任单位', 'error')
  if (!editForm.description.trim()) return showToast('请填写隐患描述', 'error')
  if (!editForm.hazard_level) return showToast('请选择隐患等级', 'error')
  if (!editForm.responsible_person.trim()) return showToast('请填写整改责任人', 'error')
  if (!editForm.plan_finish_time) return showToast('请选择计划完成时间', 'error')

  saving.value = true
  try {
    const payload = {
      contractor_unit_id: editForm.contractor_unit_id ? Number(editForm.contractor_unit_id) : null,
      unit_name: editForm.unit_name,
      location: editForm.location,
      business_dept: editForm.business_dept,
      business_dept_head: editForm.business_dept_head,
      hazard_investigation_item: editForm.hazard_investigation_item,
      description: editForm.description,
      hazard_level: editForm.hazard_level,
      rectify_measures: editForm.rectify_measures,
      responsible_person: editForm.responsible_person,
      plan_finish_time: toSqlDateTime(editForm.plan_finish_time),
    }
    await updateHazard(editForm.id, payload)
    showToast('隐患已更新', 'success')
    showEdit.value = false
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '更新失败', 'error')
  } finally {
    saving.value = false
  }
}

function confirmDelete(h) {
  deleteTarget.value = h
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await deleteHazard(deleteTarget.value.id)
    showToast('已删除隐患', 'success')
    deleteTarget.value = null
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '删除失败', 'error')
  } finally {
    deleting.value = false
  }
}

// 批量导入成功回调（弹窗自身已展示明细/告警，这里刷新列表并提示）
function onImported() {
  showToast('导入完成，已刷新隐患列表', 'success')
  fetchList()
}

/** 加载编辑弹窗所需的下拉字典 */
async function loadEditOptions() {
  try {
    const [uRes, lRes, bdRes, bhRes] = await Promise.all([
      getContractorUnits(),
      getHazardDict('level'),
      getHazardDict('business_dept'),
      getHazardDict('business_dept_head'),
    ])
    units.value = uRes.data?.data?.list || uRes.data?.data || []
    levels.value = lRes.data?.data || []
    businessDepts.value = bdRes.data?.data || []
    businessDeptHeads.value = bhRes.data?.data || []
  } catch (e) {
    showToast(e.response?.data?.error || '字典加载失败', 'error')
  }
}

watch(page, fetchList)

onMounted(() => {
  fetchList()
  loadEditOptions()
})
</script>

<style scoped>
.workbench-page { max-width: 1320px; }

.welcome-card {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24px 28px; margin-bottom: 0;
  background: linear-gradient(135deg, var(--c-navy-800), var(--c-navy-900));
  border-color: transparent; color: #fff;
}
.welcome-info h2 { font-size: 22px; font-weight: 700; }
.unit-info { font-size: 14px; color: rgba(255,255,255,.65); margin-top: 4px; }
.stat-item { text-align: center; }
.stat-num { font-size: 32px; font-weight: 900; display: block; line-height: 1.1; }
.stat-label { font-size: 12px; color: rgba(255,255,255,.65); }

.quick-entries {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  margin: 16px 12px 20px;
}
.entry-card {
  display: flex; align-items: center; gap: 16px; padding: 24px;
  cursor: pointer; transition: box-shadow .2s ease, transform .15s ease;
}
.entry-card:hover { box-shadow: var(--shadow); transform: translateY(-2px); }
.entry-icon {
  width: 56px; height: 56px; border-radius: 14px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.hazard-icon { background: linear-gradient(135deg, var(--c-blue-500), var(--c-blue-700)); box-shadow: 0 6px 16px rgba(29,111,184,.3); }
.rectify-icon { background: linear-gradient(135deg, var(--c-teal-600), #0b6b61); box-shadow: 0 6px 16px rgba(14,140,127,.3); }
.entry-text h3 { font-size: 17px; font-weight: 700; color: var(--c-text); }
.entry-text p { font-size: 13px; color: var(--c-text-2); margin-top: 3px; }

.section-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px; flex-wrap: wrap; gap: 10px;
}
.section-header h3 { font-size: 17px; font-weight: 700; color: var(--c-text); }
.filter-bar { display: flex; gap: 8px; }
.filter-select {
  padding: 8px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); min-width: 130px;
}
.filter-select:focus { outline: none; border-color: var(--c-blue-600); }
.header-actions { display: flex; align-items: center; gap: 12px; }
.import-btn { white-space: nowrap; font-size: 13px; padding: 8px 16px; }

.table-card { padding: 0; overflow-x: auto; }
.data-table { min-width: 960px; }
.data-table tbody tr.clickable { cursor: pointer; }
.cell-invest { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-desc { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); }
.col-action { white-space: nowrap; text-align: center; }
.action-link.danger { color: var(--c-danger); }
.action-link.danger:hover { background: var(--c-danger-bg); }

/* ── 详情抽屉 ── */
.drawer-overlay {
  position: fixed; inset: 0; background: rgba(10, 19, 34, .45);
  z-index: 1100; display: flex; justify-content: flex-end;
  animation: overlay-in .2s ease;
}
.drawer {
  width: 440px; max-width: 92vw; height: 100%;
  background: var(--c-surface); display: flex; flex-direction: column;
  box-shadow: var(--shadow-lg); animation: drawer-in .25s cubic-bezier(.22, 1, .36, 1);
}
.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid var(--c-border);
}
.drawer-head h3 { font-size: 17px; font-weight: 700; color: var(--c-text); }
.drawer-code { font-size: 12px; color: var(--c-text-3); margin-top: 2px; }
.drawer-close {
  border: none; background: none; font-size: 26px; line-height: 1;
  cursor: pointer; color: var(--c-text-2); padding: 0 4px;
}
.drawer-close:hover { color: var(--c-text); }
.drawer-body { padding: 20px 24px; overflow-y: auto; flex: 1; }
.detail-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
.detail-list { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.detail-row { display: flex; flex-direction: column; gap: 4px; }
.detail-label { font-size: 12px; color: var(--c-text-3); }
.detail-photos { margin-top: 22px; }
.photos-title { font-size: 13px; font-weight: 700; color: var(--c-text); margin-bottom: 10px; }
.photo-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.photo-item { display: block; border-radius: 8px; overflow: hidden; border: 1px solid var(--c-border); background: var(--c-bg); }
.photo-item img { width: 100%; height: 120px; object-fit: cover; display: block; }
.detail-photos-loading { margin-top: 18px; font-size: 13px; color: var(--c-text-3); }
.detail-value { font-size: 14px; color: var(--c-text); white-space: pre-wrap; word-break: break-word; margin: 0; }
.drawer-foot {
  padding: 16px 24px; border-top: 1px solid var(--c-border);
  display: flex; gap: 10px; justify-content: flex-end;
}

/* ── 编辑 / 确认弹窗 ── */
.edit-modal { max-width: 600px; max-height: 88vh; display: flex; flex-direction: column; }
.edit-form { overflow-y: auto; padding: 4px 4px 0; }
.confirm-modal { max-width: 420px; }

/* toast */
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

.fade-enter-active, .fade-leave-active { transition: opacity .2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@keyframes overlay-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes drawer-in { from { transform: translateX(100%) } to { transform: none } }

@media (max-width: 640px) {
  .quick-entries { grid-template-columns: 1fr; }
}
</style>
