<template>
  <div class="users-page">
    <!-- 操作栏 -->
    <div class="toolbar card">
      <div class="search-wrap">
        <span class="search-icon"><Icon name="search" :size="17" /></span>
        <input v-model="keyword" class="search-input" placeholder="搜索单位名称 / 主管单位 / 联系人…" @input="onSearchChange" />
      </div>
      <div class="toolbar-right">
        <span class="total-count">共 {{ totalCount }} 家</span>
        <button class="btn btn-primary" @click="showAdd = true">
          <Icon name="plus" :size="17" />新增单位
        </button>
        <button class="btn btn-outline" @click="showImport = true">
          <Icon name="upload" :size="17" />导入单位
        </button>
      </div>
    </div>

    <!-- 单位表格 -->
    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th>单位名称</th><th>主管单位</th><th>联系人</th><th>联系电话</th><th>安全员</th><th>状态</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="8" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
          </tr>
          <tr v-else-if="list.length === 0">
            <td colspan="8" class="empty-cell">暂无承包商单位数据</td>
          </tr>
          <tr v-for="item in paginatedList" :key="item.id">
            <td><strong>{{ item.unit_name }}</strong></td>
            <td>{{ item.supervising_unit || '-' }}</td>
            <td>{{ item.contact_name || '-' }}</td>
            <td class="mono">{{ item.contact_phone || '-' }}</td>
            <td>{{ (item.safety_officer_name || '-') + (item.safety_officer_phone ? ' / ' + item.safety_officer_phone : '') }}</td>
            <td>
              <span :class="['badge', Number(item.is_active) === 1 ? 'badge-success' : 'badge-danger']">
                {{ Number(item.is_active) === 1 ? '在册' : '退场' }}
              </span>
            </td>
            <td class="mono" style="font-size:12px">{{ item.created_at ? formatDate(item.created_at) : '-' }}</td>
            <td><button class="action-link" @click="editItem(item)"><Icon name="pencil" :size="14" /> 编辑</button></td>
          </tr>
        </tbody>
      </table>

      <!-- 分页 -->
      <div class="pagination" v-if="totalPages > 1">
        <button class="pg-btn" :disabled="page === 1" @click="page--"><Icon name="chevronLeft" :size="18" /></button>
        <span class="pg-info">{{ page }} / {{ totalPages }}</span>
        <button class="pg-btn" :disabled="page === totalPages" @click="page++"><Icon name="chevronRight" :size="18" /></button>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <div v-if="showImport" class="modal-overlay" @click.self="showImport = false">
      <div class="modal">
        <h3><Icon name="upload" :size="19" /> Excel 导入承包商单位</h3>
        <p class="modal-hint">
          请上传 .xlsx 文件，表头列名需包含：<strong>承包商单位名称</strong>（必填），
          <strong>甲方主管单位、联系人、联系电话、安全员姓名、安全员手机号</strong>（选填）
        </p>
        <div class="file-upload" @click="triggerFile" :class="{ dragover: isDragover }"
          @dragover.prevent="isDragover = true"
          @dragleave="isDragover = false"
          @drop.prevent="handleDrop">
          <span class="upload-icon"><Icon name="file" :size="40" /></span>
          <p>{{ selectedFile ? selectedFile.name : '点击或拖拽上传 .xlsx 文件' }}</p>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="handleFileChange" />

        <div class="modal-actions">
          <button class="btn btn-outline" @click="showImport = false">取消</button>
          <button class="btn btn-primary" @click="handleImport" :disabled="!selectedFile || importing">
            <Icon v-if="importing" name="loop" :size="17" class="spin" />
            {{ importing ? '导入中…' : '确认导入' }}
          </button>
        </div>

        <div v-if="importResult" class="import-result" :class="importResult.fail > 0 ? 'has-fail' : 'all-ok'">
          <p><Icon :name="importResult.fail > 0 ? 'alert' : 'check'" :size="15" /> 成功 {{ importResult.success }} 条</p>
          <p v-if="importResult.fail > 0">失败 {{ importResult.fail }} 条</p>
          <ul v-if="importResult.failPreview && importResult.failPreview.length" style="font-size:12px;margin-top:6px;color:var(--c-danger)">
            <li v-for="(f, i) in importResult.failPreview" :key="i">{{ f }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 新增弹窗 -->
    <div v-if="showAdd" class="modal-overlay" @click.self="showAdd = false">
      <div class="modal">
        <h3><Icon name="plus" :size="19" /> 新增承包商单位</h3>
        <div class="edit-form">
          <div class="form-group"><label>单位名称 *</label><input v-model="addForm.unit_name" class="form-input" /></div>
          <div class="form-group"><label>甲方主管单位</label><input v-model="addForm.supervising_unit" class="form-input" /></div>
          <div class="form-group"><label>联系人</label><input v-model="addForm.contact_name" class="form-input" /></div>
          <div class="form-group"><label>联系电话</label><input v-model="addForm.contact_phone" class="form-input" /></div>
          <div class="form-group"><label>安全员姓名</label><input v-model="addForm.safety_officer_name" class="form-input" /></div>
          <div class="form-group"><label>安全员手机号</label><input v-model="addForm.safety_officer_phone" class="form-input" /></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showAdd = false">取消</button>
          <button class="btn btn-primary" @click="handleAdd" :disabled="adding || !addForm.unit_name">
            <Icon v-if="adding" name="loop" :size="17" class="spin" />
            {{ adding ? '提交中…' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="showEdit" class="modal-overlay" @click.self="showEdit = false">
      <div class="modal">
        <h3><Icon name="pencil" :size="19" /> 编辑承包商单位</h3>
        <div class="edit-form">
          <div class="form-group"><label>单位名称</label><input v-model="editForm.unit_name" class="form-input" /></div>
          <div class="form-group"><label>甲方主管单位</label><input v-model="editForm.supervising_unit" class="form-input" /></div>
          <div class="form-group"><label>联系人</label><input v-model="editForm.contact_name" class="form-input" /></div>
          <div class="form-group"><label>联系电话</label><input v-model="editForm.contact_phone" class="form-input" /></div>
          <div class="form-group"><label>安全员姓名</label><input v-model="editForm.safety_officer_name" class="form-input" /></div>
          <div class="form-group"><label>安全员手机号</label><input v-model="editForm.safety_officer_phone" class="form-input" /></div>
          <div class="form-group">
            <label>状态</label>
            <select v-model="editForm.is_active" class="form-input">
              <option :value="1">在册</option>
              <option :value="0">退场</option>
            </select>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" @click="handleEdit" :disabled="saving">
            <Icon v-if="saving" name="loop" :size="17" class="spin" />
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { request } from '@/utils/request'
import Icon from '@/components/Icon.vue'

const list = ref([])
const loading = ref(true)
const keyword = ref('')
const page = ref(1)
const pageSize = 20
const totalCount = ref(0)

const showImport = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const isDragover = ref(false)
const importing = ref(false)
const importResult = ref(null)

const showEdit = ref(false)
const editForm = ref({
  id: null, unit_name: '', supervising_unit: '', contact_name: '', contact_phone: '',
  safety_officer_name: '', safety_officer_phone: '', is_active: 1,
})
const saving = ref(false)

const showAdd = ref(false)
const addForm = ref({
  unit_name: '', supervising_unit: '', contact_name: '', contact_phone: '',
  safety_officer_name: '', safety_officer_phone: '',
})
const adding = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize)))
const paginatedList = computed(() => list.value)

function onSearchChange() { page.value = 1; fetchList() }

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function handleAdd() {
  if (!addForm.value.unit_name) return
  adding.value = true
  try {
    await request.post('/api/contractor-units', { ...addForm.value })
    showAdd.value = false
    addForm.value = { unit_name: '', supervising_unit: '', contact_name: '', contact_phone: '', safety_officer_name: '', safety_officer_phone: '' }
    fetchList()
  } catch (e) {
    alert(e.response?.data?.error || '添加失败')
  } finally {
    adding.value = false
  }
}

function triggerFile() { fileInput.value?.click() }
function handleFileChange(e) { selectedFile.value = e.target.files[0] }
function handleDrop(e) {
  isDragover.value = false
  const f = e.dataTransfer.files[0]
  if (f && /\.(xlsx|xls)$/i.test(f.name)) selectedFile.value = f
}

async function handleImport() {
  if (!selectedFile.value) return
  importing.value = true
  importResult.value = null
  const form = new FormData()
  form.append('file', selectedFile.value)
  try {
    const res = await request.post('/api/contractor-units/import', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    importResult.value = res.data.data || res.data
    if (!importResult.value.fail) {
      setTimeout(() => { showImport.value = false; fetchList() }, 1500)
    }
  } catch (e) {
    importResult.value = { success: 0, fail: 1, failPreview: [e.response?.data?.error || '导入失败'] }
  } finally {
    importing.value = false
  }
}

function editItem(item) {
  editForm.value = {
    id: item.id,
    unit_name: item.unit_name || '',
    supervising_unit: item.supervising_unit || '',
    contact_name: item.contact_name || '',
    contact_phone: item.contact_phone || '',
    safety_officer_name: item.safety_officer_name || '',
    safety_officer_phone: item.safety_officer_phone || '',
    is_active: Number(item.is_active) ?? 1,
  }
  showEdit.value = true
}

async function handleEdit() {
  saving.value = true
  try {
    await request.put(`/api/contractor-units/${editForm.value.id}`, {
      unit_name: editForm.value.unit_name,
      supervising_unit: editForm.value.supervising_unit,
      contact_name: editForm.value.contact_name,
      contact_phone: editForm.value.contact_phone,
      safety_officer_name: editForm.value.safety_officer_name,
      safety_officer_phone: editForm.value.safety_officer_phone,
      is_active: editForm.value.is_active,
    })
    showEdit.value = false
    fetchList()
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

async function fetchList() {
  loading.value = true
  try {
    const params = { page: page.value, pageSize }
    if (keyword.value) params.keyword = keyword.value
    const res = await request.get('/api/contractor-units', { params })
    const data = res.data?.data
    list.value = data?.list || []
    totalCount.value = data?.total || 0
  } catch {
    list.value = []
    totalCount.value = 0
  }
  loading.value = false
}

onMounted(() => { fetchList() })
watch(page, fetchList)
</script>

<style scoped>
.users-page { max-width: 1200px; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 14px; flex-wrap: wrap;
}
.search-wrap { position: relative; display: flex; gap: 8px; flex: 1; flex-wrap: wrap; min-width: 240px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--c-text-3); pointer-events: none; }
.search-input {
  flex: 1; min-width: 220px; max-width: 320px; padding: 10px 14px 10px 38px;
  border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 14px;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.search-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29, 111, 184, .15); }
.toolbar-right { display: flex; align-items: center; gap: 12px; }
.total-count { font-size: 13px; color: var(--c-text-2); white-space: nowrap; }

.table-card { padding: 0; overflow: hidden; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; font-family: var(--font-sans); color: var(--c-text); }
.data-table th {
  text-align: left; padding: 13px 16px;
  background: var(--c-surface-2); color: var(--c-text-2);
  font-weight: 600; font-size: 12.5px; letter-spacing: .3px;
  border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.data-table td { padding: 13px 16px; border-bottom: 1px solid var(--c-border); }
.data-table tr:last-child td { border-bottom: none; }
.data-table tbody tr { transition: background .15s ease; }
.data-table tbody tr:hover td { background: var(--c-surface-2); }
.mono { font-family: var(--font-mono); font-size: 13px; color: var(--c-text-2); }
.empty-cell { text-align: center; padding: 44px; color: var(--c-text-3); }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; border-top: 1px solid var(--c-border); }
.pg-btn { width: 34px; height: 34px; border: 1px solid var(--c-border-strong); border-radius: var(--r-sm); background: var(--c-surface); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--c-text-2); transition: border-color .15s, color .15s; }
.pg-btn:hover:not(:disabled) { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.pg-btn:disabled { opacity: .4; cursor: default; }
.pg-info { font-size: 13px; color: var(--c-text-2); }

.modal-overlay { position: fixed; inset: 0; background: rgba(10, 19, 34, .55); backdrop-filter: blur(3px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; animation: overlay-in .2s ease; }
.modal { background: var(--c-surface); border-radius: var(--r-lg); padding: 28px; width: 100%; max-width: 460px; box-shadow: var(--shadow-lg); animation: modal-in .22s cubic-bezier(.22, 1, .36, 1); }
.modal h3 { font-size: 18px; font-weight: 700; color: var(--c-text); margin-bottom: 8px; display: flex; align-items: center; gap: 9px; }
.modal-hint { font-size: 13px; color: var(--c-text-2); margin-bottom: 18px; line-height: 1.65; }

.file-upload { border: 2px dashed var(--c-border-strong); border-radius: var(--r); padding: 32px; text-align: center; cursor: pointer; margin-bottom: 16px; transition: border-color .2s ease, background .2s ease; }
.file-upload:hover, .file-upload.dragover { border-color: var(--c-blue-600); background: var(--c-blue-50); }
.upload-icon { display: block; margin-bottom: 8px; color: var(--c-blue-600); }
.file-upload p { font-size: 13px; color: var(--c-text-2); }

.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.modal-actions .btn { width: auto; }
.spin { animation: spin .9s linear infinite; }

.import-result { margin-top: 14px; padding: 12px 14px; border-radius: var(--r); font-size: 14px; line-height: 1.6; display: flex; flex-direction: column; gap: 2px; }
.import-result.has-fail { background: var(--c-danger-bg); color: var(--c-danger); }
.import-result.all-ok { background: var(--c-success-bg); color: var(--c-success); }
.import-result ul { margin-top: 6px; font-size: 12.5px; }

.action-link { display: inline-flex; align-items: center; gap: 4px; background: none; border: none; color: var(--c-blue-600); cursor: pointer; font-size: 13px; font-weight: 500; padding: 5px 9px; border-radius: var(--r-sm); transition: background .15s ease; }
.action-link:hover { background: var(--c-blue-50); }

.edit-form { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
.edit-form label { font-size: 13px; color: var(--c-text-2); margin-bottom: 2px; font-weight: 500; }

@keyframes spin { to { transform: rotate(360deg) } }
@keyframes overlay-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes modal-in { from { opacity: 0; transform: translateY(12px) scale(.98) } to { opacity: 1; transform: none } }
</style>
