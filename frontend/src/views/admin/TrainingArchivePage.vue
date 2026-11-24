<template>
  <div class="archive-page">
    <!-- ═══ 顶部 ═══ -->
    <div class="card page-head">
      <div class="head-left">
        <h2>培训档案</h2>
        <p class="sub">
          按《中原油田安全生产教育和培训管理细则》（中原油勘制〔2024〕39号）3.10 要求，
          输出「一期一档」「一人一档」检查资料
        </p>
      </div>
      <div class="head-right">
        <select v-model.number="year" class="sel" @change="fetchList">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <button class="btn btn-ghost nowrap" @click="doExportLedger">导出培训台账</button>
        <button class="btn btn-ghost nowrap" @click="doExportAnnual">导出学时统计</button>
        <button class="btn btn-primary nowrap" @click="openCreate">＋ 新建培训场次</button>
      </div>
    </div>

    <!-- ═══ 筛选 ═══ -->
    <div class="card filter-bar">
      <select v-model="filters.month" class="sel" @change="fetchList">
        <option value="">全部月份</option>
        <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
      </select>
      <select v-model="filters.categoryId" class="sel" @change="fetchList">
        <option value="">全部类别</option>
        <option v-for="c in meta.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <select v-model="filters.status" class="sel" @change="fetchList">
        <option value="">全部状态</option>
        <option value="planned">计划中</option>
        <option value="done">已完成</option>
        <option value="archived">已归档</option>
      </select>
      <input v-model="filters.keyword" class="inp" placeholder="培训名称 / 主讲人 / 地点" @input="debouncedFetch" />
      <span class="total">共 {{ total }} 期</span>
    </div>

    <!-- ═══ 场次列表 ═══ -->
    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th>培训日期</th><th>培训名称</th><th>类别</th><th>学时</th>
            <th>地点 / 主讲</th><th>应参</th><th>实参</th><th>参训率</th>
            <th>合格率</th><th>档案</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="12" class="center"><div class="spinner" style="margin:0 auto"></div></td>
          </tr>
          <tr v-else-if="!list.length">
            <td colspan="12" class="center empty">
              还没有培训场次。点右上角「新建培训场次」，把已办过的培训按场次录进来，才能导出档案。
            </td>
          </tr>
          <tr v-for="s in list" :key="s.id">
            <td class="nowrap">{{ fmtDate(s.session_date) }}</td>
            <td class="title-cell" :title="s.material_titles || ''">
              <strong>{{ s.title }}</strong>
              <div v-if="s.material_titles" class="sub-line">{{ s.material_titles }}</div>
            </td>
            <td>{{ s.category_name || '-' }}</td>
            <td><b>{{ Number(s.hours) }}</b></td>
            <td class="small">
              <div>{{ s.location || '-' }}</div>
              <div class="sub-line">{{ s.lecturer || '主讲未填' }}</div>
            </td>
            <td>{{ s.expected_count ?? '-' }}</td>
            <td>{{ s.actual_count ?? 0 }}</td>
            <td>{{ rateText(s.actual_count, s.expected_count) }}</td>
            <td>{{ rateText(s.passed_count, s.actual_count) }}</td>
            <td>
              <span :class="['doc-chip', s.doc_ready >= 7 ? 'ok' : s.doc_ready >= 4 ? 'warn' : 'bad']">
                {{ s.doc_ready }}/7
              </span>
            </td>
            <td><span :class="['badge', statusClass(s.status)]">{{ statusText(s.status) }}</span></td>
            <td class="ops">
              <button class="lnk" @click="openEdit(s)">编辑</button>
              <button class="lnk" @click="openRoster(s)">名单</button>
              <button class="lnk" @click="exportPack(s)">一期一档</button>
              <button class="lnk" @click="exportSign(s)">签到表</button>
              <button class="lnk" @click="exportScore(s)">成绩表</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ═══ 新建 / 编辑 抽屉 ═══ -->
    <div v-if="drawer" class="drawer-mask" @click.self="drawer = false">
      <div class="drawer">
        <div class="drawer-head">
          <h3>{{ form.id ? '编辑培训场次' : '新建培训场次' }}</h3>
          <button class="close" @click="drawer = false">×</button>
        </div>

        <div class="drawer-body">
          <p class="hint">
            培训日期、学时、主讲人必须按实际情况填写——<b>不能拿学员答题时间推算</b>，
            否则属于编造培训记录（《生产经营单位安全培训规定》第 31 条）。
          </p>

          <div class="grid2">
            <label class="fld span2">
              <span>培训名称 <i>*</i></span>
              <input v-model="form.title" class="inp" placeholder="如：吊装作业安全培训" />
            </label>

            <label class="fld">
              <span>培训类别</span>
              <select v-model="form.categoryId" class="sel">
                <option :value="null">未分类</option>
                <option v-for="c in meta.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>

            <label class="fld">
              <span>培训日期 <i>*</i></span>
              <input v-model="form.sessionDate" type="date" class="inp" />
            </label>

            <label class="fld">
              <span>时间段</span>
              <input v-model="form.timeRange" class="inp" placeholder="09:00-11:30" />
            </label>

            <label class="fld">
              <span>学时 <i>*</i></span>
              <input v-model.number="form.hours" type="number" step="0.5" min="0" class="inp" />
            </label>

            <label class="fld">
              <span>培训地点</span>
              <input v-model="form.location" class="inp" placeholder="如：项目部三楼会议室" />
            </label>

            <label class="fld">
              <span>培训方式</span>
              <select v-model="form.trainMode" class="sel">
                <option value="">未填</option>
                <option v-for="m in meta.trainModes" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>

            <label class="fld">
              <span>主讲人</span>
              <input v-model="form.lecturer" class="inp" />
            </label>

            <label class="fld">
              <span>主讲人单位</span>
              <input v-model="form.lecturerUnit" class="inp" />
            </label>

            <label class="fld">
              <span>组织单位</span>
              <input v-model="form.organizer" class="inp" placeholder="通南巴项目部" />
            </label>

            <label class="fld">
              <span>考核方式</span>
              <select v-model="form.assessmentType" class="sel">
                <option value="">未填</option>
                <option v-for="a in meta.assessmentTypes" :key="a" :value="a">{{ a }}</option>
              </select>
            </label>

            <label class="fld span2">
              <span>参训范围说明</span>
              <input v-model="form.targetDesc" class="inp" placeholder="如：全体承包商现场管理人员" />
            </label>

            <label class="fld">
              <span>应参人数 <em class="tip-inline">留空则按试卷目标人群算（全员卷会得出 770 人，参训率会很低；按实际通知范围填更贴近事实）</em></span>
              <input v-model="form.expectedCount" type="number" min="0" class="inp" placeholder="留空=按试卷目标自动算" />
            </label>

            <label class="fld">
              <span>状态</span>
              <select v-model="form.status" class="sel">
                <option value="planned">计划中</option>
                <option value="done">已完成</option>
                <option value="archived">已归档</option>
              </select>
            </label>
          </div>

          <!-- 关联试卷 -->
          <div class="section">
            <div class="section-title">
              关联试卷/题库
              <span class="tip">用于生成签到表与成绩表，可多选（一场培训多张卷）</span>
            </div>
            <div class="mat-list">
              <label v-for="m in materials" :key="m.id" class="mat-item">
                <input type="checkbox" :value="m.id" v-model="form.materialIds" />
                <span class="mat-title">{{ m.title }}</span>
                <span class="mat-meta">{{ m.question_cnt }}题 / 及格{{ m.pass_score }}</span>
              </label>
              <div v-if="!materials.length" class="muted">暂无可关联的试卷</div>
            </div>
          </div>

          <!-- 附件清单 -->
          <div class="section">
            <div class="section-title">
              档案附件到位情况
              <span class="tip">勾选后才算「已归档」，未勾选的在导出件里会标「待补」</span>
            </div>
            <div class="chk-grid">
              <label v-for="c in meta.checklist" :key="c.key" class="chk">
                <input type="checkbox" v-model="form.docChecklist[c.key]" />
                {{ c.label }}
              </label>
            </div>
          </div>

          <label class="fld span2">
            <span>备注</span>
            <input v-model="form.remark" class="inp" />
          </label>
        </div>

        <div class="drawer-foot">
          <button v-if="form.id" class="btn btn-danger-ghost nowrap" @click="doDelete">删除</button>
          <span class="flex1"></span>
          <button class="btn btn-ghost nowrap" @click="drawer = false">取消</button>
          <button class="btn btn-primary nowrap" :disabled="saving" @click="doSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ═══ 名单弹窗 ═══ -->
    <div v-if="rosterOpen" class="drawer-mask" @click.self="rosterOpen = false">
      <div class="modal">
        <div class="drawer-head">
          <h3>参训名单 · {{ rosterData?.session?.title }}</h3>
          <button class="close" @click="rosterOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div class="roster-sum">
            应参 <b>{{ rosterData?.summary?.expected }}</b> 人 ·
            实参 <b>{{ rosterData?.summary?.actual }}</b> 人 ·
            缺席 <b class="bad">{{ rosterData?.summary?.absent }}</b> 人
          </div>
          <div class="table-scroll">
            <table class="data-table compact">
              <thead>
                <tr><th>序号</th><th>姓名</th><th>单位</th><th>岗位</th><th>状态</th><th>首次交卷</th></tr>
              </thead>
              <tbody>
                <tr v-for="(p, i) in rosterData?.list || []" :key="p.userId">
                  <td>{{ i + 1 }}</td>
                  <td>{{ p.name }}</td>
                  <td class="small">{{ p.unit }}</td>
                  <td class="small">{{ p.position || '-' }}</td>
                  <td>
                    <span :class="['badge', p.attended ? 'badge-success' : 'badge-danger']">
                      {{ p.attended ? '已参加' : '未参加' }}
                    </span>
                  </td>
                  <td class="small">{{ p.firstSubmit ? fmtTime(p.firstSubmit) : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import {
  getArchiveMeta, listSessions, getSession, createSession, updateSession,
  deleteSession, getRoster, openArchiveExport,
} from '@/api/trainingArchive'
import { request } from '@/utils/request'

const year = ref(new Date().getFullYear())
const yearOptions = computed(() => {
  const y = new Date().getFullYear()
  return [y, y - 1, y - 2]
})

const meta = reactive({ categories: [], trainModes: [], assessmentTypes: [], checklist: [] })
const filters = reactive({ month: '', categoryId: '', status: '', keyword: '' })
const list = ref([])
const total = ref(0)
const loading = ref(true)

const drawer = ref(false)
const saving = ref(false)
const materials = ref([])
const rosterOpen = ref(false)
const rosterData = ref(null)

const emptyForm = () => ({
  id: null, title: '', categoryId: null, sessionDate: '', timeRange: '', location: '',
  lecturer: '', lecturerUnit: '', hours: 4, trainMode: '集中授课', organizer: '通南巴项目部',
  targetDesc: '', expectedCount: '', assessmentType: '闭卷考试', status: 'done', remark: '',
  materialIds: [], docChecklist: {},
})
const form = reactive(emptyForm())

function fmtDate(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v).slice(0, 10)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function fmtTime(v) {
  const d = new Date(v)
  if (isNaN(d.getTime())) return '-'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function rateText(a, b) {
  const x = Number(a) || 0
  const y = Number(b) || 0
  return y > 0 ? Math.round((x / y) * 1000) / 10 + '%' : '-'
}
function statusText(s) {
  return { planned: '计划中', done: '已完成', archived: '已归档' }[s] || s
}
function statusClass(s) {
  return { planned: 'badge-warning', done: 'badge-success', archived: 'badge-info' }[s] || ''
}

async function fetchList() {
  loading.value = true
  try {
    const res = await listSessions({
      year: year.value,
      month: filters.month || undefined,
      categoryId: filters.categoryId || undefined,
      status: filters.status || undefined,
      keyword: filters.keyword || undefined,
      page: 1,
      pageSize: 200,
    })
    const d = res.data?.data || {}
    list.value = d.list || []
    total.value = d.total || 0
  } finally {
    loading.value = false
  }
}
function debouncedFetch() {
  clearTimeout(debouncedFetch._t)
  debouncedFetch._t = setTimeout(fetchList, 300)
}

async function fetchMaterials() {
  try {
    const res = await request.get('/api/material/list')
    const arr = res.data?.data || []
    materials.value = (Array.isArray(arr) ? arr : []).map((m) => ({
      id: m.id, title: m.title, question_cnt: m.question_cnt || 0, pass_score: m.pass_score || 60,
    }))
  } catch { materials.value = [] }
}

function openCreate() {
  Object.assign(form, emptyForm())
  const ck = {}
  meta.checklist.forEach((c) => { ck[c.key] = false })
  form.docChecklist = ck
  if (materials.value.length === 0) fetchMaterials()
  drawer.value = true
}

async function openEdit(s) {
  const res = await getSession(s.id)
  const d = res.data?.data
  if (!d) return
  Object.assign(form, {
    id: d.id, title: d.title, categoryId: d.category_id || null,
    sessionDate: String(d.session_date).slice(0, 10), timeRange: d.time_range || '',
    location: d.location || '', lecturer: d.lecturer || '', lecturerUnit: d.lecturer_unit || '',
    hours: Number(d.hours) || 0, trainMode: d.train_mode || '', organizer: d.organizer || '',
    targetDesc: d.target_desc || '', expectedCount: d.expected_count ?? '',
    assessmentType: d.assessment_type || '', status: d.status || 'planned',
    remark: d.remark || '', materialIds: d.material_ids || [],
  })
  let ck = d.doc_checklist
  if (typeof ck === 'string') { try { ck = JSON.parse(ck) } catch { ck = {} } }
  const out = {}
  meta.checklist.forEach((c) => { out[c.key] = !!(ck && ck[c.key]) })
  form.docChecklist = out
  if (materials.value.length === 0) fetchMaterials()
  drawer.value = true
}

async function doSave() {
  if (!form.title.trim()) return alert('请填写培训名称')
  if (!form.sessionDate) return alert('请填写培训日期')
  if (!(Number(form.hours) > 0)) {
    if (!confirm('学时填的是 0，学时台账会记为 0 且判为未达标。确定继续？')) return
  }
  saving.value = true
  try {
    const payload = { ...form }
    if (form.id) await updateSession(form.id, payload)
    else await createSession(payload)
    drawer.value = false
    await fetchList()
  } catch (e) {
    alert(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function doDelete() {
  if (!confirm('确定删除该培训场次？已产生考试记录的场次不允许删除。')) return
  try {
    await deleteSession(form.id)
    drawer.value = false
    await fetchList()
  } catch (e) {
    alert(e?.response?.data?.error || '删除失败')
  }
}

async function openRoster(s) {
  const res = await getRoster(s.id)
  rosterData.value = res.data?.data || null
  rosterOpen.value = true
}

function exportPack(s) { openArchiveExport(`/sessions/${s.id}/export`) }
function exportSign(s) { openArchiveExport(`/sessions/${s.id}/sign-sheet`) }
function exportScore(s) { openArchiveExport(`/sessions/${s.id}/score-sheet`) }
function doExportLedger() { openArchiveExport(`/ledger/export?year=${year.value}`) }
function doExportAnnual() { openArchiveExport(`/annual/export?year=${year.value}`) }

onMounted(async () => {
  try {
    const res = await getArchiveMeta()
    const d = res.data?.data || {}
    meta.categories = d.categories || []
    meta.trainModes = d.trainModes || []
    meta.assessmentTypes = d.assessmentTypes || []
    meta.checklist = d.checklist || []
  } catch { /* 忽略 */ }
  await fetchList()
})
</script>

<style scoped>
.archive-page { max-width: 1440px; }

.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.page-head .sub { margin: 0; font-size: 12px; color: var(--text-secondary); }
.head-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.sel, .inp {
  padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; background: var(--card-bg, #fff); color: var(--text-primary);
}
.inp { min-width: 200px; }
.total { font-size: 13px; color: var(--text-secondary); margin-left: auto; }

.table-card { padding: 0; overflow: hidden; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.data-table th { background: var(--table-head-bg, rgba(0,0,0,0.03)); font-weight: 600; white-space: nowrap; }
.data-table tbody tr:hover { background: rgba(0,0,0,0.02); }
.title-cell { max-width: 280px; }
.sub-line { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
.small { font-size: 12px; }
.nowrap { white-space: nowrap; }
.center { text-align: center; }
.empty { padding: 36px 16px; color: var(--text-secondary); line-height: 1.7; }

.doc-chip { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.doc-chip.ok { background: rgba(34,197,94,.14); color: #16a34a; }
.doc-chip.warn { background: rgba(234,179,8,.16); color: #b45309; }
.doc-chip.bad { background: rgba(239,68,68,.13); color: #dc2626; }

.ops { white-space: nowrap; }
.lnk {
  background: none; border: 0; color: var(--primary); cursor: pointer;
  font-size: 12px; padding: 2px 4px;
}
.lnk:hover { text-decoration: underline; }

/* 抽屉 */
.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 1000; display: flex; justify-content: flex-end; }
.drawer { width: min(760px, 100%); background: var(--card-bg, #fff); height: 100%; display: flex; flex-direction: column; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.drawer-head h3 { margin: 0; font-size: 15px; }
.close { background: none; border: 0; font-size: 22px; line-height: 1; cursor: pointer; color: var(--text-secondary); }
.drawer-body { padding: 16px 18px; overflow-y: auto; flex: 1; }
.drawer-foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
.flex1 { flex: 1; }

.hint { font-size: 12px; line-height: 1.7; color: #b45309; background: rgba(234,179,8,.1); border-radius: 8px; padding: 8px 10px; margin: 0 0 14px; }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 5px; }
.fld > span { font-size: 12px; color: var(--text-secondary); }
.fld i { color: #dc2626; font-style: normal; }
.tip-inline { font-size: 11px; color: var(--text-secondary); font-style: normal; margin-left: 4px; }
.span2 { grid-column: span 2; }
.fld .inp, .fld .sel { width: 100%; min-width: 0; }

.section { margin-top: 18px; }
.section-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.section-title .tip { font-weight: 400; font-size: 11px; color: var(--text-secondary); margin-left: 6px; }

.mat-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
.mat-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.mat-item:hover { background: rgba(0,0,0,.03); }
.mat-title { flex: 1; font-size: 13px; }
.mat-meta { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
.muted { font-size: 12px; color: var(--text-secondary); padding: 8px; }

.chk-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }

.modal { width: min(900px, 94vw); background: var(--card-bg, #fff); border-radius: 12px; margin: auto; max-height: 88vh; display: flex; flex-direction: column; }
.drawer-mask:has(.modal) { align-items: center; justify-content: center; }
.modal-body { padding: 14px 18px; overflow-y: auto; }
.roster-sum { font-size: 13px; margin-bottom: 10px; }
.roster-sum .bad { color: #dc2626; }
.table-scroll { max-height: 60vh; overflow-y: auto; }
.data-table.compact td, .data-table.compact th { padding: 6px 8px; font-size: 12px; }

.btn-danger-ghost { color: #dc2626; border: 1px solid rgba(220,38,38,.4); background: transparent; }
</style>
