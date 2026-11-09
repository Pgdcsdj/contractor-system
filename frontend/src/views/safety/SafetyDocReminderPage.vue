<template>
  <div class="dr-page">
    <!-- 顶部统计 -->
    <div class="card head-card">
      <div class="head-info">
        <h2>开工资料补录提醒</h2>
        <p class="head-sub">管理端在「承包商开工资料」台账发起补录提醒后，会在这里形成待办；补齐资料后请勾选处理并留痕。</p>
      </div>
      <div class="head-stats">
        <div class="hs-item pending">
          <span class="hs-n">{{ stats.pending }}</span>
          <span class="hs-l">待处理</span>
        </div>
        <div class="hs-item done">
          <span class="hs-n">{{ stats.done }}</span>
          <span class="hs-l">已处理</span>
        </div>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="card filter-bar">
      <div class="tabs">
        <button :class="['tab', statusFilter === 'pending' ? 'on' : '']" @click="setFilter('pending')">
          待处理<template v-if="stats.pending"> ({{ stats.pending }})</template>
        </button>
        <button :class="['tab', statusFilter === 'done' ? 'on' : '']" @click="setFilter('done')">
          已处理<template v-if="stats.done"> ({{ stats.done }})</template>
        </button>
        <button :class="['tab', statusFilter === '' ? 'on' : '']" @click="setFilter('')">全部</button>
      </div>
      <button class="btn btn-outline" @click="load" :disabled="loading">
        <Icon v-if="loading" name="loop" :size="15" class="spin" />
        <Icon v-else name="loop" :size="15" /> 刷新
      </button>
    </div>

    <div v-if="errorMsg" class="error-toast">{{ errorMsg }}</div>

    <!-- 列表 -->
    <div v-if="loading && !list.length" class="card empty-card">加载中…</div>
    <div v-else-if="!list.length" class="card empty-card">
      <Icon name="inbox" :size="26" />
      <div>{{ statusFilter === 'pending' ? '当前没有待处理的补录提醒' : statusFilter === 'done' ? '还没有已处理的记录' : '暂无提醒记录' }}</div>
    </div>

    <div v-for="r in list" :key="r.id" class="card rm-card" :class="{ done: r.status === 'done' }">
      <div class="rm-head">
        <div class="rm-title">
          <span class="rm-unit">{{ r.unit_name }}</span>
          <span class="rm-proj">{{ r.project_name }}</span>
        </div>
        <span :class="['badge', r.status === 'done' ? 'badge-done' : 'badge-pending']">
          {{ r.status === 'done' ? '已处理' : '待处理' }}
        </span>
      </div>

      <div class="rm-nums">
        <span class="num-item bad">
          <span class="dot"></span>未录入 <b>{{ r.missing_total }}</b> 项
        </span>
        <span v-if="r.missing_gate" class="num-item gate">
          <span class="star">★</span>其中开工门槛（否决项） <b>{{ r.missing_gate }}</b> 项
        </span>
        <span class="num-time">
          <Icon name="clock" :size="13" /> {{ fmt(r.created_at) }}
          <template v-if="r.created_by_name"> · 提醒人 {{ r.created_by_name }}</template>
        </span>
      </div>

      <div v-if="r.message" class="rm-msg">{{ r.message }}</div>

      <!-- 缺项明细（可展开） -->
      <div class="rm-detail-toggle" @click="toggle(r.id)">
        <Icon :name="expanded[r.id] ? 'chevronLeft' : 'chevronRight'" :size="14" />
        {{ expanded[r.id] ? '收起' : '展开' }}缺项明细
      </div>
      <div v-if="expanded[r.id]" class="rm-detail">
        <div v-for="(group, gi) in groupDetail(r.missing_detail)" :key="gi" class="dg">
          <div class="dg-cat">{{ group.category }}</div>
          <div v-for="(it, ii) in group.items" :key="ii" class="dg-row" :class="{ gate: it.required_type === 'gate' }">
            <span class="star" v-if="it.required_type === 'gate'">★</span>
            <span class="dg-name">{{ it.item_name }}</span>
            <span v-if="it.freq" class="dg-freq">{{ it.freq }}</span>
            <span :class="['dg-tag', it.required_type === 'gate' ? 'gate' : 'dyn']">
              {{ it.required_type === 'gate' ? '开工门槛' : '动态维护' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 处理留痕 -->
      <div v-if="r.status === 'done'" class="rm-handled">
        <Icon name="check" :size="14" />
        {{ r.handled_by_name || '—' }} 于 {{ fmt(r.handled_at) }} 标记已补录
        <template v-if="r.handle_note"> · 备注：{{ r.handle_note }}</template>
        <button class="link-btn" @click="reopen(r)">撤回为待处理</button>
      </div>
      <div v-else class="rm-actions">
        <input v-model="noteOf[r.id]" class="note-input" placeholder="处理备注（可选）：已通知 XX 队补齐…" />
        <button class="btn btn-primary" :disabled="busyId === r.id" @click="markDone(r)">
          <Icon v-if="busyId === r.id" name="loop" :size="15" class="spin" />
          <Icon v-else name="check" :size="15" />
          标记已补录
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { request } from '@/utils/request'
import Icon from '@/components/Icon.vue'

const list = ref([])
const stats = ref({ pending: 0, done: 0 })
const statusFilter = ref('pending')
const loading = ref(false)
const errorMsg = ref('')
const expanded = reactive({})
const noteOf = reactive({})
const busyId = ref(null)

function fmt(x) {
  if (!x) return '—'
  const d = new Date(x)
  if (isNaN(d.getTime())) return String(x)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function showError(m) { errorMsg.value = m; setTimeout(() => { errorMsg.value = '' }, 4000) }
function toggle(id) { expanded[id] = !expanded[id] }
function setFilter(v) { statusFilter.value = v; load() }

// missing_detail 是 [{category,item_name,freq,required_type}]，按分类聚合展示
function groupDetail(detail) {
  const arr = Array.isArray(detail) ? detail : []
  const map = new Map()
  for (const it of arr) {
    const k = it.category || '其他'
    if (!map.has(k)) map.set(k, { category: k, items: [] })
    map.get(k).items.push(it)
  }
  return [...map.values()]
}

async function load() {
  loading.value = true
  try {
    const params = {}
    if (statusFilter.value) params.status = statusFilter.value
    const res = await request.get('/api/contractor-docs/reminders', { params })
    list.value = res.data.data || []
    if (res.data.stats) stats.value = res.data.stats
    // 默认展开第一条待处理的缺项，减少一次点击
    if (list.value.length && list.value[0].status === 'pending' && expanded[list.value[0].id] === undefined) {
      expanded[list.value[0].id] = true
    }
  } catch (e) {
    showError('加载失败：' + (e.response?.data?.error || e.message))
    list.value = []
  } finally {
    loading.value = false
  }
}

async function markDone(r) {
  busyId.value = r.id
  try {
    await request.patch(`/api/contractor-docs/reminders/${r.id}`, {
      status: 'done',
      note: noteOf[r.id] || '',
    })
    noteOf[r.id] = ''
    await load()
  } catch (e) {
    showError('处理失败：' + (e.response?.data?.error || e.message))
  } finally {
    busyId.value = null
  }
}

async function reopen(r) {
  if (!confirm('确认把这条提醒撤回为「待处理」？')) return
  try {
    await request.patch(`/api/contractor-docs/reminders/${r.id}`, { status: 'pending' })
    await load()
  } catch (e) {
    showError('撤回失败：' + (e.response?.data?.error || e.message))
  }
}

onMounted(load)
</script>

<style scoped>
.dr-page { display: flex; flex-direction: column; gap: 14px; max-width: 1080px; }

.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 18px; box-shadow: var(--shadow-sm); }

.head-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; background: linear-gradient(135deg, #fff 0%, #fff5f5 100%); border-color: #f2d5d5; }
.head-info h2 { font-size: 18px; font-weight: 800; color: var(--c-text); }
.head-sub { font-size: 12.5px; color: var(--c-text-2); margin-top: 6px; line-height: 1.6; max-width: 620px; }
.head-stats { display: flex; gap: 12px; }
.hs-item { min-width: 92px; text-align: center; border-radius: var(--r); padding: 12px 16px; border: 1px solid var(--c-border); }
.hs-item.pending { background: #fff4f3; border-color: #f6cdc9; }
.hs-item.done { background: var(--c-success-bg); border-color: #c8e6d4; }
.hs-n { display: block; font-size: 24px; font-weight: 800; line-height: 1.1; }
.hs-item.pending .hs-n { color: #c0392b; }
.hs-item.done .hs-n { color: var(--c-success); }
.hs-l { font-size: 12px; color: var(--c-text-2); }

.filter-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; gap: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; }
.tab { border: 1px solid var(--c-border-strong); background: var(--c-surface); padding: 7px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; color: var(--c-text-2); cursor: pointer; transition: all .15s; }
.tab:hover { border-color: var(--c-blue-600); color: var(--c-blue-600); }
.tab.on { background: var(--c-blue-600); border-color: var(--c-blue-600); color: #fff; }

.btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: var(--r); font-size: 13.5px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
/* 全局 .btn 带 width:100%，这里必须收回自适应宽度，否则筛选栏「刷新」会独占一行 */
.filter-bar .btn, .rm-actions .btn { width: auto; flex: 0 0 auto; }
.btn:disabled { opacity: .55; cursor: default; }
.btn-primary { background: var(--c-blue-600); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--c-blue-700); }
.btn-outline { background: var(--c-surface); border-color: var(--c-border-strong); color: var(--c-text-2); }
.btn-outline:hover:not(:disabled) { border-color: var(--c-blue-600); color: var(--c-blue-600); }

.error-toast { background: var(--c-danger-bg); color: var(--c-danger); padding: 10px 14px; border-radius: var(--r); font-size: 13.5px; }
.empty-card { text-align: center; color: var(--c-text-3); font-size: 13.5px; padding: 44px 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; }

.rm-card { border-left: 4px solid #e8890c; }
.rm-card.done { border-left-color: var(--c-success); opacity: .92; }
.rm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.rm-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rm-unit { font-size: 13px; font-weight: 700; color: #b45309; }
.rm-proj { font-size: 14.5px; font-weight: 700; color: var(--c-text); line-height: 1.5; }
.badge { flex-shrink: 0; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 20px; }
.badge-pending { background: #fde8e8; color: #c0392b; }
.badge-done { background: var(--c-success-bg); color: var(--c-success); }

.rm-nums { display: flex; align-items: center; gap: 16px; margin-top: 10px; flex-wrap: wrap; }
.num-item { font-size: 13px; color: var(--c-text-2); display: inline-flex; align-items: center; gap: 5px; }
.num-item b { font-size: 16px; }
.num-item.bad b { color: #c0392b; }
.num-item.gate { color: #c0392b; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #e8890c; display: inline-block; }
.star { color: #e0342b; font-weight: 900; }
.num-time { font-size: 12px; color: var(--c-text-3); display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }

.rm-msg { margin-top: 10px; font-size: 13px; color: var(--c-text-2); background: var(--c-surface-2); padding: 9px 12px; border-radius: var(--r-sm); line-height: 1.6; }

.rm-detail-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--c-blue-600); cursor: pointer; margin-top: 10px; font-weight: 600; user-select: none; }
.rm-detail-toggle:hover { text-decoration: underline; }
.rm-detail { margin-top: 8px; border: 1px dashed var(--c-border-strong); border-radius: var(--r); padding: 10px 12px; max-height: 300px; overflow-y: auto; }
.dg { margin-bottom: 10px; }
.dg:last-child { margin-bottom: 0; }
.dg-cat { font-size: 12.5px; font-weight: 700; color: var(--c-blue-700); margin-bottom: 5px; }
.dg-row { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 9px; border-radius: var(--r-sm); background: #f6f8fb; margin-bottom: 4px; }
.dg-row.gate { background: #fff4f3; border-left: 3px solid #e0342b; }
.dg-name { flex: 1; min-width: 0; color: var(--c-text); }
.dg-row.gate .dg-name { font-weight: 700; color: #b02a22; }
.dg-freq { font-size: 11px; color: var(--c-text-3); flex-shrink: 0; }
.dg-tag { font-size: 11px; padding: 2px 7px; border-radius: 20px; font-weight: 600; flex-shrink: 0; }
.dg-tag.gate { background: #fde8e8; color: #c0392b; }
.dg-tag.dyn { background: #e8f1fd; color: #2563eb; }

.rm-handled { margin-top: 12px; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--c-success); background: var(--c-success-bg); padding: 9px 12px; border-radius: var(--r-sm); flex-wrap: wrap; }
.rm-handled svg { flex-shrink: 0; }
.link-btn { margin-left: auto; background: none; border: none; color: var(--c-text-2); font-size: 12.5px; cursor: pointer; text-decoration: underline; }
.link-btn:hover { color: var(--c-blue-600); }

.rm-actions { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.note-input { flex: 1; min-width: 240px; padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r); font-size: 13.5px; font-family: var(--font-sans); background-color: var(--c-surface); color: var(--c-text); }
.note-input:focus { outline: none; border-color: var(--c-blue-600); box-shadow: 0 0 0 3px rgba(29,111,184,.15); }

.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
</style>
