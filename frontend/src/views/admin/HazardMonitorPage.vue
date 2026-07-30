<template>
  <div class="monitor-page">
    <!-- 页头 -->
    <div class="page-head">
      <div>
        <h2 class="page-section-title">隐患监控看板</h2>
        <p class="sub">全局态势 · 自动超期盯防 · 周报推送</p>
      </div>
      <button class="btn btn-outline refresh-btn" :disabled="loading" @click="load">
        <Icon name="loop" :size="16" /> {{ loading ? '加载中…' : '刷新数据' }}
      </button>
    </div>

    <!-- 顶部统计卡（5 张） -->
    <div class="stats-grid">
      <component
        :is="card.to ? 'router-link' : 'div'"
        v-for="card in statCards"
        :key="card.key"
        :to="card.to || undefined"
        class="stat-card"
        :class="{ 'danger': card.danger, 'clickable': card.to || card.anchor }"
        @click="() => card.anchor && scrollToOverdue()"
      >
        <span class="stat-icon" :class="card.color"><Icon :name="card.icon" :size="24" /></span>
        <div class="stat-info">
          <div class="stat-value">{{ card.value }}</div>
          <div class="stat-label">{{ card.label }}</div>
        </div>
      </component>
    </div>

    <!-- 行1：状态分布 + 等级分布 -->
    <div class="row-2">
      <div class="card">
        <h3 class="card-title">状态分布</h3>
        <div class="dist-list">
          <div class="dist-item" v-for="s in statusList" :key="s.key">
            <span class="dist-label">{{ s.label }}</span>
            <div class="bar"><div class="bar-fill" :style="{ width: pct(s.count, statusMax) + '%', background: statusColorMap[s.key] }"></div></div>
            <span class="dist-count">{{ s.count }}</span>
            <span :class="['badge', statusBadge(s.key)]">{{ statusLabel(s.key) }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">等级分布</h3>
        <div class="dist-list">
          <div class="dist-item" v-for="l in levelList" :key="l.key">
            <span class="dist-label">{{ l.label }}</span>
            <div class="bar"><div class="bar-fill" :style="{ width: pct(l.count, levelMax) + '%', background: levelColorMap[l.key] }"></div></div>
            <span class="dist-count">{{ l.count }}</span>
            <span :class="['badge', levelBadge(l.key)]">{{ l.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 行2：各单位隐患数排名 -->
    <div class="card">
      <h3 class="card-title">各单位隐患数（按数量降序）</h3>
      <div class="unit-bars">
        <div class="unit-item" v-for="u in unitList" :key="u.unitName">
          <span class="unit-name" :title="u.unitName">{{ u.unitName }}</span>
          <div class="bar"><div class="bar-fill bar-new" :style="{ width: pct(u.count, unitMax) + '%' }"></div></div>
          <span class="unit-count">{{ u.count }}</span>
        </div>
      </div>
      <table class="data-table unit-table">
        <thead>
          <tr><th>单位</th><th>隐患数</th><th>超期</th><th>已闭环</th><th>闭环率</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in unitList" :key="u.unitName">
            <td>{{ u.unitName }}</td>
            <td>{{ u.count }}</td>
            <td>
              <span v-if="u.overdue" class="badge badge-danger">{{ u.overdue }}</span>
              <span v-else class="muted">0</span>
            </td>
            <td>{{ u.closed }}</td>
            <td>{{ u.count ? Math.round((u.closed / u.count) * 100) : 0 }}%</td>
          </tr>
          <tr v-if="unitList.length === 0">
            <td colspan="5" class="empty-cell">暂无单位数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 超期预警清单（Sprint 3 新增面板） -->
    <div class="card overdue-card" ref="overdueRef">
      <h3 class="card-title">
        超期预警清单
        <span class="sub-count">（共 {{ overdueList.length }} 条未闭环超期隐患）</span>
      </h3>

      <div class="overdue-toolbar">
        <label class="check-all">
          <input type="checkbox" :checked="allSelected" :indeterminate="indeterminate" @change="toggleSelectAll" />
          <span>全选</span>
        </label>
        <button class="btn btn-primary" :disabled="overdueLoading || selectedIds.length === 0" @click="notifySelected">
          <Icon name="inbox" :size="16" /> 一键催办所选（{{ selectedIds.length }}）
        </button>
        <span v-if="notifyMsg" class="notify-msg">{{ notifyMsg }}</span>
      </div>

      <div class="table-wrap">
        <table class="data-table overdue-table">
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" :checked="allSelected" :indeterminate="indeterminate" @change="toggleSelectAll" aria-label="全选" />
              </th>
              <th>隐患编号</th>
              <th>责任单位</th>
              <th>责任人</th>
              <th>等级</th>
              <th>计划完成</th>
              <th>超期天数</th>
              <th>概要</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="h in overdueList"
              :key="h.id"
              :class="{ 'row-selected': selectedIds.includes(h.id) }"
            >
              <td class="col-check">
                <input type="checkbox" :checked="selectedIds.includes(h.id)" @change="toggleSelect(h.id)" />
              </td>
              <td class="mono">{{ h.hazardCode }}</td>
              <td>{{ h.unitName }}</td>
              <td>{{ h.responsiblePerson }}</td>
              <td>
                <span :class="['badge', levelBadge(h.hazardLevel)]">{{ h.hazardLevel || '-' }}</span>
              </td>
              <td class="mono">{{ h.planFinishTime }}</td>
              <td>
                <span
                  :class="[
                    'badge',
                    h.overdueDays > 7 ? 'badge-danger' : h.overdueDays > 3 ? 'badge-warning' : 'badge-neutral',
                  ]"
                >{{ h.overdueDays }} 天</span>
              </td>
              <td class="ov-title" :title="h.title">{{ h.title }}</td>
            </tr>
            <tr v-if="overdueList.length === 0">
              <td colspan="8" class="empty-cell">
                <span v-if="overdueLoading">加载中…</span>
                <span v-else>暂无超期隐患 🎉</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 行3：近 30 天趋势（自绘 SVG） -->
    <div class="card">
      <h3 class="card-title">
        新增 vs 闭环趋势
        <span class="trend-hint">（近 30 天 · {{ granularity === 'day' ? '按天' : '按周' }}）</span>
      </h3>
      <div class="legend">
        <span class="lg"><i class="dot dot-new"></i>新增</span>
        <span class="lg"><i class="dot dot-closed"></i>闭环</span>
      </div>

      <svg v-if="trend.length" :viewBox="`0 0 ${SVG_W} ${SVG_H}`" class="trend-svg">
        <line v-for="(g, i) in gridLines" :key="'g' + i" :x1="PAD_L" :y1="g" :x2="SVG_W - PAD_R" :y2="g" class="grid" />
        <text :x="PAD_L" :y="PAD_T - 4" class="axis-max">{{ trendMax }}</text>
        <polyline :points="newPoints" class="line-new" fill="none" />
        <polyline :points="closedPoints" class="line-closed" fill="none" />
        <circle v-for="(p, i) in newArr" :key="'n' + i" :cx="p.x" :cy="p.y" r="3" class="dot-new-fill" />
        <circle v-for="(p, i) in closedArr" :key="'c' + i" :cx="p.x" :cy="p.y" r="3" class="dot-closed-fill" />
        <text v-for="(x, i) in xLabels" :key="'x' + i" :x="x.x" :y="SVG_H - PAD_B + 16" class="axis-label">{{ x.label }}</text>
      </svg>
      <div v-else class="empty-row"><Icon name="trending" :size="18" /> 暂无趋势数据</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import Icon from '@/components/Icon.vue'
import { getHazardStats, getOverdueHazards } from '@/api/stats'
import { triggerOverdueNotify } from '@/api/hazard'
import { statusLabel, statusBadge, levelBadge } from '@/utils/hazardStatus'
import { pct, maxOf, sortUnits } from '@/utils/statsFormat'

// ── 数据 ──
const data = ref({
  total: 0, byStatus: {}, byLevel: {}, byUnit: [],
  closedRate: 0, overdue: 0, trend: [],
})
const loading = ref(false)
const granularity = ref('week') // 默认按周（P1-2 可按天切换，此处后端已支持）

// ── 超期预警清单 ──
const overdueList = ref([])
const overdueLoading = ref(false)
const selectedIds = ref([])
const notifyMsg = ref('')
const overdueRef = ref(null)

// ── 统计卡 ──
const statCards = computed(() => {
  const d = data.value
  const bs = d.byStatus || {}
  return [
    { key: 'total', label: '隐患总数', value: d.total ?? 0, icon: 'hazard', color: 'icon-blue', to: '' },
    { key: 'rate', label: '闭环率', value: `${d.closedRate ?? 0}%`, icon: 'check', color: 'icon-green', to: '' },
    { key: 'overdue', label: '超期数', value: d.overdue ?? 0, icon: 'alert', color: 'icon-red', to: '', anchor: true, danger: (d.overdue ?? 0) > 0 },
    { key: 'rectifying', label: '整改中', value: bs.rectifying ?? 0, icon: 'settings', color: 'icon-amber', to: '' },
    { key: 'verifying', label: '待验收', value: bs.verifying ?? 0, icon: 'clock', color: 'icon-blue', to: '' },
  ]
})

// ── 状态分布 ──
const statusColorMap = {
  reported: 'var(--c-blue-500)',
  assigned: 'var(--c-warning)',
  rectifying: 'var(--c-warning)',
  verifying: 'var(--c-blue-600)',
  closed: 'var(--c-success)',
}
const statusList = computed(() => {
  const bs = data.value.byStatus || {}
  return [
    { key: 'reported', label: '已上报', count: bs.reported || 0 },
    { key: 'assigned', label: '已分派', count: bs.assigned || 0 },
    { key: 'rectifying', label: '整改中', count: bs.rectifying || 0 },
    { key: 'verifying', label: '待验收', count: bs.verifying || 0 },
    { key: 'closed', label: '已闭环', count: bs.closed || 0 },
  ]
})
const statusMax = computed(() => maxOf(statusList.value, 'count') || 1)

// ── 等级分布 ──
const levelColorMap = {
  重大: 'var(--c-danger)',
  较大: 'var(--c-warning)',
  一般: 'var(--c-blue-600)',
  低: 'var(--c-text-3)',
}
const levelList = computed(() => {
  const bl = data.value.byLevel || {}
  return [
    { key: '重大', label: '重大', count: bl['重大'] || 0 },
    { key: '较大', label: '较大', count: bl['较大'] || 0 },
    { key: '一般', label: '一般', count: bl['一般'] || 0 },
    { key: '低', label: '低', count: bl['低'] || 0 },
  ]
})
const levelMax = computed(() => maxOf(levelList.value, 'count') || 1)

// ── 单位排名 ──
const unitList = computed(() => sortUnits(data.value.byUnit || []))
const unitMax = computed(() => maxOf(unitList.value, 'count') || 1)

// ── 趋势 SVG（自绘，无 ECharts）──
const SVG_W = 640
const SVG_H = 220
const PAD_L = 40
const PAD_R = 16
const PAD_T = 18
const PAD_B = 30
const plotW = SVG_W - PAD_L - PAD_R
const plotH = SVG_H - PAD_T - PAD_B

const trend = computed(() => data.value.trend || [])
const trendMax = computed(() =>
  trend.value.reduce((m, p) => Math.max(m, Number(p.newCount) || 0, Number(p.closedCount) || 0), 0) || 1
)
const gridLines = computed(() => [PAD_T, PAD_T + plotH / 2, PAD_T + plotH])

function pointXY(key, i, n) {
  const x = PAD_L + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1))
  const y = PAD_T + plotH - ((Number(trend.value[i]?.[key]) || 0) / trendMax.value) * plotH
  return { x, y }
}
const newArr = computed(() =>
  trend.value.map((_, i) => pointXY('newCount', i, trend.value.length))
)
const closedArr = computed(() =>
  trend.value.map((_, i) => pointXY('closedCount', i, trend.value.length))
)
const newPoints = computed(() => newArr.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
const closedPoints = computed(() => closedArr.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
const xLabels = computed(() =>
  trend.value.map((p, i) => ({ x: pointXY('newCount', i, trend.value.length).x, label: p.label }))
)

// ── 加载 ──
async function load() {
  loading.value = true
  try {
    const res = await getHazardStats({ granularity: granularity.value })
    const d = res.data?.data
    if (d) data.value = { ...data.value, ...d }
  } catch (e) {
    console.error('[HazardMonitor] 数据加载失败', e)
  } finally {
    loading.value = false
  }
  // 超期清单独立加载，统计卡失败不影响其展示
  await loadOverdue()
}

// ── 超期预警清单：滚动锚点 ──
function scrollToOverdue() {
  overdueRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 超期预警清单：加载 / 选择 / 催办 ──
async function loadOverdue() {
  overdueLoading.value = true
  try {
    const res = await getOverdueHazards()
    const lst = res.data?.data?.list || []
    overdueList.value = lst
    // 列表刷新后，剔除已不在超期清单中的已选项，保持 selectedIds 正确
    const validIds = new Set(lst.map((h) => h.id))
    selectedIds.value = selectedIds.value.filter((id) => validIds.has(id))
  } catch (e) {
    console.error('[HazardMonitor] 超期清单加载失败', e)
  } finally {
    overdueLoading.value = false
  }
}

function toggleSelect(id) {
  const idx = selectedIds.value.indexOf(id)
  if (idx === -1) selectedIds.value.push(id)
  else selectedIds.value.splice(idx, 1)
}

function toggleSelectAll(e) {
  if (e && e.target && e.target.checked) {
    selectedIds.value = overdueList.value.map((h) => h.id)
  } else {
    selectedIds.value = []
  }
}

// 全部选中（列表非空且已选数 == 总数）
const allSelected = computed(() =>
  overdueList.value.length > 0 && selectedIds.value.length === overdueList.value.length
)
// 半选（已选数 > 0 且 < 总数）
const indeterminate = computed(() =>
  selectedIds.value.length > 0 && selectedIds.value.length < overdueList.value.length
)

async function notifySelected() {
  if (selectedIds.value.length === 0) {
    notifyMsg.value = '请先勾选要催办的隐患'
    return
  }
  try {
    const res = await triggerOverdueNotify(selectedIds.value)
    const r = res.data?.data || {}
    notifyMsg.value = `已催办 ${r.sent ?? 0} 条，跳过 ${r.skipped ?? 0} 条`
    selectedIds.value = [] // 催办后清空选择
    await loadOverdue()     // 已置位 overdue_notified 的仍留在超期清单，刷新即可
  } catch (e) {
    console.error('[HazardMonitor] 催办失败', e)
    notifyMsg.value = '催办失败，请稍后重试'
  }
}

onMounted(load)
</script>

<style scoped>
.monitor-page { max-width: 1120px; }

.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.page-section-title { font-size: 22px; font-weight: 700; color: var(--c-text); }
.sub { font-size: 14px; color: var(--c-text-2); margin-top: 4px; }
.refresh-btn { width: auto; }

/* 统计卡 */
.stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin-bottom: 16px; }
.stat-card {
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg);
  padding: 18px; display: flex; align-items: center; gap: 14px; box-shadow: var(--shadow-sm);
  text-decoration: none; color: inherit;
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}
.stat-card:hover { transform: translateY(-3px); box-shadow: var(--shadow); }
.stat-card.clickable { cursor: pointer; }
.stat-card.danger { border-color: var(--c-danger); }
.stat-card.danger .stat-value { color: var(--c-danger); }
.stat-icon { width: 48px; height: 48px; border-radius: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.icon-blue { background: var(--c-blue-50); color: var(--c-blue-700); }
.icon-green { background: var(--c-success-bg); color: var(--c-success); }
.icon-amber { background: var(--c-warning-bg); color: var(--c-warning); }
.icon-red { background: var(--c-danger-bg); color: var(--c-danger); }
.stat-value { font-size: 25px; font-weight: 700; color: var(--c-text); line-height: 1.1; }
.stat-label { font-size: 13px; color: var(--c-text-2); margin-top: 3px; }

.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.card-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; color: var(--c-text); }

/* 分布条形 */
.dist-list { display: flex; flex-direction: column; gap: 12px; }
.dist-item { display: flex; align-items: center; gap: 12px; }
.dist-label { width: 56px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; text-align: right; }
.bar { flex: 1; height: 8px; background: var(--c-border); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; transition: width .6s ease; }
.dist-count { width: 34px; font-size: 13px; font-weight: 600; color: var(--c-text); text-align: right; flex-shrink: 0; }

/* 单位排名 */
.unit-bars { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.unit-item { display: flex; align-items: center; gap: 12px; }
.unit-name { width: 140px; font-size: 13px; color: var(--c-text); flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-new { background: var(--c-blue-600); }
.unit-count { width: 34px; font-size: 13px; font-weight: 600; color: var(--c-text); text-align: right; flex-shrink: 0; }
.unit-table { margin-top: 4px; }
.muted { color: var(--c-text-3); }

/* 趋势 */
.trend-hint { font-size: 12px; color: var(--c-text-3); font-weight: 500; }
.legend { display: flex; gap: 18px; margin-bottom: 8px; }
.lg { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-2); }
.dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.dot-new { background: var(--c-blue-600); }
.dot-closed { background: var(--c-success); }
.trend-svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--c-border); stroke-width: 1; }
.axis-label { fill: var(--c-text-3); font-size: 11px; text-anchor: middle; }
.axis-max { fill: var(--c-text-3); font-size: 11px; text-anchor: start; }
.line-new { stroke: var(--c-blue-600); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.line-closed { stroke: var(--c-success); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.dot-new-fill { fill: var(--c-blue-600); }
.dot-closed-fill { fill: var(--c-success); }
.empty-row { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--c-text-3); padding: 30px; font-weight: 500; }

/* 超期预警清单面板 */
.overdue-card { scroll-margin-top: 16px; }
.card-title .sub-count { font-size: 12px; color: var(--c-text-3); font-weight: 500; margin-left: 4px; }
.overdue-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.check-all { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-2); cursor: pointer; user-select: none; }
.check-all input { width: 16px; height: 16px; cursor: pointer; }
.overdue-toolbar .btn { width: auto; display: inline-flex; align-items: center; gap: 6px; }
.notify-msg { font-size: 13px; color: var(--c-blue-700); font-weight: 600; }
.table-wrap { overflow-x: auto; }
.overdue-table { min-width: 760px; }
.overdue-table .col-check { width: 36px; text-align: center; }
.overdue-table .col-check input { width: 16px; height: 16px; cursor: pointer; }
.overdue-table .mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
.overdue-table .ov-title { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overdue-table .row-selected { background: var(--c-blue-50); }

@media (max-width: 900px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .row-2 { grid-template-columns: 1fr; }
}
</style>
