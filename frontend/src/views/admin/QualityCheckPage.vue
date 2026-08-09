<template>
  <div class="quality-page">
    <!-- ── 顶部工具条 ── -->
    <div class="toolbar">
      <div class="title-group">
        <button class="action-link" @click="$router.push('/admin/trainings')">← 返回题库</button>
        <h2 class="page-title">出题质量校验</h2>
        <span v-if="report" class="material-title">{{ report.materialTitle || `素材 #${materialId}` }}</span>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" :disabled="busy" @click="doCheck">
          {{ checking ? '校验中…' : '运行校验' }}
        </button>
        <button class="btn" :disabled="busy" @click="doEnrich">
          {{ enriching ? '补标中…' : '补全标注' }}
        </button>
        <button class="btn" :disabled="busy" @click="doRefreshKeypoints">
          {{ refreshing ? '抽取中…' : '刷新源关键点' }}
        </button>
        <button class="btn" :disabled="busy || !report" @click="doExport">
          {{ exporting ? '导出中…' : '导出 Excel' }}
        </button>
      </div>
    </div>

    <!-- ── 提示条 ── -->
    <div v-if="message" :class="['alert', messageType]">{{ message }}</div>

    <!-- ── 空态 ── -->
    <div v-if="!report && !checking" class="card empty-card">
      <p class="empty-text">该题库尚无质量报告。</p>
      <p class="empty-hint">点击右上角「运行校验」，系统会执行整卷一致性校验、源文档覆盖率比对与综合打分。</p>
    </div>

    <div v-if="checking && !report" class="card empty-card">
      <p class="empty-text">正在校验，请稍候…</p>
      <p class="empty-hint">首次校验需调用大模型抽取源文档关键点，可能耗时 30-90 秒。</p>
    </div>

    <template v-if="report">
      <!-- ── 综合分卡片 ── -->
      <div class="card score-card">
        <div class="score-main">
          <div :class="['score-ring', gradeClass]">
            <span class="score-num">{{ report.qualityScore }}</span>
            <span class="score-unit">分</span>
          </div>
          <div class="score-meta">
            <span :class="['grade-badge', gradeClass]">{{ report.grade }}</span>
            <p class="score-desc">
              综合分 = 题量达标率×25% + 题型匹配度×20% + 源覆盖率×30% + 标注完整度×15% + 修订收敛度×10%
            </p>
            <p class="score-sub">
              第 {{ report.revision.rounds }} 轮 · 共 {{ report.consistency.actualCount }} 道题 ·
              校验时间 {{ formatTime(report.checkedAt || report.createdAt) }}
            </p>
          </div>
        </div>

        <div class="metric-grid">
          <div v-for="m in metricList" :key="m.key" class="metric-item">
            <div class="metric-head">
              <span class="metric-name">{{ m.label }}</span>
              <span class="metric-value">{{ m.value }}%</span>
            </div>
            <div class="metric-bar">
              <div class="metric-bar-fill" :style="{ width: Math.min(100, m.value) + '%', background: m.color }"></div>
            </div>
            <span class="metric-weight">权重 {{ m.weight }}%</span>
          </div>
        </div>
      </div>

      <!-- ── 处置建议 ── -->
      <div v-if="report.hints && report.hints.length" class="card hint-card">
        <h3 class="card-title">处置建议</h3>
        <ul class="hint-list">
          <li v-for="(h, i) in report.hints" :key="i">{{ h }}</li>
        </ul>
      </div>

      <!-- ── 一致性校验 ── -->
      <div class="card">
        <h3 class="card-title">
          整卷一致性校验
          <span :class="['badge', report.consistency.pass ? 'badge-success' : 'badge-danger']">
            {{ report.consistency.pass ? '通过' : '未通过' }}
          </span>
        </h3>

        <div class="summary-row">
          <span>实际题量 <b>{{ report.consistency.actualCount }}</b> / 期望 <b>{{ report.consistency.expectedCount }}</b></span>
          <span>已标注 <b>{{ report.consistency.annotatedCount }}</b> 道</span>
          <span>去重知识点 <b>{{ report.consistency.kpCount }}</b> 个（下限 {{ report.consistency.kpMinCount }}）</span>
        </div>

        <table class="data-table">
          <thead>
            <tr><th style="width:60px">#</th><th>维度</th><th>期望</th><th>实际</th><th style="width:90px">严重度</th></tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in report.consistency.diffs" :key="i">
              <td>{{ i + 1 }}</td>
              <td>{{ d.dimension }}</td>
              <td>{{ d.expected }}</td>
              <td>{{ d.actual }}</td>
              <td><span :class="['badge', severityClass(d.severity)]">{{ severityText(d.severity) }}</span></td>
            </tr>
            <tr v-if="!report.consistency.diffs.length">
              <td colspan="5" class="muted-cell">无差异项</td>
            </tr>
          </tbody>
        </table>

        <div v-if="report.consistency.warnings.length" class="warn-block">
          <h4 class="sub-title">告警清单</h4>
          <ul class="warn-list">
            <li v-for="(w, i) in report.consistency.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>
      </div>

      <!-- ── 分布明细 ── -->
      <div class="card">
        <h3 class="card-title">题目分布明细</h3>
        <div class="dist-grid">
          <div class="dist-block">
            <h4 class="sub-title">题型分布</h4>
            <div v-for="(v, k) in report.consistency.typeCounts" :key="'t' + k" class="dist-row">
              <span class="dist-label">{{ typeText(k) }}</span>
              <span class="dist-count">{{ v }} 道</span>
            </div>
            <p v-if="!hasKeys(report.consistency.typeCounts)" class="muted-cell">暂无数据</p>
          </div>
          <div class="dist-block">
            <h4 class="sub-title">难度分布</h4>
            <div v-for="(v, k) in report.consistency.difficultyHistogram" :key="'d' + k" class="dist-row">
              <span class="dist-label">难度 {{ k }}</span>
              <span class="dist-count">{{ v }} 道</span>
            </div>
            <p v-if="!hasKeys(report.consistency.difficultyHistogram)" class="muted-cell">暂无数据</p>
          </div>
          <div class="dist-block">
            <h4 class="sub-title">Bloom 层级分布</h4>
            <div v-for="(v, k) in report.consistency.bloomDistribution" :key="'b' + k" class="dist-row">
              <span class="dist-label">{{ k }}</span>
              <span class="dist-count">{{ v }} 道</span>
            </div>
            <p v-if="!hasKeys(report.consistency.bloomDistribution)" class="muted-cell">暂无数据</p>
          </div>
        </div>
      </div>

      <!-- ── 源覆盖率 ── -->
      <div class="card">
        <h3 class="card-title">
          源文档覆盖率
          <span class="badge badge-info">{{ report.coverage.coveragePct }}%</span>
          <span v-if="report.coverage.needsManual" class="badge badge-warning">需人工复核</span>
        </h3>
        <p class="summary-row">
          关键点总数 <b>{{ report.coverage.totalKP }}</b> ·
          已覆盖 <b>{{ report.coverage.covered.length }}</b> ·
          未覆盖 <b>{{ report.coverage.uncovered.length }}</b> ·
          来源 {{ sourceText(report.coverage.source) }}
        </p>
        <div class="cover-grid">
          <div class="cover-block">
            <h4 class="sub-title">未覆盖关键点（优先补题）</h4>
            <ol class="kp-list">
              <li v-for="(kp, i) in report.coverage.uncovered" :key="'u' + i" class="kp-uncovered">{{ kp }}</li>
            </ol>
            <p v-if="!report.coverage.uncovered.length" class="muted-cell">全部覆盖</p>
          </div>
          <div class="cover-block">
            <h4 class="sub-title">已覆盖关键点</h4>
            <ol class="kp-list">
              <li v-for="(kp, i) in report.coverage.covered" :key="'c' + i">{{ kp }}</li>
            </ol>
            <p v-if="!report.coverage.covered.length" class="muted-cell">暂无</p>
          </div>
        </div>
      </div>

      <!-- ── 修订历史 ── -->
      <div class="card">
        <h3 class="card-title">修订留痕</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:60px">#</th><th style="width:70px">轮次</th><th style="width:110px">操作人</th>
              <th style="width:100px">类型</th><th>内容</th><th style="width:160px">时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(h, i) in history" :key="h.id">
              <td>{{ i + 1 }}</td>
              <td>{{ h.roundNo }}</td>
              <td>{{ h.operatorName || '系统' }}</td>
              <td><span class="badge badge-muted">{{ opTypeText(h.opType) }}</span></td>
              <td>{{ h.opContent }}</td>
              <td>{{ formatTime(h.createdAt) }}</td>
            </tr>
            <tr v-if="!history.length">
              <td colspan="6" class="muted-cell">暂无修订记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  runQualityCheck,
  getLatestQualityReport,
  enrichQuestions,
  refreshSourceKeypoints,
  getRevisionHistory,
  exportQualityExcel,
} from '@/api/quality'

const route = useRoute()
const materialId = Number(route.params.id)

const report = ref(null)
const history = ref([])

const checking = ref(false)
const enriching = ref(false)
const refreshing = ref(false)
const exporting = ref(false)

const message = ref('')
const messageType = ref('info')

const busy = computed(
  () => checking.value || enriching.value || refreshing.value || exporting.value
)

const WEIGHTS = {
  countRate: 25,
  typeMatch: 20,
  coveragePct: 30,
  annotateRate: 15,
  revisionConvergence: 10,
}

const METRIC_LABELS = {
  countRate: '题量达标率',
  typeMatch: '题型匹配度',
  coveragePct: '源覆盖率',
  annotateRate: '标注完整度',
  revisionConvergence: '修订收敛度',
}

/** 指标列表（用于渲染进度条） */
const metricList = computed(() => {
  if (!report.value || !report.value.metrics) return []
  return Object.keys(METRIC_LABELS).map((key) => {
    const value = Number(report.value.metrics[key]) || 0
    return {
      key,
      label: METRIC_LABELS[key],
      value,
      weight: WEIGHTS[key],
      color: value >= 90 ? '#34a853' : value >= 75 ? '#1a73e8' : value >= 60 ? '#f9ab00' : '#d93025',
    }
  })
})

/** 分档对应的样式类 */
const gradeClass = computed(() => {
  const g = report.value?.grade || ''
  if (g === '优秀') return 'grade-excellent'
  if (g === '良好') return 'grade-good'
  if (g === '合格') return 'grade-pass'
  return 'grade-poor'
})

/**
 * 统一提示
 * @param {string} text
 * @param {string} type info | success | error
 */
function notify(text, type = 'info') {
  message.value = text
  messageType.value = type
  if (type !== 'error') {
    setTimeout(() => {
      if (message.value === text) message.value = ''
    }, 5000)
  }
}

/** 提取接口错误文案 */
function errText(e) {
  return e?.response?.data?.error || e?.message || '未知错误'
}

/** 时间格式化 */
function formatTime(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const TYPE_CN = {
  single: '单选题',
  multiple: '多选题',
  judgment: '判断题',
  judge: '判断题',
  fill: '填空题',
  essay: '简答题',
  short_answer: '简答题',
  short_answer_image: '图片简答题',
  multiple_image: '图片多选题',
}
function typeText(t) {
  return TYPE_CN[t] || t
}

const OP_TYPE_CN = {
  GENERATE: '首次出题',
  REGEN: '重新出题',
  ADD: '新增题目',
  EDIT: '修改题目',
  DELETE: '删除题目',
  CONFIG: '配置变更',
}
function opTypeText(t) {
  return OP_TYPE_CN[t] || t || '-'
}

const SOURCE_CN = {
  cache: '缓存',
  ai: 'AI 抽取正文',
  questions: '题目汇总',
  none: '无',
}
function sourceText(s) {
  return SOURCE_CN[s] || s || '-'
}

function severityText(s) {
  return { high: '严重', mid: '中等', low: '轻微' }[s] || s || '-'
}
function severityClass(s) {
  return { high: 'badge-danger', mid: 'badge-warning', low: 'badge-muted' }[s] || 'badge-muted'
}

/** 对象是否有可枚举键（模板里判断分布是否为空） */
function hasKeys(obj) {
  return !!obj && Object.keys(obj).length > 0
}

/** 加载修订历史 */
async function loadHistory() {
  try {
    const res = await getRevisionHistory(materialId)
    history.value = res.data.data || []
  } catch (e) {
    history.value = []
    console.warn('[quality] 加载修订历史失败：', errText(e))
  }
}

/** 进页面先读最近一次报告（不触发重算） */
async function loadLatest() {
  try {
    const res = await getLatestQualityReport(materialId)
    report.value = res.data.data || null
  } catch (e) {
    notify('读取历史报告失败：' + errText(e), 'error')
  }
}

/** 运行校验 */
async function doCheck() {
  checking.value = true
  message.value = ''
  try {
    const res = await runQualityCheck(materialId)
    report.value = res.data.data
    await loadHistory()
    notify(`校验完成：综合 ${report.value.qualityScore} 分（${report.value.grade}）`, 'success')
  } catch (e) {
    notify('校验失败：' + errText(e), 'error')
  } finally {
    checking.value = false
  }
}

/** 一键补标 */
async function doEnrich() {
  enriching.value = true
  message.value = ''
  try {
    const res = await enrichQuestions(materialId, false)
    const r = res.data.data || {}
    notify(
      `补标完成：成功 ${r.annotated || 0} 道，跳过 ${r.skipped || 0} 道，失败 ${r.failed || 0} 道，正在重新校验…`,
      'success'
    )
    await doCheck()
  } catch (e) {
    notify('补全标注失败：' + errText(e), 'error')
  } finally {
    enriching.value = false
  }
}

/** 重新抽取源关键点 */
async function doRefreshKeypoints() {
  refreshing.value = true
  message.value = ''
  try {
    const res = await refreshSourceKeypoints(materialId)
    const r = res.data.data || {}
    const n = (r.keyPoints || []).length
    if (r.needsManual) {
      notify('该素材无可用正文，未能抽取源关键点，覆盖率将按保守分计入，请人工复核', 'error')
    } else {
      notify(`已抽取 ${n} 条源关键点（来源：${sourceText(r.source)}），正在重新校验…`, 'success')
      await doCheck()
    }
  } catch (e) {
    notify('抽取源关键点失败：' + errText(e), 'error')
  } finally {
    refreshing.value = false
  }
}

/** 导出 Excel */
async function doExport() {
  exporting.value = true
  try {
    await exportQualityExcel(materialId, report.value?.materialTitle || '')
    notify('导出成功', 'success')
  } catch (e) {
    notify('导出失败：' + errText(e), 'error')
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  if (!materialId) {
    notify('素材ID无效', 'error')
    return
  }
  await loadLatest()
  await loadHistory()
})
</script>

<style scoped>
.quality-page { max-width: 1100px; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px; flex-wrap: wrap; gap: 10px;
}
.title-group { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.page-title { font-size: 18px; font-weight: 600; margin: 0; }
.material-title { color: var(--text-secondary); font-size: 14px; }
.btn-group { display: flex; gap: 8px; flex-wrap: wrap; }

.btn {
  padding: 8px 14px; border: 1px solid var(--border); background: #fff;
  border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
}
.btn:hover:not(:disabled) { background: #f8f9fa; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #1765cc; }

.action-link {
  background: none; border: none; cursor: pointer; color: #1a73e8;
  font-size: 13px; padding: 3px 8px; border-radius: 6px;
}
.action-link:hover { background: #e8f0fe; }

.alert { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
.alert.info { background: #e8f0fe; color: #1a73e8; }
.alert.success { background: #e6f4ea; color: #137333; }
.alert.error { background: #fce8e6; color: #c5221f; }

.card {
  background: #fff; border: 1px solid var(--border);
  border-radius: 10px; padding: 16px; margin-bottom: 14px;
}
.card-title {
  font-size: 15px; font-weight: 600; margin: 0 0 12px;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.sub-title { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: var(--text-secondary); }

.empty-card { text-align: center; padding: 40px 16px; }
.empty-text { font-size: 15px; margin: 0 0 6px; }
.empty-hint { font-size: 13px; color: var(--text-secondary); margin: 0; }

/* ── 综合分 ── */
.score-main { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.score-ring {
  width: 104px; height: 104px; border-radius: 50%;
  display: flex; align-items: baseline; justify-content: center; gap: 2px;
  border: 6px solid #e8eaed; flex-shrink: 0;
}
.score-ring.grade-excellent { border-color: #34a853; }
.score-ring.grade-good { border-color: #1a73e8; }
.score-ring.grade-pass { border-color: #f9ab00; }
.score-ring.grade-poor { border-color: #d93025; }
.score-num { font-size: 34px; font-weight: 700; line-height: 104px; }
.score-unit { font-size: 13px; color: var(--text-secondary); }

.score-meta { flex: 1; min-width: 260px; }
.grade-badge {
  display: inline-block; padding: 3px 12px; border-radius: 12px;
  font-size: 13px; font-weight: 600; margin-bottom: 8px;
}
.grade-badge.grade-excellent { background: #e6f4ea; color: #137333; }
.grade-badge.grade-good { background: #e8f0fe; color: #1a73e8; }
.grade-badge.grade-pass { background: #fef7e0; color: #b06000; }
.grade-badge.grade-poor { background: #fce8e6; color: #c5221f; }
.score-desc { font-size: 12px; color: var(--text-secondary); margin: 0 0 4px; line-height: 1.6; }
.score-sub { font-size: 12px; color: var(--text-secondary); margin: 0; }

.metric-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border);
}
.metric-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.metric-name { font-size: 13px; }
.metric-value { font-size: 14px; font-weight: 600; }
.metric-bar { height: 6px; background: #f1f3f4; border-radius: 3px; overflow: hidden; }
.metric-bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }
.metric-weight { font-size: 11px; color: var(--text-secondary); display: block; margin-top: 4px; }

/* ── 建议 ── */
.hint-card { background: #fef7e0; border-color: #fdd663; }
.hint-list { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.9; }

/* ── 表格 ── */
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th {
  text-align: left; padding: 10px 12px; background: #f8f9fa;
  color: var(--text-secondary); font-weight: 500; font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.data-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.data-table tr:last-child td { border-bottom: none; }
.muted-cell { color: var(--text-secondary); text-align: center; padding: 14px; font-size: 13px; }

.summary-row {
  display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px;
  color: var(--text-secondary); margin-bottom: 12px;
}
.summary-row b { color: var(--text-primary, #202124); }

.badge {
  display: inline-block; padding: 2px 9px; border-radius: 10px;
  font-size: 12px; font-weight: 500;
}
.badge-success { background: #e6f4ea; color: #137333; }
.badge-danger { background: #fce8e6; color: #c5221f; }
.badge-warning { background: #fef7e0; color: #b06000; }
.badge-info { background: #e8f0fe; color: #1a73e8; }
.badge-muted { background: #f0f0f0; color: #666; }

.warn-block { margin-top: 14px; }
.warn-list { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.9; color: #b06000; }

/* ── 分布 / 覆盖率 ── */
.dist-grid, .cover-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px;
}
.dist-row {
  display: flex; justify-content: space-between;
  font-size: 13px; padding: 5px 0; border-bottom: 1px dashed var(--border);
}
.dist-row:last-child { border-bottom: none; }
.dist-label { color: var(--text-secondary); }
.dist-count { font-weight: 500; }

.kp-list { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.9; max-height: 320px; overflow-y: auto; }
.kp-uncovered { color: #c5221f; }
</style>
