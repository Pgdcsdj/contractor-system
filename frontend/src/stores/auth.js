import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { request } from '@/utils/request'
// offlineDb 动态加载，已移除静态导入

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const token = ref(localStorage.getItem('tnb_token') || null)

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  // 扫码登录
  async function qrLogin(token_str) {
    const res = await request.post('/api/auth/qr-login', { token: token_str })
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('tnb_token', res.data.token)
    localStorage.setItem('tnb_user', JSON.stringify(res.data.user))
    return res.data
  }

  // 手动登录（姓名 + 身份证后4位）
  async function manualLogin(name, last4) {
    const res = await request.post('/api/auth/manual-login', { name, last4 })
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('tnb_token', res.data.token)
    localStorage.setItem('tnb_user', JSON.stringify(res.data.user))
    return res.data
  }

  // 临时注册（未录入人员自助注册）
  async function register(info) {
    const res = await request.post('/api/auth/register', info)
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('tnb_token', res.data.token)
    localStorage.setItem('tnb_user', JSON.stringify(res.data.user))
    return res.data
  }

  // 恢复会话
  function restoreSession() {
    const saved = localStorage.getItem('tnb_user')
    if (saved) {
      try {
        user.value = JSON.parse(saved)
      } catch {}
    }
  }

  // 登出
  function logout() {
    user.value = null
    token.value = null
    localStorage.removeItem('tnb_token')
    localStorage.removeItem('tnb_user')
    // 动态加载 offlineDb，被 CSP 阻断时静默忽略
    import('@/utils/offlineDb').then(m => m.offlineDb.clearUserSession()).catch(() => {})
  }

  return { user, token, isLoggedIn, qrLogin, manualLogin, register, restoreSession, logout }
})
