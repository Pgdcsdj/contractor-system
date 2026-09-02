<template>
  <div class="safety-layout">
    <header class="topbar">
      <div class="topbar-left">
        <img :src="logoUrl" class="topbar-logo" alt="通南巴气田安全管理" />
        <span class="brand-text">通南巴隐患整改 — 安全员工作台</span>
      </div>
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
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import logoUrl from '@/assets/logo.jpg'

const router = useRouter()
const admin = useAdminStore()

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
.user-name { font-size: 13px; color: #fff; font-weight: 600; }
.user-unit { font-size: 11px; color: rgba(255,255,255,.7); }

.btn-logout {
  padding: 6px 14px; border: 1px solid rgba(255,255,255,.4); border-radius: var(--r-sm);
  background: transparent; color: #fff; font-size: 13px; cursor: pointer;
  font-weight: 500; transition: background .15s ease;
}
.btn-logout:hover { background: rgba(255,255,255,.15); }

.content { flex: 1; overflow-y: auto; padding: 24px; background: var(--c-bg); }
</style>
