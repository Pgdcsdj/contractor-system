import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { request } from '@/utils/request'

export const useAdminStore = defineStore('admin', () => {
  const token = ref(localStorage.getItem('tnb_admin_token') || null)
  const user = ref(JSON.parse(localStorage.getItem('tnb_admin_user') || 'null'))

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  async function login(username, password) {
    const res = await request.post('/api/admin/login', { username, password })
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('tnb_admin_token', res.data.token)
    localStorage.setItem('tnb_admin_user', JSON.stringify(res.data.user))
    return res.data
  }

  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('tnb_admin_token')
    localStorage.removeItem('tnb_admin_user')
  }

  function restoreSession() {
    const saved = localStorage.getItem('tnb_admin_user')
    if (saved) {
      try { user.value = JSON.parse(saved) } catch {}
    }
  }

  return { token, user, isLoggedIn, login, logout, restoreSession }
})
