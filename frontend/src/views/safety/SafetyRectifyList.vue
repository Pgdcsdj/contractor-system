<template>
  <div class="rectify-list-page">
    <div class="card">
      <div class="section-header">
        <h2>整改资料录入</h2>
        <div class="filter-bar">
          <select v-model="unitFilter" class="filter-select" @change="onFilterChange">
            <option value="">全部单位</option>
            <option v-for="u in unitOptions" :key="u.value" :value="u.value">{{ u.label }}</option>
          </select>
          <select v-model="statusFilter" class="filter-select" @change="onFilterChange">
            <option value="">全部状态</option>
            <option value="reported">已上报</option>
            <option value="rectifying">整改中</option>
            <option value="verifying">待验收</option>
            <option value="closed">已闭环</option>
          </select>
          <button v-if="unitFilter || statusFilter" class="btn-ghost" type="button" @click="resetFilters">重置</button>
        </div>
      </div>

      <div class="table-card">
        <table class="data-table">
          <thead>
            <tr>
              <th>隐患编号</th>
              <th>责任单位</th>
              <th>场所</th>
              <th>隐患排查项目</th>
              <th>问题描述</th>
              <th>等级</th>
              <th>状态</th>
              <th>上报时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="9" class="empty-cell">暂无隐患记录</td>
            </tr>
            <tr v-for="h in list" :key="h.id">
              <td class="mono">{{ h.hazard_code || '-' }}</td>
              <td>{{ h.unit_name || '-' }}</td>
              <td>{{ h.location || '-' }}</td>
              <td>{{ h.hazard_investigation_item || '-' }}</td>
              <td class="desc-cell" :title="h.description">{{ h.description || '-' }}</td>
              <td><span :class="['badge', levelBadge(h.hazard_level)]">{{ h.hazard_level || '-' }}</span></td>
              <td><span :class="['badge', statusBadge(h.status)]">{{ statusLabel(h.status) }}</span></td>
              <td class="mono" style="font-size:12px">{{ fmtDate(h.created_at) }}</td>
              <td>
                <button class="action-link" @click="openDetail(h)">查看</button>
                <button class="action-link primary" @click="openRectify(h)" :disabled="h.status === 'closed'">
                  {{ h.status === 'closed' ? '已闭环' : '录入整改资料' }}
                </button>
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

    <!-- 整改弹窗 -->
    <div v-if="showRectifyModal" class="modal-overlay" @click.self="showRectifyModal = false">
      <div class="modal">
        <h3>录入整改资料</h3>
        <p class="modal-hint">隐患编号：{{ currentHazard?.hazard_code || '-' }}</p>
        <div class="form-group">
          <label>整改情况 <span class="req">*</span></label>
          <textarea v-model="rectifyForm.rectify_description" class="form-input" rows="4" placeholder="填写整改情况、完成情况等"></textarea>
        </div>
        <div class="form-group">
          <label>整改后照片 <span class="req">*</span>（至少 1 张）</label>
          <div class="photo-upload-area">
            <div class="photo-list" v-if="rectifyPhotos.length > 0">
              <div v-for="(p, i) in rectifyPhotos" :key="i" class="photo-item">
                <img :src="p" class="photo-preview" />
                <button class="photo-remove" type="button" @click="rectifyPhotos.splice(i, 1)">&times;</button>
              </div>
            </div>
            <div class="upload-trigger" @click="triggerPhotoInput" v-if="rectifyPhotos.length < 9">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
              </svg>
              <span>添加照片</span>
            </div>
            <input ref="photoInput" type="file" accept="image/*" style="display:none" @change="handlePhotoSelect" />
          </div>
          <p class="finish-tip">现场检查问题闭环前，整改情况与整改后照片二者缺一不可。</p>
          <div v-if="existingRectifyPhotos.length" class="existing-photos">
            <span>已上传的整改后照片（{{ existingRectifyPhotos.length }}）：</span>
            <a v-for="p in existingRectifyPhotos" :key="p.id" :href="p.photo_url" target="_blank" class="photo-item small">
              <img :src="p.photo_url" class="photo-preview" />
            </a>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showRectifyModal = false">取消</button>
          <button class="btn btn-primary" @click="submitRectify" :disabled="saving || !canSubmitRectify">
            {{ saving ? '提交中…' : '确认提交' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 隐患详情弹窗：查看具体内容 + 整改前后照片 -->
    <div v-if="showDetail" class="modal-overlay" @click.self="showDetail = false">
      <div class="modal detail-modal">
        <h3>隐患详情</h3>
        <p class="modal-hint mono">{{ detail?.hazard_code || '-' }}</p>
        <div class="detail-badges">
          <span :class="['badge', levelBadge(detail?.hazard_level)]">{{ detail?.hazard_level || '-' }}</span>
          <span :class="['badge', statusBadge(detail?.status)]">{{ statusLabel(detail?.status) }}</span>
        </div>
        <div v-if="detailLoading" class="detail-loading">加载中…</div>
        <template v-else>
          <dl class="detail-list">
            <div v-for="row in detailRows" :key="row.label" class="detail-row">
              <dt>{{ row.label }}</dt>
              <dd :class="{ 'value-warn': row.warn }">{{ row.value }}<span v-if="row.warn" class="inline-warn">（未录入，闭环前必须补齐）</span></dd>
            </div>
          </dl>
          <div class="detail-photos">
            <h4>上报照片（整改前）</h4>
            <div v-if="detailPhotos.report.length" class="photo-grid">
              <a v-for="p in detailPhotos.report" :key="p.id" :href="p.photo_url" target="_blank" class="photo-item">
                <img :src="p.photo_url" class="photo-preview" />
              </a>
            </div>
            <p v-else class="no-photo">暂无上报照片</p>
          </div>
          <div class="detail-photos">
            <h4>整改后照片</h4>
            <div v-if="detailPhotos.rectify.length" class="photo-grid">
              <a v-for="p in detailPhotos.rectify" :key="p.id" :href="p.photo_url" target="_blank" class="photo-item">
                <img :src="p.photo_url" class="photo-preview" />
              </a>
            </div>
            <p v-else class="no-photo warn">未上传整改后照片，闭环前必须补齐</p>
          </div>
        </template>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showDetail = false">关闭</button>
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
import { getHazards, getHazardDetail, getHazardsUnitNames, rectifyHazard } from '@/api/hazard'
import { uploadHazardPhoto } from '@/api/hazard'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'

const list = ref([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = 15
const statusFilter = ref('')
const unitFilter = ref('')
const unitOptions = ref([])

const showRectifyModal = ref(false)
const currentHazard = ref(null)
const saving = ref(false)
const rectifyForm = reactive({ rectify_description: '' })
const rectifyPhotos = ref([])
const photoInput = ref(null)
const existingRectifyPhotos = ref([])

// 详情弹窗
const showDetail = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
const detailPhotos = ref({ report: [], rectify: [] })

/** 整改情况 + 整改后照片（本次新上传或历史已有）二者齐备才可提交 */
const canSubmitRectify = computed(() =>
  rectifyForm.rectify_description.trim().length > 0 &&
  (rectifyPhotos.value.length > 0 || existingRectifyPhotos.value.length > 0)
)

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

function buildParams() {
  const p = { page: page.value, pageSize }
  if (statusFilter.value) p.status = statusFilter.value
  if (unitFilter.value) p.unit_name = unitFilter.value
  return p
}

function onFilterChange() {
  if (page.value !== 1) { page.value = 1; return }
  fetchList()
}
function resetFilters() {
  unitFilter.value = ''
  statusFilter.value = ''
  onFilterChange()
}
async function loadUnitOptions() {
  try {
    const res = await getHazardsUnitNames()
    unitOptions.value = (res.data?.data?.list || []).map((x) => ({ value: x.unit_name, label: x.unit_name }))
  } catch (e) { /* 静默 */ }
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

async function openRectify(h) {
  currentHazard.value = h
  rectifyForm.rectify_description = h.rectify_measures || ''
  rectifyPhotos.value = []
  existingRectifyPhotos.value = []
  showRectifyModal.value = true
  // 载入已有整改后照片，避免重复上传，也用于判断"资料已齐"
  try {
    const res = await getHazardDetail(h.id)
    const photos = res.data?.data?.photos || {}
    existingRectifyPhotos.value = photos.rectify || []
    if (!rectifyForm.rectify_description && res.data?.data?.rectify_measures) {
      rectifyForm.rectify_description = res.data.data.rectify_measures
    }
  } catch (e) { /* 详情加载失败不阻塞录入 */ }
}

// ─── 详情查看 ──────────────────────────────────────────────────────────────
const detailRows = computed(() => {
  const h = detail.value
  if (!h) return []
  const rows = [
    ['隐患排查项目', h.hazard_investigation_item],
    ['责任单位', h.unit_name],
    ['业务部门', h.business_dept],
    ['业务部门负责人', h.business_dept_head],
    ['场所', h.location],
    ['隐患等级', h.hazard_level],
    ['问题描述', h.description],
    ['标准依据', h.standard_basis],
    ['整改情况', h.rectify_measures],
    ['整改进度', h.rectify_status],
    ['整改责任人', h.responsible_person],
    ['计划完成时间', h.plan_finish_time],
    ['验收结论', h.verify_result],
    ['验收意见', h.verify_comment],
    ['闭环时间', h.closed_at],
    ['上报时间', h.created_at],
    ['录入人', h.recorder_name],
  ]
  return rows.map(([label, value]) => ({
    label, value: value || '-',
    warn: label === '整改情况' && !String(value || '').trim(),
  }))
})

async function openDetail(h) {
  detail.value = h
  detailLoading.value = true
  detailPhotos.value = { report: [], rectify: [] }
  showDetail.value = true
  try {
    const res = await getHazardDetail(h.id)
    const d = res.data?.data
    if (d) {
      detail.value = d
      detailPhotos.value = d.photos || { report: [], rectify: [] }
    }
  } catch (e) {
    showToast(e.response?.data?.error || '加载详情失败', 'error')
  } finally {
    detailLoading.value = false
  }
}

function triggerPhotoInput() {
  photoInput.value?.click()
}

async function handlePhotoSelect(e) {
  const file = e.target.files?.[0]
  if (!file) return
  try {
    const res = await uploadHazardPhoto(file, 'rectify')
    const url = res.data?.data?.url || res.data?.url
    if (url) rectifyPhotos.value.push(url)
  } catch (e) {
    showToast('照片上传失败', 'error')
  }
  // reset input for re-select
  if (photoInput.value) photoInput.value.value = ''
}

async function submitRectify() {
  if (!rectifyForm.rectify_description.trim()) return showToast('请填写整改情况', 'error')
  if (!rectifyPhotos.value.length && !existingRectifyPhotos.value.length) {
    return showToast('请至少上传 1 张整改后照片', 'error')
  }
  if (!currentHazard.value) return

  saving.value = true
  try {
    const payload = {
      rectify_description: rectifyForm.rectify_description.trim(),
    }
    if (rectifyPhotos.value.length > 0) {
      payload.rectify_photos = [...rectifyPhotos.value]
    }
    await rectifyHazard(currentHazard.value.id, payload)
    showToast('整改资料已提交', 'success')
    showRectifyModal.value = false
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '提交失败', 'error')
  } finally {
    saving.value = false
  }
}

watch(page, fetchList)

onMounted(() => {
  fetchList()
  loadUnitOptions()
})
</script>

<style scoped>
.rectify-list-page { max-width: 1360px; }

.section-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px; flex-wrap: wrap; gap: 10px;
}
.section-header h2 { font-size: 18px; font-weight: 700; color: var(--c-text); }
.filter-bar { display: flex; gap: 8px; align-items: center; }
.filter-select {
  padding: 8px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); min-width: 130px; max-width: 190px;
}
.filter-select:focus { outline: none; border-color: var(--c-blue-600); }
.btn-ghost { border: none; background: none; color: var(--c-text-2); font-size: 13px; cursor: pointer; padding: 6px 4px; }
.btn-ghost:hover { color: var(--c-primary); }
.action-link.primary { color: var(--c-blue-600); font-weight: 600; }

.table-card { padding: 0; overflow-x: auto; }
.desc-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 照片上传 */
.photo-upload-area { display: flex; flex-wrap: wrap; gap: 10px; }
.photo-list { display: flex; flex-wrap: wrap; gap: 10px; width: 100%; }
.photo-item { position: relative; width: 80px; height: 80px; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
.photo-preview { width: 100%; height: 100%; object-fit: cover; }
.photo-remove {
  position: absolute; top: 2px; right: 2px; width: 20px; height: 20px;
  border-radius: 50%; border: none; background: rgba(0,0,0,.55); color: #fff;
  font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.upload-trigger {
  width: 80px; height: 80px; border: 2px dashed var(--c-border-strong); border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  cursor: pointer; color: var(--c-text-3); font-size: 11px; gap: 4px;
  transition: border-color .2s;
}
.upload-trigger:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }

.req { color: var(--c-danger); }
.finish-tip { font-size: 12px; color: var(--c-warning, #ba7517); background: var(--c-warning-bg, #fff7e6); border-radius: 8px; padding: 8px 10px; margin: 10px 0 0; line-height: 1.5; }
.existing-photos { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--c-text-2); }
.existing-photos .photo-item.small { width: 56px; height: 56px; border-radius: 8px; overflow: hidden; border: 1px solid var(--c-border); }

/* 详情弹窗 */
.detail-modal { max-width: 620px; max-height: 88vh; display: flex; flex-direction: column; }
.detail-modal .modal-hint { margin-bottom: 8px; }
.detail-badges { display: flex; gap: 8px; margin-bottom: 12px; }
.detail-list { display: flex; flex-direction: column; gap: 11px; margin: 0; overflow-y: auto; flex: 1; }
.detail-row { display: flex; flex-direction: column; gap: 3px; }
.detail-row dt { font-size: 12px; color: var(--c-text-3); }
.detail-row dd { font-size: 13.5px; color: var(--c-text); white-space: pre-wrap; word-break: break-word; margin: 0; }
.value-warn { color: var(--c-warning, #ba7517); }
.inline-warn { font-size: 11.5px; margin-left: 6px; }
.detail-loading { font-size: 13px; color: var(--c-text-3); padding: 20px 0; }
.detail-photos { margin-top: 16px; }
.detail-photos h4 { font-size: 13px; font-weight: 700; color: var(--c-text); margin: 0 0 8px; }
.photo-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.photo-grid .photo-item { display: block; border-radius: 8px; overflow: hidden; border: 1px solid var(--c-border); height: 84px; }
.photo-grid .photo-preview { width: 100%; height: 100%; object-fit: cover; display: block; }
.no-photo { font-size: 12.5px; color: var(--c-text-3); margin: 0; }
.no-photo.warn { color: var(--c-warning, #ba7517); }
.mono { font-family: ui-monospace, monospace; }

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
</style>
