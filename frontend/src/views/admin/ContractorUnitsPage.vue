<template>
  <div class="users-page">
    <!-- 操作栏 -->
    <div class="toolbar card">
      <div class="search-wrap">
        <span class="search-icon"><Icon name="search" :size="17" /></span>
        <input v-model="keyword" class="search-input" placeholder="搜索单位名称 / 上级单位 / 网格长…" @input="onSearchChange" />
        <select v-model="filterGridL2" class="filter-select" @change="onFilterChange">
          <option value="">全部板块</option>
          <option v-for="g in gridL2Options" :key="g" :value="g">{{ g }}</option>
        </select>
        <select v-model="filterGridLevel" class="filter-select" @change="onFilterChange">
          <option value="">全部层级</option>
          <option v-for="l in gridLevelOptions" :key="l" :value="l">{{ l }}</option>
        </select>
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
            <th>单位名称</th><th>二级板块</th><th>网格层级</th><th>上级单位</th><th>网格长</th><th>网格员</th><th>备注</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="9" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
          </tr>
          <tr v-else-if="list.length === 0">
            <td colspan="9" class="empty-cell">暂无网格管理单位数据</td>
          </tr>
          <tr v-for="item in paginatedList" :key="item.id">
            <td><strong>{{ item.unit_name }}</strong></td>
            <td><span v-if="item.grid_l2" class="grid-tag">{{ item.grid_l2 }}</span><span v-else class="grid-tag empty">未归类</span></td>
            <td><span v-if="item.grid_level" class="level-tag" :class="'lv-' + levelClass(item.grid_level)">{{ item.grid_level }}</span><span v-else class="grid-tag empty">-</span></td>
            <td>{{ item.parent_unit_name || '-' }}</td>
            <td>{{ item.grid_leader || '-' }}</td>
            <td>{{ item.grid_member || '-' }}</td>
            <td class="remark-cell">{{ item.remark || '-' }}</td>
            <td>
              <span :class="['badge', Number(item.is_active) === 1 ? 'badge-success' : 'badge-danger']">
                {{ Number(item.is_active) === 1 ? '在册' : '退场' }}
              </span>
            </td>
            <td>
              <button class="action-link" @click="editItem(item)"><Icon name="pencil" :size="14" /> 编辑</button>
              <button class="action-link danger" @click="removeItem(item)"><Icon name="trash" :size="14" /> 退场</button>
            </td>
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
        <h3><Icon name="upload" :size="19" /> Excel 导入网格管理单位</h3>
        <p class="modal-hint">
          请上传 .xlsx 文件，表头列名需包含：
          <strong>单位名称</strong>（必填）、<strong>二级板块、网格层级、上级单位、系统现有ID、是否启用、操作、网格长、网格员、备注</strong>（选填）。<br />
          二级板块可选值：钻前工程 / 钻井工程 / 试气作业工程 / 地面工程 / 生产运行 / 工程监督 / 后勤保障。<br />
          系统现有ID 填库内单位 id 则按 id 原地更新（保留关联数据），留空则新增。
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
          <p><Icon :name="importResult.fail > 0 ? 'alert' : 'check'" :size="15" /> 成功 {{ importResult.success }} 条 / 上级关联 {{ importResult.parentResolved || 0 }} 条</p>
          <p v-if="importResult.fail > 0">失败 {{ importResult.fail }} 条</p>
          <ul v-if="importResult.warnings && importResult.warnings.length" style="font-size:12px;margin-top:6px;color:var(--c-warning)">
            <li v-for="(w, i) in importResult.warnings.slice(0, 8)" :key="i">{{ w }}</li>
          </ul>
          <ul v-if="importResult.failPreview && importResult.failPreview.length" style="font-size:12px;margin-top:6px;color:var(--c-danger)">
            <li v-for="(f, i) in importResult.failPreview" :key="i">{{ f.error }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 新增弹窗 -->
    <div v-if="showAdd" class="modal-overlay" @click.self="showAdd = false">
      <div class="modal">
        <h3><Icon name="plus" :size="19" /> 新增网格管理单位</h3>
        <div class="edit-form">
          <div class="form-group"><label>单位名称 *</label><input v-model="addForm.unit_name" class="form-input" /></div>
          <div class="form-row">
            <div class="form-group">
              <label>二级板块</label>
              <select v-model="addForm.grid_l2" class="form-input">
                <option value="">（未归类）</option>
                <option v-for="g in gridL2Options" :key="g" :value="g">{{ g }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>网格层级</label>
              <select v-model="addForm.grid_level" class="form-input">
                <option value="">（未设）</option>
                <option v-for="l in gridLevelOptions" :key="l" :value="l">{{ l }}</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>上级单位</label>
            <select v-model="addForm.parent_id" class="form-input" @change="onParentChange('add')">
              <option :value="null">（无上级 / 顶级）</option>
              <option v-for="u in unitOptions" :key="u.id" :value="u.id">{{ u.unit_name }}<template v-if="u.grid_l2">（{{ u.grid_l2 }}）</template></option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-group"><label>网格长</label><input v-model="addForm.grid_leader" class="form-input" placeholder="多人用 / 分隔" /></div>
            <div class="form-group"><label>网格员</label><input v-model="addForm.grid_member" class="form-input" placeholder="多人用 / 分隔" /></div>
          </div>
          <div class="form-group"><label>备注</label><input v-model="addForm.remark" class="form-input" /></div>
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
        <h3><Icon name="pencil" :size="19" /> 编辑网格管理单位</h3>
        <div class="edit-form">
          <div class="form-group"><label>单位名称</label><input v-model="editForm.unit_name" class="form-input" /></div>
          <div class="form-row">
            <div class="form-group">
              <label>二级板块</label>
              <select v-model="editForm.grid_l2" class="form-input">
                <option value="">（未归类）</option>
                <option v-for="g in gridL2Options" :key="g" :value="g">{{ g }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>网格层级</label>
              <select v-model="editForm.grid_level" class="form-input">
                <option value="">（未设）</option>
                <option v-for="l in gridLevelOptions" :key="l" :value="l">{{ l }}</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>上级单位</label>
            <select v-model="editForm.parent_id" class="form-input" @change="onParentChange('edit')">
              <option :value="null">（无上级 / 顶级）</option>
              <option v-for="u in unitOptions" :key="u.id" :value="u.id" :disabled="u.id === editForm.id">{{ u.unit_name }}<template v-if="u.grid_l2">（{{ u.grid_l2 }}）</template></option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-group"><label>网格长</label><input v-model="editForm.grid_leader" class="form-input" placeholder="多人用 / 分隔" /></div>
            <div class="form-group"><label>网格员</label><input v-model="editForm.grid_member" class="form-input" placeholder="多人用 / 分隔" /></div>
          </div>
          <div class="form-group"><label>备注</label><input v-model="editForm.remark" class="form-input" /></div>
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
const filterGridL2 = ref('')
const filterGridLevel = ref('')
const page = ref(1)
const pageSize = 50
const totalCount = ref(0)

// 二级专业板块（与「承包商单位导入模板」保持一致，7 大板块）
const gridL2Options = [
  '钻前工程',
  '钻井工程',
  '试气作业工程',
  '地面工程',
  '生产运行',
  '工程监督',
  '后勤保障',
]
const gridLevelOptions = ['一级', '二级', '三级', '四级']

const unitOptions = ref([])

const showImport = ref(false)
const fileInput = ref(null)
const selectedFile = ref(null)
const isDragover = ref(false)
const importing = ref(false)
const importResult = ref(null)

const showEdit = ref(false)
const editForm = ref({
  id: null, unit_name: '', grid_l2: '', grid_level: '', parent_id: null,
  grid_leader: '', grid_member: '', remark: '', is_active: 1,
})
const saving = ref(false)

const showAdd = ref(false)
const addForm = ref({
  unit_name: '', grid_l2: '', grid_level: '', parent_id: null,
  grid_leader: '', grid_member: '', remark: '',
})
const adding = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize)))
const paginatedList = computed(() => list.value)

function levelClass(lvl) {
  return { '一级': '1', '二级': '2', '三级': '3', '四级': '4' }[lvl] || '0'
}

function onSearchChange() { page.value = 1; fetchList() }
function onFilterChange() { page.value = 1; fetchList() }

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function loadOptions() {
  try {
    const res = await request.get('/api/contractor-units/options')
    unitOptions.value = res.data?.data || []
  } catch { unitOptions.value = [] }
}

function onParentChange(kind) {
  const f = kind === 'add' ? addForm.value : editForm.value
  const sel = unitOptions.value.find(u => u.id === f.parent_id)
  f.parent_unit_name = sel ? sel.unit_name : ''
}

async function handleAdd() {
  if (!addForm.value.unit_name) return
  adding.value = true
  try {
    await request.post('/api/contractor-units', { ...addForm.value })
    showAdd.value = false
    addForm.value = { unit_name: '', grid_l2: '', grid_level: '', parent_id: null, grid_leader: '', grid_member: '', remark: '' }
    loadOptions()
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
      setTimeout(() => { showImport.value = false; loadOptions(); fetchList() }, 1800)
    }
  } catch (e) {
    importResult.value = { success: 0, fail: 1, failPreview: [{ error: e.response?.data?.error || '导入失败' }] }
  } finally {
    importing.value = false
  }
}

function editItem(item) {
  editForm.value = {
    id: item.id,
    unit_name: item.unit_name || '',
    grid_l2: item.grid_l2 || '',
    grid_level: item.grid_level || '',
    parent_id: item.parent_id || null,
    parent_unit_name: item.parent_unit_name || '',
    grid_leader: item.grid_leader || '',
    grid_member: item.grid_member || '',
    remark: item.remark || '',
    is_active: Number(item.is_active) ?? 1,
  }
  showEdit.value = true
}

async function handleEdit() {
  saving.value = true
  try {
    await request.put(`/api/contractor-units/${editForm.value.id}`, {
      unit_name: editForm.value.unit_name,
      grid_l2: editForm.value.grid_l2,
      grid_level: editForm.value.grid_level,
      parent_id: editForm.value.parent_id,
      parent_unit_name: editForm.value.parent_unit_name,
      grid_leader: editForm.value.grid_leader,
      grid_member: editForm.value.grid_member,
      remark: editForm.value.remark,
      is_active: editForm.value.is_active,
    })
    showEdit.value = false
    loadOptions()
    fetchList()
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

async function removeItem(item) {
  if (!confirm(`确认将「${item.unit_name}」置为退场？（保留历史关联数据）`)) return
  try {
    await request.delete(`/api/contractor-units/${item.id}`)
    fetchList()
  } catch (e) {
    alert('操作失败：' + (e.response?.data?.error || e.message))
  }
}

async function fetchList() {
  loading.value = true
  try {
    const params = { page: page.value, pageSize }
    if (keyword.value) params.keyword = keyword.value
    if (filterGridL2.value) params.gridL2 = filterGridL2.value
    if (filterGridLevel.value) params.gridLevel = filterGridLevel.value
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

onMounted(() => { loadOptions(); fetchList() })
watch(page, fetchList)
</script>

<style scoped>
.users-page { max-width: 1240px; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 14px; flex-wrap: wrap;
}
.search-wrap { position: relative; display: flex; gap: 8px; flex: 1; flex-wrap: wrap; min-width: 240px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--c-text-3); pointer-events: none; }
.filter-select {
  padding: 10px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); color: var(--c-text); cursor: pointer; min-width: 130px;
}
.filter-select:focus { outline: none; border-color: var(--c-blue-600); }
.grid-tag { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--c-blue-50); color: var(--c-blue-600); white-space: nowrap; }
.grid-tag.empty { background: var(--c-surface-2); color: var(--c-text-3); }
.level-tag { display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.level-tag.lv-1 { background: #eef2ff; color: #4338ca; }
.level-tag.lv-2 { background: #e0f2fe; color: #0369a1; }
.level-tag.lv-3 { background: #dcfce7; color: #15803d; }
.level-tag.lv-4 { background: #fef3c7; color: #b45309; }
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
.remark-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-2); font-size: 13px; }
.mono { font-family: var(--font-mono); font-size: 13px; color: var(--c-text-2); }
.empty-cell { text-align: center; padding: 44px; color: var(--c-text-3); }

.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px; border-top: 1px solid var(--c-border); }
.pg-btn { width: 34px; height: 34px; border: 1px solid var(--c-border-strong); border-radius: var(--r-sm); background: var(--c-surface); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--c-text-2); transition: border-color .15s, color .15s; }
.pg-btn:hover:not(:disabled) { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.pg-btn:disabled { opacity: .4; cursor: default; }
.pg-info { font-size: 13px; color: var(--c-text-2); }

.modal-overlay { position: fixed; inset: 0; background: rgba(10, 19, 34, .55); backdrop-filter: blur(3px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; animation: overlay-in .2s ease; }
.modal { background: var(--c-surface); border-radius: var(--r-lg); padding: 28px; width: 100%; max-width: 520px; box-shadow: var(--shadow-lg); animation: modal-in .22s cubic-bezier(.22, 1, .36, 1); max-height: 90vh; overflow: auto; }
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
.action-link.danger { color: var(--c-danger); }
.action-link.danger:hover { background: var(--c-danger-bg); }

.edit-form { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
.edit-form label { font-size: 13px; color: var(--c-text-2); margin-bottom: 2px; font-weight: 500; display: block; }
.form-input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); color: var(--c-text);
}
.form-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }

@keyframes spin { to { transform: rotate(360deg) } }
@keyframes overlay-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes modal-in { from { opacity: 0; transform: translateY(12px) scale(.98) } to { opacity: 1; transform: none } }
</style>
