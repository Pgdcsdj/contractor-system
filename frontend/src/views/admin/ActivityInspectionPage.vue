<template>
  <div class="inspection-page">
    <div class="page-head">
      <div>
        <h2 class="page-section-title">上级检查问题类比排查</h2>
        <p class="sub">管理员上传标准表并设定截止时间 → 各承包商下载填写回填 → 系统自动汇总成一张表</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-outline" @click="openSubmitEntry"><Icon name="file" :size="16" /> 打开填报入口</button>
        <button class="btn btn-primary" @click="openCreate"><Icon name="plus" :size="16" /> 新建排查项目</button>
      </div>
    </div>

    <!-- 到期提醒横幅 -->
    <div v-if="reminders.length" class="remind-banner">
      <Icon name="bell" :size="18" />
      <div class="rb-body">
        <div v-for="r in reminders" :key="r.id" class="rb-line">
          <strong>{{ r.title }}</strong> — {{ r.content }}
        </div>
      </div>
      <button class="btn-ghost" @click="loadReminders">刷新</button>
    </div>

    <!-- 项目列表 -->
    <div class="card table-card">
      <div class="table-toolbar">
        <span class="table-title">排查项目（批次）</span>
        <span class="total-count">共 {{ periods.length }} 个</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>项目名称</th><th>标准表列数</th><th>截止时间</th><th>应报</th><th>已报</th>
              <th>未报</th><th>明细行</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="9" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td></tr>
            <tr v-else-if="!periods.length"><td colspan="9" class="empty-cell">暂无排查项目，点击「新建排查项目」上传标准表格</td></tr>
            <tr v-for="p in periods" :key="p.id" :class="{ 'row-overdue': p.is_due && p.status === 'open' }">
              <td><strong>{{ p.title }}</strong></td>
              <td>{{ p.columnCount }} 列</td>
              <td>{{ p.due_at ? fmtDT(p.due_at) : '-' }}</td>
              <td>{{ p.expected }}</td>
              <td class="c-ok"><b>{{ p.reportedCount }}</b></td>
              <td class="c-warn"><b>{{ p.unreportedCount }}</b></td>
              <td>{{ p.rowTotal }}</td>
              <td>
                <span class="badge" :class="p.status === 'open' ? 'b-open' : 'b-closed'">{{ p.status === 'open' ? '进行中' : '已关闭' }}</span>
                <span v-if="p.is_due && p.status === 'open'" class="badge b-due">已到期</span>
              </td>
              <td class="op-cell">
                <button class="action-link" @click="openDetail(p)"><Icon name="search" :size="14" /> 查看汇总</button>
                <button class="action-link" @click="exportOne(p)"><Icon name="download" :size="14" /> 导出</button>
                <button class="action-link danger" @click="removePeriod(p)"><Icon name="trash" :size="14" /> 删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建排查项目 -->
    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h3><Icon name="plus" :size="19" /> 新建排查项目</h3>
        <p class="modal-hint">
          ① 上传一份标准 Excel 表格（列名即排查项目，系统自动解析，格式每期可不同）；
          ② 设定上报截止时间与提前提醒天数（到期在系统内提醒）；
          ③ 创建后各承包商可在填报入口下载标准表、填写并上传回填。
        </p>
        <div class="form-grid">
          <div class="form-group full"><label>项目名称 <i>*</i></label><input v-model="cf.title" class="form-input" placeholder="如：2026年集团公司QHSE大检查问题类比排查" /></div>
          <div class="form-group"><label>上报截止时间 <i>*</i></label><input v-model="cf.due_at" type="datetime-local" class="form-input" /></div>
          <div class="form-group"><label>提前提醒（天）</label><input v-model.number="cf.remind_days" type="number" min="0" max="30" class="form-input" /></div>
          <div class="form-group full"><label>排查要求 / 说明</label><textarea v-model="cf.description" rows="2" class="form-input" placeholder="选填，如：请对照附件3逐条排查，只填写本队涉及的问题行"></textarea></div>
          <div class="form-group full">
            <label>标准表格（.xlsx / .xls）<i>*</i></label>
            <div class="file-upload" @click="triggerTpl">
              <Icon name="upload" :size="26" />
              <span>{{ tplFile ? tplFile.name : '点击上传标准表格（表头将在创建后自动解析）' }}</span>
            </div>
            <input ref="tplInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onTplChange" />
            <p v-if="tplHint" class="tpl-hint">{{ tplHint }}</p>
          </div>
          <div class="form-group full">
            <label>应报单位范围</label>
            <div class="unit-scope">
              <label class="radio-line"><input type="radio" v-model="scopeMode" value="all" /> 全部在册单位（默认）</label>
              <label class="radio-line"><input type="radio" v-model="scopeMode" value="part" /> 指定单位</label>
            </div>
            <div v-if="scopeMode === 'part'" class="scope-box">
              <input v-model="unitKeyword" class="form-input" placeholder="搜索单位" @input="loadUnits" />
              <div class="scope-checks">
                <label v-for="u in units" :key="u.id" class="check-line">
                  <input type="checkbox" :value="u.id" v-model="scopeIds" /> {{ u.unit_name }} <em>{{ u.grid_l2 }}</em>
                </label>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showCreate = false">取消</button>
          <button class="btn btn-primary" :disabled="creating" @click="doCreate">{{ creating ? '创建中…' : '确认创建' }}</button>
        </div>
      </div>
    </div>

    <!-- 详情：统计 + 汇总表 -->
    <div v-if="showDetail" class="modal-overlay" @click.self="showDetail = false">
      <div class="modal widest">
        <h3><Icon name="list" :size="19" /> {{ detail.period?.title }} · 汇总</h3>
        <p class="modal-hint">
          截止 {{ detail.period?.due_at ? fmtDT(detail.period.due_at) : '-' }} ·
          应报 {{ detail.stats?.expected || 0 }} 家 / <b class="c-ok">已报 {{ detail.stats?.reportedCount || 0 }}</b> /
          <b class="c-warn">未报 {{ detail.stats?.unreportedCount || 0 }}</b> · 明细 {{ detail.rows?.length || 0 }} 行
        </p>

        <div class="detail-tabs">
          <button :class="{ on: tab === 'summary' }" @click="tab = 'summary'">汇总表（{{ detail.rows?.length || 0 }}）</button>
          <button :class="{ on: tab === 'reported' }" @click="tab = 'reported'">已报单位（{{ detail.stats?.reported?.length || 0 }}）</button>
          <button :class="{ on: tab === 'unreported' }" @click="tab = 'unreported'">未报单位（{{ detail.stats?.unreported?.length || 0 }}）</button>
        </div>

        <div v-if="tab === 'summary'" class="summary-wrap">
          <div v-if="!detail.rows?.length" class="empty-cell">暂无填报数据</div>
          <div v-else class="table-scroll">
            <table class="data-table compact">
              <thead><tr><th>填报单位</th><th>上报人</th><th v-for="c in detail.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in detail.rows" :key="i">
                  <td><strong>{{ r.unit_name }}</strong></td>
                  <td>{{ r.uploader_name }}</td>
                  <td v-for="c in detail.columns" :key="c" class="cell-long">{{ r.data?.[c] || '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-else-if="tab === 'reported'" class="unit-list">
          <div v-for="u in detail.stats?.reported || []" :key="u.id" class="unit-row">
            <span><strong>{{ u.unit_name }}</strong> <em>{{ u.grid_l2 }} {{ u.grid_level }}</em></span>
            <span>{{ u.record?.uploader_name }} · {{ u.record?.uploader_phone }}</span>
            <span>{{ u.row_count || 0 }} 行 / {{ u.file_count || 0 }} 附件</span>
            <span>{{ u.record?.submitted_at ? fmtDT(u.record.submitted_at) : '' }}</span>
          </div>
          <div v-if="!detail.stats?.reported?.length" class="empty-cell">暂无单位上报</div>
        </div>

        <div v-else class="unit-list">
          <div v-for="u in detail.stats?.unreported || []" :key="u.id" class="unit-row">
            <span><strong>{{ u.unit_name }}</strong> <em>{{ u.grid_l2 }} {{ u.grid_level }}</em></span>
            <span class="c-warn">未上报</span>
          </div>
          <div v-if="!detail.stats?.unreported?.length" class="empty-cell">全部单位已上报</div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" @click="downloadTemplate(false)">下载标准表</button>
          <button class="btn btn-outline" @click="downloadTemplate(true)">下载空白模板</button>
          <button class="btn btn-primary" @click="exportOne(detail.period)"><Icon name="download" :size="16" /> 导出汇总表</button>
          <button class="btn btn-outline" @click="showDetail = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import { fmtDT } from '@/utils/datetime'
import { openActivitySubmit } from '@/utils/activityLink'
import {
  getActivityPeriods, createActivityPeriod, deleteActivityPeriod, getActivityUnits,
  getActivitySummary, getActivityReminders, exportPeriodSummary, downloadPeriodTemplate,
} from '@/api/activity'

const periods = ref([])
const loading = ref(false)
const reminders = ref([])
const showCreate = ref(false)
const creating = ref(false)
const scopeMode = ref('all')
const scopeIds = ref([])
const unitKeyword = ref('')
const units = ref([])
const tplFile = ref(null)
const tplInput = ref(null)
const tplHint = ref('')
const cf = reactive({ title: '', due_at: '', remind_days: 3, description: '' })

const showDetail = ref(false)
const tab = ref('summary')
const detail = reactive({ period: null, columns: [], rows: [], stats: {} })

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg; toast.type = type; toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3600)
}
function errMsg(e) { return e.response?.data?.error || e.message || '操作失败' }

async function loadPeriods() {
  loading.value = true
  try {
    const res = await getActivityPeriods({ type: 'inspection' })
    periods.value = res.data?.data || []
  } catch (e) { showToast(errMsg(e), 'error') }
  loading.value = false
}
async function loadReminders() {
  try {
    const res = await getActivityReminders()
    reminders.value = (res.data?.data?.list || []).filter((r) => !r.is_read)
  } catch (e) { /* 静默 */ }
}
async function loadUnits() {
  try {
    const res = await getActivityUnits(unitKeyword.value)
    units.value = res.data?.data || []
  } catch (e) { showToast(errMsg(e), 'error') }
}
function defaultDue() {
  const d = new Date(Date.now() + 7 * 86400000)
  d.setHours(18, 0, 0, 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function openCreate() {
  cf.title = ''
  cf.due_at = defaultDue()
  cf.remind_days = 3
  cf.description = ''
  tplFile.value = null; tplHint.value = ''
  scopeMode.value = 'all'; scopeIds.value = []; unitKeyword.value = ''
  showCreate.value = true
  loadUnits()
}
function triggerTpl() { tplInput.value?.click() }
function onTplChange(e) {
  const f = e.target.files?.[0]
  if (f) { tplFile.value = f; tplHint.value = `已选择：${f.name}（${(f.size / 1024).toFixed(1)} KB）` }
}
async function doCreate() {
  if (!cf.title.trim()) return showToast('请填写项目名称', 'error')
  if (!cf.due_at) return showToast('请设置上报截止时间', 'error')
  if (!tplFile.value) return showToast('请上传标准表格', 'error')
  creating.value = true
  try {
    const form = new FormData()
    form.append('period_type', 'inspection')
    form.append('title', cf.title.trim())
    form.append('due_at', cf.due_at.replace('T', ' ') + ':00')
    form.append('remind_days', String(cf.remind_days || 0))
    form.append('description', cf.description || '')
    form.append('expected_unit_ids', JSON.stringify(scopeMode.value === 'part' ? scopeIds.value.map(Number) : []))
    form.append('template', tplFile.value)
    const res = await createActivityPeriod(form)
    const d = res.data?.data || {}
    showToast(`项目已创建，自动解析出 ${d.columns?.length || 0} 列排查项目、${d.templateRows || 0} 行下发问题库`, 'success')
    showCreate.value = false
    await loadPeriods(); await loadReminders()
    if (tplInput.value) tplInput.value.value = ''
  } catch (e) { showToast(errMsg(e), 'error') }
  creating.value = false
}
async function removePeriod(p) {
  if (!confirm(`确认删除排查项目「${p.title}」？所有回填数据、附件将一并删除，不可恢复。`)) return
  try {
    await deleteActivityPeriod(p.id)
    showToast('已删除', 'success')
    await loadPeriods()
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function openDetail(p) {
  try {
    const res = await getActivitySummary(p.id)
    const d = res.data?.data || {}
    detail.period = d.period || p
    detail.columns = d.columns || []
    detail.rows = d.rows || []
    detail.stats = d.stats || {}
    tab.value = 'summary'
    showDetail.value = true
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function exportOne(p) {
  if (!p?.id) return
  try {
    await exportPeriodSummary(p.id, p.title, 'inspection')
    showToast('汇总表已导出', 'success')
  } catch (e) { showToast(errMsg(e), 'error') }
}
async function downloadTemplate(blank) {
  if (!detail.period?.id) return
  try {
    await downloadPeriodTemplate(detail.period.id, detail.period.title, blank)
    showToast(blank ? '空白模板已下载' : '标准表已下载', 'success')
  } catch (e) { showToast(errMsg(e), 'error') }
}
function openSubmitEntry() {
  const { url, opened } = openActivitySubmit()
  if (opened) showToast(`已打开填报入口（新窗口）：${url}`, 'success')
  else showToast(`填报入口：${url}（浏览器拦截了新窗口，请手动复制打开）`, 'error')
}
onMounted(async () => { await loadPeriods(); await loadReminders() })
</script>

<style scoped>
.inspection-page { display: flex; flex-direction: column; gap: 16px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-section-title { font-size: 20px; font-weight: 600; color: var(--c-text); margin: 0; }
.sub { font-size: 13px; color: var(--c-text-2); margin: 5px 0 0; }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg, 12px); }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-text); }
.btn:hover { border-color: var(--c-primary); }
.btn-primary { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.btn-outline { background: transparent; }
.btn-ghost { border: none; background: none; color: var(--c-primary); cursor: pointer; font-size: 13px; white-space: nowrap; }

.remind-banner { display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px; border-radius: 10px; background: var(--c-warning-bg, #fff7e6); border: 1px solid var(--c-warning, #ba7517); color: var(--c-warning, #ba7517); font-size: 12.5px; }
.rb-body { flex: 1; line-height: 1.7; }
.rb-line strong { font-weight: 600; }

.table-card { overflow: hidden; }
.table-toolbar { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--c-border); }
.table-title { font-size: 14px; font-weight: 600; color: var(--c-text); }
.total-count { font-size: 12.5px; color: var(--c-text-3); }
.table-scroll { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
.data-table th { background: var(--c-surface-2, #f7f8fa); color: var(--c-text-2); font-weight: 600; }
.data-table td { color: var(--c-text); }
.data-table.compact th, .data-table.compact td { padding: 8px 9px; font-size: 12px; }
.row-overdue { background: var(--c-warning-bg, #fff7e6); }
.empty-cell { text-align: center; color: var(--c-text-3); padding: 30px; }
.c-ok { color: var(--c-success, #1d9e75); }
.c-warn { color: var(--c-warning, #ba7517); }
.op-cell { white-space: nowrap; }
.action-link { border: none; background: none; color: var(--c-primary); cursor: pointer; font-size: 12.5px; display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px; }
.action-link.danger { color: var(--c-danger, #e24b4a); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-right: 4px; }
.b-open { background: var(--c-success-bg, #e8f7f1); color: var(--c-success, #1d9e75); }
.b-closed { background: var(--c-surface-2, #f0f1f3); color: var(--c-text-3); }
.b-due { background: var(--c-warning-bg, #fff1d6); color: var(--c-warning, #ba7517); }
.spinner { width: 22px; height: 22px; border: 2px solid var(--c-border); border-top-color: var(--c-primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-overlay { position: fixed; inset: 0; background: rgba(10, 19, 34, .55); display: flex; align-items: center; justify-content: center; z-index: 400; padding: 20px; }
.modal { width: 620px; max-width: 100%; max-height: 92vh; overflow-y: auto; background: var(--c-surface); border-radius: 14px; padding: 22px; }
.modal.widest { width: 1080px; }
.modal h3 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0 0 10px; color: var(--c-text); }
.modal-hint { font-size: 12.5px; color: var(--c-text-2); line-height: 1.7; margin: 0 0 16px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 5px; }
.form-group.full { grid-column: 1 / -1; }
.form-group label { font-size: 12.5px; color: var(--c-text-2); }
.form-group label i { color: var(--c-danger, #e24b4a); font-style: normal; }
.form-input { padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 8px; font-size: 13px; background: var(--c-surface); color: var(--c-text); font-family: inherit; }
.file-upload { display: flex; align-items: center; gap: 10px; padding: 16px; border: 1px dashed var(--c-border); border-radius: 9px; cursor: pointer; color: var(--c-text-2); font-size: 12.5px; }
.file-upload:hover { border-color: var(--c-primary); color: var(--c-primary); }
.tpl-hint { font-size: 12px; color: var(--c-success, #1d9e75); margin: 6px 0 0; }
.unit-scope { display: flex; gap: 16px; flex-wrap: wrap; }
.radio-line, .check-line { font-size: 12.5px; color: var(--c-text); display: inline-flex; align-items: center; gap: 5px; }
.scope-box { border: 1px solid var(--c-border); border-radius: 8px; padding: 10px; margin-top: 6px; }
.scope-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 160px; overflow-y: auto; margin-top: 8px; }
.check-line em { font-style: normal; color: var(--c-text-3); font-size: 11px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; flex-wrap: wrap; }

.detail-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--c-border); margin-bottom: 14px; }
.detail-tabs button { border: none; background: none; padding: 8px 14px; font-size: 13px; color: var(--c-text-2); cursor: pointer; border-bottom: 2px solid transparent; }
.detail-tabs button.on { color: var(--c-primary); border-bottom-color: var(--c-primary); font-weight: 600; }
.summary-wrap { max-height: 52vh; overflow: auto; }
.cell-long { max-width: 320px; white-space: pre-wrap; word-break: break-word; }
.unit-list { max-height: 52vh; overflow-y: auto; }
.unit-row { display: grid; grid-template-columns: 2fr 1.3fr 1fr 1fr; gap: 10px; padding: 9px 6px; border-bottom: 1px solid var(--c-border); font-size: 12.5px; color: var(--c-text); }
.unit-row em { font-style: normal; color: var(--c-text-3); font-size: 11px; margin-left: 6px; }
.toast { position: fixed; top: 24px; right: 24px; z-index: 500; padding: 11px 18px; border-radius: 9px; font-size: 13px; background: var(--c-success, #1d9e75); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.18); max-width: 460px; }
.toast.error { background: var(--c-danger, #e24b4a); }
@media (max-width: 768px) { .form-grid, .scope-checks { grid-template-columns: 1fr; } .unit-row { grid-template-columns: 1fr; } }
</style>
