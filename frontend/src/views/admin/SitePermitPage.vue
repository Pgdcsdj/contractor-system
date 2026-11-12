<template>
  <div class="site-permit-page">
    <!-- ═══ 顶部：标题 + 上次同步状态 ═══ -->
    <div class="card page-head">
      <div class="head-left">
        <h2>直接作业预约报备</h2>
        <p class="sub">
          数据源：钉钉在线表格 · 每晚 {{ String(cfg.cronHour).padStart(2, '0') }}:{{
            String(cfg.cronMinute).padStart(2, '0')
          }} 自动同步
        </p>
      </div>
      <div class="head-right">
        <span class="sync-chip" :class="syncChipClass">
          <span class="dot"></span>{{ syncText }}
        </span>
        <button class="btn btn-ghost nowrap" :disabled="syncing" @click="doSync(false)">
          {{ syncing ? '同步中…' : '立即同步' }}
        </button>
      </div>
    </div>

    <!-- ═══ Tab 切换 ═══ -->
    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'list' }" @click="tab = 'list'">预约台账</button>
      <button class="tab" :class="{ on: tab === 'config' }" @click="tab = 'config'">同步设置</button>
    </div>

    <!-- ════════════════════════════════════════════════════════════════
         Tab 1 · 预约台账
    ═════════════════════════════════════════════════════════════════ -->
    <template v-if="tab === 'list'">
      <!-- 作业预约统计：当日与当月合并为一个对照面板 -->
      <div class="card stats-panel">
        <div class="stats-head">
          <div class="stats-title">
            <h3>作业预约统计</h3>
            <span class="stats-note">
              当日 {{ statsDate || '—' }} ｜ 本月 {{ stats.month || '—' }}（已报 {{ stats.monthDays || 0 }} 天）
            </span>
          </div>
          <div class="stats-high">
            <span class="high-dot"></span>本月高风险（橙 / 红）<strong>{{ monthHighRisk }}</strong> 项
          </div>
        </div>

        <div class="stats-grid-wrap">
          <div class="stats-grid">
            <div class="sg-head sg-label"></div>
            <div class="sg-head">预约总数</div>
            <div v-for="lv in DISPLAY_LEVELS" :key="'h-' + lv" class="sg-head" :style="lvStyle(lv)">
              <i class="lv-dot"></i>{{ lv }}
            </div>

            <div class="sg-label sg-row-label">
              <strong>当日</strong><small>{{ statsDate || '—' }}</small>
            </div>
            <div class="sg-cell sg-total"><b>{{ stats.total || 0 }}</b><small>项</small></div>
            <div v-for="lv in DISPLAY_LEVELS" :key="'d-' + lv" class="sg-cell" :style="lvStyle(lv)">
              <b>{{ dayRiskMap[lv] || 0 }}</b><small>项</small>
            </div>

            <div class="sg-label sg-row-label">
              <strong>本月累计</strong><small>{{ stats.month || '—' }}</small>
            </div>
            <div class="sg-cell sg-total"><b>{{ stats.monthTotal || 0 }}</b><small>项</small></div>
            <div v-for="lv in DISPLAY_LEVELS" :key="'m-' + lv" class="sg-cell" :style="lvStyle(lv)">
              <b>{{ monthRiskMap[lv] || 0 }}</b><small>项</small>
            </div>
          </div>
        </div>
      </div>

      <!-- 近 14 天日期选择 -->
      <div class="card filter-card">
        <div class="filter-line">
          <div class="field">
            <label>计划日期</label>
            <select v-model="q.date" class="form-input" @change="reload(1)">
              <option value="">全部日期</option>
              <option v-for="d in stats.dates || []" :key="d.plan_date" :value="String(d.plan_date).slice(0, 10)">
                {{ String(d.plan_date).slice(0, 10) }}（{{ d.cnt }}）
              </option>
            </select>
          </div>
          <div class="field">
            <label>风险分级</label>
            <select v-model="q.risk" class="form-input" @change="reload(1)">
              <option value="">全部等级</option>
              <option v-for="lv in RISK_LEVELS" :key="lv" :value="lv">{{ lv }}</option>
            </select>
          </div>
          <div class="field">
            <label>作业板块</label>
            <select v-model="q.sheet" class="form-input" @change="reload(1)">
              <option value="">全部板块</option>
              <option v-for="s in sheetOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="field grow">
            <label>关键词</label>
            <input
              v-model.trim="q.keyword"
              class="form-input"
              placeholder="施工单位 / 施工内容 / 地点 / 上报人"
              @keyup.enter="reload(1)"
            />
          </div>
          <div class="field field-actions">
            <button class="btn btn-primary nowrap" @click="reload(1)">查询</button>
            <button class="btn btn-ghost nowrap" @click="resetFilter">重置</button>
            <button class="btn btn-ghost nowrap" :disabled="exporting" @click="doExport">
              {{ exporting ? '导出中…' : '导出 Excel' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 台账表格 -->
      <div class="card table-card">
        <div v-if="loading" class="empty-box">加载中…</div>
        <div v-else-if="!list.length" class="empty-box">
          暂无预约记录。{{ cfg.enabled ? '等待今晚自动同步，或点上「立即同步」。' : '请先到「同步设置」配置钉钉表格。' }}
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-idx">#</th>
                <th class="col-time">预计施工时间</th>
                <th class="col-unit">施工单位</th>
                <th class="col-content">施工内容</th>
                <th class="col-place">施工地点</th>
                <th class="col-type">作业类别</th>
                <th class="col-risk">风险分级</th>
                <th class="col-person">带班人</th>
                <th class="col-person">上报人</th>
                <th class="col-op">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in list" :key="r.id">
                <td class="col-idx">{{ (page - 1) * pageSize + i + 1 }}</td>
                <td class="col-time">
                  <div class="time-main">{{ planDateText(r) }}</div>
                  <div class="time-sub">{{ planRange(r) }}</div>
                </td>
                <td class="col-unit" :title="r.work_unit">{{ r.work_unit || '—' }}</td>
                <td class="col-content" :title="r.content"><div class="clamp3">{{ r.content || '—' }}</div></td>
                <td class="col-place" :title="r.place">{{ r.place || '—' }}</td>
                <td class="col-type">{{ r.work_type || '—' }}</td>
                <td class="col-risk">
                  <span class="risk-tag" :style="riskTagStyle(r.risk_level)">{{ r.risk_level || '未分级' }}</span>
                  <span v-if="r.dual_op && r.dual_op !== '否'" class="dual-tag">双边</span>
                </td>
                <td class="col-person" :title="r.leader">{{ shortPerson(r.leader) }}</td>
                <td class="col-person" :title="r.reporter">{{ shortPerson(r.reporter) }}</td>
                <td class="col-op">
                  <button class="link-btn" @click="openDetail(r)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="total > pageSize" class="pager">
          <span class="pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ Math.ceil(total / pageSize) }} 页</span>
          <div class="pager-btns">
            <button class="btn btn-ghost nowrap" :disabled="page <= 1" @click="reload(page - 1)">上一页</button>
            <button class="btn btn-ghost nowrap" :disabled="page >= Math.ceil(total / pageSize)" @click="reload(page + 1)">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════════════════════════════════════════════════════
         Tab 2 · 同步设置
    ═════════════════════════════════════════════════════════════════ -->
    <template v-else>
      <div class="card">
        <div class="cfg-head">
          <div>
            <h3>钉钉表格接入</h3>
            <p class="sub">填好下面四项后点「测试连通」，通了再保存。凭据仅存本系统数据库。</p>
          </div>
          <label class="master-switch">
            <span class="master-label">{{ form.enabled ? '自动同步已开启' : '自动同步已暂停' }}</span>
            <input type="checkbox" v-model="form.enabled" />
            <span class="track" :class="{ on: form.enabled }"><span class="thumb"></span></span>
          </label>
        </div>

        <section class="group">
          <h4 class="group-title">① 数据源类型</h4>
          <div class="radio-row">
            <label class="radio-item" :class="{ on: form.sourceType === 'workbook' }">
              <input type="radio" value="workbook" v-model="form.sourceType" />
              <span class="radio-box"></span>
              <span class="radio-text">
                <strong>钉钉表格（在线文档）</strong>
                <small>群里的「在线编辑」表格，读取所选区域单元格</small>
              </span>
            </label>
            <label class="radio-item" :class="{ on: form.sourceType === 'notable' }">
              <input type="radio" value="notable" v-model="form.sourceType" />
              <span class="radio-box"></span>
              <span class="radio-text">
                <strong>智能表格 / AI 表格</strong>
                <small>多行记录式表格，按记录逐条读取（字段更规整）</small>
              </span>
            </label>
          </div>
        </section>

        <section class="group">
          <h4 class="group-title">② 应用凭据</h4>
          <div class="form-grid">
            <div class="form-group">
              <label>AppKey（应用 Key）</label>
              <input v-model.trim="form.appKey" class="form-input" placeholder="钉钉开放平台 · 企业内部应用" />
            </div>
            <div class="form-group">
              <label>AppSecret（应用密钥）</label>
              <input v-model.trim="form.appSecret" class="form-input" type="password" placeholder="保存后显示为 ******" />
            </div>
            <div class="form-group">
              <label>operatorId（操作人 unionId）</label>
              <input v-model.trim="form.operatorId" class="form-input" placeholder="以该人身份读表，必须是表格协作者" />
              <small>接口以这个人身份读表，所以 TA 必须被加为那张表格的协作者。</small>
            </div>
            <div class="form-group" v-if="form.sourceType !== 'notable'">
              <label>workbookId（表格文档 ID）</label>
              <input v-model.trim="form.workbookId" class="form-input" placeholder="表格 URL: .../workbook?workbookId=xxxx" />
              <small>从钉钉里打开那张表格，复制浏览器地址栏里的文档 ID。</small>
            </div>
            <div class="form-group" v-else>
              <label>baseId（智能表格 ID）</label>
              <input v-model.trim="form.baseId" class="form-input" placeholder="智能表格 URL 里的 baseId" />
              <small>智能表格/AI 表格的 baseId，与钉钉表格的 workbookId 不是一回事。</small>
            </div>
            <div class="form-group" v-if="form.sourceType === 'workbook'">
              <label>读取区域终点</label>
              <input v-model.trim="form.rangeEnd" class="form-input" placeholder="Q300" />
              <small>Q300 = 从 A 列读到 Q 列、最多 300 行。数据超了改成 Q500。</small>
            </div>
            <div class="form-group">
              <label>同步时刻（每天）</label>
              <div class="time-picker">
                <select v-model.number="form.cronHour" class="form-input">
                  <option v-for="h in 24" :key="h" :value="h - 1">{{ String(h - 1).padStart(2, '0') }} 时</option>
                </select>
                <select v-model.number="form.cronMinute" class="form-input">
                  <option v-for="m in [0, 10, 15, 20, 30, 40, 45, 50]" :key="m" :value="m">
                    {{ String(m).padStart(2, '0') }} 分
                  </option>
                </select>
              </div>
              <small>默认 22:00。改完保存即生效，不用重启服务。</small>
            </div>
          </div>
        </section>

        <section class="group">
          <h4 class="group-title">③ 工作表过滤（可选）</h4>
          <p class="group-hint">
            不选 = 同步全部工作表（会自动跳过「作业类别下拉选项」这类无表头的页）。
            当前已识别：{{ cfg.sheetNames && cfg.sheetNames.length ? cfg.sheetNames.join('、') : '全部' }}
          </p>
          <div v-if="knownSheets.length" class="chip-row">
            <label v-for="s in knownSheets" :key="s" class="chip" :class="{ on: form.sheetNames.includes(s) }">
              <input type="checkbox" :value="s" v-model="form.sheetNames" />
              {{ s }}
            </label>
          </div>
          <p v-else class="group-hint dim">先点「测试连通」拉到工作表清单后，这里会出现可勾选项。</p>
        </section>

        <div class="footer-actions">
          <p v-if="msg" class="msg" :class="msgType">{{ msg }}</p>
          <div class="footer-btns">
            <button class="btn btn-ghost nowrap" :disabled="testing" @click="doTest">
              {{ testing ? '测试中…' : '测试连通' }}
            </button>
            <button class="btn btn-ghost nowrap" :disabled="syncing" @click="doSync(true)">
              {{ syncing ? '解析中…' : '预演（不写库）' }}
            </button>
            <button class="btn btn-ghost nowrap" :disabled="syncing" @click="doSync(false)">
              {{ syncing ? '同步中…' : '立即同步' }}
            </button>
            <button class="btn btn-primary nowrap" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存配置' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 同步日志 -->
      <div class="card">
        <h3 class="log-title">同步记录（最近 30 次）</h3>
        <div v-if="!logs.length" class="empty-box small">还没有同步记录</div>
        <table v-else class="data-table log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>触发</th>
              <th>结果</th>
              <th>明细</th>
              <th class="col-num">新增</th>
              <th class="col-num">更新</th>
              <th class="col-num">失效</th>
              <th class="col-num">耗时</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td class="nowrap-cell">{{ fmtTime(l.started_at) }}</td>
              <td>{{ l.triggered_by === 'cron' ? '定时' : '手动' }}</td>
              <td>
                <span class="status-tag" :class="l.status === 'ok' ? 'ok' : 'fail'">
                  {{ l.status === 'ok' ? '成功' : '失败' }}
                </span>
              </td>
              <td class="log-msg" :title="l.message">{{ l.message || '—' }}</td>
              <td class="col-num">{{ l.new_rows || 0 }}</td>
              <td class="col-num">{{ l.updated_rows || 0 }}</td>
              <td class="col-num">{{ l.inactive_rows || 0 }}</td>
              <td class="col-num">{{ l.duration_ms ? (l.duration_ms / 1000).toFixed(1) + 's' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ═══ 详情弹窗 ═══ -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal-box">
        <div class="modal-head">
          <h3>预约详情</h3>
          <button class="modal-close" @click="detail = null">×</button>
        </div>
        <div class="modal-body">
          <dl class="detail-grid">
            <div v-for="f in DETAIL_FIELDS" :key="f.key" class="detail-item" :class="{ full: f.full }">
              <dt>{{ f.label }}</dt>
              <dd>{{ detailText(f.key) }}</dd>
            </div>
          </dl>
        </div>
        <div class="modal-foot">
          <span class="modal-meta">来源：{{ detail.sheet_name }} · 同步于 {{ fmtTime(detail.updated_at) }}</span>
          <button class="btn btn-primary nowrap" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import {
  getSitePermitConfig, saveSitePermitConfig, testSitePermitConn,
  syncSitePermitNow, getSitePermitSyncLogs, getSitePermitList,
  getSitePermitStats, exportSitePermit,
} from '@/api/sitePermit'

const RISK_LEVELS = ['红色', '橙色', '黄色', '蓝色']
// 统计面板按风险由低到高排列（蓝→黄→橙→红），与筛选下拉顺序分开
const DISPLAY_LEVELS = ['蓝色', '黄色', '橙色', '红色']
const RISK_COLORS = {
  红色: '#dc2626',
  橙色: '#ea580c',
  黄色: '#ca8a04',
  蓝色: '#2563eb',
}
const DETAIL_FIELDS = [
  { key: 'plan_time_raw', label: '预计施工时间' },
  { key: 'apply_unit', label: '申请单位' },
  { key: 'work_unit', label: '施工单位' },
  { key: 'content', label: '施工内容', full: true },
  { key: 'place', label: '施工地点' },
  { key: 'camera', label: '监控设备名称' },
  { key: 'work_type', label: '施工作业类别' },
  { key: 'dual_op', label: '是否属于双边作业' },
  { key: 'risk_level', label: '风险分级' },
  { key: 'measures', label: '风险管控措施', full: true },
  { key: 'leader', label: '带班人姓名、职务及联系方式', full: true },
  { key: 'supervisor', label: '监护人姓名及联系方式' },
  { key: 'auditor', label: '审核人姓名' },
  { key: 'reporter', label: '上报人姓名' },
  { key: 'report_date_raw', label: '上报日期' },
  { key: 'remark', label: '备注', full: true },
]

const tab = ref('list')
const loading = ref(false)
const syncing = ref(false)
const saving = ref(false)
const testing = ref(false)
const exporting = ref(false)
const msg = ref('')
const msgType = ref('')

const cfg = reactive({
  enabled: false, sourceType: 'workbook', appKey: '', appSecret: '',
  workbookId: '', baseId: '', operatorId: '', sheetNames: [], rangeEnd: 'Q300',
  cronHour: 22, cronMinute: 0, lastSyncAt: null, lastSyncStatus: '', lastSyncMsg: '',
})
const form = reactive(JSON.parse(JSON.stringify(cfg)))
const knownSheets = ref([])
const logs = ref([])
const detail = ref(null)

const q = reactive({ date: '', risk: '', sheet: '', keyword: '' })
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const stats = reactive({
  total: 0, byRisk: [], bySheet: [], dates: [], sheets: [],
  month: '', monthTotal: 0, monthByRisk: [], monthDays: 0,
})
const statsDate = ref('')

// ── 计算属性 ──────────────────────────────────────────────────────────────
function toRiskMap(rows) {
  const map = {}
  for (const r of rows || []) map[r.risk_level || '未分级'] = Number(r.cnt) || 0
  return map
}
const dayRiskMap = computed(() => toRiskMap(stats.byRisk))
const monthRiskMap = computed(() => toRiskMap(stats.monthByRisk))
const monthHighRisk = computed(() =>
  (monthRiskMap.value['橙色'] || 0) + (monthRiskMap.value['红色'] || 0))
const sheetOptions = computed(() => stats.sheets || [])
const syncChipClass = computed(() => {
  if (!cfg.enabled) return 'off'
  if (cfg.lastSyncStatus === 'ok') return 'ok'
  if (cfg.lastSyncStatus === 'fail') return 'fail'
  return 'idle'
})
const syncText = computed(() => {
  if (!cfg.enabled) return '自动同步已暂停'
  if (!cfg.lastSyncAt) return '尚未同步过'
  const t = fmtTime(cfg.lastSyncAt)
  return cfg.lastSyncStatus === 'ok' ? `上次同步 ${t} 成功` : `上次同步 ${t} 失败`
})

// ── 工具 ──────────────────────────────────────────────────────────────────
function riskColor(k) { return RISK_COLORS[k] || '#94a3b8' }
/** 统计面板每个风险列的配色（CSS 变量由 Vue 内联样式注入） */
function lvStyle(k) {
  const c = riskColor(k)
  return { '--lv': c, '--lv-bg': c + '0d', '--lv-soft': c + '22' }
}
function riskTagStyle(k) {
  const c = riskColor(k)
  return { color: c, borderColor: c + '55', background: c + '12' }
}
function fmtTime(s) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function planDateText(r) {
  if (r.plan_date) return String(r.plan_date).slice(0, 10)
  return r.plan_time_raw || '—'
}
/** 从「2026-11-11 08:00-12:00」里取时段，取不到就返回空 */
function planRange(r) {
  const raw = String(r.plan_time_raw || '')
  const m = raw.match(/(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})/)
  if (m) return `${m[1]}–${m[2]}`
  if (r.plan_start) {
    const s = String(r.plan_start).slice(11, 16)
    if (s && s !== '00:00') return s
  }
  return ''
}
function shortPerson(v) {
  if (!v) return '—'
  // 多人时单元格里是换行分隔的若干条，列表只显示第一条并去掉手机号，
  // 否则会变成「冯林/主管/187081…」这种截断得很别扭的文本。完整内容看 title / 详情。
  let t = String(v).split(/\r?\n/)[0].trim()
  t = t.replace(/[/／\-—、\s]*1\d{10}\s*$/, '').trim()
  return t.length > 14 ? t.slice(0, 14) + '…' : t
}
function detailText(key) {
  if (!detail.value) return '—'
  const v = detail.value[key]
  return v === null || v === undefined || v === '' ? '—' : String(v)
}

// ── 数据加载 ──────────────────────────────────────────────────────────────
function applyCfg(src) {
  Object.assign(cfg, src)
  Object.assign(form, JSON.parse(JSON.stringify(src)))
  if (Array.isArray(src.sheetNames)) {
    knownSheets.value = src.sheetNames.slice()
  }
}

async function loadConfig() {
  try {
    const res = await getSitePermitConfig()
    const d = res.data?.data || {}
    applyCfg(d.config || {})
  } catch (e) {
    msg.value = e.response?.data?.error || '配置加载失败'
    msgType.value = 'error'
  }
}

async function loadStats() {
  try {
    const res = await getSitePermitStats(statsDate.value)
    const d = res.data?.data || {}
    stats.total = d.total || 0
    stats.byRisk = d.byRisk || []
    stats.bySheet = d.bySheet || []
    stats.dates = d.dates || []
    stats.sheets = d.sheets || []
    stats.month = d.month || ''
    stats.monthTotal = d.monthTotal || 0
    stats.monthByRisk = d.monthByRisk || []
    stats.monthDays = d.monthDays || 0
    statsDate.value = d.date || ''
  } catch (e) { /* 统计失败不阻断列表 */ }
}

async function reload(p) {
  if (p) page.value = p
  loading.value = true
  try {
    const res = await getSitePermitList({ ...q, page: page.value, pageSize: pageSize.value })
    const d = res.data?.data || {}
    list.value = d.list || []
    total.value = d.total || 0
  } catch (e) {
    list.value = []
    total.value = 0
    msg.value = e.response?.data?.error || '台账加载失败'
    msgType.value = 'error'
  } finally {
    loading.value = false
  }
}

async function loadLogs() {
  try {
    const res = await getSitePermitSyncLogs()
    logs.value = res.data?.data || []
  } catch (e) { logs.value = [] }
}

function resetFilter() {
  q.date = ''
  q.risk = ''
  q.sheet = ''
  q.keyword = ''
  reload(1)
}

function openDetail(r) { detail.value = r }

// ── 操作 ──────────────────────────────────────────────────────────────────
async function save() {
  saving.value = true
  msg.value = ''
  try {
    const payload = JSON.parse(JSON.stringify(form))
    const res = await saveSitePermitConfig(payload)
    const d = res.data?.data || {}
    applyCfg(d)
    msg.value = '配置已保存，定时任务立即按新设置执行'
    msgType.value = 'success'
    loadStats()
  } catch (e) {
    msg.value = e.response?.data?.error || '保存失败'
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

async function doTest() {
  testing.value = true
  msg.value = ''
  try {
    const payload = JSON.parse(JSON.stringify(form))
    const res = await testSitePermitConn(payload)
    const d = res.data?.data || {}
    const names = (d.sheets || []).map((s) => (typeof s === 'string' ? s : s.name || s.title)).filter(Boolean)
    knownSheets.value = names
    msg.value = `${d.message || '连通成功'}${names.length ? '：' + names.join('、') : ''}`
    msgType.value = 'success'
  } catch (e) {
    msg.value = e.response?.data?.error || '连通失败，请检查 AppKey/AppSecret/operatorId/文档 ID'
    msgType.value = 'error'
  } finally {
    testing.value = false
  }
}

async function doSync(dryRun) {
  syncing.value = true
  msg.value = ''
  try {
    const res = await syncSitePermitNow(dryRun)
    const d = res.data?.data || {}
    msg.value = d.message || (dryRun ? '预演完成' : '同步完成')
    msgType.value = 'success'
    await loadConfig()
    await loadStats()
    await reload(1)
    await loadLogs()
  } catch (e) {
    const d = e.response?.data
    msg.value = d?.error || d?.data?.message || '同步失败'
    msgType.value = 'error'
    loadLogs()
  } finally {
    syncing.value = false
  }
}

async function doExport() {
  exporting.value = true
  try {
    await exportSitePermit({ ...q })
  } catch (e) {
    msg.value = e.response?.data?.error || '导出失败'
    msgType.value = 'error'
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  await loadConfig()
  await loadStats()
  await reload(1)
  await loadLogs()
})
</script>

<style scoped>
.site-permit-page { display: flex; flex-direction: column; gap: 14px; }

/* ── 顶部 ── */
.page-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.head-left h2 { font-size: 18px; margin: 0; }
.sub { font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; line-height: 1.6; }
.head-right { display: flex; align-items: center; gap: 10px; }

.sync-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 5px 11px; border-radius: 999px; background: #f1f5f9; color: var(--text-secondary); white-space: nowrap; }
.sync-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; }
.sync-chip.ok { background: #e8f5e9; color: #2e7d32; }
.sync-chip.ok .dot { background: #43a047; }
.sync-chip.fail { background: #fdecea; color: #c62828; }
.sync-chip.fail .dot { background: #e53935; }
.sync-chip.off { background: #f1f5f9; color: #64748b; }

/* ── Tabs ── */
.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border); }
.tab { background: none; border: none; padding: 10px 18px; font-size: 14px; color: var(--text-secondary); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; }
.tab:hover { color: var(--text-primary, #1e293b); }
.tab.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }

/* ── 作业预约统计面板（当日 + 当月）── */
.stats-panel { padding: 16px 18px 18px; }
.stats-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.stats-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.stats-title h3 { margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary, #1e293b); }
.stats-note { font-size: 12px; color: var(--text-secondary); }
.stats-high { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #b45309; background: #fff7ed; border: 1px solid #fed7aa; padding: 5px 11px; border-radius: 999px; white-space: nowrap; }
.stats-high strong { font-size: 15px; color: #c2410c; }
.high-dot { width: 7px; height: 7px; border-radius: 50%; background: #ea580c; flex: 0 0 auto; }

.stats-grid-wrap { overflow-x: auto; }
.stats-grid { display: grid; grid-template-columns: 104px repeat(5, minmax(92px, 1fr)); gap: 8px; min-width: 620px; }
.sg-head { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 0 4px 9px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.sg-label { text-align: left; }
.lv-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lv, #94a3b8); display: inline-block; flex: 0 0 auto; }
.sg-row-label { display: flex; flex-direction: column; justify-content: center; gap: 3px; padding: 6px 2px; }
.sg-row-label strong { font-size: 13.5px; color: var(--text-primary, #1e293b); }
.sg-row-label small { font-size: 11px; color: var(--text-secondary); }
.sg-cell { display: flex; align-items: baseline; justify-content: center; gap: 4px; min-height: 54px; padding: 10px 8px 9px; background: var(--lv-bg, #f8fafc); border: 1px solid var(--lv-soft, var(--border)); border-top: 3px solid var(--lv, #94a3b8); border-radius: 9px; }
.sg-cell b { font-size: 23px; line-height: 1.15; font-weight: 700; color: var(--lv, #1e293b); }
.sg-cell small { font-size: 11px; color: var(--text-secondary); }
.sg-total { background: #f8fafc; border: 1px solid var(--border); border-top: 3px solid var(--primary); }
.sg-total b { color: var(--text-primary, #1e293b); }

/* ── 筛选 ── */
.filter-card { padding: 14px 16px; }
.filter-line { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 130px; }
.field.grow { flex: 1 1 220px; }
.field label { font-size: 12.5px; color: var(--text-secondary); }
.field-actions { flex-direction: row; gap: 8px; align-items: center; }
.form-input { padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 13.5px; background: #fff; box-sizing: border-box; font-family: inherit; width: 100%; }
.form-input:focus { outline: none; border-color: var(--primary); }
select.form-input { cursor: pointer; }
.nowrap { white-space: nowrap; flex: 0 0 auto; width: auto; }

/* ── 表格 ── */
.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 1080px; }
.data-table th, .data-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.data-table thead th { background: #f8fafc; font-weight: 600; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; position: sticky; top: 0; }
.data-table tbody tr:hover { background: #f8fafc; }
.col-idx { width: 44px; color: var(--text-secondary); }
.col-time { width: 128px; }
.col-unit { width: 150px; }
.col-content { max-width: 300px; }
.clamp3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.55; }
.col-place { width: 130px; }
.col-type { width: 96px; }
.col-risk { width: 96px; white-space: nowrap; }
.col-person { width: 96px; }
.col-op { width: 60px; }
.col-num { width: 60px; text-align: right; }
.time-main { font-weight: 600; font-variant-numeric: tabular-nums; }
.time-sub { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.risk-tag { display: inline-block; padding: 2px 8px; border-radius: 6px; border: 1px solid; font-size: 12px; font-weight: 600; }
.dual-tag { display: inline-block; margin-left: 5px; font-size: 11px; padding: 1px 6px; border-radius: 5px; background: #eef2ff; color: #4338ca; }
.link-btn { background: none; border: none; color: var(--primary); font-size: 13px; cursor: pointer; padding: 0; font-family: inherit; }
.link-btn:hover { text-decoration: underline; }
.empty-box { padding: 48px 20px; text-align: center; color: var(--text-secondary); font-size: 13.5px; line-height: 1.8; }
.empty-box.small { padding: 24px 16px; font-size: 13px; }

.pager { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border); gap: 12px; flex-wrap: wrap; }
.pager-info { font-size: 12.5px; color: var(--text-secondary); }
.pager-btns { display: flex; gap: 8px; }

/* ── 配置表单 ── */
.cfg-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.cfg-head h3 { font-size: 16px; margin: 0; }
.master-switch { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; cursor: pointer; }
.master-label { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
.master-switch input { display: none; }
.track { width: 52px; height: 28px; border-radius: 999px; background: #cbd5e1; position: relative; transition: background .2s; }
.track.on { background: var(--primary); }
.thumb { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: left .2s; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.track.on .thumb { left: 27px; }

.group { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 18px; }
.group-title { font-size: 14px; margin: 0 0 6px; }
.group-hint { font-size: 12.5px; color: var(--text-secondary); margin: 0 0 10px; line-height: 1.6; }
.group-hint.dim { color: #94a3b8; }

.radio-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.radio-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; transition: all .15s; }
.radio-item:hover { background: #f8fafc; }
.radio-item.on { border-color: var(--primary); background: #f0f7ff; }
.radio-item input { display: none; }
.radio-box { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #cbd5e1; flex-shrink: 0; margin-top: 2px; position: relative; }
.radio-item.on .radio-box { border-color: var(--primary); }
.radio-item.on .radio-box::after { content: ''; position: absolute; inset: 2px; border-radius: 50%; background: var(--primary); }
.radio-text { display: flex; flex-direction: column; gap: 2px; line-height: 1.5; }
.radio-text strong { font-size: 13.5px; }
.radio-text small { font-size: 12px; color: var(--text-secondary); }

.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.form-group { display: flex; flex-direction: column; gap: 5px; }
.form-group label { font-size: 12.5px; color: var(--text-secondary); }
.form-group small { font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; }
.time-picker { display: flex; gap: 8px; }

.chip-row { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border: 1px solid var(--border); border-radius: 999px; font-size: 13px; cursor: pointer; transition: all .15s; }
.chip:hover { background: #f8fafc; }
.chip.on { border-color: var(--primary); background: #f0f7ff; color: var(--primary); font-weight: 600; }
.chip input { display: none; }

.footer-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; flex-wrap: wrap; }
.footer-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.msg { font-size: 13px; margin: 0; line-height: 1.6; flex: 1 1 260px; }
.msg.success { color: #2e7d32; }
.msg.error { color: var(--danger); }

/* ── 日志 ── */
.log-title { font-size: 15px; margin: 0 0 12px; }
.log-table { min-width: 720px; font-size: 12.5px; }
.log-table td { padding: 8px 10px; vertical-align: middle; }
.nowrap-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }
.log-msg { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.status-tag { display: inline-block; padding: 1px 8px; border-radius: 5px; font-size: 11.5px; font-weight: 600; }
.status-tag.ok { background: #e8f5e9; color: #2e7d32; }
.status-tag.fail { background: #fdecea; color: #c62828; }

/* ── 弹窗 ── */
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: flex; align-items: center; justify-content: center; z-index: 2000; padding: 20px; }
.modal-box { background: #fff; border-radius: 14px; width: min(760px, 100%); max-height: 86vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.22); }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.modal-head h3 { margin: 0; font-size: 16px; }
.modal-close { background: none; border: none; font-size: 24px; line-height: 1; color: var(--text-secondary); cursor: pointer; padding: 0 4px; }
.modal-body { padding: 16px 20px; overflow-y: auto; }
.detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 20px; margin: 0; }
.detail-item { display: flex; flex-direction: column; gap: 3px; }
.detail-item.full { grid-column: 1 / -1; }
.detail-item dt { font-size: 12px; color: var(--text-secondary); }
.detail-item dd { margin: 0; font-size: 13.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.modal-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.modal-meta { font-size: 12px; color: var(--text-secondary); }

@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
  .detail-grid { grid-template-columns: 1fr; }
  .field, .field.grow { flex: 1 1 100%; min-width: 0; }
  .head-right { width: 100%; justify-content: flex-start; }
}
</style>
