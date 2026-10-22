<template>
  <div class="users-page">
    <!-- 操作栏 -->
    <div class="toolbar card">
      <div class="search-wrap">
        <span class="search-icon"><Icon name="search" :size="17" /></span>
        <input v-model="keyword" class="search-input" placeholder="搜索编号 / 场所 / 分类 / 条款 / 依据 / 扣分等级…" @input="onSearchChange" />
      </div>
      <div class="toolbar-right">
        <span class="total-count">共 {{ total }} 条</span>
        <button class="btn btn-outline" @click="downloadTemplate"><Icon name="download" :size="17" />模板</button>
        <button class="btn btn-outline" @click="exportLib"><Icon name="download" :size="17" />导出</button>
        <button class="btn btn-outline" @click="showImport = true"><Icon name="upload" :size="17" />导入</button>
        <button class="btn btn-primary" @click="openAdd"><Icon name="plus" :size="17" />新增依据</button>
      </div>
    </div>

    <!-- 表格（横向滚动承载 8 列） -->
    <div class="card table-card">
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>违章编号</th>
              <th>适用场所</th>
              <th>违章分类</th>
              <th>细分环节</th>
              <th>检查对象</th>
              <th>违章条款具体内容</th>
              <th>检查依据</th>
              <th>扣分风险等级</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="9" class="empty-cell">暂无依据数据，点击「新增依据」或「导入」</td>
            </tr>
            <tr v-for="item in list" :key="item.id">
              <td class="mono">{{ item.code }}</td>
              <td>{{ item.place || '-' }}</td>
              <td><strong>{{ item.category }}</strong></td>
              <td>{{ item.sub_segment || '-' }}</td>
              <td>{{ item.inspect_object || '-' }}</td>
              <td class="basis-cell">{{ item.standard_basis }}</td>
              <td>{{ item.source || '-' }}</td>
              <td>{{ item.deduct_level || '-' }}</td>
              <td class="op-cell">
                <button class="action-link" @click="openEdit(item)"><Icon name="pencil" :size="14" /> 编辑</button>
                <button class="action-link danger" @click="removeItem(item)"><Icon name="trash" :size="14" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pagination" v-if="totalPages > 1">
        <button class="pg-btn" :disabled="page === 1" @click="page--"><Icon name="chevronLeft" :size="18" /></button>
        <span class="pg-info">{{ page }} / {{ totalPages }}</span>
        <button class="pg-btn" :disabled="page === totalPages" @click="page++"><Icon name="chevronRight" :size="18" /></button>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <div v-if="showImport" class="modal-overlay" @click.self="showImport = false">
      <div class="modal">
        <h3><Icon name="upload" :size="19" /> Excel 导入安全违章依据库</h3>
        <p class="modal-hint">
          请上传 .xlsx 文件，表头列名需包含：<strong>违章分类</strong>（必填）、
          <strong>违章条款具体内容</strong>（必填）、<strong>检查依据</strong>（选填）。<br />
          可选列：违章编号 / 适用场所 / 细分环节 / 检查对象 / 扣分风险等级。同一违章编号重复导入将更新。
        </p>
        <div class="file-upload" @click="triggerFile">
          <span class="upload-icon"><Icon name="file" :size="40" /></span>
          <p>{{ selectedFile ? selectedFile.name : '点击上传 .xlsx 文件' }}</p>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx" style="display:none" @change="handleFileChange" />

        <div class="modal-actions">
          <button class="btn btn-outline" @click="showImport = false">取消</button>
          <button class="btn btn-primary" @click="handleImport" :disabled="!selectedFile || importing">
            {{ importing ? '导入中…' : '确认导入' }}
          </button>
        </div>

        <div v-if="importResult" class="import-result" :class="importResult.fail > 0 ? 'has-fail' : 'all-ok'">
          <p>成功 {{ importResult.success }} 条 / 失败 {{ importResult.fail }} 条</p>
          <ul v-if="importResult.failRows && importResult.failRows.length" style="font-size:12px;margin-top:6px;color:var(--c-danger)">
            <li v-for="(f, i) in importResult.failRows.slice(0, 20)" :key="i">第 {{ f.row }} 行：{{ f.reason }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑弹窗 -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <h3><Icon :name="editing ? 'pencil' : 'plus'" :size="19" /> {{ editing ? '编辑依据' : '新增依据' }}</h3>
        <div class="edit-form">
          <div class="form-group">
            <label>违章编号</label>
            <input v-model="form.code" class="form-input" placeholder="留空自动生成（M 开头）" />
          </div>
          <div class="form-group">
            <label>违章分类 *</label>
            <input v-model="form.category" class="form-input" placeholder="如：直接作业安全" />
          </div>
          <div class="form-group">
            <label>适用场所</label>
            <input v-model="form.place" class="form-input" placeholder="如：陆上油气场站" />
          </div>
          <div class="form-group">
            <label>细分环节</label>
            <input v-model="form.sub_segment" class="form-input" placeholder="如：动火作业" />
          </div>
          <div class="form-group">
            <label>检查对象</label>
            <input v-model="form.inspect_object" class="form-input" placeholder="如：作业人员" />
          </div>
          <div class="form-group">
            <label>扣分风险等级</label>
            <input v-model="form.deduct_level" class="form-input" placeholder="如：扣2分/高风险" />
          </div>
          <div class="form-group full">
            <label>违章条款具体内容 *</label>
            <textarea v-model="form.standard_basis" class="form-input" rows="3" placeholder="违反的标准条款正文"></textarea>
          </div>
          <div class="form-group full">
            <label>检查依据</label>
            <input v-model="form.source" class="form-input" placeholder="如 GB 30871-2022" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showForm = false">取消</button>
          <button class="btn btn-primary" @click="handleSave" :disabled="saving || !form.category || !form.standard_basis">
            {{ saving ? '提交中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import {
  getStandardBasisList,
  createStandardBasis,
  updateStandardBasis,
  deleteStandardBasis,
  importStandardBasis,
  getStandardBasisTemplate,
  exportStandardBasis,
} from '@/api/hazard'

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const keyword = ref('')
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

let searchTimer = null
function onSearchChange() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; loadList() }, 300)
}

async function loadList() {
  loading.value = true
  try {
    const res = await getStandardBasisList({ page: page.value, pageSize: pageSize.value, keyword: keyword.value })
    list.value = res.data?.data?.list || []
    total.value = res.data?.data?.total || 0
  } catch (e) {
    showToast(e.response?.data?.error || '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

// ─── 新增 / 编辑 ────────────────────────────────────────────────────────────
const showForm = ref(false)
const editing = ref(null)
const saving = ref(false)
const form = reactive({ code: '', category: '', place: '', sub_segment: '', inspect_object: '', standard_basis: '', source: '', deduct_level: '' })

function openAdd() {
  editing.value = null
  Object.assign(form, { code: '', category: '', place: '', sub_segment: '', inspect_object: '', standard_basis: '', source: '', deduct_level: '' })
  showForm.value = true
}
function openEdit(item) {
  editing.value = item.id
  Object.assign(form, {
    code: item.code || '',
    category: item.category || '',
    place: item.place || '',
    sub_segment: item.sub_segment || '',
    inspect_object: item.inspect_object || '',
    standard_basis: item.standard_basis || '',
    source: item.source || '',
    deduct_level: item.deduct_level || '',
  })
  showForm.value = true
}
async function handleSave() {
  saving.value = true
  try {
    const payload = { ...form }
    if (editing.value) {
      await updateStandardBasis(editing.value, payload)
      showToast('已保存', 'success')
    } else {
      await createStandardBasis(payload)
      showToast('已新增', 'success')
    }
    showForm.value = false
    loadList()
  } catch (e) {
    showToast(e.response?.data?.error || '保存失败', 'error')
  } finally {
    saving.value = false
  }
}
async function removeItem(item) {
  if (!confirm(`确认删除「${item.category}（${item.code}）」的依据？`)) return
  try {
    await deleteStandardBasis(item.id)
    showToast('已删除', 'success')
    loadList()
  } catch (e) {
    showToast(e.response?.data?.error || '删除失败', 'error')
  }
}

// ─── 导入 ──────────────────────────────────────────────────────────────────
const showImport = ref(false)
const selectedFile = ref(null)
const importing = ref(false)
const importResult = ref(null)
const fileInput = ref(null)

function triggerFile() { fileInput.value?.click() }
function handleFileChange(e) {
  const f = e.target.files?.[0]
  if (f) { selectedFile.value = f; importResult.value = null }
}
async function handleImport() {
  if (!selectedFile.value) return
  importing.value = true
  importResult.value = null
  try {
    const res = await importStandardBasis(selectedFile.value)
    importResult.value = {
      success: res.data?.data?.imported || 0,
      fail: res.data?.data?.failed || 0,
      failRows: res.data?.data?.failRows || [],
    }
    showToast('导入完成', 'success')
    selectedFile.value = null
    if (fileInput.value) fileInput.value.value = ''
    loadList()
  } catch (e) {
    showToast(e.response?.data?.error || '导入失败', 'error')
  } finally {
    importing.value = false
  }
}

// ─── 模板 / 导出（blob 下载）─────────────────────────────────────────────────
function downloadBlob(res, filename) {
  const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}
async function downloadTemplate() {
  try {
    const res = await getStandardBasisTemplate()
    downloadBlob(res, 'standard_basis_template.xlsx')
  } catch (e) {
    showToast(e.response?.data?.error || '下载模板失败', 'error')
  }
}
async function exportLib() {
  try {
    const res = await exportStandardBasis()
    downloadBlob(res, 'standard_basis_export.xlsx')
  } catch (e) {
    showToast(e.response?.data?.error || '导出失败', 'error')
  }
}

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}

onMounted(loadList)
</script>

<style scoped>
.users-page { max-width: 1280px; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 14px 18px; margin-bottom: 16px; flex-wrap: wrap; }
.search-wrap { position: relative; flex: 1; min-width: 240px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--c-text-2); }
.search-input { width: 100%; padding: 9px 12px 9px 38px; border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-bg); color: var(--c-text); }
.toolbar-right { display: flex; align-items: center; gap: 8px; }
.total-count { font-size: 13px; color: var(--c-text-2); white-space: nowrap; }
.table-card { padding: 8px 0 16px; }
.table-scroll { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; min-width: 1100px; }
.data-table th, .data-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--c-border); font-size: 14px; vertical-align: top; }
.data-table th { font-size: 12px; color: var(--c-text-2); font-weight: 600; background: var(--c-bg-soft); white-space: nowrap; }
.basis-cell { max-width: 380px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.op-cell { white-space: nowrap; }
.mono { font-family: ui-monospace, monospace; }
.empty-cell { text-align: center; color: var(--c-text-2); padding: 28px; }
.action-link { background: none; border: none; color: var(--c-primary); cursor: pointer; font-size: 13px; margin-right: 10px; }
.action-link.danger { color: var(--c-danger); }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 14px; }
.pg-btn { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-bg); color: var(--c-text); cursor: pointer; }
.pg-btn:disabled { opacity: .4; cursor: not-allowed; }
.pg-info { font-size: 13px; color: var(--c-text-2); }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 1500; padding: 20px; }
.modal { background: var(--c-bg); border-radius: 16px; padding: 22px; width: 100%; max-width: 560px; max-height: 88vh; overflow: auto; box-shadow: var(--shadow-lg); }
.modal h3 { display: flex; align-items: center; gap: 8px; font-size: 17px; margin-bottom: 14px; }
.modal-hint { font-size: 13px; color: var(--c-text-2); line-height: 1.6; margin-bottom: 14px; }
.file-upload { border: 1.5px dashed var(--c-border); border-radius: 12px; padding: 28px; text-align: center; cursor: pointer; color: var(--c-text-2); }
.upload-icon { color: var(--c-text-2); display: block; margin-bottom: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.edit-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.edit-form .form-group.full { grid-column: 1 / -1; }
.edit-form label { display: block; font-size: 13px; font-weight: 500; color: var(--c-text-2); margin-bottom: 6px; }
.form-input { width: 100%; padding: 9px 12px; border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-bg); color: var(--c-text); }
.import-result { margin-top: 14px; padding: 12px 14px; border-radius: 10px; font-size: 14px; }
.import-result.all-ok { background: rgba(16,185,129,.12); color: var(--c-success); }
.import-result.has-fail { background: rgba(239,68,68,.1); color: var(--c-danger); }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.btn-primary { background: var(--c-primary); color: #fff; }
.btn-outline { background: transparent; border-color: var(--c-border); color: var(--c-text); }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 2000; padding: 12px 20px; border-radius: 12px; font-size: 14px; font-weight: 600; color: #fff; box-shadow: var(--shadow-lg); max-width: 90vw; }
.toast.success { background: var(--c-success); }
.toast.error { background: var(--c-danger); }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, -12px); }
@media (max-width: 640px) { .edit-form { grid-template-columns: 1fr; } }
</style>
