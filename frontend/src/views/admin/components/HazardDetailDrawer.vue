<template>
  <transition name="drawer">
    <div v-if="show" class="drawer-overlay" @click.self="onClose">
      <aside class="drawer">
        <!-- 头部 -->
        <header class="drawer-head">
          <div class="dh-left">
            <span class="mono code">{{ current?.hazard_code }}</span>
            <span v-if="current" :class="['badge', statusBadge(current.status)]">{{ statusLabel(current.status) }}</span>
            <span v-if="current?.is_overdue" class="badge badge-danger">超期</span>
          </div>
          <button class="drawer-close" @click="onClose" title="关闭"><Icon name="x" :size="18" /></button>
        </header>

        <div v-if="current" class="drawer-body">
          <!-- 基础信息 -->
          <section class="sec">
            <h4 class="sec-title">基础信息</h4>
            <div class="info-grid">
              <div class="info-item"><span class="k">单位</span><span class="v">{{ current.unit_name || '-' }}</span></div>
              <div class="info-item"><span class="k">业务部门</span><span class="v">{{ current.business_dept || '-' }}</span></div>
              <div class="info-item"><span class="k">隐患排查项目</span><span class="v">{{ current.hazard_investigation_item || '-' }}</span></div>
              <div class="info-item"><span class="k">业务部门负责人</span><span class="v">{{ current.business_dept_head || '-' }}</span></div>
              <div class="info-item"><span class="k">场所</span><span class="v">{{ current.location || '-' }}</span></div>
              <div class="info-item">
                <span class="k">等级</span>
                <span class="v"><span :class="['badge', levelBadge(current.hazard_level)]">{{ current.hazard_level || '-' }}</span></span>
              </div>
            </div>
            <div class="info-line"><span class="k">描述</span><p class="v">{{ current.description || '-' }}</p></div>
            <div class="info-line"><span class="k">整改情况</span><p class="v">{{ current.rectify_measures || '-' }}</p></div>
          </section>

          <!-- 整改 & 验收 -->
          <section class="sec">
            <h4 class="sec-title">整改 & 验收</h4>
            <div class="info-grid">
              <div class="info-item"><span class="k">责任人</span><span class="v">{{ current.responsible_person || '-' }}</span></div>
              <div class="info-item"><span class="k">计划完成</span><span class="v">{{ fmt(current.plan_finish_time) }}</span></div>
              <div class="info-item"><span class="k">整改进度</span><span class="v">{{ current.rectify_status || '-' }}</span></div>
              <div class="info-item"><span class="k">验收结论</span><span class="v">{{ current.verify_result || '-' }}</span></div>
              <div class="info-item"><span class="k">闭环时间</span><span class="v">{{ fmt(current.closed_at) }}</span></div>
              <div class="info-item"><span class="k">是否否决项</span><span class="v">{{ current.is_reject_item ? '是' : '否' }}</span></div>
              <div class="info-item"><span class="k">扣分项</span><span class="v">{{ current.deduct_score || '-' }}</span></div>
            </div>
            <div v-if="current.verify_comment" class="info-line"><span class="k">验收意见</span><p class="v">{{ current.verify_comment }}</p></div>
          </section>

          <!-- 照片 -->
          <section class="sec">
            <h4 class="sec-title">上报照片</h4>
            <div v-if="current.photos.report.length" class="photo-grid">
              <a v-for="p in current.photos.report" :key="p.id" :href="p.photo_url" target="_blank" class="photo-thumb">
                <img :src="p.photo_url" :alt="p.photo_url" />
              </a>
            </div>
            <p v-else class="no-photo">暂无上报照片</p>

            <h4 class="sec-title" style="margin-top:14px">整改后照片</h4>
            <div v-if="current.photos.rectify.length" class="photo-grid">
              <a v-for="p in current.photos.rectify" :key="p.id" :href="p.photo_url" target="_blank" class="photo-thumb">
                <img :src="p.photo_url" :alt="p.photo_url" />
              </a>
            </div>
            <p v-else class="no-photo">暂无整改照片</p>
          </section>

          <!-- 流转操作 -->
          <section class="sec actions-sec">
            <h4 class="sec-title">流转操作</h4>

            <!-- 快速按钮（随状态） -->
            <div class="quick-actions" v-if="actionMode === 'none'">
              <button v-if="current.status === 'reported'" class="btn btn-primary" @click="openAssign">分派</button>
              <button v-if="current.status === 'assigned'" class="btn btn-primary" @click="openRectify('整改中')">代录整改</button>
              <template v-if="current.status === 'rectifying'">
                <button class="btn btn-outline" @click="quickRectify('整改中')">继续整改</button>
                <button class="btn btn-primary" @click="openRectify('已完成')">标记完成 → 待验收</button>
              </template>
              <template v-if="current.status === 'verifying'">
                <div class="form-group"><label>是否否决项</label>
                  <select v-model="verifyForm.is_reject_item" class="form-input">
                    <option :value="0">否</option>
                    <option :value="1">是</option>
                  </select></div>
                <div class="form-group"><label>扣分项</label>
                  <input v-model="verifyForm.deduct_score" class="form-input" placeholder="如：扣 2 分" /></div>
                <button class="btn btn-success" @click="passVerify">验收通过</button>
                <button class="btn btn-danger" @click="openReject">退回</button>
              </template>
              <p v-if="current.status === 'closed'" class="closed-tip">该隐患已闭环，仅可查看。</p>
            </div>

            <!-- 分派表单 -->
            <div v-else-if="actionMode === 'assign'" class="action-form">
              <div class="form-group"><label>责任人</label>
                <input v-model="assignForm.responsible_person" class="form-input" /></div>
              <div class="form-group"><label>计划完成时间</label>
                <input v-model="assignForm.plan_finish_time" class="form-input" type="datetime-local" /></div>
              <div class="modal-actions">
                <button class="btn btn-outline" @click="cancelAction" :disabled="submitting">取消</button>
                <button class="btn btn-primary" @click="submitAssign" :disabled="submitting">确认分派</button>
              </div>
            </div>

            <!-- 整改表单 -->
            <div v-else-if="actionMode === 'rectify'" class="action-form">
              <div class="form-group"><label>整改进度</label>
                <select v-model="rectifyForm.rectify_status" class="form-input">
                  <option value="整改中">整改中</option>
                  <option value="已完成">已完成</option>
                </select></div>
              <div class="form-group"><label>整改情况</label>
                <textarea v-model="rectifyForm.rectify_measures" class="form-input" rows="2"></textarea></div>
              <div class="form-group"><label>整改照片</label>
                <HazardPhotoUpload v-model="rectifyPhotoUrls" photo-type="rectify" :max="9" /></div>
              <div class="modal-actions">
                <button class="btn btn-outline" @click="cancelAction" :disabled="submitting">取消</button>
                <button class="btn btn-primary" @click="submitRectify" :disabled="submitting">提交</button>
              </div>
            </div>

            <!-- 退回表单 -->
            <div v-else-if="actionMode === 'verify'" class="action-form">
              <div class="form-group"><label>是否否决项</label>
                <select v-model="verifyForm.is_reject_item" class="form-input">
                  <option :value="0">否</option>
                  <option :value="1">是</option>
                </select></div>
              <div class="form-group"><label>扣分项</label>
                <input v-model="verifyForm.deduct_score" class="form-input" placeholder="如：扣 2 分" /></div>
              <div class="form-group"><label>退回意见</label>
                <textarea v-model="verifyForm.verify_comment" class="form-input" rows="3" placeholder="说明退回原因"></textarea></div>
              <div class="modal-actions">
                <button class="btn btn-outline" @click="cancelAction" :disabled="submitting">取消</button>
                <button class="btn btn-danger" @click="submitReject" :disabled="submitting">确认退回</button>
              </div>
            </div>

            <p v-if="feedback" class="feedback" :class="feedbackType">{{ feedback }}</p>
          </section>
        </div>
      </aside>
    </div>
  </transition>
</template>

<script setup>
import { ref, reactive, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import HazardPhotoUpload from '@/views/admin/components/HazardPhotoUpload.vue'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'
import { assignHazard, rectifyHazard, verifyHazard, getHazardPhotos } from '@/api/hazard'

const props = defineProps({
  show: { type: Boolean, default: false },
  hazard: { type: Object, default: null },
})
const emit = defineEmits(['close', 'updated'])

const current = ref(null)
const actionMode = ref('none')
const submitting = ref(false)
const feedback = ref('')
const feedbackType = ref('')

const assignForm = reactive({ responsible_person: '', plan_finish_time: '' })
const rectifyForm = reactive({ rectify_status: '整改中', rectify_measures: '' })
const rectifyPhotoUrls = ref([])
const verifyForm = reactive({ is_reject_item: 0, deduct_score: '', verify_comment: '' })

watch(
  () => props.hazard,
  async (val) => {
    if (!val) {
      current.value = null
      return
    }
    // 基础信息先渲染（兼容列表项未携带 photos 的场景）
    current.value = {
      ...val,
      photos: { report: [], rectify: [], ...(val.photos || {}) },
    }
    actionMode.value = 'none'
    feedback.value = ''
    rectifyPhotoUrls.value = []
    verifyForm.is_reject_item = 0
    verifyForm.deduct_score = ''
    verifyForm.verify_comment = ''
    // T06：拉取该隐患照片（按 photo_type 拆分为「上报」「整改」两组），
    // 覆盖列表项未携带照片的情况，确保抽屉始终展示最新照片。
    try {
      const res = await getHazardPhotos(val.id)
      const rows = res.data?.data || []
      const report = []
      const rectify = []
      rows.forEach((p) => {
        if (p.photo_type === 'rectify') rectify.push(p)
        else report.push(p)
      })
      // 仅当仍为同一隐患时回填，避免快速切换导致照片错乱
      if (current.value && current.value.id === val.id) {
        current.value.photos = { report, rectify }
      }
    } catch (e) {
      // 照片拉取失败不影响详情其余展示
      console.error('[drawer photos]', e && e.message ? e.message : e)
    }
  },
  { immediate: true }
)

function onClose() {
  emit('close')
}

function fmt(v) {
  return v ? String(v) : '-'
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

function afterAction(newStatus, extra = {}) {
  if (current.value) {
    current.value.status = newStatus
    Object.assign(current.value, extra)
  }
  actionMode.value = 'none'
  emit('updated', current.value?.id)
}

// ─── 分派 ───────────────────────────────────────────────
function openAssign() {
  assignForm.responsible_person = current.value.responsible_person || ''
  assignForm.plan_finish_time = toLocalInput(current.value.plan_finish_time)
  actionMode.value = 'assign'
}
async function submitAssign() {
  if (!current.value) return
  submitting.value = true
  try {
    await assignHazard(current.value.id, {
      responsible_person: assignForm.responsible_person,
      plan_finish_time: toSql(assignForm.plan_finish_time),
    })
    afterAction('assigned')
  } catch (e) {
    setFeedback(e.response?.data?.error || '分派失败')
  } finally {
    submitting.value = false
  }
}

// ─── 整改 ───────────────────────────────────────────────
function openRectify(status) {
  rectifyForm.rectify_status = status
  rectifyForm.rectify_measures = current.value.rectify_measures || ''
  rectifyPhotoUrls.value = []
  actionMode.value = 'rectify'
}
async function quickRectify(status) {
  if (!current.value) return
  submitting.value = true
  try {
    await rectifyHazard(current.value.id, { rectify_status: status })
    afterAction(status === '已完成' ? 'verifying' : 'rectifying')
  } catch (e) {
    setFeedback(e.response?.data?.error || '整改失败')
  } finally {
    submitting.value = false
  }
}
async function submitRectify() {
  if (!current.value) return
  submitting.value = true
  try {
    await rectifyHazard(current.value.id, {
      rectify_status: rectifyForm.rectify_status,
      rectify_measures: rectifyForm.rectify_measures,
      rectify_photo_urls: [...rectifyPhotoUrls.value],
    })
    afterAction(rectifyForm.rectify_status === '已完成' ? 'verifying' : 'rectifying')
  } catch (e) {
    setFeedback(e.response?.data?.error || '整改失败')
  } finally {
    submitting.value = false
  }
}

// ─── 验收 ───────────────────────────────────────────────
async function passVerify() {
  if (!current.value) return
  submitting.value = true
  try {
    await verifyHazard(current.value.id, {
      verify_result: '通过',
      is_reject_item: verifyForm.is_reject_item ? 1 : 0,
      deduct_score: verifyForm.deduct_score,
    })
    afterAction('closed', {
      is_reject_item: verifyForm.is_reject_item ? 1 : 0,
      deduct_score: verifyForm.deduct_score,
    })
  } catch (e) {
    setFeedback(e.response?.data?.error || '验收失败')
  } finally {
    submitting.value = false
  }
}
function openReject() {
  verifyForm.verify_comment = ''
  actionMode.value = 'verify'
}
async function submitReject() {
  if (!current.value) return
  submitting.value = true
  try {
    await verifyHazard(current.value.id, {
      verify_result: '退回',
      verify_comment: verifyForm.verify_comment,
      is_reject_item: verifyForm.is_reject_item ? 1 : 0,
      deduct_score: verifyForm.deduct_score,
    })
    afterAction('rectifying', {
      verify_result: '退回',
      verify_comment: verifyForm.verify_comment,
      is_reject_item: verifyForm.is_reject_item ? 1 : 0,
      deduct_score: verifyForm.deduct_score,
    })
  } catch (e) {
    setFeedback(e.response?.data?.error || '退回失败')
  } finally {
    submitting.value = false
  }
}

function cancelAction() {
  actionMode.value = 'none'
  feedback.value = ''
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
