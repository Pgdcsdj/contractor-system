<template>
  <div class="hazard-report-page">
    <div class="card report-card">
      <div class="card-head">
        <span class="head-icon"><Icon name="hazard" :size="22" /></span>
        <div class="head-text">
          <h2 class="page-section-title">隐患录入</h2>
          <p class="head-sub">填写隐患信息并提交，系统自动生成编号并进入整改闭环流程</p>
        </div>
        <button class="btn btn-outline import-btn" type="button" @click="showImport = true">批量导入</button>
      </div>

      <div class="form-grid">
        <!-- 隐患排查项目（下拉来自 hazard_investigation_item 字典，非必填） -->
        <div class="form-group">
          <label>隐患排查项目</label>
          <select v-model="form.hazard_investigation_item" class="form-input" @change="onInvestigationItemChange">
            <option value="">请选择（可选）</option>
            <option v-for="p in investigationItems" :key="p.code" :value="p.name">{{ p.name }}</option>
          </select>
        </div>

        <!-- 责任单位（原"承包商单位"） -->
        <div class="form-group">
          <label>责任单位 <span class="req">*</span></label>
          <select v-model="form.contractor_unit_id" class="form-input" @change="onUnitChange">
            <option value="">请选择责任单位</option>
            <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
          </select>
        </div>

        <!-- 场所站点（位置两级联动：生产场站 → 施工点，前端拼 location） -->
        <div class="form-group">
          <label>场所站点（生产场站 / 施工点）</label>
          <div class="cascade">
            <select v-model="centerStation" class="form-input" @change="onLocationChange">
              <option value="">生产场站</option>
              <option v-for="c in centerStations" :key="c.code" :value="c.name">{{ c.name }}</option>
            </select>
            <select v-model="wellSite" class="form-input" @change="onLocationChange">
              <option value="">施工点</option>
              <option v-for="w in wellSites" :key="w.code" :value="w.name">{{ w.name }}</option>
            </select>
          </div>
        </div>

        <!-- 业务部门（复用 business_dept 列，下拉来自隐患设置可维护列表） -->
        <div class="form-group">
          <label>业务部门</label>
          <select v-model="form.business_dept" class="form-input" @change="onBizChange">
            <option value="">请选择业务部门…</option>
            <option v-for="d in businessDepts" :key="d.code" :value="d.name">{{ d.name }}</option>
          </select>
        </div>

        <!-- 业务部门负责人（自动带出，不可手填） -->
        <div class="form-group">
          <label>业务部门负责人（自动带出）</label>
          <input class="form-input" :value="form.business_dept_head" readonly placeholder="选择责任单位 + 业务部门后自动带出" />
        </div>

        <!-- 隐患等级 -->
        <div class="form-group">
          <label>隐患等级 <span class="req">*</span></label>
          <select v-model="form.hazard_level" class="form-input">
            <option value="">请选择等级</option>
            <option v-for="l in levels" :key="l.code" :value="l.name">{{ l.name }}</option>
          </select>
        </div>

        <!-- 问题描述 -->
        <div class="form-group full">
          <label>问题描述 <span class="req">*</span></label>
          <textarea v-model="form.description" class="form-input" rows="3" placeholder="描述隐患具体情况、风险点"></textarea>
        </div>

        <!-- 标准依据（按排查项目自动匹配，可手动覆盖） -->
        <div class="form-group full">
          <label>
            标准依据
            <button type="button" class="btn btn-mini" :disabled="!form.hazard_investigation_item || matching" @click="doMatchBasis">
              {{ matching ? '匹配中…' : '自动匹配依据' }}
            </button>
          </label>
          <textarea v-model="form.standard_basis" class="form-input" rows="2" placeholder="选择「隐患排查项目」后点「自动匹配依据」，或从问题依据库自动带入；也可手填"></textarea>
          <p v-if="basisHint" class="basis-hint" :class="basisHintType">{{ basisHint }}</p>
        </div>

        <!-- 整改情况（可多次更新） -->
        <div class="form-group full">
          <label>整改情况</label>
          <textarea v-model="form.rectify_measures" class="form-input" rows="3" placeholder="填写整改情况（若持续整改中，可多次更新）"></textarea>
        </div>

        <!-- 整改责任人 -->
        <div class="form-group">
          <label>整改责任人 <span class="req">*</span></label>
          <input v-model="form.responsible_person" class="form-input" placeholder="责任人姓名" />
        </div>

        <!-- 计划完成时间 -->
        <div class="form-group">
          <label>计划完成时间 <span class="req">*</span></label>
          <input v-model="form.plan_finish_time" class="form-input" type="datetime-local" />
        </div>

        <!-- 现场照片 -->
        <div class="form-group full">
          <label>现场照片</label>
          <HazardPhotoUpload v-model="photoUrls" photo-type="report" :max="9" />
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" type="button" @click="resetForm" :disabled="submitting">重置</button>
        <button class="btn btn-primary" type="button" @click="handleSubmit" :disabled="submitting">
          {{ submitting ? '提交中…' : '提交上报' }}
        </button>
      </div>
    </div>

    <!-- 隐患批量导入弹窗 -->
    <HazardImportModal :visible="showImport" @close="showImport = false" @imported="onImported" />

    <!-- 轻量 toast -->
    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import HazardPhotoUpload from '@/views/admin/components/HazardPhotoUpload.vue'
import HazardImportModal from '@/views/admin/components/HazardImportModal.vue'
import {
  getHazardDict,
  getContractorUnits,
  getRectifyUnitBiz,
  reportHazard,
  matchStandardBasis,
} from '@/api/hazard'

const units = ref([])
const levels = ref([])
const photoUrls = ref([])
const submitting = ref(false)
const showImport = ref(false)

// 标准依据自动匹配状态
const matching = ref(false)
const basisHint = ref('')
const basisHintType = ref('')

// 隐患设置下拉：业务部门；责任单位·业务口关联（用于自动带出负责人）
const businessDepts = ref([])
const bizLinks = ref([])

// 位置四级联动字典（中心站 / 井场 / 设施）+ 隐患排查项目下拉源
const centerStations = ref([])
const wellSites = ref([])
const investigationItems = ref([])
// 联动选中的两段（拼接为 location = 生产场站/施工点，缺级留空段）
const centerStation = ref('')
const wellSite = ref('')

const form = reactive({
  contractor_unit_id: '',
  unit_name: '',
  location: '',
  business_dept: '',
  hazard_investigation_item: '',
  business_dept_head: '',
  hazard_level: '',
  standard_basis: '',
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

function onUnitChange() {
  const u = units.value.find((x) => String(x.id) === String(form.contractor_unit_id))
  form.unit_name = u ? u.unit_name : ''
  applyAutoHead()
}

function onBizChange() {
  applyAutoHead()
}

// 选齐「责任单位 + 业务部门」后，从关联表自动带出负责人姓名（写入 business_dept_head）
function applyAutoHead() {
  if (form.unit_name && form.business_dept) {
    const link = bizLinks.value.find(
      (l) => l.rectify_unit === form.unit_name && l.business_dept === form.business_dept
    )
    form.business_dept_head = link && link.head_name ? link.head_name : ''
  } else {
    form.business_dept_head = ''
  }
}

// 位置两级联动：两段拼接为单 location 串（生产场站/施工点，缺级留空段）
function onLocationChange() {
  const parts = [centerStation.value, wellSite.value]
  form.location = parts.every((p) => !p) ? '' : parts.join('/')
}

// 标准依据：按排查项目自动匹配（仅当依据为空时生效，避免覆盖用户手填）
async function doMatchBasis() {
  if (!form.hazard_investigation_item) {
    basisHint.value = '请先选择「隐患排查项目」'
    basisHintType.value = 'warn'
    return
  }
  matching.value = true
  basisHint.value = ''
  try {
    const res = await matchStandardBasis(form.hazard_investigation_item)
    const m = res.data?.data || {}
    if (m.matched) {
      form.standard_basis = m.standard_basis
      basisHint.value = m.source ? `已匹配：${m.standard_basis}（${m.source}）` : `已匹配：${m.standard_basis}`
      basisHintType.value = 'ok'
    } else {
      basisHint.value = '问题依据库中未找到该排查项目对应的标准依据'
      basisHintType.value = 'warn'
    }
  } catch (e) {
    basisHint.value = '匹配失败：' + (e.response?.data?.error || e.message)
    basisHintType.value = 'warn'
  } finally {
    matching.value = false
  }
}

// 排查项目下拉变化 → 若依据为空则自动匹配
function onInvestigationItemChange() {
  if (!form.standard_basis) doMatchBasis()
}

// 批量导入成功回调（弹窗已展示明细，这里给个全局提示）
function onImported() {
  showToast('导入完成，请到闭环看板查看', 'success')
}

// datetime-local → "YYYY-MM-DD HH:mm:ss"
function toSqlDateTime(v) {
  if (!v) return ''
  return v.replace('T', ' ') + (v.length === 16 ? ':00' : '')
}

function resetForm() {
  form.contractor_unit_id = ''
  form.unit_name = ''
  form.location = ''
  form.business_dept = ''
  form.hazard_investigation_item = ''
  form.business_dept_head = ''
  form.hazard_level = ''
  form.standard_basis = ''
  form.description = ''
  form.rectify_measures = ''
  form.responsible_person = ''
  form.plan_finish_time = ''
  centerStation.value = ''
  wellSite.value = ''
  photoUrls.value = []
}

async function handleSubmit() {
  if (!form.unit_name) return showToast('请选择责任单位', 'error')
  if (!form.description.trim()) return showToast('请填写隐患描述', 'error')
  if (!form.hazard_level) return showToast('请选择隐患等级', 'error')
  if (!form.responsible_person.trim()) return showToast('请填写整改责任人', 'error')
  if (!form.plan_finish_time) return showToast('请选择计划完成时间', 'error')

  submitting.value = true
  try {
    const payload = {
      contractor_unit_id: form.contractor_unit_id ? Number(form.contractor_unit_id) : null,
      unit_name: form.unit_name,
      location: form.location,
      business_dept: form.business_dept,
      hazard_investigation_item: form.hazard_investigation_item,
      business_dept_head: form.business_dept_head,
      standard_basis: form.standard_basis || '',
      description: form.description,
      hazard_level: form.hazard_level,
      rectify_measures: form.rectify_measures,
      responsible_person: form.responsible_person,
      plan_finish_time: toSqlDateTime(form.plan_finish_time),
      photo_urls: [...photoUrls.value],
    }
    const res = await reportHazard(payload)
    const code = res.data?.data?.hazard_code
    showToast('隐患已上报，编号：' + code, 'success')
    resetForm()
  } catch (e) {
    showToast(e.response?.data?.error || '上报失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function loadOptions() {
  try {
    const [uRes, lRes, bdRes, bizRes, csRes, wsRes, invRes] = await Promise.all([
      getContractorUnits(),
      getHazardDict('level'),
      getHazardDict('business_dept'),
      getRectifyUnitBiz(),
      getHazardDict('center_station'),
      getHazardDict('well_site'),
      getHazardDict('hazard_investigation_item'),
    ])
    units.value = uRes.data?.data?.list || []
    levels.value = lRes.data?.data || []
    businessDepts.value = bdRes.data?.data || []
    bizLinks.value = bizRes.data?.data || []
    centerStations.value = csRes.data?.data || []
    wellSites.value = wsRes.data?.data || []
    investigationItems.value = invRes.data?.data || []
  } catch (e) {
    showToast(e.response?.data?.error || '字典加载失败', 'error')
  }
}

onMounted(loadOptions)
</script>

<style scoped>
.hazard-report-page { max-width: 920px; }
.report-card { padding: 24px; }
.card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.card-head .head-text { flex: 1; min-width: 180px; padding-right: 12px; }
.import-btn { margin-left: auto; white-space: nowrap; font-size: 13px; padding: 6px 16px; }
.head-icon {
  width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, var(--c-teal-600), #0b6b61);
  box-shadow: 0 6px 16px rgba(14, 140, 127, .3);
}
.page-section-title { font-size: 20px; font-weight: 700; color: var(--c-text); }
.head-sub { font-size: 13px; color: var(--c-text-2); margin-top: 2px; white-space: normal; line-height: 1.4; }

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}
.form-group.full { grid-column: 1 / -1; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 6px; }
.req { color: var(--c-danger); }
.cascade { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.btn-mini {
  margin-left: 8px; padding: 2px 10px; font-size: 12px; line-height: 1.6;
  border: 1px solid var(--c-border); border-radius: 8px; cursor: pointer;
  background: var(--c-bg-soft); color: var(--c-primary);
}
.btn-mini:disabled { opacity: .5; cursor: not-allowed; }
.basis-hint { font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
.basis-hint.ok { color: var(--c-success); }
.basis-hint.warn { color: var(--c-warning); }

.form-actions {
  display: flex; gap: 12px; justify-content: flex-end; margin-top: 22px;
}
.form-actions .btn { width: auto; min-width: 120px; }

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

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
  .form-actions { flex-direction: column-reverse; }
  .form-actions .btn { width: 100%; }
}
</style>
