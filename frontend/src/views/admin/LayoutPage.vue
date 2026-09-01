<template>
  <div class="admin-layout">
    <!-- 侧边栏 -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span class="brand-mark">
          <span class="brand-char">通</span>
        </span>
        <span v-if="!sidebarCollapsed" class="logo-text">通南巴承包商系统</span>
      </div>

      <nav class="sidebar-nav">
        <!-- 分组一：承包商人员培训 -->
        <div v-if="!sidebarCollapsed" class="nav-group-title">承包商人员培训</div>
        <router-link to="/admin/dashboard" class="nav-item">
          <Icon name="dashboard" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">培训看板</span>
        </router-link>
        <router-link to="/admin/users" class="nav-item">
          <Icon name="users" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">人员管理</span>
        </router-link>
        <router-link to="/admin/trainings" class="nav-item">
          <Icon name="book" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">题库管理</span>
        </router-link>
        <router-link to="/admin/records" class="nav-item">
          <Icon name="clipboard" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">答题记录</span>
        </router-link>
        <router-link to="/admin/categories" class="nav-item">
          <Icon name="tag" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">培训分类管理</span>
        </router-link>
        <router-link to="/admin/contractor-units" class="nav-item">
          <Icon name="building" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">承包商单位</span>
        </router-link>

        <!-- 分组二：隐患整改 -->
        <div v-if="!sidebarCollapsed" class="nav-group-title">隐患整改</div>
        <router-link to="/admin/hazard-monitor" class="nav-item">
          <Icon name="trending" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">监控看板</span>
        </router-link>
        <router-link to="/admin/hazard-report" class="nav-item">
          <Icon name="hazard" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">隐患录入</span>
        </router-link>
        <router-link to="/admin/hazard-loop" class="nav-item">
          <Icon name="loop" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">隐患闭环</span>
        </router-link>
        <router-link to="/admin/hazard-settings" class="nav-item">
          <Icon name="settings" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">隐患模块设置</span>
        </router-link>
        <router-link to="/admin/standard-basis" class="nav-item">
          <Icon name="book" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">问题依据库</span>
        </router-link>
        <router-link to="/admin/data" class="nav-item">
          <Icon name="inbox" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">数据管理</span>
        </router-link>

        <!-- 分组三：开工资料 -->
        <div v-if="!sidebarCollapsed" class="nav-group-title">开工资料</div>
        <router-link to="/admin/contractor-docs" class="nav-item">
          <Icon name="building" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">承包商开工资料</span>
        </router-link>

        <router-link to="/admin/accounts" class="nav-item">
          <Icon name="users" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">账号管理</span>
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <button class="nav-item logout-btn" @click="handleLogout">
          <Icon name="logout" :size="20" class="nav-icon" />
          <span v-if="!sidebarCollapsed" class="nav-label">退出登录</span>
        </button>
        <button class="collapse-btn" @click="sidebarCollapsed = !sidebarCollapsed" :title="sidebarCollapsed ? '展开' : '收起'">
          <Icon :name="sidebarCollapsed ? 'chevronRight' : 'chevronLeft'" :size="18" />
        </button>
      </div>
    </aside>

    <!-- 主内容区 -->
    <div class="main-area">
      <!-- 顶部栏 -->
      <header class="topbar">
        <div class="topbar-left">
          <button class="mobile-menu-btn" @click="sidebarCollapsed = !sidebarCollapsed" aria-label="菜单">
            <Icon name="menu" :size="20" />
          </button>
          <span class="page-title">{{ currentTitle }}</span>
        </div>
        <div class="topbar-right">
          <div class="admin-chip">
            <span class="admin-avatar">{{ adminInitial }}</span>
            <div class="admin-meta">
              <span class="admin-name">{{ admin.user?.username || '管理员' }}</span>
              <span class="today">{{ todayStr }}</span>
            </div>
          </div>
        </div>
      </header>

      <!-- 页面内容 -->
      <main class="content">
        <router-view />
      </main>
    </div>

    <!-- 移动端遮罩 -->
    <div v-if="!sidebarCollapsed" class="sidebar-overlay" @click="sidebarCollapsed = true"></div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import Icon from '@/components/Icon.vue'

const admin = useAdminStore()
const route = useRoute()
const router = useRouter()
const sidebarCollapsed = ref(false)

const routeMap = {
  Dashboard: '培训看板',
  Users: '人员管理',
  Trainings: '题库管理',
  NewTraining: '新建培训',
  TrainingQuestions: '题目审核',
  Records: '答题记录',
  Settings: '系统设置',
  Categories: '培训分类管理',
  ContractorUnits: '承包商单位',
  HazardReport: '隐患录入',
  HazardLoop: '隐患闭环',
  HazardMonitor: '隐患监控看板',
  HazardSettings: '隐患模块设置',
  StandardBasisLibrary: '问题依据库',
  AccountManage: '账号管理',
  DataManage: '数据管理',
  QuizImport: '题目导入',
  ContractorDocs: '承包商开工资料',
}

const currentTitle = computed(() => routeMap[route.name] || '')
const adminInitial = computed(() => (admin.user?.username || '管').slice(0, 1).toUpperCase())

const todayStr = computed(() => {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日 周${['日', '一', '二', '三', '四', '五', '六'][d.getDay()]}`
})

function handleLogout() {
  admin.logout()
  router.push('/admin/login')
}
</script>

<style scoped>
.admin-layout { display: flex; height: 100vh; overflow: hidden; }

/* ── 侧边栏 ── */
.sidebar {
  width: 232px;
  background: linear-gradient(180deg, var(--c-navy-800) 0%, var(--c-navy-900) 100%);
  display: flex; flex-direction: column;
  transition: width .26s cubic-bezier(.4, 0, .2, 1);
  flex-shrink: 0; z-index: 200;
  box-shadow: 2px 0 16px rgba(10, 19, 34, .25);
}
.sidebar.collapsed { width: 64px; }

.sidebar-header {
  display: flex; align-items: center; gap: 11px;
  padding: 20px 18px; border-bottom: 1px solid rgba(255, 255, 255, .08);
}
.brand-mark {
  width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--c-blue-500), var(--c-blue-700));
  color: #fff; box-shadow: 0 4px 12px rgba(29, 111, 184, .45);
}
.brand-char {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
  user-select: none;
}
.logo-text { color: #fff; font-weight: 700; font-size: 15.5px; letter-spacing: .5px; white-space: nowrap; }

.sidebar-nav { flex: 1; padding: 14px 12px; display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
.sidebar-nav::-webkit-scrollbar { width: 0; }

.nav-item {
  position: relative;
  display: flex; align-items: center; gap: 12px;
  padding: 11px 13px; border-radius: 10px;
  color: rgba(255, 255, 255, .62); text-decoration: none;
  font-size: 14px; font-weight: 500; cursor: pointer;
  border: none; background: transparent; width: 100%; text-align: left;
  transition: background .16s ease, color .16s ease;
}
.nav-item:hover { background: rgba(255, 255, 255, .07); color: #fff; }
.nav-item.router-link-active {
  background: rgba(46, 139, 214, .18); color: #fff; font-weight: 600;
}
.nav-item.router-link-active::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 3px; height: 20px; border-radius: 0 3px 3px 0; background: var(--c-blue-500);
}
.nav-icon { flex-shrink: 0; }
.nav-label { white-space: nowrap; }

.nav-group-title {
  padding: 14px 13px 6px;
  font-size: 11px; font-weight: 700; letter-spacing: .8px;
  color: rgba(255,255,255,.38); text-transform: none;
}
.nav-group-title:first-child { padding-top: 4px; }

.sidebar-footer {
  padding: 12px; border-top: 1px solid rgba(255, 255, 255, .08);
  display: flex; flex-direction: column; gap: 6px;
}
.logout-btn { color: rgba(255, 255, 255, .5); }
.logout-btn:hover { color: #fff; background: rgba(220, 38, 38, .18) !important; }
.collapse-btn {
  display: flex; align-items: center; justify-content: center;
  padding: 7px; background: rgba(255, 255, 255, .06);
  border: none; border-radius: 8px; color: rgba(255, 255, 255, .5); cursor: pointer;
  transition: background .16s ease, color .16s ease;
}
.collapse-btn:hover { background: rgba(255, 255, 255, .12); color: #fff; }

/* ── 主区域 ── */
.main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ── 顶部栏 ── */
.topbar {
  height: 60px; background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; flex-shrink: 0;
}
.topbar-left { display: flex; align-items: center; gap: 12px; }
.page-title { font-size: 16px; font-weight: 700; color: var(--c-text); letter-spacing: .3px; }
.topbar-right { display: flex; align-items: center; gap: 14px; }
.mobile-menu-btn { display: none; background: none; border: none; color: var(--c-text-2); cursor: pointer; }

.admin-chip { display: flex; align-items: center; gap: 10px; }
.admin-avatar {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--c-blue-50); color: var(--c-blue-700);
  font-weight: 700; font-size: 15px;
}
.admin-meta { display: flex; flex-direction: column; line-height: 1.25; }
.admin-name { font-size: 13.5px; color: var(--c-text); font-weight: 600; }
.today { font-size: 11.5px; color: var(--c-text-3); }

/* ── 内容区 ── */
.content { flex: 1; overflow-y: auto; padding: 24px; background: var(--c-bg); }

/* ── 移动端遮罩 ── */
.sidebar-overlay { display: none; }

/* ── 响应式 ── */
@media (max-width: 768px) {
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; transform: translateX(-100%); }
  .sidebar:not(.collapsed) { transform: translateX(0); }
  .mobile-menu-btn { display: flex; }
  .sidebar-overlay { display: block; position: fixed; inset: 0; background: rgba(10, 19, 34, .5); z-index: 150; }
  .content { padding: 16px; }
  .topbar { padding: 0 16px; }
}
</style>
