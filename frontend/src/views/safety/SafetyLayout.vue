<template>
  <div class="safety-layout">
    <header class="topbar">
      <div class="topbar-left">
        <img :src="logoUrl" class="topbar-logo" alt="通南巴气田安全管理" />
        <span class="brand-text">通南巴隐患整改 — 安全员工作台</span>
      </div>
      <nav class="topnav">
        <router-link to="/safety/workbench" class="nav-tab">隐患工作台</router-link>
        <router-link to="/safety/report" class="nav-tab">隐患录入</router-link>
        <router-link to="/safety/rectify" class="nav-tab">整改资料录入</router-link>
        <router-link to="/safety/doc-reminders" class="nav-tab">
          开工资料提醒
          <span v-if="pendingReminders > 0" class="nav-badge">{{ pendingReminders > 99 ? '99+' : pendingReminders }}</span>
        </router-link>
      </nav>
      <div class="topbar-right">
        <div class="user-chip">
          <span class="user-avatar">{{ userInitial }}</span>
          <div class="user-meta">
            <span class="user-name">{{ admin.user?.real_name || '安全员' }}</span>
            <span class="user-unit">{{ admin.user?.unit_name || (admin.user?.unit_id || '') }}</span>
          </div>
        </div>
        <button class="btn btn-logout" @click="handleLogout">退出</button>
      </div>
    </header>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import { request } from '@/utils/request'
import logoUrl from '@/assets/logo.jpg'

const router = useRouter()
const route = useRoute()
const admin = useAdminStore()

// 开工资料补录提醒待办角标：进入任意安全员页面都刷新一次，处理完返回时也会刷新
const pendingReminders = ref(0)
async function loadReminderCount() {
  try {
    const res = await request.get('/api/contractor-docs/reminders/count')
    pendingReminders.value = Number(res.data?.data?.pending) || 0
  } catch {
    pendingReminders.value = 0
  }
}
onMounted(loadReminderCount)
watch(() => route.path, loadReminderCount)

const userInitial = computed(() => {
  const name = admin.user?.real_name || '安'
  return name.slice(0, 1)
})

function handleLogout() {
  localStorage.removeItem('tnb_admin_token')
  localStorage.removeItem('tnb_admin_user')
  admin.token = null
  admin.user = null
  router.push('/safety/login')
}
</script>

<style scoped>
.safety-layout { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

.topbar {
  height: 56px;
  background: linear-gradient(135deg, #b71c1c 0%, #d32f2f 100%);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; flex-shrink: 0; color: #fff;
  box-shadow: 0 2px 12px rgba(183, 28, 28, .3);
}
.topbar-left { display: flex; align-items: center; gap: 12px; }

/* 顶部导航（安全员端原先没有菜单，开工资料提醒需要一个入口） */
.topnav { display: flex; align-items: center; gap: 4px; flex: 1; justify-content: center; flex-wrap: wrap; }
.nav-tab {
  position: relative; display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 14px; border-radius: 20px; font-size: 13px; font-weight: 600;
  color: rgba(255,255,255,.82); text-decoration: none; transition: all .15s;
}
.nav-tab:hover { background: rgba(255,255,255,.16); color: #fff; }
.nav-tab.router-link-active { background: #fff; color: #b71c1c; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
.nav-badge {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: #ffd54f; color: #8a4b00; font-size: 11px; font-weight: 800;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
}
.nav-tab.router-link-active .nav-badge { background: #e0342b; color: #fff; }
.brand-text { font-size: 15px; font-weight: 700; letter-spacing: .5px; }
.topbar-logo {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  object-fit: contain;
  background: #fff;
  box-shadow: 0 3px 10px rgba(0,0,0,.2);
}
.topbar-right { display: flex; align-items: center; gap: 14px; }

.user-chip { display: flex; align-items: center; gap: 10px; }
.user-avatar {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,.2); color: #fff;
  font-weight: 700; font-size: 14px;
}
.user-meta { display: flex; flex-direction: column; line-height: 1.2; }
.user-name { font-size: 13px; color: #fff; font-weight: 600; white-space: nowrap; }
.user-unit { font-size: 11px; color: rgba(255,255,255,.7); white-space: nowrap; }

.btn-logout {
  padding: 6px 14px; border: 1px solid rgba(255,255,255,.4); border-radius: var(--r-sm);
  background: transparent; color: #fff; font-size: 13px; cursor: pointer;
  font-weight: 500; transition: background .15s ease;
}
.btn-logout:hover { background: rgba(255,255,255,.15); }

.content { flex: 1; overflow-y: auto; padding: 24px; background: var(--c-bg); }
</style>
