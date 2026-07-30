<template>
  <div class="rectify-list-page">
    <div class="card">
      <div class="section-header">
        <h2>整改资料录入</h2>
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
                <button class="action-link" @click="openRectify(h)" :disabled="h.status === 'closed'">
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
          <label>整改照片</label>
          <div class="photo-upload-area">
            <div class="photo-list" v-if="rectifyPhotos.length > 0">
              <div v-for="(p, i) in rectifyPhotos" :key="i" class="photo-item">
                <img :src="p" class="photo-preview" />
                <button class="photo-remove" @click="rectifyPhotos.splice(i, 1)">&times;</button>
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
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showRectifyModal = false">取消</button>
          <button class="btn btn-primary" @click="submitRectify" :disabled="saving || !rectifyForm.rectify_description.trim()">
            {{ saving ? '提交中…' : '确认提交' }}
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
import { getHazards, getHazardDetail, rectifyHazard } from '@/api/hazard'
import { uploadHazardPhoto } from '@/api/hazard'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'

const list = ref([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = 15
const statusFilter = ref('')

const showRectifyModal = ref(false)
const currentHazard = ref(null)
const saving = ref(false)
const rectifyForm = reactive({ rectify_description: '' })
const rectifyPhotos = ref([])
const photoInput = ref(null)

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

function openRectify(h) {
  currentHazard.value = h
  rectifyForm.rectify_description = ''
  rectifyPhotos.value = []
  showRectifyModal.value = true
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
  if (!rectifyForm.rectify_description.trim()) return showToast('请填写整改描述', 'error')
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

onMounted(fetchList)
</script>

<style scoped>
.rectify-list-page { max-width: 1360px; }

.section-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px; flex-wrap: wrap; gap: 10px;
}
.section-header h2 { font-size: 18px; font-weight: 700; color: var(--c-text); }
.filter-bar { display: flex; gap: 8px; }
.filter-select {
  padding: 8px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); min-width: 130px;
}
.filter-select:focus { outline: none; border-color: var(--c-blue-600); }

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
