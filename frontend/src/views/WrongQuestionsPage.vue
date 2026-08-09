<template>
  <div class="wrong-page">
    <div class="page-header">
      <button class="back-btn" @click="$router.push('/quiz')">←</button>
      <h1>❌ 错题库</h1>
      <span class="count-tag" v-if="!loading">{{ total }} 道</span>
    </div>

    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中…</span>
    </div>

    <template v-else>
      <!-- 空状态：完全无错题 -->
      <div v-if="list.length === 0" class="empty-state">
        <div class="icon">🎉</div>
        <p>暂无错题</p>
        <p class="hint">学习和练习中答错的题会自动记录到这里，方便重点复习</p>
      </div>

      <div v-else>
        <!-- ① 统计概览 -->
        <div class="stats card">
          <div class="stat"><div class="num">{{ total }}</div><div class="lbl">总错题</div></div>
          <div class="stat"><div class="num">{{ typeCount.single }}</div><div class="lbl">单选</div></div>
          <div class="stat"><div class="num">{{ typeCount.multiple }}</div><div class="lbl">多选</div></div>
          <div class="stat"><div class="num">{{ typeCount.judgment }}</div><div class="lbl">判断</div></div>
          <div class="stat high"><div class="num">{{ highFreq }}</div><div class="lbl">高频≥3次</div></div>
        </div>

        <!-- ② 操作栏：错题练习 / 批量已掌握 -->
        <div class="toolbar">
          <button class="btn-practice" @click="startPractice(false)">▶ 开始错题练习</button>
          <button class="btn-practice ghost" :disabled="!hasFilter" @click="startPractice(true)">▶ 练习筛选结果</button>
          <button class="btn-batch" :disabled="!selectedIds.size" @click="batchMaster">
            标记已掌握 ({{ selectedIds.size }})
          </button>
        </div>

        <!-- ③ 筛选 -->
        <div class="filters">
          <select v-model="selType" class="filter-select">
            <option value="">全部题型</option>
            <option value="single">单选题</option>
            <option value="multiple">多选题</option>
            <option value="judgment">判断题</option>
          </select>
          <select v-model="selMinWrong" class="filter-select">
            <option value="">错次不限</option>
            <option value="2">错≥2次</option>
            <option value="3">错≥3次</option>
          </select>
          <select v-model="selMaterial" class="filter-select">
            <option value="">全部题库</option>
            <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.title }}</option>
          </select>
        </div>

        <!-- ④ 列表（按题库分组） -->
        <div v-if="sorted.length > 0" class="group-list">
          <section v-for="g in grouped" :key="g.materialId" class="group card">
            <div class="group-head">
              {{ g.materialTitle }}
              <span class="grp-count">{{ g.items.length }}</span>
            </div>
            <div
              v-for="q in g.items"
              :key="q.id"
              class="wrong-card"
              :class="{ starred: q.starred }"
            >
              <div class="q-head">
                <input
                  type="checkbox"
                  class="sel-box"
                  :checked="selectedIds.has(q.id)"
                  @change="toggleSelect(q)"
                />
                <span class="type-tag" :class="'type-' + q.type">{{ typeLabel(q.type) }}</span>
                <span class="wrong-times" v-if="q.wrongTimes > 1">错 {{ q.wrongTimes }} 次</span>
                <button
                  class="star-btn"
                  :class="{ on: q.starred }"
                  @click="toggleStar(q)"
                  :title="q.starred ? '取消重点标记' : '标记为重点'"
                >{{ q.starred ? '★' : '☆' }}</button>
              </div>
              <div class="q-body" @click="toggle(q)">{{ q.question }}</div>

              <!-- 展开：正确答案 + 解析 -->
              <div v-if="expanded.has(q.id)" class="q-detail">
                <div v-if="q.type === 'single' || q.type === 'multiple'" class="options">
                  <div
                    v-for="(val, key) in q.options"
                    :key="key"
                    :class="['opt', isCorrectOpt(q, key) ? 'opt-correct' : '']"
                  >
                    {{ key }}. {{ val }}
                    <span v-if="isCorrectOpt(q, key)" class="mark">✓ 正确答案</span>
                  </div>
                </div>
                <div v-else-if="q.type === 'judgment'" class="judgment-ans">
                  正确答案：<b :class="q.correctAnswer === '正确' ? 'ok' : 'no'">{{ q.correctAnswer }}</b>
                </div>
                <div v-if="q.analysis" class="analysis">📖 解析：{{ q.analysis }}</div>
                <button class="btn-master" @click.stop="markMastered(q)">✅ 标记已掌握</button>
              </div>
            </div>
          </section>
        </div>

        <!-- 筛选无结果 -->
        <div v-else class="empty-state">
          <div class="icon">🔍</div>
          <p>当前筛选条件下没有错题</p>
          <p class="hint">试试放宽筛选条件</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { request } from '@/utils/request'

const router = useRouter()
const loading = ref(true)
const list = ref([])
const expanded = ref(new Set())
const selectedIds = ref(new Set())

// 筛选条件
const selType = ref('')
const selMinWrong = ref('')
const selMaterial = ref('')

const TYPE_MAP = { single: '单选', multiple: '多选', judgment: '判断', essay: '简答' }
function typeLabel(t) { return TYPE_MAP[t] || '题' }

const total = computed(() => list.value.length)
// 按题型统计（基于全量，不随筛选变化）
const typeCount = computed(() => {
  const c = { single: 0, multiple: 0, judgment: 0 }
  for (const q of list.value) if (c[q.type] !== undefined) c[q.type]++
  return c
})
// 高频错题（错≥3次）
const highFreq = computed(() => list.value.filter(q => q.wrongTimes >= 3).length)

// 筛选后的列表
const filtered = computed(() => {
  return list.value.filter(q => {
    if (selType.value && q.type !== selType.value) return false
    if (selMinWrong.value && q.wrongTimes < Number(selMinWrong.value)) return false
    if (selMaterial.value && String(q.materialId) !== String(selMaterial.value)) return false
    return true
  })
})
// 重点标记置顶 + 最近答错在前
const sorted = computed(() => {
  return [...filtered.value].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1
    return new Date(b.lastWrongAt) - new Date(a.lastWrongAt)
  })
})
// 按题库分组
const grouped = computed(() => {
  const map = new Map()
  for (const q of sorted.value) {
    if (!map.has(q.materialId)) {
      map.set(q.materialId, { materialId: q.materialId, materialTitle: q.materialTitle, items: [] })
    }
    map.get(q.materialId).items.push(q)
  }
  return [...map.values()]
})
// 题库下拉选项
const materials = computed(() => {
  const m = new Map()
  for (const q of list.value) m.set(q.materialId, q.materialTitle)
  return [...m.entries()].map(([id, title]) => ({ id, title }))
})
const hasFilter = computed(() => !!(selType.value || selMinWrong.value || selMaterial.value))

function toggle(q) {
  const s = new Set(expanded.value)
  s.has(q.id) ? s.delete(q.id) : s.add(q.id)
  expanded.value = s
}

function isCorrectOpt(q, key) {
  const ans = String(q.correctAnswer || '').toUpperCase()
  if (q.type === 'judgment') return false
  return ans.includes(String(key).toUpperCase())
}

// 单题标记已掌握（移出错题库）
async function markMastered(q) {
  try {
    await request.delete(`/api/quiz/wrong-questions/${q.id}`)
    list.value = list.value.filter(x => x.id !== q.id)
    const s = new Set(expanded.value)
    s.delete(q.id)
    expanded.value = s
  } catch (e) {
    alert('操作失败：' + (e.response?.data?.error || e.message))
  }
}

// 重点标记★切换
async function toggleStar(q) {
  try {
    const next = !q.starred
    await request.patch(`/api/quiz/wrong-questions/${q.id}/star`, { starred: next ? 1 : 0 })
    q.starred = next
  } catch (e) {
    alert('标记失败：' + (e.response?.data?.error || e.message))
  }
}

function toggleSelect(q) {
  const s = new Set(selectedIds.value)
  s.has(q.id) ? s.delete(q.id) : s.add(q.id)
  selectedIds.value = s
}

// 批量标记已掌握
async function batchMaster() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  if (!confirm(`确认将选中的 ${ids.length} 道错题标记为已掌握？`)) return
  for (const id of ids) {
    try { await request.delete(`/api/quiz/wrong-questions/${id}`) } catch (e) { console.warn(e) }
  }
  list.value = list.value.filter(x => !selectedIds.value.has(x.id))
  selectedIds.value = new Set()
}

// 开始错题练习：useFilter=true 时带当前筛选条件
function startPractice(useFilter) {
  const q = { mode: 'practice' }
  if (useFilter) {
    if (selType.value) q.type = selType.value
    if (selMinWrong.value) q.minWrong = selMinWrong.value
    if (selMaterial.value) q.materialId = selMaterial.value
  }
  router.push({ path: '/quiz/wrong', query: q })
}

onMounted(async () => {
  try {
    const res = await request.get('/api/quiz/wrong-questions')
    list.value = res.data?.data || []
  } catch (err) {
    console.error('[WrongQuestionsPage] 加载失败', err)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.page-header { justify-content: space-between; }
.count-tag { font-size: 13px; color: var(--danger, #dc2626); font-weight: 700; margin-left: auto; }

/* ① 统计概览 */
.stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin: 12px 12px 0;
  padding: 14px 10px;
  text-align: center;
}
.stat .num { font-size: 22px; font-weight: 800; color: var(--primary, #1D6FB8); line-height: 1.1; }
.stat .lbl { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.stat.high .num { color: var(--danger, #dc2626); }

/* ② 操作栏 */
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px;
}
.btn-practice {
  flex: 1;
  min-width: 120px;
  padding: 11px 10px;
  border-radius: 10px;
  border: none;
  background: var(--primary, #1D6FB8);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
}
.btn-practice.ghost { background: #fff; color: var(--primary, #1D6FB8); border: 1px solid var(--primary, #1D6FB8); }
.btn-practice:disabled { opacity: .45; cursor: not-allowed; }
.btn-batch {
  flex: 1;
  min-width: 120px;
  padding: 11px 10px;
  border-radius: 10px;
  border: 1px solid #a3d9b1;
  background: #e6f4ea;
  color: #166534;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.btn-batch:disabled { opacity: .45; cursor: not-allowed; }

/* ③ 筛选 */
.filters { display: flex; gap: 8px; padding: 0 12px 8px; }
.filter-select {
  flex: 1;
  padding: 8px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
  font-size: 13px;
  color: var(--text-primary);
}

/* ④ 列表 */
.group-list { padding: 8px 12px 24px; display: flex; flex-direction: column; gap: 14px; }
.group { padding: 12px; }
.group-head {
  font-size: 15px; font-weight: 700; margin-bottom: 10px;
  padding-bottom: 8px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.grp-count {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  background: var(--bg); border-radius: 999px; padding: 1px 8px;
}
.wrong-card {
  border: 1px solid #fbd5d5; background: #fff7f7;
  border-radius: 10px; padding: 12px; margin-bottom: 10px;
}
.wrong-card.starred { border-color: #f0c14b; background: #fffdf3; }
.wrong-card:last-child { margin-bottom: 0; }
.q-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sel-box { width: 18px; height: 18px; flex-shrink: 0; cursor: pointer; }
.type-tag {
  font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px;
}
.type-single { background: #EAF3FB; color: #155A96; }
.type-multiple { background: #FBF1E0; color: #C2740B; }
.type-judgment { background: #EDE9FE; color: #6D28D9; }
.type-essay { background: #E7F6EC; color: #166534; }
.wrong-times { font-size: 11px; color: var(--danger, #dc2626); font-weight: 600; }
.star-btn {
  margin-left: auto;
  background: none; border: none; cursor: pointer;
  font-size: 18px; line-height: 1; color: #cbb26a;
}
.star-btn.on { color: #f0a500; }
.q-body { font-size: 14px; line-height: 1.6; color: #0f172a; cursor: pointer; }
.q-detail { margin-top: 10px; border-top: 1px dashed #f1c4c4; padding-top: 10px; }
.options { display: flex; flex-direction: column; gap: 6px; }
.opt {
  font-size: 13px; padding: 8px 10px; border-radius: 8px;
  background: #fff; border: 1px solid var(--border);
}
.opt-correct { background: #e6f4ea; border-color: #a3d9b1; color: #166534; }
.mark { font-size: 11px; margin-left: 6px; font-weight: 700; }
.judgment-ans { font-size: 14px; }
.judgment-ans .ok { color: #166534; }
.judgment-ans .no { color: #dc2626; }
.analysis { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-top: 8px; }
.btn-master {
  margin-top: 10px; width: 100%;
  padding: 8px; border-radius: 8px; border: 1px solid #a3d9b1;
  background: #e6f4ea; color: #166534; font-weight: 600; cursor: pointer; font-size: 13px;
}
.loading, .empty-state { padding: 60px 20px; text-align: center; color: var(--text-secondary); }
.empty-state .icon { font-size: 44px; margin-bottom: 10px; }
.hint { font-size: 12px; margin-top: 6px; }
</style>
