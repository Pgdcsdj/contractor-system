<template>
  <div class="cd-admin">
    <div class="page-head">
      <h2>承包商开工资料</h2>
      <div class="tabs">
        <button :class="['tab', tab === 'ledger' ? 'active' : '']" @click="tab = 'ledger'">项目台账</button>
        <button :class="['tab', tab === 'catalog' ? 'active' : '']" @click="tab = 'catalog'">目录维护</button>
      </div>
    </div>

    <!-- 项目台账 -->
    <section v-if="tab === 'ledger'">
      <div class="toolbar card">
        <div class="search-wrap">
          <span class="search-icon"><Icon name="search" :size="17" /></span>
          <input v-model="kw" class="search-input" placeholder="搜索单位 / 项目名称…" @input="onSearch" />
        </div>
        <select v-model="filterUnit" class="form-input" @change="fetchLedger">
          <option value="">全部单位</option>
          <option v-for="u in units" :key="u.id" :value="u.id">{{ u.short_name || u.unit_name }}</option>
        </select>
        <select v-model="filterStatus" class="form-input" @change="fetchLedger">
          <option value="">全部状态</option>
          <option value="0">进行中</option>
          <option value="1">已提交</option>
        </select>
        <button class="btn btn-primary" @click="exportExcel"><Icon name="download" :size="16" /> 导出台账</button>
      </div>

      <div class="card table-card">
        <table class="data-table">
          <thead>
            <tr>
              <th>承包商</th><th>项目名称</th><th>上报人</th>
              <th>开工门槛</th><th>动态维护</th><th>状态</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="8" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td></tr>
            <tr v-else-if="!rows.length"><td colspan="8" class="empty-cell">暂无项目资料</td></tr>
            <tr v-for="r in rows" :key="r.id">
              <td><strong>{{ r.unit_name }}</strong></td>
              <td>{{ r.project_name }}</td>
              <td>{{ r.reporter_name || '—' }}</td>
              <td>
                <span :class="['pill', r.gate_done >= totals.gate_total && totals.gate_total ? 'ok' : 'warn']">
                  {{ r.gate_done }}/{{ totals.gate_total }}
                </span>
              </td>
              <td>
                <span :class="['pill', r.dyn_done >= totals.dyn_total && totals.dyn_total ? 'ok' : 'muted']">
                  {{ r.dyn_done }}/{{ totals.dyn_total }}
                </span>
              </td>
              <td>
                <span :class="['badge', r.status ? 'badge-success' : 'badge-warn']">{{ r.status ? '已提交' : '进行中' }}</span>
              </td>
              <td class="mono" style="font-size:12px">{{ r.updated_at ? fmt(r.updated_at) : '—' }}</td>
              <td>
                <button class="action-link" @click="viewFiles(r)"><Icon name="file" :size="14" /> 查看</button>
                <button class="action-link danger" @click="delPackage(r)"><Icon name="x" :size="14" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 目录维护 -->
    <section v-else>
      <div class="toolbar card">
        <span class="total-count">共 {{ catalogAll.length }} 项（{{ activeCount }} 启用）</span>
        <button class="btn btn-primary" @click="openAdd"><Icon name="plus" :size="16" /> 新增资料项</button>
      </div>

      <div class="card table-card">
        <table class="data-table">
          <thead>
            <tr><th>体系分类</th><th>资料名称</th><th>报送频次</th><th>类型</th><th>排序</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in catalogAll" :key="c.id">
              <td>{{ c.category }}</td>
              <td>{{ c.item_name }}</td>
              <td>{{ c.freq || '—' }}</td>
              <td>
                <span :class="['tag', c.required_type === 'gate' ? 'tag-gate' : 'tag-dyn']">
                  {{ c.required_type === 'gate' ? '开工门槛' : '动态维护' }}
                </span>
              </td>
              <td class="mono">{{ c.sort_order }}</td>
              <td>
                <span :class="['badge', c.is_active ? 'badge-success' : 'badge-danger']">{{ c.is_active ? '启用' : '停用' }}</span>
              </td>
              <td>
                <button class="action-link" @click="openEdit(c)"><Icon name="pencil" :size="14" /> 编辑</button>
                <button class="action-link" @click="toggleActive(c)">{{ c.is_active ? '停用' : '启用' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 查看文件弹窗 -->
    <div v-if="showFiles" class="modal-overlay" @click.self="showFiles = false">
      <div class="modal modal-lg">
        <h3>资料明细 · {{ curPkg?.project_name }}</h3>
        <div class="file-list">
          <div v-for="f in fileRows" :key="f.id" class="file-row">
            <span class="fr-cat">{{ f.category }}</span>
            <span class="fr-name">{{ f.catalog_name }}</span>
            <a class="fr-link" :href="f.cos_url" target="_blank" rel="noopener"><Icon name="file" :size="14" /> {{ f.sys_name }}</a>
            <span class="fr-meta">录入：{{ f.uploader_name }} · {{ fmt(f.uploaded_at) }}</span>
            <button class="mini-btn" @click="pickFileReplace(f)"><Icon name="loop" :size="13" /> 换</button>
            <button class="mini-btn" @click="openEditFile(f)"><Icon name="pencil" :size="13" /> 改</button>
            <button class="mini-btn danger" @click="delFile(f)"><Icon name="x" :size="13" /> 删</button>
          </div>
          <div v-if="!fileRows.length" class="empty-mini">该项目暂无上传文件</div>
        </div>
        <div class="add-bar">
          <select v-model="addFrm.catalog_id" class="form-input add-select">
            <option value="">选择资料项后增补…</option>
            <option v-for="c in activeCatalogs" :key="c.id" :value="c.id">{{ c.category }} / {{ c.item_name }}</option>
          </select>
          <button class="mini-btn primary" :disabled="!addFrm.catalog_id" @click="pickFileAdd">＋ 增补文件</button>
        </div>
        <div class="modal-actions"><button class="btn btn-outline" @click="showFiles = false">关闭</button></div>
      </div>
    </div>

    <!-- 新增/编辑目录弹窗 -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ editing ? '编辑资料项' : '新增资料项' }}</h3>
        <div class="edit-form">
          <div class="form-group"><label>体系分类 *</label><input v-model="frm.category" class="form-input" /></div>
          <div class="form-group"><label>资料名称 *</label><input v-model="frm.item_name" class="form-input" /></div>
          <div class="form-group"><label>报送频次</label><input v-model="frm.freq" class="form-input" placeholder="如：入场前 / 动态更新" /></div>
          <div class="form-group">
            <label>类型</label>
            <select v-model="frm.required_type" class="form-input">
              <option value="gate">开工门槛（否决项）</option>
              <option value="dynamic">动态维护</option>
            </select>
          </div>
          <div class="form-group"><label>排序</label><input v-model.number="frm.sort_order" type="number" class="form-input" /></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showForm = false">取消</button>
          <button class="btn btn-primary" @click="saveCatalog" :disabled="!frm.category || !frm.item_name || saving">
            <Icon v-if="saving" name="loop" :size="16" class="spin" /> 保存
          </button>
        </div>
      </div>
    </div>

    <!-- 编辑文件信息弹窗 -->
    <div v-if="showFileForm" class="modal-overlay" @click.self="showFileForm = false">
      <div class="modal">
        <h3>编辑文件信息</h3>
        <div class="edit-form">
          <div class="form-group">
            <label>资料项</label>
            <select v-model="fileFrm.catalog_id" class="form-input">
              <option v-for="c in activeCatalogs" :key="c.id" :value="c.id">{{ c.category }} / {{ c.item_name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>原文件名</label>
            <input v-model="fileFrm.original_name" class="form-input" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showFileForm = false">取消</button>
          <button class="btn btn-primary" @click="saveFileInfo" :disabled="savingFile">
            <Icon v-if="savingFile" name="loop" :size="16" class="spin" /> 保存
          </button>
        </div>
      </div>
    </div>

    <!-- 隐藏 file input 已改为每次操作动态创建（见 pickFile），无需模板固定 input -->
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { request } from '@/utils/request'
import Icon from '@/components/Icon.vue'

const tab = ref('ledger')
const units = ref([])
const rows = ref([])
const totals = ref({ gate_total: 0, dyn_total: 0 })
const loading = ref(false)
const kw = ref('')
const filterUnit = ref('')
const filterStatus = ref('')

const catalogAll = ref([])
const showForm = ref(false)
const editing = ref(false)
const saving = ref(false)
const frm = ref({ id: null, category: '', item_name: '', freq: '', required_type: 'dynamic', sort_order: 0 })

const showFiles = ref(false)
const curPkg = ref(null)
const fileRows = ref([])
const fileInput = ref(null)
const fileAction = ref(null)       // { type: 'replace', id } | { type: 'add' }
const showFileForm = ref(false)
const savingFile = ref(false)
const fileFrm = ref({ id: null, catalog_id: '', original_name: '' })
const addFrm = ref({ catalog_id: '' })

const activeCount = computed(() => catalogAll.value.filter(c => c.is_active).length)
const activeCatalogs = computed(() => catalogAll.value.filter(c => c.is_active))

function fmt(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadUnits() {
  try {
    const res = await request.get('/api/contractor-docs/units')
    units.value = res.data.data || []
  } catch { units.value = [] }
}

async function fetchLedger() {
  loading.value = true
  try {
    const params = {}
    if (kw.value) params.keyword = kw.value
    if (filterUnit.value) params.unit_id = filterUnit.value
    if (filterStatus.value !== '') params.status = filterStatus.value
    const res = await request.get('/api/contractor-docs/admin/packages', { params })
    rows.value = res.data.data || []
    totals.value = res.data.totals || { gate_total: 0, dyn_total: 0 }
  } catch { rows.value = [] }
  loading.value = false
}

function onSearch() { fetchLedger() }

async function fetchCatalog() {
  try {
    const res = await request.get('/api/contractor-docs/admin/catalog')
    catalogAll.value = res.data.data || []
  } catch { catalogAll.value = [] }
}

async function exportExcel() {
  try {
    const params = {}
    if (kw.value) params.keyword = kw.value
    if (filterUnit.value) params.unit_id = filterUnit.value
    if (filterStatus.value !== '') params.status = filterStatus.value
    const res = await request.get('/api/contractor-docs/admin/export', { params, responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'contractor_docs.xlsx'
    a.click()
    window.URL.revokeObjectURL(url)
  } catch (e) {
    alert('导出失败：' + (e.response?.data?.error || e.message))
  }
}

async function refreshFiles() {
  if (!curPkg.value) return
  try {
    const res = await request.get(`/api/contractor-docs/admin/packages/${curPkg.value.id}/files`)
    fileRows.value = res.data.data || []
  } catch { fileRows.value = [] }
}

// 弹窗内的任何文件改动（换/改/删/增补）都会影响台账行的「开工门槛/动态维护」计数，
// 同步刷新台账列表，避免用户在弹窗里改完发现台账数据"没变化"。
async function refreshLedgerAfterEdit() {
  try { await fetchLedger() } catch {}
}

async function viewFiles(r) {
  curPkg.value = r
  addFrm.value = { catalog_id: '' }
  await refreshFiles()
  showFiles.value = true
}

// 关闭文件弹窗时兜底再刷一次台账，避免任何修改路径没触发 refreshLedgerAfterEdit 时的台账旧值
watch(showFiles, async (v) => {
  if (!v && curPkg.value) { try { await fetchLedger() } catch {} }
})

// 动态创建隐藏 file input（避开 display:none 共享 input 在某些浏览器/扩展下的兼容问题）
let activeInput = null
// 用浏览器原生 XHR 直接发 multipart，避免 axios 在某些环境下对 FormData/file 的字段丢失
function xhrSend(method, url, fd) {
  const token = localStorage.getItem('tnb_admin_token') || ''
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    xhr.setRequestHeader('Authorization', 'Bearer ' + token)
    xhr.timeout = 300000
    xhr.onload = () => {
      let body = xhr.responseText
      let parsed = null
      try { parsed = JSON.parse(body) } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ data: parsed })
      } else {
        const errMsg = (parsed && parsed.error) || body || '请求失败'
        reject({ response: { data: parsed || { error: errMsg } }, message: errMsg })
      }
    }
    xhr.onerror = () => reject({ response: { data: { error: '网络错误' } }, message: '网络错误' })
    xhr.ontimeout = () => reject({ response: { data: { error: '请求超时' } }, message: '请求超时' })
    xhr.send(fd)
  })
}
function pickFile(action) {
  if (activeInput) { activeInput.remove(); activeInput = null }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf,.jpg,.jpeg,.doc,.docx,.xlsx,.xls'
  input.style.position = 'absolute'
  input.style.left = '-9999px'
  input.style.width = '1px'
  input.style.height = '1px'
  input.style.opacity = '0'
  document.body.appendChild(input)
  activeInput = input
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0]
    console.log('[contractorDoc] pickFile change fired, file =', file && { name: file.name, size: file.size, type: file.type })
    input.remove()
    activeInput = null
    if (!file) return
    if (action.type === 'replace') {
      const fd = new FormData(); fd.append('file', file)
      try {
        await xhrSend('PUT', `/api/contractor-docs/admin/files/${action.id}`, fd)
        await refreshFiles()
        await refreshLedgerAfterEdit()
      } catch (err) { alert('替换失败：' + (err.response?.data?.error || err.message)) }
    } else if (action.type === 'add') {
      if (!addFrm.value.catalog_id) { alert('请先选择资料项'); return }
      const fd = new FormData()
      fd.append('file', file)
      fd.append('catalog_id', addFrm.value.catalog_id)
      console.log('[contractorDoc] add fd entries:', [...fd.entries()].map(([k, v]) => k + '=' + (v instanceof File ? `File(${v.name},${v.size})` : v)))
      try {
        await xhrSend('POST', `/api/contractor-docs/admin/packages/${curPkg.value.id}/files`, fd)
        addFrm.value = { catalog_id: '' }
        await refreshFiles()
        await refreshLedgerAfterEdit()
      } catch (err) { alert('增补失败：' + (err.response?.data?.error || err.message)) }
    }
  })
  input.click()
}
function pickFileReplace(f) { pickFile({ type: 'replace', id: f.id }) }
function pickFileAdd() { pickFile({ type: 'add' }) }
function openEditFile(f) {
  fileFrm.value = {
    id: f.id, catalog_id: f.catalog_id, original_name: f.original_name,
    _orig_catalog_id: f.catalog_id, _orig_name: f.original_name,
  }
  showFileForm.value = true
}
async function saveFileInfo() {
  const body = {}
  if (String(fileFrm.value.catalog_id) !== String(fileFrm.value._orig_catalog_id)) body.catalog_id = fileFrm.value.catalog_id
  const newName = String(fileFrm.value.original_name || '').trim()
  if (newName !== String(fileFrm.value._orig_name || '').trim()) body.original_name = newName
  if (!Object.keys(body).length) { showFileForm.value = false; return }
  savingFile.value = true
  try {
    await request.patch(`/api/contractor-docs/admin/files/${fileFrm.value.id}`, body)
    showFileForm.value = false
    await refreshFiles()
    await refreshLedgerAfterEdit()
  } catch (err) { alert('保存失败：' + (err.response?.data?.error || err.message)) }
  finally { savingFile.value = false }
}

async function delFile(f) {
  if (!confirm(`删除文件 ${f.sys_name}？`)) return
  try {
    await request.delete(`/api/contractor-docs/admin/files/${f.id}`)
    fileRows.value = fileRows.value.filter(x => x.id !== f.id)
    await refreshLedgerAfterEdit()
  } catch (e) { alert('删除失败：' + (e.response?.data?.error || e.message)) }
}

async function delPackage(r) {
  if (!confirm(`删除项目「${r.project_name}」及其全部资料文件？此操作不可恢复。`)) return
  try {
    await request.delete(`/api/contractor-docs/admin/packages/${r.id}`)
    rows.value = rows.value.filter(x => x.id !== r.id)
  } catch (e) { alert('删除失败：' + (e.response?.data?.error || e.message)) }
}

function openAdd() {
  editing.value = false
  frm.value = { id: null, category: '', item_name: '', freq: '', required_type: 'dynamic', sort_order: catalogAll.value.length + 1 }
  showForm.value = true
}
function openEdit(c) {
  editing.value = true
  frm.value = { ...c }
  showForm.value = true
}
async function saveCatalog() {
  saving.value = true
  try {
    if (editing.value) {
      await request.put(`/api/contractor-docs/admin/catalog/${frm.value.id}`, {
        category: frm.value.category, item_name: frm.value.item_name, freq: frm.value.freq,
        required_type: frm.value.required_type, sort_order: frm.value.sort_order,
      })
    } else {
      await request.post('/api/contractor-docs/admin/catalog', {
        category: frm.value.category, item_name: frm.value.item_name, freq: frm.value.freq,
        required_type: frm.value.required_type, sort_order: frm.value.sort_order,
      })
    }
    showForm.value = false
    await fetchCatalog()
  } catch (e) { alert('保存失败：' + (e.response?.data?.error || e.message)) }
  finally { saving.value = false }
}
async function toggleActive(c) {
  try {
    await request.put(`/api/contractor-docs/admin/catalog/${c.id}`, { is_active: c.is_active ? 0 : 1 })
    await fetchCatalog()
  } catch (e) { alert('操作失败：' + (e.response?.data?.error || e.message)) }
}

onMounted(() => { loadUnits(); fetchLedger(); fetchCatalog() })
</script>

<style scoped>
.cd-admin { max-width: 1200px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.page-head h2 { font-size: 18px; font-weight: 800; color: var(--c-text); }
.tabs { display: flex; gap: 6px; background: var(--c-surface-2); padding: 4px; border-radius: var(--r); }
.tab { border: none; background: transparent; padding: 8px 16px; border-radius: var(--r-sm); font-size: 14px; font-weight: 600; color: var(--c-text-2); cursor: pointer; transition: all .15s; }
.tab.active { background: var(--c-surface); color: var(--c-blue-600); box-shadow: var(--shadow-sm); }

.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-bottom: 14px; flex-wrap: wrap; }
.search-wrap { position: relative; flex: 1; min-width: 220px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--c-text-3); pointer-events: none; }
.search-input { width: 100%; padding: 9px 13px 9px 38px; border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 14px; }
.search-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }
.form-input { padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 14px; font-family: var(--font-sans); color: var(--c-text); background: var(--c-surface); }
.form-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }

.table-card { padding: 0; overflow: hidden; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th { text-align: left; padding: 13px 16px; background: var(--c-surface-2); color: var(--c-text-2); font-weight: 600; font-size: 12.5px; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
.data-table td { padding: 12px 16px; border-bottom: 1px solid var(--c-border); }
.data-table tbody tr:hover td { background: var(--c-surface-2); }
.empty-cell { text-align: center; padding: 44px; color: var(--c-text-3); }
.mono { font-family: var(--font-mono); font-size: 13px; color: var(--c-text-2); }

.pill { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12.5px; font-weight: 700; }
.pill.ok { background: var(--c-success-bg); color: var(--c-success); }
.pill.warn { background: #fde8e8; color: #c0392b; }
.pill.muted { background: var(--c-surface-2); color: var(--c-text-2); }

.badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.badge-success { background: var(--c-success-bg); color: var(--c-success); }
.badge-warn { background: #fef3cd; color: #b7791f; }
.badge-danger { background: var(--c-danger-bg); color: var(--c-danger); }

.tag { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
.tag-gate { background: #fde8e8; color: #c0392b; }
.tag-dyn { background: #e8f1fd; color: #2563eb; }

.total-count { font-size: 13px; color: var(--c-text-2); }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: var(--r); font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.btn-primary { background: var(--c-blue-600); color: #fff; }
.btn-primary:hover { background: var(--c-blue-700); }
.btn-outline { background: var(--c-surface); border-color: var(--c-border-strong); color: var(--c-text-2); }
.btn-outline:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }

.action-link { display: inline-flex; align-items: center; gap: 4px; background: none; border: none; color: var(--c-blue-600); cursor: pointer; font-size: 13px; font-weight: 500; padding: 5px 8px; border-radius: var(--r-sm); margin-right: 4px; }
.action-link:hover { background: var(--c-blue-50); }
.action-link.danger { color: var(--c-danger); }
.action-link.danger:hover { background: var(--c-danger-bg); }

.modal-overlay { position: fixed; inset: 0; background: rgba(10,19,34,.55); backdrop-filter: blur(3px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: var(--c-surface); border-radius: var(--r-lg); padding: 26px; width: 100%; max-width: 460px; box-shadow: var(--shadow-lg); }
.modal-lg { max-width: 640px; }
.modal h3 { font-size: 17px; font-weight: 700; color: var(--c-text); margin-bottom: 16px; }
.edit-form { display: flex; flex-direction: column; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 5px; }
.form-group label { font-size: 13px; color: var(--c-text-2); font-weight: 600; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }

.file-list { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; margin-top: 4px; }
.file-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--c-surface-2); border-radius: var(--r); flex-wrap: wrap; }
.fr-cat { font-size: 12px; color: var(--c-blue-700); font-weight: 600; background: var(--c-blue-50); padding: 2px 8px; border-radius: 20px; }
.fr-name { font-size: 13px; color: var(--c-text); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--c-blue-600); text-decoration: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-link:hover { text-decoration: underline; }
.fr-meta { font-size: 11.5px; color: var(--c-text-3); }
.mini-btn { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; padding: 5px 9px; border-radius: var(--r-sm); border: 1px solid var(--c-border-strong); background: var(--c-surface); color: var(--c-text-2); cursor: pointer; }
.mini-btn:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.mini-btn.danger:hover { border-color: var(--c-danger); color: var(--c-danger); }
.mini-btn.primary { background: var(--c-blue-600); border-color: var(--c-blue-600); color: #fff; }
.mini-btn.primary:hover { background: var(--c-blue-700); color: #fff; }
.mini-btn.primary:disabled { opacity: .5; cursor: not-allowed; }
.add-bar { display: flex; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px; background: var(--c-surface-2); border-radius: var(--r); }
.add-select { flex: 1; min-width: 0; }
.empty-mini { font-size: 13px; color: var(--c-text-3); text-align: center; padding: 24px; }
.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
</style>
