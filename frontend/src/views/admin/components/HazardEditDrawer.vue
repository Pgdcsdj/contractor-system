<template>
  <transition name="drawer">
    <div v-if="show" class="drawer-overlay" @click.self="onClose">
      <aside class="drawer">
        <!-- 头部 -->
        <header class="drawer-head">
          <div class="dh-left">
            <span class="mono code">{{ current?.hazard_code || '—' }}</span>
            <span v-if="current" :class="['badge', statusBadge(current.status)]">{{ statusLabel(current.status) }}</span>
            <span v-if="current?.is_overdue" class="badge badge-danger">超期</span>
          </div>
          <button class="drawer-close" @click="onClose" title="关闭"><Icon name="x" :size="18" /></button>
        </header>

        <div v-if="loading" class="drawer-body">
          <div class="spinner" style="margin:48px auto"></div>
        </div>

        <div v-else-if="current" class="drawer-body">
          <!-- 编辑表单（不含 status / rectify_status） -->
          <section class="sec">
            <h4 class="sec-title">编辑隐患信息</h4>

            <div class="form-group"><label>隐患排查项目</label>
              <input v-model="form.hazard_investigation_item" class="form-input" /></div>

            <div class="form-group"><label>责任单位</label>
              <input v-model="form.unit_name" class="form-input" placeholder="手动填写责任单位名称" /></div>

            <div class="form-group"><label>责任单位（下拉，可选）</label>
              <select v-model="form.contractor_unit_id" class="form-input" @change="onUnitChange">
                <option :value="null">（不关联 / 手动填写）</option>
                <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
              </select></div>

            <div class="form-group"><label>业务归口</label>
              <input v-model="form.business_dept" class="form-input" /></div>

            <div class="form-group"><label>业务部门负责人</label>
              <input v-model="form.business_dept_head" class="form-input" /></div>

            <div class="form-group"><label>场所</label>
              <input v-model="form.location" class="form-input" /></div>

            <div class="form-group"><label>隐患等级</label>
              <select v-model="form.hazard_level" class="form-input">
                <option value="重大隐患">重大隐患</option>
                <option value="较大隐患">较大隐患</option>
                <option value="一般隐患">一般隐患</option>
              </select></div>

            <div class="form-group"><label>整改责任人</label>
              <input v-model="form.responsible_person" class="form-input" /></div>

            <div class="form-group"><label>计划完成</label>
              <input v-model="form.plan_finish_time" class="form-input" type="datetime-local" /></div>

            <div class="form-group"><label>问题描述</label>
              <textarea v-model="form.description" class="form-input" rows="3"></textarea></div>

            <div class="form-group"><label>整改情况</label>
              <textarea v-model="form.rectify_measures" class="form-input" rows="2"></textarea></div>

            <div class="form-group"><label>备注</label>
              <input v-model="form.remark" class="form-input" /></div>

            <div class="form-group"><label>是否否决项</label>
              <select v-model="form.is_reject_item" class="form-input">
                <option :value="0">否</option>
                <option :value="1">是</option>
              </select></div>

            <div class="form-group"><label>扣分项</label>
              <input v-model="form.deduct_score" class="form-input" placeholder="如：扣 2 分" /></div>
          </section>

          <div class="modal-actions">
            <button class="btn btn-outline" @click="onClose" :disabled="submitting">取消</button>
            <button class="btn btn-primary" @click="submit" :disabled="submitting">保存修改</button>
          </div>

          <p v-if="feedback" class="feedback" :class="feedbackType">{{ feedback }}</p>
        </div>
      </aside>
    </div>
  </transition>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import { statusLabel, statusBadge } from '@/utils/hazardStatus'
import { getHazardDetail, updateHazard, getContractorUnits, getHazardDict } from '@/api/hazard'

const props = defineProps({
  show: { type: Boolean, default: false },
  hazardId: { type: [Number, String], default: null },
})
const emit = defineEmits(['close', 'updated'])

const current = ref(null)
const loading = ref(false)
const submitting = ref(false)
const feedback = ref('')
const feedbackType = ref('')

const units = ref([])
const levels = ref([])

// 表单字段与 PATCH 白名单一一对应（不含 status / rectify_status）
const form = reactive({
  hazard_investigation_item: '',
  unit_name: '',
  contractor_unit_id: null,
  business_dept: '',
  business_dept_head: '',
  location: '',
  hazard_level: '',
  responsible_person: '',
  plan_finish_time: '',
  description: '',
  rectify_measures: '',
  remark: '',
  is_reject_item: 0,
  deduct_score: '',
})

function onClose() {
  emit('close')
}

function toSql(v) {
  if (!v) return ''
  return v.replace('T', ' ') + (v.length === 16 ? ':00' : '')
}
function toLocalInput(v) {
  return v ? String(v).replace(' ', 'T').slice(0, 16) : ''
}
function setFeedback(msg, type = 'error') {
  feedback.value = msg
  feedbackType.value = type
  setTimeout(() => { feedback.value = '' }, 3000)
}

// 责任单位下拉变更：同步 unit_name（便于与 contractor_unit_id 一致）
function onUnitChange() {
  const id = form.contractor_unit_id
  if (id) {
    const u = units.value.find((x) => x.id === id)
    if (u) form.unit_name = u.unit_name
  }
}

async function loadOptions() {
  try {
    const [uRes, lRes] = await Promise.all([getContractorUnits(), getHazardDict('level')])
    units.value = uRes.data?.data?.list || uRes.data?.data || []
    levels.value = lRes.data?.data || []
  } catch {
    /* 静默：下拉选项缺失不影响编辑 */
  }
}

function fillForm(d) {
  current.value = d
  form.hazard_investigation_item = d.hazard_investigation_item || ''
  form.unit_name = d.unit_name || ''
  form.contractor_unit_id = d.contractor_unit_id ?? null
  form.business_dept = d.business_dept || ''
  form.business_dept_head = d.business_dept_head || ''
  form.location = d.location || ''
  form.hazard_level = d.hazard_level || ''
  form.responsible_person = d.responsible_person || ''
  form.plan_finish_time = toLocalInput(d.plan_finish_time)
  form.description = d.description || ''
  form.rectify_measures = d.rectify_measures || ''
  form.remark = d.remark || ''
  // 是否否决项：库内 0/1 映射 select 的 0/1
  form.is_reject_item = d.is_reject_item ? 1 : 0
  form.deduct_score = d.deduct_score ?? ''
}

async function loadDetail(id) {
  if (!id) return
  loading.value = true
  try {
    const res = await getHazardDetail(id)
    fillForm(res.data?.data || {})
  } catch (e) {
    setFeedback(e.response?.data?.error || '详情加载失败')
  } finally {
    loading.value = false
  }
}

// 打开或切换隐患时重新预填（覆盖 list 项字段不全的情况，确保 remark/is_reject_item/deduct_score 齐全）
onMounted(() => {
  loadOptions()
  if (props.show && props.hazardId) loadDetail(props.hazardId)
})
watch(
  () => props.show,
  (v) => { if (v && props.hazardId) loadDetail(props.hazardId) }
)
watch(
  () => props.hazardId,
  (id) => { if (props.show && id) loadDetail(id) }
)

async function submit() {
  if (!props.hazardId) return
  submitting.value = true
  feedback.value = ''
  const payload = {
    hazard_investigation_item: form.hazard_investigation_item,
    contractor_unit_id: form.contractor_unit_id ? Number(form.contractor_unit_id) : null,
    unit_name: form.unit_name,
    location: form.location,
    business_dept: form.business_dept,
    business_dept_head: form.business_dept_head,
    description: form.description,
    hazard_level: form.hazard_level,
    rectify_measures: form.rectify_measures,
    remark: form.remark,
    responsible_person: form.responsible_person,
    plan_finish_time: toSql(form.plan_finish_time),
    // 与 verify 接口一致：Number(v)?1:0；deduct_score 原值透传
    is_reject_item: Number(form.is_reject_item) ? 1 : 0,
    deduct_score: form.deduct_score ?? '',
  }
  try {
    await updateHazard(props.hazardId, payload)
    setFeedback('保存成功', 'success')
    emit('updated', props.hazardId)
    setTimeout(() => emit('close'), 600)
  } catch (e) {
    // 失败展示错误文案（等级非法 / 越权 403 等）
    setFeedback(e.response?.data?.error || '保存失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.drawer-overlay {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(10, 19, 34, .5);
  display: flex; justify-content: flex-end;
  backdrop-filter: blur(2px);
}
.drawer {
  width: 100%; max-width: 480px; height: 100%;
  background: var(--c-surface);
  display: flex; flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: drawer-in .26s cubic-bezier(.22, 1, .36, 1);
}
@keyframes drawer-in { from { transform: translateX(100%) } to { transform: none } }
.drawer-leave-active .drawer { animation: drawer-out .2s ease forwards; }
@keyframes drawer-out { to { transform: translateX(100%) } }

.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--c-border); flex-shrink: 0;
}
.dh-left { display: flex; align-items: center; gap: 8px; }
.code { font-size: 15px; font-weight: 700; }
.drawer-close {
  width: 34px; height: 34px; border: none; border-radius: 9px;
  background: var(--c-surface-2); color: var(--c-text-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.drawer-close:hover { background: var(--c-border); color: var(--c-text); }

.drawer-body { flex: 1; overflow-y: auto; padding: 18px 20px 28px; }

.sec { margin-bottom: 22px; }
.sec-title { font-size: 13px; font-weight: 700; color: var(--c-text-2); margin-bottom: 12px; letter-spacing: .3px; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.info-item { display: flex; flex-direction: column; gap: 3px; }
.info-item .k, .info-line .k { font-size: 12px; color: var(--c-text-3); }
.info-item .v, .info-line .v { font-size: 14px; color: var(--c-text); font-weight: 500; }
.info-line { display: flex; gap: 10px; margin-top: 12px; align-items: flex-start; }
.info-line .k { flex-shrink: 0; width: 64px; padding-top: 1px; }
.info-line .v { margin: 0; flex: 1; line-height: 1.6; }

.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
.photo-thumb { display: block; aspect-ratio: 1/1; border-radius: 10px; overflow: hidden; border: 1px solid var(--c-border); }
.photo-thumb img { width: 100%; height: 100%; object-fit: cover; }
.no-photo { font-size: 13px; color: var(--c-text-3); padding: 10px 0; }

.actions-sec { border-top: 1px solid var(--c-border); padding-top: 18px; }
.quick-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.quick-actions .btn { width: auto; }
.closed-tip { font-size: 13px; color: var(--c-text-3); }
.action-form .form-group { margin-bottom: 12px; }
.action-form .form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 6px; }

.feedback { font-size: 13px; margin-top: 10px; padding: 8px 12px; border-radius: 8px; }
.feedback.error { background: var(--c-danger-bg); color: var(--c-danger); }
.feedback.success { background: var(--c-success-bg); color: var(--c-success); }

@media (max-width: 520px) { .drawer { max-width: 100%; } }
</style>
