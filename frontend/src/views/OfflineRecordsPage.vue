<template>
  <div>
    <div class="page-header">
      <button class="back-btn" @click="$router.back()">←</button>
      <h1>离线记录</h1>
    </div>

    <!-- 全部已上传 -->
    <div v-if="records.length === 0" class="empty-state">
      <div class="icon">☁️</div>
      <p>暂无离线记录</p>
    </div>

    <div v-else>
      <div class="sync-status card">
        <div class="sync-row">
          <span>待上传</span>
          <span class="badge badge-warning">{{ records.length }} 条</span>
        </div>
        <button class="btn btn-primary" @click="syncAll" :disabled="syncing || !isOnline">
          {{ syncing ? '上传中…' : isOnline ? '全部上传' : '网络不可用' }}
        </button>
      </div>

      <div
        v-for="record in records"
        :key="record.id"
        class="record-item card"
      >
        <div class="record-header">
          <span class="record-title">{{ record.trainingTitle || '培训 #' + record.trainingId }}</span>
          <span class="badge" :class="record.synced ? 'badge-success' : 'badge-warning'">
            {{ record.synced ? '已上传' : '待上传' }}
          </span>
        </div>
        <div class="record-meta">
          <span>📅 {{ formatTime(record.createdAt) }}</span>
          <span>📱 {{ record.deviceId }}</span>
        </div>
        <div class="record-hash">{{ record.answerHash }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
// offlineDb 动态加载

const records = ref([])
const syncing = ref(false)
const isOnline = ref(navigator.onLine)

onMounted(async () => {
  try {
    const { offlineDb } = await import('@/utils/offlineDb')
    records.value = await offlineDb.getPendingRecords()
  } catch { records.value = [] }
})

async function syncAll() {
  syncing.value = true
  try {
    const { offlineDb } = await import('@/utils/offlineDb')
    await offlineDb.syncPendingRecords()
    records.value = await offlineDb.getPendingRecords()
  } catch { alert('同步失败，离线功能可能被浏览器限制') }
  syncing.value = false
}

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth()+1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`
}
</script>

<style scoped>
.page-header { justify-content: center; gap: 16px; }
.page-header h1 { font-size: 18px; }
.back-btn {
  position: absolute;
  left: 14px;
  background: rgba(255,255,255,0.2);
  border: none;
  color: #fff;
  width: 34px; height: 34px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  font-size: 16px;
}

.sync-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px;
}
.sync-row { display: flex; align-items: center; gap: 8px; }

.record-item { margin: 0 12px 10px; }
.record-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.record-title { font-weight: 600; font-size: 15px; }
.record-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.record-hash {
  font-size: 10px;
  font-family: monospace;
  color: var(--text-secondary);
  word-break: break-all;
  background: #f5f5f5;
  padding: 4px 8px;
  border-radius: 4px;
}
</style>
