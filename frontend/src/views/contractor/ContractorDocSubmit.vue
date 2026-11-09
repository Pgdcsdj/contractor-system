<template>
  <div class="cd-page">
    <!-- 顶部条 -->
    <header class="cd-header">
      <div class="cd-brand">
        <img :src="logoUrl" class="brand-img" alt="通南巴气田安全管理" />
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

    <!-- ───────── 步骤一：选择窗口（新建 / 修改）+ 表单 ───────── -->
    <div v-if="step === 1">
      <!-- 选择窗口：两个大按钮切换 -->
      <div class="mode-switch">
        <button :class="['mode-card', mode === 'new' ? 'on' : '']" @click="switchMode('new')">
          <span class="mc-ico"><Icon name="plus" :size="20" /></span>
          <span class="mc-text">
            <span class="mc-title">新建项目录入</span>
            <span class="mc-sub">首次上报的工程 / 项目，先建台账再逐项上传资料</span>
          </span>
          <span class="mc-check" v-if="mode === 'new'"><Icon name="check" :size="15" /></span>
        </button>
        <button :class="['mode-card', mode === 'edit' ? 'on' : '']" @click="switchMode('edit')">
          <span class="mc-ico alt"><Icon name="pencil" :size="20" /></span>
          <span class="mc-text">
            <span class="mc-title">修改已有项目</span>
            <span class="mc-sub">补传 / 替换 / 删除已上报资料，按单位选项目即可</span>
          </span>
          <span class="mc-check" v-if="mode === 'edit'"><Icon name="check" :size="15" /></span>
        </button>
      </div>

      <div class="cd-grid">
        <section class="card step-card">
          <!-- 新建项目 -->
          <template v-if="mode === 'new'">
            <h2 class="step-h"><span class="step-no">1</span> 新建项目台账</h2>
            <p class="step-tip">同一承包商下，项目名称重复时系统会自动进入已有项目，不会重复建包。</p>
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
                {{ loadingPkg ? '处理中…' : '创建并进入项目' }}
                <Icon v-if="!loadingPkg" name="chevronRight" :size="16" />
              </button>
            </div>
          </template>

          <!-- 修改已有项目：选单位 → 项目自动列出，直接下拉选 -->
          <template v-else>
            <h2 class="step-h"><span class="step-no">2</span> 选择已有项目</h2>
            <p class="step-tip">先选承包商单位，该单位已建的项目会自动列在下面，直接下拉选即可，无需输入关键词。</p>
            <div class="form-grid">
              <div class="fg fg-narrow">
                <label>承包商单位 *</label>
                <select v-model="pickUnit" class="form-input" @change="loadUnitPackages">
                  <option value="">— 请选择 —</option>
                  <option v-for="u in units" :key="u.id" :value="u.id">{{ u.short_name || u.unit_name }}</option>
                </select>
              </div>
              <div class="fg fg-wide fg-block">
                <label>工程 / 项目 *</label>
                <select v-model="pickedPkgId" class="form-input" :disabled="!pickUnit || loadingPkgs || !unitPackages.length">
                  <option value="">
                    {{ !pickUnit ? '— 请先选择承包商单位 —'
                      : loadingPkgs ? '加载中…'
                      : !unitPackages.length ? '— 该单位暂无项目 —'
                      : `— 请选择（共 ${unitPackages.length} 个项目）—` }}
                  </option>
                  <option v-for="p in unitPackages" :key="p.id" :value="p.id">{{ pkgLabel(p) }}</option>
                </select>
              </div>
            </div>

            <div v-if="pickUnit && !loadingPkgs && !unitPackages.length" class="pick-empty">
              <Icon name="inbox" :size="16" />
              「{{ unitNameOf(pickUnit) }}」名下还没有任何项目，请改用
              <a href="javascript:;" class="link" @click="switchMode('new')">新建项目录入</a>。
            </div>

            <div v-if="pickedPkg" class="pick-preview">
              <div class="pp-name">{{ pickedPkg.project_name }}</div>
              <div class="pp-meta">
                {{ pickedPkg.unit_name }} · 上报人 {{ pickedPkg.reporter_name || '—' }} ·
                {{ pickedPkg.file_count }} 个文件 · {{ pickedPkg.status ? '已提交' : '进行中' }}
              </div>
              <div class="pp-gate" :class="gateMissingOf(pickedPkg) > 0 ? 'bad' : 'ok'">
                <template v-if="gateMissingOf(pickedPkg) > 0">
                  <span class="star">★</span> 开工门槛资料还缺 <b>{{ gateMissingOf(pickedPkg) }}</b> 项（共 {{ pkgTotals.gate_total }} 项）
                </template>
                <template v-else>
                  <Icon name="check" :size="14" /> 开工门槛资料已齐全（{{ pkgTotals.gate_total }}/{{ pkgTotals.gate_total }}）
                </template>
              </div>
            </div>

            <div class="step-actions">
              <button class="btn btn-primary" @click="openPicked" :disabled="!pickedPkgId">
                进入项目上传资料 <Icon name="chevronRight" :size="16" />
              </button>
            </div>
          </template>
        </section>

        <aside class="feed-panel card">
          <div class="feed-title">最新录入项目 <span class="feed-sub">（全部承包商）</span></div>
          <div v-if="feedLoading" class="feed-empty">加载中…</div>
          <div v-else-if="!allPackages.length" class="feed-empty">暂无项目</div>
          <button v-for="p in allPackages" :key="p.id" class="feed-item" @click="openDetail(p.id)">
            <div class="feed-name">{{ p.project_name }}</div>
            <div class="feed-meta">{{ p.unit_name }} · {{ p.file_count }} 个文件 · {{ p.status ? '已提交' : '进行中' }}</div>
            <div class="feed-gate" :class="gateMissingOf(p) > 0 ? 'bad' : 'ok'">
              <span v-if="gateMissingOf(p) > 0">★ 开工门槛缺 {{ gateMissingOf(p) }} 项</span>
              <span v-else>✓ 门槛齐全</span>
            </div>
            <div class="feed-time">{{ fmtTime(p.updated_at) }}</div>
          </button>
        </aside>
      </div>
    </div>

    <!-- ───────── 步骤二：上传资料 ───────── -->
    <section v-else class="upload-stage">
      <div class="upload-main">
        <div class="card proj-head">
          <div>
            <div class="proj-name">{{ packageInfo.project_name }}</div>
            <div class="proj-meta">{{ packageInfo.unit_name }} · 上报人 {{ packageInfo.reporter_name || '—' }}</div>
            <div v-if="gateMissing > 0" class="proj-alert">
              <span class="star">★</span> 还有 <b>{{ gateMissing }}</b> 项开工门槛资料未上传（表中带 <span class="star">★</span> 的行）
            </div>
          </div>
          <button class="btn btn-ghost" @click="backToStep1"><Icon name="chevronLeft" :size="16" /> 换项目</button>
        </div>

        <div v-for="group in catalogTree" :key="group.category" class="card cat-block">
          <div class="cat-title">
            {{ group.category }}
            <span v-if="missingInGroup(group) > 0" class="cat-miss">★ 缺 {{ missingInGroup(group) }} 项必备</span>
          </div>
          <div
            v-for="item in group.items" :key="item.id"
            class="doc-row"
            :class="{
              done: hasFile(item.id),
              miss: !hasFile(item.id) && item.requiredType === 'gate',
              pend: !hasFile(item.id) && item.requiredType !== 'gate',
            }"
          >
            <div class="doc-info">
              <span class="doc-name">
                <span v-if="!hasFile(item.id) && item.requiredType === 'gate'" class="star" title="开工必备资料，尚未上传">★</span>
                {{ item.name }}
              </span>
              <span class="doc-tags">
                <span class="tag tag-freq">{{ item.freq }}</span>
                <span :class="['tag', item.requiredType === 'gate' ? 'tag-gate' : 'tag-dyn']">
                  {{ item.requiredType === 'gate' ? '开工门槛' : '动态维护' }}
                </span>
                <span v-if="!hasFile(item.id) && item.requiredType === 'gate'" class="tag tag-miss">必备缺项</span>
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
              <button v-else class="mini-btn up" :class="{ urgent: item.requiredType === 'gate' }" @click="triggerPick(item.id)" :disabled="uploading[item.id]">
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
            <div class="ring gate" :class="gateTotal && gateDone === gateTotal ? 'ok' : 'bad'">
              <div class="ring-num">{{ gateDone }}/{{ gateTotal }}</div>
              <div class="ring-lbl">开工门槛</div>
            </div>
            <div class="ring dyn" :class="dynDone === dynTotal ? 'ok' : ''">
              <div class="ring-num">{{ dynDone }}/{{ dynTotal }}</div>
              <div class="ring-lbl">动态维护</div>
            </div>
          </div>
          <div v-if="gateMissing > 0" class="side-alert">
            <span class="star">★</span> 还差 <b>{{ gateMissing }}</b> 项开工门槛资料，未补齐不得开工。
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
import logoUrl from '@/assets/logo.jpg'

const units = ref([])
const catalogTree = ref([])
const identity = ref({
  name: localStorage.getItem('cd_name') || '',
  phone: localStorage.getItem('cd_phone') || '',
})
const step = ref(1)

// 选择窗口：new = 新建项目录入 / edit = 修改已有项目
const mode = ref('new')

const form = ref({ unit_id: '', project_name: '' })

// 修改已有项目：先选单位 → 自动列出该单位的项目 → 直接下拉选
const pickUnit = ref('')
const unitPackages = ref([])
const pickedPkgId = ref('')
const loadingPkgs = ref(false)
const pkgTotals = ref({ gate_total: 0, dyn_total: 0 })

const packageId = ref(null)
const packageInfo = ref(null)
const files = ref([])
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

function switchMode(m) {
  if (mode.value === m) return
  mode.value = m
  if (m === 'new') { pickUnit.value = ''; unitPackages.value = []; pickedPkgId.value = '' }
}

function unitNameOf(id) {
  const u = units.value.find(x => String(x.id) === String(id))
  return u ? (u.short_name || u.unit_name) : ''
}

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

// 某项目还缺几项开工门槛资料
function gateMissingOf(p) {
  const total = Number(pkgTotals.value.gate_total) || 0
  const done = Number(p.gate_done) || 0
  return Math.max(0, total - done)
}

// 下拉里的一行文案：把「缺几项」放最前面 —— 项目名普遍很长，下拉宽度放不下会被截断，
// 最该先看到的判断依据（★缺N / ✓齐全）必须保证永远可见。完整项目名见下方预览块。
function pkgLabel(p) {
  const total = pkgTotals.value.gate_total || 0
  const lack = gateMissingOf(p)
  const flag = lack > 0 ? `★缺${lack}` : '✓齐全'
  return `${flag}　｜　门槛 ${p.gate_done || 0}/${total}　｜　${p.file_count || 0} 文件　｜　${p.status ? '已提交' : '进行中'}　｜　${p.project_name}`
}

const pickedPkg = computed(() => unitPackages.value.find(p => String(p.id) === String(pickedPkgId.value)) || null)

// 选单位后自动拉该单位的项目（无需输入关键词）
async function loadUnitPackages() {
  pickedPkgId.value = ''
  unitPackages.value = []
  if (!pickUnit.value) return
  loadingPkgs.value = true
  try {
    const res = await request.get('/api/contractor-docs/packages', { params: { unit_id: pickUnit.value } })
    unitPackages.value = res.data.data || []
    if (res.data.totals) pkgTotals.value = res.data.totals
  } catch {
    unitPackages.value = []
  } finally {
    loadingPkgs.value = false
  }
}

// 加载全员最新录入项目（公开列表，无过滤参数）
async function loadAllPackages() {
  feedLoading.value = true
  try {
    const res = await request.get('/api/contractor-docs/packages')
    allPackages.value = res.data.data || []
    if (res.data.totals) pkgTotals.value = res.data.totals
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
const gateMissing = computed(() => Math.max(0, gateTotal.value - gateDone.value))

// 某分类下还缺几项开工门槛资料
function missingInGroup(group) {
  let n = 0
  for (const it of group.items) {
    if (it.requiredType === 'gate' && !filesByCatalog.value[it.id]) n++
  }
  return n
}

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

function openPicked() {
  if (!pickedPkgId.value) return
  selectPackageById(pickedPkgId.value)
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
    window.scrollTo({ top: 0, behavior: 'smooth' })
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
  // 回到选择窗口时保持当前模式；若在"修改"模式，刷新一下该单位的项目列表（文件数/齐全度可能已变）
  if (mode.value === 'edit' && pickUnit.value) loadUnitPackages()
  loadAllPackages()
}

onMounted(() => { loadBase(); loadAllPackages() })
</script>

<style scoped>
.cd-page { max-width: 1080px; margin: 0 auto; padding: 20px 18px 60px; }
.cd-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.cd-brand { display: flex; align-items: center; gap: 12px; }
.brand-img { width: 42px; height: 42px; border-radius: 11px; object-fit: contain; background: #fff; box-shadow: 0 4px 12px rgba(29,111,184,.4); }
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

/* ── 选择窗口（新建 / 修改） ── */
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
.mode-card {
  position: relative; display: flex; align-items: flex-start; gap: 12px; text-align: left;
  background: var(--c-surface); border: 1.5px solid var(--c-border); border-radius: var(--r-lg);
  padding: 16px 18px; cursor: pointer; transition: all .16s ease; box-shadow: var(--shadow-sm);
}
.mode-card:hover { border-color: var(--c-blue-400, #7db0dd); transform: translateY(-1px); }
.mode-card.on { border-color: var(--c-blue-600); background: linear-gradient(180deg, var(--c-blue-50), var(--c-surface) 70%); box-shadow: 0 0 0 3px rgba(29,111,184,.12); }
.mc-ico { flex-shrink: 0; width: 38px; height: 38px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; background: var(--c-blue-600); color: #fff; }
.mc-ico.alt { background: #0f9d76; }
.mc-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mc-title { font-size: 15px; font-weight: 700; color: var(--c-text); }
.mc-sub { font-size: 12.5px; color: var(--c-text-3); line-height: 1.5; }
.mc-check { position: absolute; top: 12px; right: 12px; width: 20px; height: 20px; border-radius: 50%; background: var(--c-blue-600); color: #fff; display: inline-flex; align-items: center; justify-content: center; }

.step-card { margin-top: 0; }
.step-h { font-size: 16px; font-weight: 700; color: var(--c-text); display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.step-no { width: 26px; height: 26px; border-radius: 50%; background: var(--c-blue-600); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
.step-tip { font-size: 12.5px; color: var(--c-text-3); line-height: 1.6; margin-bottom: 16px; }
.form-grid { display: flex; gap: 14px; flex-wrap: wrap; }
.fg { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 200px; }
.fg-narrow { flex: 0 0 260px; min-width: 200px; }
.fg-wide { flex: 2; min-width: 280px; }
/* 工程/项目名称普遍很长，单独占一行，避免下拉里被截断看不全 */
.fg-block { flex: 1 1 100%; min-width: 100%; }
.fg label { font-size: 13px; color: var(--c-text-2); font-weight: 600; }

/* 下拉框必须用 background-color：background 简写会清掉全局 select.form-input 的 data-uri 箭头 */
.form-input {
  padding: 11px 13px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; font-family: var(--font-sans); color: var(--c-text);
  background-color: var(--c-surface); width: 100%;
}
.form-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }
.form-input:disabled { background-color: var(--c-surface-2); color: var(--c-text-3); cursor: not-allowed; }

.pick-empty { display: flex; align-items: center; gap: 6px; margin-top: 14px; padding: 11px 14px; border-radius: var(--r); background: #fff8e6; color: #96620a; font-size: 13px; }
.link { color: var(--c-blue-600); text-decoration: underline; font-weight: 600; }

.pick-preview { margin-top: 14px; padding: 14px 16px; border-radius: var(--r); background: var(--c-surface-2); border: 1px dashed var(--c-border-strong); }
.pp-name { font-size: 14.5px; font-weight: 700; color: var(--c-text); line-height: 1.5; }
.pp-meta { font-size: 12.5px; color: var(--c-text-2); margin-top: 4px; }
.pp-gate { font-size: 13px; margin-top: 8px; font-weight: 600; }
.pp-gate.bad { color: #c0392b; }
.pp-gate.ok { color: var(--c-success); display: flex; align-items: center; gap: 5px; }
.pp-gate b { font-size: 15px; }

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

/* ★ 必备缺项标记 */
.star { color: #e0342b; font-weight: 900; font-size: 14px; display: inline-block; margin-right: 3px; animation: starPulse 1.8s ease-in-out infinite; }
@keyframes starPulse { 0%, 100% { opacity: 1; transform: scale(1) } 50% { opacity: .55; transform: scale(1.15) } }

.upload-stage { display: grid; grid-template-columns: 1fr 280px; gap: 18px; margin-top: 6px; align-items: start; }
.upload-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.proj-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.proj-name { font-size: 16px; font-weight: 700; color: var(--c-text); line-height: 1.5; }
.proj-meta { font-size: 12.5px; color: var(--c-text-2); margin-top: 2px; }
.proj-alert { margin-top: 8px; font-size: 13px; color: #c0392b; background: #fff4f3; border: 1px solid #f6cdc9; padding: 7px 11px; border-radius: var(--r-sm); }

.cat-block { padding: 16px 18px; }
.cat-title { font-size: 14px; font-weight: 700; color: var(--c-blue-700); margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--c-border); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cat-miss { font-size: 11.5px; font-weight: 700; color: #c0392b; background: #fde8e8; padding: 2px 8px; border-radius: 20px; }
.doc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 8px; border-bottom: 1px dashed var(--c-border); border-radius: var(--r-sm); }
.doc-row:last-child { border-bottom: none; }
.doc-row.done { background: linear-gradient(90deg, var(--c-success-bg), transparent 60%); }
/* 必备资料缺失：整行淡红底 + 左侧红条，一眼能扫出来 */
.doc-row.miss { background: linear-gradient(90deg, #fff1f0, transparent 75%); border-left: 3px solid #e0342b; padding-left: 11px; }
.doc-row.pend { background: transparent; }
.doc-info { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.doc-name { font-size: 14px; color: var(--c-text); display: flex; align-items: center; gap: 2px; }
.doc-row.miss .doc-name { font-weight: 700; color: #b02a22; }
.doc-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
.tag-freq { background: var(--c-surface-2); color: var(--c-text-2); }
.tag-gate { background: #fde8e8; color: #c0392b; }
.tag-dyn { background: #e8f1fd; color: #2563eb; }
.tag-miss { background: #e0342b; color: #fff; }
.doc-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.file-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--c-blue-700); text-decoration: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--c-blue-50); padding: 5px 9px; border-radius: var(--r-sm); }
.file-chip:hover { text-decoration: underline; }
.mini-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; padding: 6px 10px; border-radius: var(--r-sm); border: 1px solid var(--c-border-strong); background: var(--c-surface); color: var(--c-text-2); cursor: pointer; transition: all .15s; }
.mini-btn:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.mini-btn.up { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.mini-btn.up.urgent { background: #e0342b; border-color: #e0342b; color: #fff; }
.mini-btn.up.urgent:hover { background: #c0392b; border-color: #c0392b; color: #fff; }
.mini-btn.danger:hover { border-color: var(--c-danger); color: var(--c-danger); }

.upload-side { position: sticky; top: 20px; }
.side-card { padding: 18px; }
.side-title { font-size: 14px; font-weight: 700; color: var(--c-text); margin-bottom: 14px; }
.ring-row { display: flex; gap: 12px; }
.ring { flex: 1; border-radius: var(--r); padding: 14px 8px; text-align: center; border: 1px solid var(--c-border); }
.ring.gate { background: #fde8e8; }
.ring.dyn { background: #e8f1fd; }
.ring.gate.bad { border-color: #e0342b; animation: ringBlink 2.2s ease-in-out infinite; }
@keyframes ringBlink { 0%, 100% { box-shadow: 0 0 0 0 rgba(224,52,43,.35) } 50% { box-shadow: 0 0 0 5px rgba(224,52,43,0) } }
.ring.ok { box-shadow: 0 0 0 2px var(--c-success); }
.ring-num { font-size: 22px; font-weight: 800; color: var(--c-text); }
.ring-lbl { font-size: 12px; color: var(--c-text-2); margin-top: 2px; }
.side-alert { display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; color: #c0392b; background: #fff4f3; border: 1px solid #f6cdc9; border-radius: var(--r-sm); padding: 9px 11px; margin-top: 12px; line-height: 1.55; }
.side-alert b { font-size: 14px; }
.side-tip { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: var(--c-text-2); margin-top: 12px; line-height: 1.5; }
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
.feed-gate { font-size: 11.5px; font-weight: 700; margin-top: 4px; }
.feed-gate.bad { color: #c0392b; }
.feed-gate.ok { color: var(--c-success); }
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
  .mode-switch { grid-template-columns: 1fr; }
}

@media (max-width: 820px) {
  .upload-stage { grid-template-columns: 1fr; }
  .upload-side { position: static; }
  .fg-narrow { flex: 1 1 100%; }
}
</style>
