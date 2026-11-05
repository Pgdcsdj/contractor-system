<template>
  <div class="submit-page">
    <header class="sp-header">
      <div class="sp-brand">
        <span class="sp-logo">通</span>
        <div>
          <h1>承包商安全活动填报</h1>
          <p>中国石化中原油田普光分公司 · 通南巴项目部</p>
        </div>
      </div>
    </header>

    <main class="sp-main">
      <!-- 栏目切换 -->
      <div class="type-tabs" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.key"
          role="tab"
          :aria-selected="type === t.key"
          class="type-tab"
          :class="{ on: type === t.key }"
          @click="switchType(t.key)"
        >
          <span class="tab-icon"><Icon :name="t.icon" :size="20" /></span>
          <span class="tab-text">
            <span class="tab-title">{{ t.label }}</span>
            <span class="tab-sub">{{ t.sub }}</span>
          </span>
        </button>
      </div>

      <!-- 身份与期次 -->
      <section class="card">
        <h2 class="sec-title">① 选择期次与单位</h2>
        <div class="form-grid">
          <div class="form-group full">
            <label>活动期次 / 排查项目 <i>*</i></label>
            <select v-model="periodId" class="form-input" @change="onPeriodChange">
              <option value="">请选择</option>
              <option v-for="p in periods" :key="p.id" :value="p.id">{{ p.title }}{{ p.is_overdue ? '（已过截止）' : '' }}</option>
            </select>
            <p v-if="period && period.due_at" class="hint" :class="{ overdue: period.is_overdue }">
              截止时间：{{ fmtDT(period.due_at) }}{{ period.is_overdue ? ' · 已过期，仍可补报' : '' }}
            </p>
            <p v-if="period?.description" class="hint">{{ period.description }}</p>
            <p v-if="!periods.length" class="hint empty-hint">
              当前「{{ typeLabel }}」暂无可填报期次。<br />
              请等项目部安全环保室发布后再来，或联系安全员确认是否已开启本期。
            </p>
          </div>
          <div class="form-group full">
            <label>承包商单位 <i>*</i></label>
            <input v-model="unitKeyword" class="form-input" placeholder="输入单位名称关键字可快速筛选" @input="loadUnits" />
            <select v-model="unitId" class="form-input unit-select" size="5" @change="loadMine">
              <option value="">— 请从四级网格单位中选择 —</option>
              <option v-for="u in filteredUnits" :key="u.id" :value="u.id">
                {{ u.unit_name }}　[{{ u.grid_l2 || '未分板块' }}{{ u.grid_level ? ' / ' + u.grid_level : '' }}]
              </option>
            </select>
            <p class="hint">单位清单来自「承包商准入 → 网格化管理」，如未找到请联系项目部管理员。</p>
          </div>
          <div class="form-group">
            <label>录入人姓名 <i>*</i></label>
            <input v-model="uploaderName" class="form-input" placeholder="请填写真实姓名" />
          </div>
          <div class="form-group">
            <label>联系电话 <i>*</i></label>
            <input v-model="uploaderPhone" class="form-input" placeholder="手机号或座机" @blur="loadMine" />
          </div>
        </div>
        <div class="tip-line"><Icon name="alert" :size="15" /> 无需登录，凭「单位 + 姓名 + 电话」留痕，可回显和修改本单位本期上报内容。</div>
      </section>

      <!-- 周一 / 周三：结构化表单 -->
      <section v-if="period && type !== 'inspection'" class="card">
        <h2 class="sec-title">② 填写{{ type === 'monday' ? 'HSE 活动（会议）记录' : '周三安全培训教育主题活动' }}</h2>
        <div class="form-grid">
          <div v-for="f in fields" :key="f.key" class="form-group" :class="{ full: f.wide }">
            <label>{{ f.label }}</label>
            <input v-if="f.type === 'date'" v-model="form[f.key]" type="date" class="form-input" />
            <textarea v-else-if="f.wide" v-model="form[f.key]" class="form-input" rows="3" :placeholder="f.placeholder || ''"></textarea>
            <input v-else v-model="form[f.key]" class="form-input" :placeholder="f.placeholder || ''" />
          </div>
        </div>
        <div class="submit-line">
          <button class="btn btn-primary" :disabled="submitting" @click="submitForm">{{ submitting ? '提交中…' : '提交活动记录' }}</button>
          <span v-if="myRecord" class="mine-tag">本期已有上报记录，再次提交将覆盖更新</span>
        </div>
      </section>

      <!-- 排查：下载标准表 / 回填 / 在线补录 -->
      <section v-if="period && type === 'inspection'" class="card">
        <h2 class="sec-title">② 下载标准表 → 填写 → 上传回填</h2>
        <div class="download-row">
          <button class="btn btn-outline" @click="downloadTpl(false)"><Icon name="download" :size="16" /> 下载标准表（含下发问题库）</button>
          <button class="btn btn-outline" @click="downloadTpl(true)"><Icon name="download" :size="16" /> 下载空白填报模板</button>
          <span class="col-hint">本期排查项目共 {{ period.columns?.length || 0 }} 列</span>
        </div>
        <p class="hint">在下载的标准表中填写本队涉及的问题行后上传；未修改的行系统会自动跳过，只汇总已填写内容。也可直接在下方「在线补录」逐行填写。</p>

        <div class="import-box">
          <div class="file-upload" @click="triggerImport">
            <Icon name="upload" :size="28" />
            <span>{{ importFile ? importFile.name : '点击上传填写好的标准表（.xlsx / .xls）' }}</span>
          </div>
          <input ref="importInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onImportChange" />
          <button class="btn btn-primary" :disabled="importing || !importFile" @click="doImport">
            {{ importing ? '解析中…' : '上传并回填（整单覆盖）' }}
          </button>
        </div>
        <div v-if="importResult" class="result-box" :class="importResult.ok ? 'ok' : 'bad'">
          <template v-if="importResult.ok">
            回填成功：导入 <b>{{ importResult.imported }}</b> 行，跳过未修改/空行 {{ importResult.skipped }} 行。
          </template>
          <template v-else>{{ importResult.msg }}</template>
        </div>

        <div class="online-block">
          <div class="online-head">
            <h3>在线补录（按标准表列逐行填写）</h3>
            <button class="btn-ghost" @click="addRow">+ 添加一行</button>
          </div>
          <div v-if="!period.columns?.length" class="hint">该期次暂未配置标准表列，请联系管理员上传。</div>
          <div v-else class="online-rows">
            <div v-for="(row, ri) in onlineRows" :key="ri" class="online-row">
              <div class="row-head">
                <span>第 {{ ri + 1 }} 行</span>
                <button class="btn-ghost danger" @click="onlineRows.splice(ri, 1)">删除</button>
              </div>
              <div class="row-fields">
                <div v-for="c in period.columns" :key="c" class="row-field">
                  <label>{{ c }}</label>
                  <input v-model="row[c]" class="form-input" />
                </div>
              </div>
            </div>
            <div v-if="!onlineRows.length" class="hint">还没有补录行，点「+ 添加一行」开始。</div>
          </div>
          <button v-if="onlineRows.length" class="btn btn-primary" :disabled="submitting" @click="submitRows">
            {{ submitting ? '提交中…' : '提交补录内容' }}
          </button>
        </div>
      </section>

      <!-- 附件 -->
      <section v-if="period" class="card">
        <h2 class="sec-title">③ 上传附件（签到表 / 照片 / 材料）</h2>
        <div class="upload-row">
          <select v-model="fileCategory" class="form-input">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
          <div class="file-upload small" @click="triggerFile">
            <Icon name="upload" :size="20" />
            <span>{{ attachFile ? attachFile.name : '选择文件（PDF/图片/Word/Excel，单文件 ≤20MB）' }}</span>
          </div>
          <input ref="attachInput" type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.xls" style="display:none" @change="onAttachChange" />
          <button class="btn btn-outline" :disabled="uploading || !attachFile" @click="doUpload">{{ uploading ? '上传中…' : '上传附件' }}</button>
        </div>
      </section>

      <!-- 本单位本期上报回显 -->
      <section v-if="myRecord" class="card mine-card">
        <h2 class="sec-title">本单位本期已上报内容 <span class="mine-time">{{ myRecord.submitted_at ? fmtDT(myRecord.submitted_at) : '' }}</span></h2>
        <p class="hint">上报人：{{ myRecord.uploader_name }} / {{ myRecord.uploader_phone }}　来源：{{ sourceLabel(myRecord.source) }}</p>
        <div v-if="myRows.length" class="mine-rows">
          <div class="table-scroll">
            <table class="data-table compact">
              <thead><tr><th>#</th><th v-for="c in (period?.columns || myColumns)" :key="c">{{ c }}</th><th v-if="type === 'inspection'">操作</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in myRows" :key="r.id">
                  <td>{{ i + 1 }}</td>
                  <td v-for="c in (period?.columns || myColumns)" :key="c">{{ r.data?.[c] || '' }}</td>
                  <td v-if="type === 'inspection'"><button class="btn-ghost danger" @click="removeRow(r)">删除</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-if="myFiles.length" class="mine-files">
          <a v-for="f in myFiles" :key="f.id" :href="f.cos_url" target="_blank" rel="noopener" class="file-link">
            <Icon name="file" :size="14" /> {{ f.category }}：{{ f.original_name }}
          </a>
        </div>
        <div v-if="type !== 'inspection' && Object.keys(myRecord.form || {}).length" class="mine-form">
          <div v-for="f in fields" :key="f.key" class="mf-item" :class="{ full: f.wide }">
            <label>{{ f.label }}</label><div>{{ myRecord.form?.[f.key] || '—' }}</div>
          </div>
        </div>
      </section>
    </main>

    <footer class="sp-footer">通南巴承包商安全培训与隐患整改闭环管理系统 · 安全活动填报</footer>
    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import { fmtDT } from '@/utils/datetime'
import {
  getOpenUnits, getOpenPeriods, getOpenPeriod, submitActivityForm,
  importActivityFilled, submitActivityRows, uploadActivityFile, getMySubmission,
  deleteMyRow, openDownloadTemplate,
} from '@/api/activity'

const MONDAY_FIELDS = [
  { key: 'activity_time', label: '活动时间', type: 'date' },
  { key: 'location', label: '活动地点', placeholder: '如：马401-4井会议室' },
  { key: 'activity_name', label: '会议（活动）名称', placeholder: '“周一”HSE活动' },
  { key: 'host', label: '主持人' },
  { key: 'main_content', label: '会议（活动）主要内容', wide: true },
  { key: 'attendees', label: '参加人员', wide: true, placeholder: '附签到表、参会人照片' },
  { key: 'hse_meeting', label: '（一）周一 HSE 例会', wide: true },
  { key: 'training', label: '培训学习情况', wide: true },
  { key: 'hazard_check', label: '隐患排查情况', wide: true },
  { key: 'drill', label: '应急演练情况', wide: true },
  { key: 'next_plan', label: '二、下步重点工作安排', wide: true },
  { key: 'remark', label: '备注', wide: true },
]
const WEDNESDAY_FIELDS = [
  { key: 'study_time', label: '学习时间', type: 'date' },
  { key: 'location', label: '学习地点' },
  { key: 'host', label: '主持人' },
  { key: 'study_content', label: '学习内容', wide: true, placeholder: '如：《2026年消防月宣传视频》' },
  { key: 'study_detail', label: '学习具体内容', wide: true },
  { key: 'attendees', label: '参加人员', wide: true },
  { key: 'remark', label: '备注', wide: true },
]
const MONDAY_CATS = ['签到表', '参会人照片', 'HSE隐患整改通知单', '检查问题汇总', '其他附件']
const WEDNESDAY_CATS = ['学习材料', '学习照片', '其他附件']
const INSPECTION_CATS = ['排查佐证材料', '整改照片', '回填表', '其他附件']

const TABS = [
  { key: 'monday', label: '周一安全活动', sub: 'HSE 活动记录', icon: 'clipboard' },
  { key: 'wednesday', label: '周三学习活动', sub: '安全培训教育', icon: 'book' },
  { key: 'inspection', label: '上级检查类比排查', sub: '下载标准表回填', icon: 'list' },
]

const type = ref('monday')
const typeLabel = computed(() => ({
  monday: '周一安全活动',
  wednesday: '周三学习活动',
  inspection: '上级检查类比排查',
}[type.value] || ''))
const periods = ref([])
const periodId = ref('')
const period = ref(null)
const units = ref([])
const unitKeyword = ref('')
const unitId = ref('')
const uploaderName = ref('')
const uploaderPhone = ref('')
const form = reactive({})
const fields = computed(() => type.value === 'monday' ? MONDAY_FIELDS : WEDNESDAY_FIELDS)
const categories = computed(() => type.value === 'monday' ? MONDAY_CATS : (type.value === 'wednesday' ? WEDNESDAY_CATS : INSPECTION_CATS))
const filteredUnits = computed(() => {
  const k = unitKeyword.value.trim().toLowerCase()
  if (!k) return units.value
  return units.value.filter((u) => String(u.unit_name || '').toLowerCase().includes(k) || String(u.grid_l2 || '').toLowerCase().includes(k))
})

const submitting = ref(false)
const importing = ref(false)
const uploading = ref(false)
const importFile = ref(null)
const importInput = ref(null)
const importResult = ref(null)
const onlineRows = ref([])
const attachFile = ref(null)
const attachInput = ref(null)
const fileCategory = ref('')
const myRecord = ref(null)
const myRows = ref([])
const myFiles = ref([])
const myColumns = ref([])

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, t = 'success') {
  toast.msg = msg; toast.type = t; toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 4000)
}
function errMsg(e) { return e.response?.data?.error || e.message || '操作失败' }
function sourceLabel(s) { return s === 'import' ? '表格回填' : (s === 'online' ? '在线补录' : '表单录入') }

async function loadPeriods() {
  try {
    const res = await getOpenPeriods(type.value)
    periods.value = res.data?.data || []
    if (!periods.value.some((p) => String(p.id) === String(periodId.value))) {
      periodId.value = periods.value.length ? periods.value[0].id : ''
    }
    await onPeriodChange()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function loadUnits() {
  try {
    const res = await getOpenUnits('')
    units.value = res.data?.data || []
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function onPeriodChange() {
  period.value = null
  myRecord.value = null; myRows.value = []; myFiles.value = []
  onlineRows.value = []; importResult.value = null
  fileCategory.value = categories.value[0] || ''
  if (!periodId.value) return
  try {
    const res = await getOpenPeriod(periodId.value)
    period.value = res.data?.data || null
  } catch (e) { showToast(errMsg(e), 'error') }
  await loadMine()
}
function switchType(t) {
  if (type.value === t) return
  type.value = t
  periodId.value = ''
  Object.keys(form).forEach((k) => delete form[k])
  loadPeriods()
}
function identity(extra = {}) {
  if (!periodId.value) throw new Error('请选择活动期次')
  if (!unitId.value) throw new Error('请选择承包商单位')
  if (!uploaderName.value.trim()) throw new Error('请填写录入人姓名')
  if (!uploaderPhone.value.trim()) throw new Error('请填写联系电话')
  return {
    period_id: Number(periodId.value), unit_id: Number(unitId.value),
    uploader_name: uploaderName.value.trim(), uploader_phone: uploaderPhone.value.trim(), ...extra,
  }
}
async function submitForm() {
  submitting.value = true
  try {
    const payload = identity({ form: { ...form } })
    await submitActivityForm(payload)
    showToast('活动记录已提交', 'success')
    await loadMine()
  } catch (e) { showToast(errMsg(e), 'error') }
  submitting.value = false
}
function triggerImport() { importInput.value?.click() }
function onImportChange(e) { const f = e.target.files?.[0]; if (f) { importFile.value = f; importResult.value = null } }
async function doImport() {
  if (!importFile.value) return
  importing.value = true
  importResult.value = null
  try {
    const fd = new FormData()
    const i = identity()
    Object.keys(i).forEach((k) => fd.append(k, i[k]))
    fd.append('file', importFile.value)
    const res = await importActivityFilled(fd)
    const d = res.data?.data || {}
    importResult.value = { ok: true, imported: d.imported || 0, skipped: d.skipped || 0 }
    showToast('回填成功', 'success')
    importFile.value = null
    if (importInput.value) importInput.value.value = ''
    await loadMine()
  } catch (e) { importResult.value = { ok: false, msg: errMsg(e) } }
  importing.value = false
}
function addRow() {
  if (!period.value?.columns?.length) return showToast('该期次暂无标准表列', 'error')
  onlineRows.value.push({})
}
async function submitRows() {
  submitting.value = true
  try {
    const payload = identity({ rows: onlineRows.value })
    await submitActivityRows(payload)
    showToast('补录内容已提交', 'success')
    onlineRows.value = []
    await loadMine()
  } catch (e) { showToast(errMsg(e), 'error') }
  submitting.value = false
}
function triggerFile() { attachInput.value?.click() }
function onAttachChange(e) { const f = e.target.files?.[0]; if (f) attachFile.value = f }
async function doUpload() {
  if (!attachFile.value) return
  uploading.value = true
  try {
    const fd = new FormData()
    const i = identity()
    Object.keys(i).forEach((k) => fd.append(k, i[k]))
    fd.append('category', fileCategory.value || '其他附件')
    fd.append('file', attachFile.value)
    await uploadActivityFile(fd)
    showToast('附件已上传', 'success')
    attachFile.value = null
    if (attachInput.value) attachInput.value.value = ''
    await loadMine()
  } catch (e) { showToast(errMsg(e), 'error') }
  uploading.value = false
}
async function loadMine() {
  if (!periodId.value || !unitId.value || !uploaderPhone.value.trim()) { myRecord.value = null; return }
  try {
    const res = await getMySubmission({
      period_id: periodId.value, unit_id: unitId.value, phone: uploaderPhone.value.trim(),
    })
    const d = res.data?.data || null
    myRecord.value = d?.record || null
    myRows.value = d?.rows || []
    myFiles.value = d?.files || []
    myColumns.value = d?.columns || []
    if (myRecord.value?.form) {
      Object.keys(myRecord.value.form).forEach((k) => { form[k] = myRecord.value.form[k] })
    }
  } catch (e) { /* 静默：尚无记录 */ }
}
async function removeRow(r) {
  if (!confirm('确认删除这一行？')) return
  try {
    await deleteMyRow(r.id, uploaderName.value.trim(), uploaderPhone.value.trim())
    showToast('已删除', 'success')
    await loadMine()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function downloadTpl(blank) {
  if (!period.value) return
  try {
    await openDownloadTemplate(period.value.id, period.value.title, blank)
    showToast(blank ? '空白模板已下载' : '标准表已下载', 'success')
  } catch (e) { showToast(errMsg(e), 'error') }
}
onMounted(async () => { await loadUnits(); await loadPeriods() })
</script>

<style scoped>
.submit-page { min-height: 100vh; background: var(--c-bg, #f5f7fa); }
.sp-header { background: linear-gradient(120deg, #0c447c, #185fa5); color: #fff; padding: 18px 20px; }
.sp-brand { max-width: 940px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
.sp-logo { width: 40px; height: 40px; border-radius: 10px; background: rgba(255,255,255,.18); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; }
.sp-brand h1 { font-size: 18px; margin: 0; font-weight: 600; }
.sp-brand p { font-size: 11.5px; margin: 3px 0 0; opacity: .8; }
.sp-main { max-width: 940px; margin: 0 auto; padding: 18px 16px 30px; display: flex; flex-direction: column; gap: 14px; }
.type-tabs {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
  background: #fff; border: 1px solid #E6EAF0; border-radius: 12px; padding: 8px;
  box-shadow: 0 1px 2px rgba(15,23,42,.04);
}
.type-tab {
  display: flex; align-items: center; justify-content: center; gap: 9px;
  min-width: 0; padding: 11px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid #E6EAF0; background: #F4F6FB; color: #475569;
  font-family: inherit; transition: background .18s, color .18s, border-color .18s, box-shadow .18s;
}
.type-tab:hover { background: #EAF3FB; color: #155A96; border-color: #BBD7EF; }
.type-tab.on {
  background: #1D6FB8; color: #FFFFFF; border-color: #1D6FB8;
  box-shadow: 0 4px 14px rgba(29,111,184,.28);
}
.tab-icon { display: inline-flex; flex-shrink: 0; }
.tab-text { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; text-align: left; }
.tab-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; }
.tab-sub { font-size: 11px; color: #94A3B8; white-space: nowrap; }
.type-tab.on .tab-sub { color: rgba(255,255,255,.82); }
.card { background: var(--c-surface, #fff); border: 1px solid var(--c-border, #E6EAF0); border-radius: 12px; padding: 16px; }
.sec-title { font-size: 15px; font-weight: 600; color: var(--c-text); margin: 0 0 14px; display: flex; align-items: center; gap: 10px; }
.mine-time { font-size: 12px; color: var(--c-text-3); font-weight: 400; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 5px; }
.form-group.full { grid-column: 1 / -1; }
.form-group label { font-size: 12.5px; color: var(--c-text-2); }
.form-group label i, .form-group label i { color: #e24b4a; font-style: normal; }
.form-input { padding: 9px 10px; border: 1px solid var(--c-border, #E6EAF0); border-radius: 8px; font-size: 13px; background: var(--c-surface, #fff); color: var(--c-text); font-family: inherit; width: 100%; box-sizing: border-box; }
textarea.form-input { resize: vertical; }
.unit-select { height: 128px; padding: 4px; }
.unit-select option { padding: 5px 6px; font-size: 12.5px; }
.hint { font-size: 12px; color: var(--c-text-3); line-height: 1.6; margin: 4px 0 0; }
.hint.overdue { color: #ba7517; }
.hint.empty-hint { color: #ba7517; background: #fff7e6; border-radius: 8px; padding: 10px 12px; line-height: 1.7; }
.tip-line { display: flex; align-items: center; gap: 7px; margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: var(--c-surface-2, #f7f8fa); font-size: 12px; color: var(--c-text-2); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 15px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid var(--c-border, #E6EAF0); background: var(--c-surface, #fff); color: var(--c-text); white-space: nowrap; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--c-primary, #1D6FB8); color: #fff; border-color: var(--c-primary, #1D6FB8); }
.btn-outline { background: transparent; }
.btn-ghost { border: none; background: none; color: var(--c-primary, #1D6FB8); cursor: pointer; font-size: 12.5px; padding: 3px 6px; }
.btn-ghost.danger { color: #e24b4a; }
.submit-line { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.mine-tag { font-size: 12px; color: #ba7517; }
.download-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.col-hint { font-size: 12px; color: var(--c-text-3); }
.import-box { display: flex; align-items: stretch; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.file-upload { flex: 1; min-width: 240px; display: flex; align-items: center; gap: 10px; padding: 14px; border: 1px dashed var(--c-border, #E6EAF0); border-radius: 9px; cursor: pointer; color: var(--c-text-2); font-size: 12.5px; }
.file-upload:hover { border-color: var(--c-primary, #1D6FB8); color: var(--c-primary, #1D6FB8); }
.file-upload.small { padding: 8px 12px; min-width: 220px; }
.result-box { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 12.5px; }
.result-box.ok { background: #e8f7f1; color: #0f6e56; }
.result-box.bad { background: #fcecec; color: #a32d2d; }
.online-block { margin-top: 18px; border-top: 1px solid var(--c-border, #E6EAF0); padding-top: 14px; }
.online-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.online-head h3 { font-size: 13.5px; margin: 0; color: var(--c-text); }
.online-rows { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.online-row { border: 1px solid var(--c-border, #E6EAF0); border-radius: 9px; padding: 10px; }
.row-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--c-text-3); margin-bottom: 8px; }
.row-fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.row-field { display: flex; flex-direction: column; gap: 3px; }
.row-field label { font-size: 11px; color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-field .form-input { padding: 6px 8px; font-size: 12px; }
.upload-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.upload-row > select { width: 180px; }
.mine-card { border-color: var(--c-primary, #1D6FB8); }
.mine-rows { margin-top: 12px; }
.table-scroll { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data-table th, .data-table td { padding: 8px 9px; border-bottom: 1px solid var(--c-border, #E6EAF0); text-align: left; white-space: nowrap; }
.data-table th { background: var(--c-surface-2, #f7f8fa); color: var(--c-text-2); font-weight: 600; }
.mine-files { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.file-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--c-primary, #1D6FB8); text-decoration: none; }
.mine-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.mf-item.full { grid-column: 1 / -1; }
.mf-item label { font-size: 11.5px; color: var(--c-text-3); display: block; margin-bottom: 3px; }
.mf-item div { font-size: 12.5px; color: var(--c-text); background: var(--c-surface-2, #f7f8fa); padding: 7px 9px; border-radius: 7px; white-space: pre-wrap; }
.sp-footer { text-align: center; font-size: 11.5px; color: var(--c-text-3); padding: 16px; }
.toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 500; padding: 11px 20px; border-radius: 9px; font-size: 13px; background: #1d9e75; color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.2); max-width: 90vw; }
.toast.error { background: #e24b4a; }
@media (max-width: 768px) {
  .form-grid, .mine-form { grid-template-columns: 1fr; }
  .row-fields { grid-template-columns: 1fr 1fr; }
  .upload-row > select { width: 100%; }
  .type-tabs button { min-width: 118px; font-size: 12px; }
}
</style>
