<template>
  <div>
    <div class="page-header">
      <button class="back-btn" @click="$router.push('/login')">←</button>
      <h1>我的培训</h1>
      <span class="user-name">{{ auth.user?.name }}</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中…</span>
    </div>

    <!-- 无培训 -->
    <div v-else-if="materials.length === 0" class="empty-state">
      <div class="icon">📋</div>
      <p>暂无培训</p>
      <p class="hint">有新培训发布后会显示在这里</p>
    </div>

    <!-- 培训列表（每个题库一张卡片，含 学习/练习/考试 三个入口） -->
    <div v-else class="material-list">
      <section
        v-for="m in materials"
        :key="m.trainingId"
        class="material-card card"
      >
        <div class="card-head">
          <span class="material-title">{{ m.title }}</span>
          <span v-if="m.completed" class="done-tag">已作答</span>
        </div>

        <div class="card-meta">
          <span>📝 {{ m.totalQuestions || '?' }} 题</span>
          <span>⏱ 限时 {{ m.timeLimit }} 分钟</span>
          <span>🎯 及格 {{ m.passScore }}%</span>
        </div>

        <!-- 三个模式入口：学习 / 练习 / 考试 -->
        <div class="mode-btns">
          <button
            v-for="modeKey in MODE_ORDER"
            :key="modeKey"
            class="btn btn-mode"
            :class="['mode-' + modeKey, hasInProgress(m.trainingId, modeKey) ? 'has-progress' : '']"
            @click="goMode(m, modeKey)"
          >
            <span class="mode-name">{{ hasInProgress(m.trainingId, modeKey) ? '继续作答' : MODE_LABELS[modeKey] }}</span>
            <span v-if="m.mode === modeKey" class="default-tag">默认</span>
          </button>
        </div>

        <!-- 已完成：分数 + 回顾 -->
        <div v-if="m.completed" class="card-footer">
          <span :class="['score-mini', m.passed ? 'pass' : 'fail']">{{ m.score }} / {{ m.maxScore }}</span>
          <button class="btn btn-outline btn-sm" @click="goReview(m)">查看回顾</button>
        </div>
      </section>

      <!-- 离线待上传记录 -->
      <div
        v-if="pendingCount > 0"
        class="pending-card card"
        @click="$router.push('/offline-records')"
      >
        <span class="pending-icon">📤</span>
        <div>
          <p class="pending-title">离线答题记录</p>
          <p class="pending-desc">有 {{ pendingCount }} 条记录待上传至服务器</p>
        </div>
        <span class="pending-arrow">›</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useQuizStore } from '@/stores/quiz'
import { MODE_LABELS, MODE_ORDER } from '@/utils/quizModes'
import { listInProgress } from '@/utils/progressStorage'

const auth = useAuthStore()
const quizStore = useQuizStore()
const router = useRouter()

const materials = ref([])
const loading = ref(true)
const pendingCount = ref(0)
// 存在断点进度的 (materialId_mode) 集合，供"继续作答"判断
const progressSet = ref(new Set())

function hasInProgress(materialId, mode) {
  return progressSet.value.has(`${materialId}_${mode}`)
}

onMounted(async () => {
  try {
    const list = await quizStore.fetchQuizList()
    materials.value = list || []
    // 构建断点进度索引
    const set = new Set()
    for (const p of listInProgress()) {
      set.add(`${p.materialId}_${p.mode}`)
    }
    progressSet.value = set
  } catch (err) {
    console.error('[QuizListPage] 加载培训列表失败', err)
  }
  try {
    const { offlineDb } = await import('@/utils/offlineDb')
    const pending = await offlineDb.getPendingRecords()
    pendingCount.value = pending.length
  } catch {
    pendingCount.value = 0
  }
  loading.value = false
})

// 进入指定模式的答题（运行模式严格由 ?mode= 决定；QuizPage 挂载时按 materialId+mode 续做）
function goMode(m, modeKey) {
  router.push(`/quiz/${m.trainingId}?mode=${modeKey}`)
}

// 查看回顾（回顾页按 t_record.mode 还原）
function goReview(m) {
  router.push(`/result/${m.trainingId}`)
}
</script>

<style scoped>
.page-header { justify-content: space-between; }
.user-name { font-size: 13px; opacity: 0.8; margin-left: auto; }

/* 物料卡片列表 */
.material-list { padding: 8px 12px 20px; display: flex; flex-direction: column; gap: 12px; }

.material-card { cursor: default; padding: 16px; }
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.material-title {
  font-size: 15px;
  font-weight: 600;
  flex: 1;
  line-height: 1.4;
}
.done-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: 999px;
  background: #e8f5e9;
  color: #2e7d32;
  flex-shrink: 0;
}

.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

/* 三个模式入口按钮 */
.mode-btns { display: flex; gap: 8px; }
.btn-mode {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 4px;
  width: auto;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid transparent;
  transition: filter 0.15s, transform 0.15s;
}
.btn-mode:active { transform: translateY(1px); }
.btn-mode.has-progress { box-shadow: 0 0 0 2px rgba(26,115,232,0.25) inset; }

.mode-study   { background: #EAF3FB; color: #155A96; border-color: #BFE0F5; }
.mode-practice{ background: #FBF1E0; color: #C2740B; border-color: #F3DDAE; }
.mode-exam    { background: #FCE9E9; color: #DC2626; border-color: #F6C9C9; }

.mode-name { line-height: 1.2; }
.default-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(0,0,0,0.06);
  color: inherit;
  opacity: 0.85;
}

/* 已完成底部 */
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  gap: 10px;
}
.score-mini { font-size: 15px; font-weight: 700; }
.score-mini.pass { color: var(--c-success, #16A34A); }
.score-mini.fail { color: var(--c-danger, #DC2626); }
.btn-sm { padding: 6px 12px; font-size: 12px; width: auto; }

.hint { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }

/* 离线待上传 */
.pending-card {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  background: #fffbe6;
  border: 1px solid var(--warning);
  margin: 8px 12px 16px;
}
.pending-icon { font-size: 28px; }
.pending-title { font-weight: 600; font-size: 15px; }
.pending-desc { font-size: 12px; color: var(--text-secondary); }
.pending-arrow { font-size: 24px; color: var(--text-secondary); margin-left: auto; }
</style>
