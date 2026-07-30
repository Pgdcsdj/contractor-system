<template>
  <div class="safety-report-page">
    <div class="card report-card">
      <div class="card-head">
        <div class="head-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div class="head-text">
          <h2 class="page-section-title">隐患录入</h2>
          <p class="head-sub">填写隐患信息并提交，系统自动生成编号</p>
        </div>
      </div>

      <div class="form-grid">
        <!-- 隐患排查项目（自由文本，非必填） -->
        <div class="form-group">
          <label>隐患排查项目</label>
          <input v-model="form.hazard_investigation_item" class="form-input" placeholder="如：集团公司第3期类比排查" />
        </div>

        <!-- 整改单位（责任单位） -->
        <div class="form-group">
          <label>责任单位 <span class="req">*</span></label>
          <select v-model="form.contractor_unit_id" class="form-input" @change="onUnitChange">
            <option value="">请选择责任单位</option>
            <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
          </select>
        </div>

        <!-- 场所站点 -->
        <div class="form-group">
          <label>场所站点</label>
          <input v-model="form.location" class="form-input" placeholder="如：3#阀室 / 集气站" />
        </div>

        <!-- 业务部门 -->
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

        <!-- 整改情况（可多次更新） -->
        <div class="form-group full">
          <label>整改情况</label>
          <textarea v-model="form.rectify_measures" class="form-input" rows="3" placeholder="填写整改情况（若持续整改中，可多次更新）"></textarea>
        </div>

        <!-- 备注（选填） -->
        <div class="form-group full">
          <label>备注</label>
          <textarea v-model="form.remark" class="form-input" rows="2" placeholder="补充说明（选填）"></textarea>
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

    <!-- toast -->
    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getHazardDict, getContractorUnits, getRectifyUnitBiz, reportHazard } from '@/api/hazard'
import HazardPhotoUpload from '@/views/admin/components/HazardPhotoUpload.vue'

const router = useRouter()

const units = ref([])
const levels = ref([])
const businessDepts = ref([])
const bizLinks = ref([])
const photoUrls = ref([])
const submitting = ref(false)

const form = reactive({
  contractor_unit_id: '',
  unit_name: '',
  location: '',
  business_dept: '',
  hazard_investigation_item: '',
  business_dept_head: '',
  hazard_level: '',
  description: '',
  rectify_measures: '',
  remark: '',
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
  form.description = ''
  form.rectify_measures = ''
  form.responsible_person = ''
  form.plan_finish_time = ''
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
      description: form.description,
      hazard_level: form.hazard_level,
      rectify_measures: form.rectify_measures,
      remark: form.remark,
      responsible_person: form.responsible_person,
      plan_finish_time: toSqlDateTime(form.plan_finish_time),
      photo_urls: [...photoUrls.value],
    }
    const res = await reportHazard(payload)
    const code = res.data?.data?.hazard_code
    showToast('隐患已上报，编号：' + code, 'success')
    setTimeout(() => router.push('/safety/workbench'), 1500)
  } catch (e) {
    showToast(e.response?.data?.error || '上报失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function loadOptions() {
  try {
    const [uRes, lRes, bdRes, bizRes] = await Promise.all([
      getContractorUnits(),
      getHazardDict('level'),
      getHazardDict('business_dept'),
      getRectifyUnitBiz(),
    ])
    units.value = uRes.data?.data?.list || uRes.data?.data || []
    levels.value = lRes.data?.data || []
    businessDepts.value = bdRes.data?.data || []
    bizLinks.value = bizRes.data?.data || []
  } catch (e) {
    showToast(e.response?.data?.error || '字典加载失败', 'error')
  }
}

onMounted(loadOptions)
</script>

<style scoped>
.safety-report-page { max-width: 920px; }
.report-card { padding: 24px; }
.card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.card-head .head-text { flex: 1; min-width: 180px; padding-right: 12px; }
.head-icon {
  width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, #b71c1c, #d32f2f);
  box-shadow: 0 6px 16px rgba(183, 28, 28, .3);
}
.page-section-title { font-size: 20px; font-weight: 700; color: var(--c-text); }
.head-sub { font-size: 13px; color: var(--c-text-2); margin-top: 2px; }

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}
.form-group.full { grid-column: 1 / -1; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 6px; }
.req { color: var(--c-danger); }

.form-actions {
  display: flex; gap: 12px; justify-content: flex-end; margin-top: 22px;
}
.form-actions .btn { width: auto; min-width: 120px; }

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
