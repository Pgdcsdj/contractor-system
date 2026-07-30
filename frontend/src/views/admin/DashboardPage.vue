<template>
  <div class="dashboard">
    <!-- 统计卡片 -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-icon icon-blue"><Icon name="users" :size="24" /></span>
        <div class="stat-info">
          <div class="stat-value">{{ stats.totalUsers }}</div>
          <div class="stat-label">培训人员</div>
        </div>
      </div>
      <div class="stat-card">
        <span class="stat-icon icon-green"><Icon name="check" :size="24" /></span>
        <div class="stat-info">
          <div class="stat-value">{{ stats.totalCompleted }}</div>
          <div class="stat-label">已完成答题</div>
        </div>
      </div>
      <div class="stat-card">
        <span class="stat-icon icon-amber"><Icon name="book" :size="24" /></span>
        <div class="stat-info">
          <div class="stat-value">{{ stats.totalTrainings }}</div>
          <div class="stat-label">发布培训</div>
        </div>
      </div>
      <div class="stat-card">
        <span class="stat-icon icon-red"><Icon name="alert" :size="24" /></span>
        <div class="stat-info">
          <div class="stat-value">{{ stats.todayIncomplete }}</div>
          <div class="stat-label">今日未完成</div>
        </div>
      </div>
    </div>

    <!-- 完成率 & 通过率 -->
    <div class="row-2">
      <div class="card chart-card">
        <h3 class="card-title">今日完成率</h3>
        <div class="rate-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--c-border)" stroke-width="10" />
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--c-blue-600)" stroke-width="10"
              stroke-linecap="round" :stroke-dasharray="rateCircumference"
              :stroke-dashoffset="completionOffset" transform="rotate(-90 50 50)"
              style="transition: stroke-dashoffset 1s ease" />
          </svg>
          <div class="rate-text">
            <span class="rate-num">{{ stats.completionRate }}</span>
            <span class="rate-pct">%</span>
          </div>
        </div>
        <div class="rate-detail">已完成 {{ stats.todayCompleted }} / 应答 {{ stats.todayTotal }}</div>
      </div>

      <div class="card chart-card">
        <h3 class="card-title">今日通过率</h3>
        <div class="rate-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--c-border)" stroke-width="10" />
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--c-success)" stroke-width="10"
              stroke-linecap="round" :stroke-dasharray="rateCircumference"
              :stroke-dashoffset="passOffset" transform="rotate(-90 50 50)"
              style="transition: stroke-dashoffset 1s ease" />
          </svg>
          <div class="rate-text">
            <span class="rate-num">{{ stats.passRate }}</span>
            <span class="rate-pct">%</span>
          </div>
        </div>
        <div class="rate-detail">通过 {{ stats.todayPassed }} / 已答 {{ stats.todayCompleted }}</div>
      </div>
    </div>

    <!-- 快捷操作 -->
    <div class="card quick-actions">
      <h3 class="card-title">快捷操作</h3>
      <div class="action-btns">
        <router-link to="/admin/contractor-units" class="action-btn">
          <Icon name="building" :size="18" />承包商单位
        </router-link>
        <router-link to="/admin/hazard-report" class="action-btn">
          <Icon name="hazard" :size="18" />隐患录入
        </router-link>
        <router-link to="/admin/hazard-loop" class="action-btn">
          <Icon name="loop" :size="18" />隐患闭环
        </router-link>
        <router-link to="/admin/categories" class="action-btn">
          <Icon name="tag" :size="18" />分类管理
        </router-link>
      </div>
    </div>

    <!-- 未完成名单 -->
    <div class="card">
      <h3 class="card-title">今日未完成人员</h3>
      <div v-if="incompleteUsers.length === 0" class="empty-row">
        <Icon name="check" :size="18" /> 全部完成！
      </div>
      <table v-else class="data-table">
        <thead>
          <tr><th>姓名</th><th>单位</th><th>手机</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in incompleteUsers" :key="u.id">
            <td>{{ u.name }}</td>
            <td>{{ u.unit }}</td>
            <td class="mono">{{ u.phone }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { request } from '@/utils/request'
import Icon from '@/components/Icon.vue'

const stats = ref({
  totalUsers: 0, totalCompleted: 0, totalTrainings: 0,
  todayIncomplete: 0, todayCompleted: 0, todayTotal: 0,
  todayPassed: 0, completionRate: 0, passRate: 0,
})
const incompleteUsers = ref([])

const rateCircumference = 2 * Math.PI * 40
const completionOffset = computed(() => rateCircumference - (stats.value.completionRate / 100) * rateCircumference)
const passOffset = computed(() => rateCircumference - (stats.value.passRate / 100) * rateCircumference)

onMounted(async () => {
  try {
    const [summary, incomplete] = await Promise.all([
      request.get('/api/record/summary'),
      request.get('/api/record/incomplete'),
    ])
    stats.value = summary.data
    incompleteUsers.value = incomplete.data?.list || []
  } catch (e) {
    console.error('[Dashboard] 数据加载失败', e)
  }
})
</script>

<style scoped>
.dashboard { max-width: 1120px; }

.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
.stat-card {
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg);
  padding: 20px; display: flex; align-items: center; gap: 16px; box-shadow: var(--shadow-sm);
  transition: transform .18s ease, box-shadow .18s ease;
}
.stat-card:hover { transform: translateY(-3px); box-shadow: var(--shadow); }
.stat-icon { width: 50px; height: 50px; border-radius: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.icon-blue { background: var(--c-blue-50); color: var(--c-blue-700); }
.icon-green { background: var(--c-success-bg); color: var(--c-success); }
.icon-amber { background: var(--c-warning-bg); color: var(--c-warning); }
.icon-red { background: var(--c-danger-bg); color: var(--c-danger); }
.stat-value { font-size: 27px; font-weight: 700; color: var(--c-text); line-height: 1.1; }
.stat-label { font-size: 13px; color: var(--c-text-2); margin-top: 3px; }

.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.chart-card { text-align: center; }
.card-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; color: var(--c-text); }

.rate-ring { position: relative; width: 124px; height: 124px; margin: 0 auto 12px; }
.rate-ring svg { width: 100%; height: 100%; }
.rate-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 1px; }
.rate-num { font-size: 30px; font-weight: 700; color: var(--c-text); }
.rate-pct { font-size: 14px; color: var(--c-text-2); }
.rate-detail { font-size: 13px; color: var(--c-text-2); }

.quick-actions { margin-bottom: 16px; }
.action-btns { display: flex; gap: 12px; flex-wrap: wrap; }
.action-btn {
  display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px;
  background: var(--c-surface-2); border: 1px solid var(--c-border); border-radius: var(--r);
  font-size: 14px; font-weight: 500; color: var(--c-text); text-decoration: none;
  transition: border-color .16s ease, color .16s ease, background .16s ease;
}
.action-btn:hover { border-color: var(--c-blue-600); color: var(--c-blue-700); background: var(--c-blue-50); }

.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th { text-align: left; padding: 10px 14px; background: var(--c-surface-2); color: var(--c-text-2); font-weight: 600; font-size: 12.5px; border-bottom: 1px solid var(--c-border); }
.data-table td { padding: 11px 14px; border-top: 1px solid var(--c-border); }
.empty-row { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--c-success); padding: 22px; font-weight: 500; }

@media (max-width: 900px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .row-2 { grid-template-columns: 1fr; }
}
</style>
