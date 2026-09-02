<template>
  <div class="users-page">
    <!-- 操作栏 -->
    <div class="toolbar card">
      <div class="search-wrap">
        <input v-model="keyword" class="search-input" placeholder="搜索姓名/身份证…" @input="onSearchChange" />
        <select v-model="filterSupervising" class="filter-select" @change="onFilterChange">
          <option value="">全部主管单位</option>
          <option v-for="s in supervisingUnits" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="filterCompany" class="filter-select" @change="onFilterChange">
          <option value="">全部承包商</option>
          <option v-for="c in companies" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="toolbar-right">
        <span class="total-count">共 {{ totalCount }} 人</span>
        <button class="btn btn-primary" @click="showAdd = true">➕ 新增人员</button>
        <button class="btn btn-outline" @click="showImport = true">📥 导入人员</button>
        <button class="btn btn-outline" @click="handleExport" :disabled="exporting">
          {{ exporting ? '导出中…' : '📤 导出' }}
        </button>
      </div>
    </div>

    <!-- 批量操作条 -->
    <div v-if="selectedIds.length > 0" class="batch-bar card">
      <span class="batch-info">已选 <b>{{ selectedIds.length }}</b> 人</span>
      <div class="batch-actions">
        <button class="btn btn-outline" @click="handleBatch('enable')">✅ 批量启用</button>
        <button class="btn btn-outline" @click="handleBatch('disable')">⛔ 批量禁用</button>
        <button class="btn btn-danger" @click="handleBatch('delete')">🗑 批量删除</button>
        <button class="btn btn-ghost" @click="selectedIds = []">取消选择</button>
      </div>
    </div>

    <!-- 用户表格 -->
    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th class="col-check">
              <input type="checkbox" :checked="allSelectedOnPage" @change="toggleAll" aria-label="全选本页" />
            </th>
            <th>姓名</th><th>身份证</th><th>主管单位</th><th>承包商</th><th>岗位</th><th>手机</th><th>录入时间</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="10" style="text-align:center;padding:30px;color:var(--text-secondary)">
              <div class="spinner" style="margin:0 auto"></div>
            </td>
          </tr>
          <tr v-else-if="filteredUsers.length === 0">
            <td colspan="10" class="empty-cell">暂无人员数据</td>
          </tr>
          <tr v-for="u in paginatedUsers" :key="u.id">
            <td class="col-check">
              <input type="checkbox" :checked="selectedIds.includes(u.id)" @change="toggleOne(u.id)" :aria-label="'选择 ' + u.name" />
            </td>
            <td><strong>{{ u.name }}</strong></td>
            <td class="mono">{{ maskIdCard(u.id_card) }}</td>
            <td>{{ u.supervising_unit || '-' }}</td>
            <td>{{ u.unit || '-' }}</td>
            <td>{{ u.position || '-' }}</td>
            <td>{{ u.phone || '-' }}</td>
            <td class="mono" style="font-size:12px">{{ u.created_at ? formatDate(u.created_at) : '-' }}</td>
            <td><span :class="['badge', Number(u.status) === 1 ? 'badge-success' : 'badge-danger']">
                {{ Number(u.status) === 1 ? '启用' : '禁用' }}
              </span></td>
            <td class="op-cell">
              <button class="action-link" @click="editUser(u)">编辑</button>
              <button class="action-link danger" @click="handleDelete(u)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 分页 -->
      <div class="pagination" v-if="totalPages > 1">
        <button class="pg-btn" :disabled="page === 1" @click="page--">‹</button>
        <span class="pg-info">{{ page }} / {{ totalPages }}</span>
        <button class="pg-btn" :disabled="page === totalPages" @click="page++">›</button>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <div v-if="showImport" class="modal-overlay" @click.self="showImport = false">
      <div class="modal">
        <h3>📥 Excel 导入人员</h3>
        <p class="modal-hint">
          请上传 Excel 文件，表头列名需包含：<strong>姓名、身份证号</strong>（必填），
          <strong>所属单位（承包商）、主管单位（甲方）、岗位、手机号</strong>（选填，自动识别列名）。<br />
          导入将<strong>按身份证号自动去重</strong>：相同身份证号视为同一人，以最新导入信息覆盖原记录。
        </p>
        <div class="file-upload" @click="triggerFile" :class="{ dragover: isDragover }"
          @dragover.prevent="isDragover = true"
          @dragleave="isDragover = false"
          @drop.prevent="handleDrop">
          <span class="upload-icon">📂</span>
          <p>{{ selectedFile ? selectedFile.name : '点击或拖拽上传 .xlsx / .xls 文件' }}</p>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="handleFileChange" />

        <div class="modal-actions">
          <button class="btn btn-outline" @click="showImport = false">取消</button>
          <button class="btn btn-primary" @click="handleImport" :disabled="!selectedFile || importing">
            {{ importing ? '导入中…' : '确认导入' }}
          </button>
        </div>

        <!-- 导入结果 -->
        <div v-if="importResult" class="import-result" :class="(importResult.fail > 0) ? 'has-fail' : 'all-ok'">
          <p v-if="importResult.error" class="err-text">⚠️ {{ importResult.error }}</p>
          <template v-else>
            <p>✅ 新增 {{ importResult.inserted ?? 0 }} 条 / 覆盖更新 {{ importResult.updated ?? 0 }} 条</p>
            <p v-if="importResult.fail > 0">❌ 失败 {{ importResult.fail }} 条</p>
            <p v-if="importResult.warnings && importResult.warnings.length" class="warn-text">
              ⚠️ {{ importResult.warnings.length }} 条「姓名」与既有记录重复但身份证不同，已作为新记录保留
            </p>
          </template>
          <button v-if="importResult.logId && importResult.fail > 0" class="btn btn-outline" style="margin-top:8px;font-size:13px" @click="downloadFail(importResult.logId)">
            📥 下载失败报告
          </button>
        </div>
      </div>
    </div>

    <!-- 新增人员弹窗 -->
    <div v-if="showAdd" class="modal-overlay" @click.self="showAdd = false">
      <div class="modal">
        <h3>➕ 新增人员</h3>
        <div class="edit-form">
          <div class="form-group"><label>姓名 *</label><input v-model="addForm.name" class="form-input" /></div>
          <div class="form-group"><label>身份证号 *</label><input v-model="addForm.id_card" class="form-input" maxlength="18" /></div>
          <div class="form-group"><label>承包商单位</label><input v-model="addForm.unit" class="form-input" /></div>
          <div class="form-group"><label>主管单位</label><input v-model="addForm.supervising_unit" class="form-input" /></div>
          <div class="form-group"><label>岗位</label><input v-model="addForm.position" class="form-input" placeholder="如：焊工 / 安全员" /></div>
          <div class="form-group"><label>手机号</label><input v-model="addForm.phone" class="form-input" /></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showAdd = false">取消</button>
          <button class="btn btn-primary" @click="handleAddUser" :disabled="adding || !addForm.name || !addForm.id_card">
            {{ adding ? '提交中…' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="showEdit" class="modal-overlay" @click.self="showEdit = false">
      <div class="modal">
        <h3>编辑人员信息</h3>
        <div class="edit-form">
          <div class="form-group">
            <label>姓名</label>
            <input v-model="editForm.name" class="form-input" />
          </div>
          <div class="form-group">
            <label>身份证号</label>
            <input v-model="editForm.id_card" class="form-input" />
          </div>
          <div class="form-group">
            <label>承包商单位</label>
            <input v-model="editForm.unit" class="form-input" />
          </div>
          <div class="form-group">
            <label>主管单位</label>
            <input v-model="editForm.supervising_unit" class="form-input" />
          </div>
          <div class="form-group">
            <label>岗位</label>
            <input v-model="editForm.position" class="form-input" placeholder="如：焊工 / 安全员" />
          </div>
          <div class="form-group">
            <label>手机号</label>
            <input v-model="editForm.phone" class="form-input" />
          </div>
          <div class="form-group">
            <label>状态</label>
            <select v-model="editForm.status" class="form-input">
              <option :value="1">启用</option>
              <option :value="0">禁用</option>
            </select>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" @click="handleEdit" :disabled="saving">
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

const users = ref([])
const loading = ref(true)
const keyword = ref('')
const filterCompany = ref('')
const filterSupervising = ref('')
const page = ref(1)
const pageSize = 20
const totalCount = ref(0)
const allUnits = ref([])
const allSupervisingUnits = ref([])

const showImport = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const isDragover = ref(false)
const importing = ref(false)
const importResult = ref(null)

// 编辑
const showEdit = ref(false)
const editForm = ref({ id: null, name: '', id_card: '', unit: '', supervising_unit: '', position: '', phone: '', status: 1 })
const saving = ref(false)

// 新增
const showAdd = ref(false)
const addForm = ref({ name: '', id_card: '', unit: '', supervising_unit: '', position: '', phone: '' })
const adding = ref(false)

// 选择 / 批量 / 导出
const selectedIds = ref([])
const exporting = ref(false)
const allSelectedOnPage = computed(() =>
  paginatedUsers.value.length > 0 &&
  paginatedUsers.value.every(u => selectedIds.value.includes(u.id))
)
function toggleOne(id) {
  const i = selectedIds.value.indexOf(id)
  if (i >= 0) selectedIds.value.splice(i, 1)
  else selectedIds.value.push(id)
}
function toggleAll(e) {
  const checked = e.target.checked
  const pageIds = paginatedUsers.value.map(u => u.id)
  if (checked) {
    for (const id of pageIds) if (!selectedIds.value.includes(id)) selectedIds.value.push(id)
  } else {
    selectedIds.value = selectedIds.value.filter(id => !pageIds.includes(id))
  }
}
function clearSelection() { selectedIds.value = [] }

async function handleBatch(action) {
  if (selectedIds.value.length === 0) return
  const label = { delete: '删除', enable: '启用', disable: '禁用' }[action]
  if (!confirm(`确认${action === 'delete' ? '永久' : ''}${label}选中的 ${selectedIds.value.length} 名人员？`)) return
  try {
    const res = await request.post('/api/admin/users/batch', { ids: selectedIds.value, action })
    alert(res.data.message || '操作成功')
    clearSelection()
    fetchUsers()
  } catch (e) {
    alert('批量操作失败：' + (e.response?.data?.error || e.message))
  }
}

async function handleDelete(u) {
  if (!confirm(`确认删除人员「${u.name}」？此操作不可恢复。`)) return
  try {
    await request.delete(`/api/admin/users/${u.id}`)
    selectedIds.value = selectedIds.value.filter(id => id !== u.id)
    fetchUsers()
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.error || e.message))
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const params = {}
    if (keyword.value) params.keyword = keyword.value
    if (filterCompany.value) params.unit = filterCompany.value
    if (filterSupervising.value) params.supervising_unit = filterSupervising.value
    const res = await request.get('/api/admin/users/export', { params, responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `人员信息_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    alert('导出失败：' + (e.response?.data?.error || e.message))
  } finally {
    exporting.value = false
  }
}

const companies = computed(() => allUnits.value)

const supervisingUnits = computed(() => allSupervisingUnits.value)

const filteredUsers = computed(() => users.value)

const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize)))
const paginatedUsers = computed(() => filteredUsers.value)

function onSearchChange() { page.value = 1; fetchUsers() }
function onFilterChange() { page.value = 1; fetchUsers() }

function maskIdCard(id) {
  if (!id || id.length < 8) return id
  return id.slice(0, 4) + '****' + id.slice(-4)
}

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
}

async function handleAddUser() {
  if (!addForm.value.name || !addForm.value.id_card) return
  adding.value = true
  try {
    await request.post('/api/admin/users', { ...addForm.value })
    showAdd.value = false
    addForm.value = { name: '', id_card: '', unit: '', supervising_unit: '', position: '', phone: '' }
    fetchUsers()
  } catch (e) {
    alert(e.response?.data?.error || '添加失败')
  } finally {
    adding.value = false
  }
}

function triggerFile() { fileInput.value?.click() }

function handleFileChange(e) {
  selectedFile.value = e.target.files[0]
}

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
    const res = await request.post('/api/admin/import-users', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    const d = res.data?.data || {}
    importResult.value = d
    if (!d.fail) {
      setTimeout(() => { showImport.value = false; fetchUsers() }, 1500)
    }
  } catch (e) {
    importResult.value = { inserted: 0, updated: 0, fail: 1, error: e.response?.data?.error || '导入失败' }
  } finally {
    importing.value = false
  }
}

async function downloadFail(logId) {
  if (!logId) return
  try {
    const res = await request.get(`/api/admin/import-users/fail/${logId}`, { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `失败明细_${logId}.xlsx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    alert('下载失败：' + (e.response?.data?.error || e.message))
  }
}

function editUser(u) {
  editForm.value = {
    id: u.id,
    name: u.name || '',
    id_card: u.id_card || '',
    unit: u.unit || '',
    supervising_unit: u.supervising_unit || '',
    position: u.position || '',
    phone: u.phone || '',
    status: Number(u.status) ?? 1,
  }
  showEdit.value = true
}

async function handleEdit() {
  saving.value = true
  try {
    await request.put(`/api/admin/users/${editForm.value.id}`, {
      name: editForm.value.name,
      id_card: editForm.value.id_card,
      unit: editForm.value.unit,
      supervising_unit: editForm.value.supervising_unit,
      position: editForm.value.position,
      phone: editForm.value.phone,
      status: editForm.value.status,
    })
    showEdit.value = false
    fetchUsers()
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

async function fetchUsers() {
  loading.value = true
  try {
    const params = {
      page: page.value,
      pageSize,
    }
    if (keyword.value) params.keyword = keyword.value
    if (filterCompany.value) params.unit = filterCompany.value
    if (filterSupervising.value) params.supervising_unit = filterSupervising.value

    const res = await request.get('/api/admin/users', { params })
    const data = res.data?.data
    users.value = data?.list || []
    totalCount.value = data?.total || 0
  } catch {
    users.value = []
    totalCount.value = 0
  }
  loading.value = false
}

async function fetchFilterOptions() {
  try {
    const res = await request.get('/api/admin/filter-options')
    const data = res.data?.data
    allUnits.value = data?.units || []
    allSupervisingUnits.value = data?.supervisingUnits || []
  } catch {
    // 静默失败，下拉框只为空
  }
}

onMounted(() => { fetchUsers(); fetchFilterOptions() })

// 翻页时重新获取数据
watch(page, fetchUsers)
</script>

<style scoped>
.users-page { max-width: 1200px; }

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.search-wrap { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
.search-input {
  flex: 1; min-width: 160px; max-width: 260px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
}
.search-input:focus { outline: none; border-color: var(--primary); }
.filter-select {
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  background: #fff;
  max-width: 200px;
}
.toolbar-right { display: flex; align-items: center; gap: 12px; }
.total-count { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }

.table-card { padding: 0; overflow: hidden; }

.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th {
  text-align: left; padding: 12px 14px;
  background: #f8f9fa; color: var(--text-secondary);
  font-weight: 500; font-size: 13px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.data-table td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: #f8f9fa; }
.mono { font-family: monospace; font-size: 13px; }
.empty-cell { text-align: center; padding: 40px; color: var(--text-secondary); }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; border-top: 1px solid var(--border); }
.pg-btn { width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.pg-btn:disabled { opacity: 0.4; cursor: default; }
.pg-info { font-size: 13px; color: var(--text-secondary); }

/* 弹窗 */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 440px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
.modal h3 { font-size: 18px; margin-bottom: 8px; }
.modal-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.6; }

.file-upload {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 30px;
  text-align: center;
  cursor: pointer;
  margin-bottom: 16px;
  transition: border-color 0.2s, background 0.2s;
}
.file-upload:hover, .file-upload.dragover { border-color: var(--primary); background: #e8f0fe; }
.upload-icon { font-size: 36px; display: block; margin-bottom: 8px; }
.file-upload p { font-size: 13px; color: var(--text-secondary); }

.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.modal-actions .btn { width: auto; }

.import-result { margin-top: 14px; padding: 12px; border-radius: 8px; font-size: 14px; }
.import-result.has-fail { background: #fce8e6; color: var(--danger); }
.import-result.all-ok { background: #e6f4ea; color: var(--success); }
.import-result p { margin: 2px 0; }
.import-result .warn-text { font-size: 12.5px; opacity: 0.85; }
.import-result .err-text { font-weight: 600; }

.action-link { background: none; border: none; color: var(--primary); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 6px; }
.action-link:hover { background: #e8f0fe; }
.edit-form { display: flex; flex-direction: column; gap: 10px; margin: 16px 0; }
.edit-form label { font-size: 13px; color: var(--text-secondary); margin-bottom: 2px; }

/* 批量操作条 */
.batch-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 12px; padding: 12px 16px; flex-wrap: wrap;
  border-left: 4px solid var(--primary);
}
.batch-info { font-size: 14px; color: var(--text); }
.batch-info b { color: var(--primary); font-size: 16px; margin: 0 2px; }
.batch-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* 复选框列 */
.col-check { width: 40px; text-align: center; }
.col-check input { width: 16px; height: 16px; cursor: pointer; }

/* 操作列 */
.op-cell { white-space: nowrap; }
.action-link.danger { color: var(--danger); }
.action-link.danger:hover { background: #fce8e6; }

/* 按钮变体 */
.btn-danger { background: var(--danger); color: #fff; border: 1px solid var(--danger); }
.btn-danger:hover { opacity: 0.9; }
.btn-danger:disabled { opacity: 0.5; cursor: default; }
.btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text-secondary); }
.btn-ghost:hover { background: #f1f3f4; }
</style>
