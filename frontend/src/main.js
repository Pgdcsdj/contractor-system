import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { RouterLink, RouterView, createWebHistory } from 'vue-router'
import App from './App.vue'
import router from './router'
import './style.css'
import { useAuthStore } from './stores/auth'
import { useAdminStore } from './stores/admin'
import { startVersionGuard } from './utils/versionGuard'

// offlineDb 改为动态加载，避免 CSP 阻断应用初始化

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// 恢复会话
const auth = useAuthStore()
const admin = useAdminStore()
auth.restoreSession()
admin.restoreSession()

// 启动版本守卫：线上发布新包后自动强刷，避免用户长期停留在旧缓存
startVersionGuard()

app.mount('#app')
