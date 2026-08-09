<template>
  <div class="cd-page">
    <!-- 顶部条 -->
    <header class="cd-header">
      <div class="cd-brand">
        <span class="brand-mark">
          <span class="brand-char">通</span>
        </span>
        <div>
          <div class="cd-title">承包商开工资料电子化上报</div>
          <div class="cd-sub">中原油田普光分公司 · 通南巴天然气开发项目部</div>
        </div>
      </div>
      <a class="cd-home" href="/">← 返回首页</a>
    </header>

    <!-- 录入人留痕条 -->
    <div class="id-bar card">
      <Icon name="users" :size="18" class="id-ico" />
      <span class="id-label">录入人</span>
      <input v-model.trim="identity.name" class="id-input" placeholder="姓名" @blur="saveIdentity" />
      <input v-model.trim="identity.phone" class="id-input" placeholder="电话" @blur="saveIdentity" />
      <span class="id-hint">姓名+电话用于「仅本人可删除/修改自己上传的文件」校验</span>
    </div>

    <div v-if="errorMsg" class="error-toast">{{ errorMsg }}</div>

    <!-- 步骤一：选择 / 创建项目 -->
    <div v-if="step === 1" class="cd-grid">
      <section class="card step-card">
      <h2 class="step-h"><span class="step-no">1</span> 选择工程 / 项目</h2>

      <div class="form-grid">
        <div class="fg">
          <label>承包商单位 *</label>
          <select v-model="form.unit_id" class="form-input">
            <option value="">— 请选择 —</option>
            <option v-for="u in units" :key="u.id" :value="u.id">{{ u.short_name || u.unit_name }}</option>
          </select>
        </div>
        <div class="fg fg-wide">
          <label>工程 / 项目名称 *</label>
          <input v-model.trim="form.project_name" class="form-input" placeholder="如：XX井钻前工程 / XX管道施工" @keyup.enter="createOrOpen" />
        </div>
      </div>

      <div class="step-actions">
        <button class="btn btn-primary" @click="createOrOpen" :disabled="!form.unit_id || !form.project_name || loadingPkg">
          <Icon v-if="loadingPkg" name="loop" :size="16" class="spin" />
          {{ loadingPkg ? '处理中…' : '创建 / 进入项目' }}
        </button>
        <button class="btn btn-outline" @click="showSearch = !showSearch">
          <Icon name="search" :size="16" /> 查询已有项目
        </button>
      </div>

      <!-- 查询已有项目 -->
      <div v-if="showSearch" class="search-box">
        <div class="form-grid">
          <div class="fg">
            <select v-model="searchUnit" class="form-input">
              <option value="">全部单位</option>
              <option v-for="u in units" :key="u.id" :value="u.id">{{ u.short_name || u.unit_name }}</option>
            </select>
          </div>
          <div class="fg fg-wide">
            <input v-model.trim="searchKw" class="form-input" placeholder="项目名称关键字" @input="searchPackages" />
          </div>
        </div>
        <div v-if="searchResults.length" class="search-results">
          <button v-for="p in searchResults" :key="p.id" class="sr-item" @click="selectPackage(p)">
            <span class="sr-name">{{ p.project_name }}</span>
            <span class="sr-meta">{{ p.unit_name }} · {{ p.file_count }} 个文件 · {{ p.status ? '已提交' : '进行中' }}</span>
          </button>
        </div>
        <div v-else-if="searched" class="empty-mini">未找到匹配项目</div>
      </div>
      </section>

      <aside class="feed-panel card">
        <div class="feed-title">最新录入项目 <span class="feed-sub">（全部承包商）</span></div>
        <div v-if="feedLoading" class="feed-empty">加载中…</div>
        <div v-else-if="!allPackages.length" class="feed-empty">暂无项目</div>
        <button v-for="p in allPackages" :key="p.id" class="feed-item" @click="openDetail(p.id)">
          <div class="feed-name">{{ p.project_name }}</div>
          <div class="feed-meta">{{ p.unit_name }} · {{ p.file_count }} 个文件 · {{ p.status ? '已提交' : '进行中' }}</div>
          <div class="feed-time">{{ fmtTime(p.updated_at) }}</div>
        </button>
      </aside>
    </div>

    <!-- 步骤二：上传资料 -->
    <section v-else class="upload-stage">
      <div class="upload-main">
        <div class="card proj-head">
          <div>
            <div class="proj-name">{{ packageInfo.project_name }}</div>
            <div class="proj-meta">{{ packageInfo.unit_name }} · 上报人 {{ packageInfo.reporter_name || '—' }}</div>
          </div>
          <button class="btn btn-ghost" @click="backToStep1"><Icon name="chevronLeft" :size="16" /> 换项目</button>
        </div>

        <div v-for="group in catalogTree" :key="group.category" class="card cat-block">
          <div class="cat-title">{{ group.category }}</div>
          <div v-for="item in group.items" :key="item.id" class="doc-row" :class="{ done: hasFile(item.id) }">
            <div class="doc-info">
              <span class="doc-name">{{ item.name }}</span>
              <span class="doc-tags">
                <span class="tag tag-freq">{{ item.freq }}</span>
                <span :class="['tag', item.requiredType === 'gate' ? 'tag-gate' : 'tag-dyn']">
                  {{ item.requiredType === 'gate' ? '开工门槛' : '动态维护' }}
                </span>
              </span>
            </div>
            <div class="doc-actions">
              <template v-if="hasFile(item.id)">
                <a class="file-chip" :href="filesByCatalog[item.id].cos_url" target="_blank" rel="noopener">
                  <Icon name="file" :size="15" /> {{ filesByCatalog[item.id].sys_name }}
                </a>
                <button class="mini-btn" @click="triggerReplace(item.id)"><Icon name="pencil" :size="14" /> 替换</button>
                <button class="mini-btn danger" @click="deleteFile(filesByCatalog[item.id])"><Icon name="x" :size="14" /> 删除</button>
              </template>
              <button v-else class="mini-btn up" @click="triggerPick(item.id)" :disabled="uploading[item.id]">
                <Icon v-if="uploading[item.id]" name="loop" :size="14" class="spin" />
                <Icon v-else name="upload" :size="14" /> 上传
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧齐全度 -->
      <aside class="upload-side">
        <div class="card side-card">
          <div class="side-title">资料齐全度</div>
          <div class="ring-row">
            <div class="ring gate" :class="gateTotal && gateDone === gateTotal ? 'ok' : ''">
              <div class="ring-num">{{ gateDone }}/{{ gateTotal }}</div>
              <div class="ring-lbl">开工门槛</div>
            </div>
            <div class="ring dyn" :class="dynDone === dynTotal ? 'ok' : ''">
              <div class="ring-num">{{ dynDone }}/{{ dynTotal }}</div>
              <div class="ring-lbl">动态维护</div>
            </div>
          </div>
          <div class="side-tip">
            <Icon name="alert" :size="14" /> 开工门槛资料为开工前必须的否决项，缺项不得开工。
          </div>
          <button class="btn btn-primary block" @click="submitPackage" :disabled="submitting">
            <Icon v-if="submitting" name="loop" :size="16" class="spin" />
            {{ packageInfo.status ? '已提交（点击可撤销）' : '提交本项目' }}
          </button>
        </div>
      </aside>
    </section>

    <input ref="fileInputRef" type="file" accept=".pdf,.jpg,.jpeg,.doc,.docx,.xlsx,.xls" style="display:none" @change="onFilePicked" />

    <div v-if="detailOpen" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <div class="modal-head">
          <div>
            <div class="modal-title">{{ detailPkg?.project_name }}</div>
            <div class="modal-sub">{{ detailPkg?.unit_name }} · 上报人 {{ detailPkg?.reporter_name || '—' }} · {{ detailPkg?.status ? '已提交' : '进行中' }}</div>
          </div>
          <button class="modal-close" @click="closeDetail">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="detailLoading" class="feed-empty">加载中…</div>
          <div v-else-if="!detailFiles.length" class="feed-empty">该项目暂未上传资料</div>
          <div v-for="f in detailFiles" :key="f.id" class="detail-file">
            <div>
              <div class="df-name">{{ f.catalog_name }}</div>
              <div class="df-meta">{{ f.category }} · {{ f.sys_name }} · 录入人 {{ f.uploader_name }}</div>
            </div>
            <a class="df-link" :href="f.cos_url" target="_blank" rel="noopener">下载</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { request } from '@/utils/request'
import Icon from '@/components/Icon.vue'

const units = ref([])
const catalogTree = ref([])
const identity = ref({
  name: localStorage.getItem('cd_name') || '',
  phone: localStorage.getItem('cd_phone') || '',
})
const step = ref(1)
const form = ref({ unit_id: '', project_name: '' })
const packageId = ref(null)
const packageInfo = ref(null)
const files = ref([])
const showSearch = ref(false)
const searchResults = ref([])
const searchKw = ref('')
const searchUnit = ref('')
const searched = ref(false)
const loadingPkg = ref(false)
const uploading = ref({})
const submitting = ref(false)
const errorMsg = ref('')
const fileInputRef = ref(null)
const pendingCatId = ref(null)
const pendingReplaceId = ref(null)

// 全员最新录入项目（只读侧栏）
const allPackages = ref([])
const feedLoading = ref(false)
// 只读详情弹层
const detailOpen = ref(false)
const detailPkg = ref(null)
const detailFiles = ref([])
const detailLoading = ref(false)

function saveIdentity() {
  localStorage.setItem('cd_name', identity.value.name)
  localStorage.setItem('cd_phone', identity.value.phone)
}
function showError(m) { errorMsg.value = m; setTimeout(() => { errorMsg.value = '' }, 4000) }

async function loadBase() {
  try {
    const [u, c] = await Promise.all([
      request.get('/api/contractor-docs/units'),
      request.get('/api/contractor-docs/catalog'),
    ])
    units.value = u.data.data || []
    catalogTree.value = c.data.data || []
  } catch (e) {
    showError('基础数据加载失败，请刷新重试')
  }
}

// 时间格式化：YYYY-MM-DD HH:mm
function fmtTime(x) {
  if (!x) return ''
  const d = new Date(x)
  if (isNaN(d.getTime())) return String(x)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 加载全员最新录入项目（公开列表，无过滤参数）
async function loadAllPackages() {
  feedLoading.value = true
  try {
    const res = await request.get('/api/contractor-docs/packages')
    allPackages.value = res.data.data || []
  } catch {
    // 失败静默：侧栏留空，不影响主流程
    allPackages.value = []
  } finally {
    feedLoading.value = false
  }
}

// 打开只读详情弹层
async function openDetail(id) {
  detailOpen.value = true
  detailLoading.value = true
  try {
    const res = await request.get('/api/contractor-docs/packages/' + id + '/files')
    detailPkg.value = res.data.package || null
    detailFiles.value = res.data.data || []
  } catch {
    detailPkg.value = null
    detailFiles.value = []
  } finally {
    detailLoading.value = false
  }
}

// 关闭详情弹层
function closeDetail() {
  detailOpen.value = false
  detailPkg.value = null
  detailFiles.value = []
}

const filesByCatalog = computed(() => {
  const m = {}
  for (const f of files.value) m[f.catalog_id] = f
  return m
})
function hasFile(catId) { return !!filesByCatalog.value[catId] }

function countItems(type, onlyUploaded = false) {
  let n = 0
  for (const g of catalogTree.value) {
    for (const it of g.items) {
      if (it.requiredType === type && (!onlyUploaded || filesByCatalog.value[it.id])) n++
    }
  }
  return n
}
const gateTotal = computed(() => countItems('gate'))
const dynTotal = computed(() => countItems('dynamic'))
const gateDone = computed(() => countItems('gate', true))
const dynDone = computed(() => countItems('dynamic', true))

async function createOrOpen() {
  if (!identity.value.name || !identity.value.phone) {
    showError('请先填写录入人姓名与电话')
    return
  }
  loadingPkg.value = true
  try {
    const res = await request.post('/api/contractor-docs/packages', {
      unit_id: form.value.unit_id,
      project_name: form.value.project_name,
      reporter_name: identity.value.name,
      reporter_phone: identity.value.phone,
    })
    const pid = res.data.data.id
    await selectPackageById(pid)
    await loadAllPackages()
  } catch (e) {
    showError(e.response?.data?.error || '创建项目失败')
  } finally {
    loadingPkg.value = false
  }
}

async function searchPackages() {
  searched.value = true
  try {
    const params = {}
    if (searchUnit.value) params.unit_id = searchUnit.value
    if (searchKw.value) params.keyword = searchKw.value
    const res = await request.get('/api/contractor-docs/packages', { params })
    searchResults.value = res.data.data || []
  } catch { searchResults.value = [] }
}

async function selectPackage(p) {
  showSearch.value = false
  await selectPackageById(p.id)
}

async function selectPackageById(pid) {
  try {
    const res = await request.get(`/api/contractor-docs/packages/${pid}/files`)
    packageId.value = pid
    files.value = res.data.data || []
    const p = res.data.package
    if (p) {
      packageInfo.value = {
        project_name: p.project_name,
        unit_name: p.unit_name,
        reporter_name: p.reporter_name,
        status: Number(p.status) || 0,
      }
      // 回填身份（便于本人删改校验一致）
      if (p.reporter_name) identity.value.name = p.reporter_name
      if (p.reporter_phone) identity.value.phone = p.reporter_phone
    }
    step.value = 2
  } catch (e) {
    showError('打开项目失败：' + (e.response?.data?.error || e.message))
  }
}

async function fetchFiles() {
  if (!packageId.value) return
  try {
    const res = await request.get(`/api/contractor-docs/packages/${packageId.value}/files`)
    files.value = res.data.data || []
  } catch {}
}

function triggerPick(catId) {
  pendingCatId.value = catId
  pendingReplaceId.value = null
  fileInputRef.value?.click()
}
function triggerReplace(fileId) {
  pendingReplaceId.value = fileId
  pendingCatId.value = null
  fileInputRef.value?.click()
}

function validateFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (!['pdf', 'jpg', 'jpeg', 'doc', 'docx', 'xlsx', 'xls'].includes(ext)) { showError('仅支持 PDF / 图片 / Word / Excel 格式'); return false }
  if (file.size > 20 * 1024 * 1024) { showError('单个文件不得超过 20MB'); return false }
  return true
}

async function onFilePicked(e) {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  if (!identity.value.name || !identity.value.phone) { showError('请先填写录入人姓名与电话'); return }
  if (!validateFile(file)) return
  if (pendingReplaceId.value) {
    await doReplace(pendingReplaceId.value, file)
  } else if (pendingCatId.value) {
    await doUpload(pendingCatId.value, file)
  }
}

async function doUpload(catId, file) {
  uploading.value = { ...uploading.value, [catId]: true }
  const fd = new FormData()
  fd.append('file', file)
  fd.append('package_id', packageId.value)
  fd.append('catalog_id', catId)
  fd.append('uploader_name', identity.value.name)
  fd.append('uploader_phone', identity.value.phone)
  try {
    await request.post('/api/contractor-docs/files', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    await fetchFiles()
  } catch (e) {
    showError(e.response?.data?.error || '上传失败')
  } finally {
    uploading.value = { ...uploading.value, [catId]: false }
  }
}

async function doReplace(fileId, file) {
  uploading.value = { ...uploading.value, [fileId]: true }
  const fd = new FormData()
  fd.append('file', file)
  fd.append('uploader_name', identity.value.name)
  fd.append('uploader_phone', identity.value.phone)
  try {
    await request.put(`/api/contractor-docs/files/${fileId}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    await fetchFiles()
  } catch (e) {
    showError(e.response?.data?.error || '替换失败')
  } finally {
    uploading.value = { ...uploading.value, [fileId]: false }
  }
}

async function deleteFile(f) {
  if (!confirm(`确认删除「${f.sys_name}」？此操作不可恢复。`)) return
  try {
    await request.delete(`/api/contractor-docs/files/${f.id}`, {
      data: { uploader_name: identity.value.name, uploader_phone: identity.value.phone },
    })
    await fetchFiles()
  } catch (e) {
    showError(e.response?.data?.error || '删除失败')
  }
}

async function submitPackage() {
  submitting.value = true
  try {
    const newStatus = packageInfo.value.status ? 0 : 1
    await request.patch(`/api/contractor-docs/packages/${packageId.value}`, { status: newStatus })
    packageInfo.value = { ...packageInfo.value, status: newStatus }
  } catch (e) {
    showError(e.response?.data?.error || '操作失败')
  } finally {
    submitting.value = false
  }
}

function backToStep1() {
  step.value = 1
  packageId.value = null
  packageInfo.value = null
  files.value = []
}

onMounted(() => { loadBase(); loadAllPackages() })
</script>

<style scoped>
.cd-page { max-width: 1080px; margin: 0 auto; padding: 20px 18px 60px; }
.cd-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.cd-brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 42px; height: 42px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--c-blue-500), var(--c-blue-700)); box-shadow: 0 4px 12px rgba(29,111,184,.4); }
.brand-char { font-size: 22px; font-weight: 700; color: #fff; line-height: 1; }
.cd-title { font-size: 18px; font-weight: 800; color: var(--c-text); }
.cd-sub { font-size: 12.5px; color: var(--c-text-2); }
.cd-home { font-size: 13.5px; color: var(--c-blue-600); text-decoration: none; font-weight: 600; }
.cd-home:hover { text-decoration: underline; }

.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 20px; box-shadow: var(--shadow-sm); }

.id-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.id-ico { color: var(--c-blue-600); }
.id-label { font-size: 13.5px; font-weight: 600; color: var(--c-text-2); }
.id-input { width: 150px; padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 14px; }
.id-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }
.id-hint { font-size: 12px; color: var(--c-text-3); }

.error-toast { background: var(--c-danger-bg); color: var(--c-danger); padding: 10px 14px; border-radius: var(--r); font-size: 13.5px; margin-bottom: 14px; }

.step-card { margin-top: 6px; }
.step-h { font-size: 16px; font-weight: 700; color: var(--c-text); display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.step-no { width: 26px; height: 26px; border-radius: 50%; background: var(--c-blue-600); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
.form-grid { display: flex; gap: 14px; flex-wrap: wrap; }
.fg { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 200px; }
.fg-wide { flex: 2; min-width: 280px; }
.fg label { font-size: 13px; color: var(--c-text-2); font-weight: 600; }
.form-input { padding: 11px 13px; border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 14px; font-family: var(--font-sans); color: var(--c-text); background: var(--c-surface); }
.form-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }

.step-actions { display: flex; gap: 12px; margin-top: 18px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 18px; border-radius: var(--r); font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: background .16s ease, border-color .16s ease, opacity .16s; }
.btn:disabled { opacity: .55; cursor: default; }
.btn-primary { background: var(--c-blue-600); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--c-blue-700); }
.btn-outline { background: var(--c-surface); border-color: var(--c-border-strong); color: var(--c-text-2); }
.btn-outline:hover:not(:disabled) { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.btn-ghost { background: transparent; color: var(--c-text-2); padding: 7px 12px; }
.btn-ghost:hover { color: var(--c-blue-600); }
.btn.block { width: 100%; justify-content: center; margin-top: 14px; }

.search-box { margin-top: 18px; padding-top: 16px; border-top: 1px dashed var(--c-border); }
.search-results { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; max-height: 280px; overflow-y: auto; }
.sr-item { text-align: left; background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: var(--r); padding: 11px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; transition: border-color .15s, background .15s; }
.sr-item:hover { border-color: var(--c-blue-600); background: var(--c-blue-50); }
.sr-name { font-size: 14px; font-weight: 600; color: var(--c-text); }
.sr-meta { font-size: 12px; color: var(--c-text-3); }
.empty-mini { font-size: 13px; color: var(--c-text-3); margin-top: 12px; text-align: center; }

.upload-stage { display: grid; grid-template-columns: 1fr 280px; gap: 18px; margin-top: 6px; align-items: start; }
.upload-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.proj-head { display: flex; align-items: center; justify-content: space-between; }
.proj-name { font-size: 16px; font-weight: 700; color: var(--c-text); }
.proj-meta { font-size: 12.5px; color: var(--c-text-2); margin-top: 2px; }

.cat-block { padding: 16px 18px; }
.cat-title { font-size: 14px; font-weight: 700; color: var(--c-blue-700); margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--c-border); }
.doc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px dashed var(--c-border); }
.doc-row:last-child { border-bottom: none; }
.doc-row.done { background: linear-gradient(90deg, var(--c-success-bg), transparent 60%); border-radius: var(--r-sm); padding-left: 8px; padding-right: 8px; }
.doc-info { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.doc-name { font-size: 14px; color: var(--c-text); }
.doc-tags { display: flex; gap: 6px; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
.tag-freq { background: var(--c-surface-2); color: var(--c-text-2); }
.tag-gate { background: #fde8e8; color: #c0392b; }
.tag-dyn { background: #e8f1fd; color: #2563eb; }
.doc-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.file-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--c-blue-700); text-decoration: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--c-blue-50); padding: 5px 9px; border-radius: var(--r-sm); }
.file-chip:hover { text-decoration: underline; }
.mini-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; padding: 6px 10px; border-radius: var(--r-sm); border: 1px solid var(--c-border-strong); background: var(--c-surface); color: var(--c-text-2); cursor: pointer; transition: all .15s; }
.mini-btn:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.mini-btn.up { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.mini-btn.danger:hover { border-color: var(--c-danger); color: var(--c-danger); }

.upload-side { position: sticky; top: 20px; }
.side-card { padding: 18px; }
.side-title { font-size: 14px; font-weight: 700; color: var(--c-text); margin-bottom: 14px; }
.ring-row { display: flex; gap: 12px; }
.ring { flex: 1; border-radius: var(--r); padding: 14px 8px; text-align: center; border: 1px solid var(--c-border); }
.ring.gate { background: #fde8e8; }
.ring.dyn { background: #e8f1fd; }
.ring.ok { box-shadow: 0 0 0 2px var(--c-success); }
.ring-num { font-size: 22px; font-weight: 800; color: var(--c-text); }
.ring-lbl { font-size: 12px; color: var(--c-text-2); margin-top: 2px; }
.side-tip { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--c-text-2); margin-top: 14px; line-height: 1.5; }
.side-tip svg { flex-shrink: 0; margin-top: 1px; color: #c0392b; }

.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }

/* 步骤一右侧：全员最新录入项目 */
.cd-grid { display: grid; grid-template-columns: 1fr 320px; gap: 18px; align-items: start; }
.feed-panel { padding: 16px; position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow-y: auto; }
.feed-title { font-size: 14px; font-weight: 700; color: var(--c-text); margin-bottom: 12px; }
.feed-sub { font-size: 11px; color: var(--c-text-3); font-weight: 400; }
.feed-item { display: block; width: 100%; text-align: left; background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: var(--r); padding: 11px 13px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s, background .15s; }
.feed-item:hover { border-color: var(--c-blue-600); background: var(--c-blue-50); }
.feed-name { font-size: 14px; font-weight: 600; color: var(--c-text); }
.feed-meta { font-size: 12px; color: var(--c-text-3); margin-top: 3px; }
.feed-time { font-size: 11px; color: var(--c-text-3); margin-top: 3px; }
.feed-empty { font-size: 13px; color: var(--c-text-3); text-align: center; padding: 20px 0; }

/* 只读详情弹层 */
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.modal { width: min(560px, 100%); max-height: 86vh; overflow-y: auto; background: var(--c-surface); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--c-border); }
.modal-title { font-size: 16px; font-weight: 700; color: var(--c-text); }
.modal-sub { font-size: 12.5px; color: var(--c-text-2); margin-top: 3px; }
.modal-close { border: none; background: transparent; font-size: 18px; color: var(--c-text-2); cursor: pointer; }
.modal-body { padding: 16px 20px; }
.detail-file { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px dashed var(--c-border); }
.df-name { font-size: 14px; color: var(--c-text); }
.df-meta { font-size: 11.5px; color: var(--c-text-3); margin-top: 2px; }
.df-link { flex-shrink: 0; font-size: 13px; color: var(--c-blue-600); text-decoration: none; font-weight: 600; }

@media (max-width: 900px) {
  .cd-grid { grid-template-columns: 1fr; }
  .feed-panel { position: static; max-height: none; }
}

@media (max-width: 820px) {
  .upload-stage { grid-template-columns: 1fr; }
  .upload-side { position: static; }
}
</style>
