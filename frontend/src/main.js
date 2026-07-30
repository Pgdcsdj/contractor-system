import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { RouterLink, RouterView, createWebHistory } from 'vue-router'
import App from './App.vue'
import router from './router'
import './style.css'
import { useAuthStore } from './stores/auth'
import { useAdminStore } from './stores/admin'

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

app.mount('#app')
