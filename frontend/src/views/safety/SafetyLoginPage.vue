<template>
  <div class="safety-login-page">
    <div class="login-card">
      <div class="brand">
        <div class="brand-icon">
          <span class="brand-char">通</span>
        </div>
        <div class="brand-text">
          <h1>通南巴安全隐患整改系统</h1>
          <p class="sub">安全员入口</p>
        </div>
      </div>

      <div class="form">
        <div class="form-group">
          <label>姓名</label>
          <input v-model="real_name" class="form-input" placeholder="请输入姓名" @keyup.enter="handleLogin" />
        </div>
        <div class="form-group">
          <label>电话</label>
          <input v-model="phone" type="password" class="form-input" placeholder="请输入电话（安全验证）" @keyup.enter="handleLogin" />
        </div>
        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <button class="btn btn-safety btn-block" @click="handleLogin" :disabled="loading || !real_name.trim() || !phone.trim()">
          {{ loading ? '登录中…' : '登 录' }}
        </button>
      </div>

      <p class="foot">中石化通南巴项目部 · 安全环保室</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import { safetyLogin } from '@/api/safety'

const router = useRouter()
const admin = useAdminStore()

const real_name = ref('')
const phone = ref('')
const loading = ref(false)
const errorMsg = ref('')

async function handleLogin() {
  if (!real_name.value.trim() || !phone.value.trim()) return
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await safetyLogin({
      real_name: real_name.value.trim(),
      phone: phone.value.trim(),
    })
    const data = res.data
    const token = data.token
    const userInfo = {
      real_name: data.real_name,
      phone: real_name.value.trim(),
      role: 'safety',
      unit_id: data.unit_id || null,
    }
    // 存储 token 到 localStorage
    localStorage.setItem('tnb_admin_token', token)
    localStorage.setItem('tnb_admin_user', JSON.stringify(userInfo))
    // 同步 admin store 状态
    admin.token = token
    admin.user = userInfo
    router.push('/safety/workbench')
  } catch (e) {
    errorMsg.value = e.response?.data?.error || '姓名或电话验证失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.safety-login-page {
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(183, 28, 28, .12), transparent 60%),
    linear-gradient(135deg, #1a0a0a 0%, #2d0d0d 100%);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.login-card {
  background: var(--c-surface);
  border-radius: var(--r-xl);
  padding: 40px 38px;
  width: 100%; max-width: 400px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, .35);
}
.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 30px; }
.brand-icon {
  width: 48px; height: 48px; border-radius: 13px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, var(--c-blue-500), var(--c-blue-700));
  box-shadow: 0 6px 18px rgba(29,111,184,.45);
}
.brand-char { font-size: 26px; font-weight: 700; line-height: 1; }
.brand-text h1 { font-size: 17px; font-weight: 700; color: var(--c-text); line-height: 1.3; }
.sub { font-size: 12.5px; color: var(--c-text-3); margin-top: 3px; }

.form { text-align: left; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; color: var(--c-text-2); margin-bottom: 6px; font-weight: 500; }

.error-msg { color: var(--c-danger); font-size: 13px; margin-bottom: 12px; }

.btn-safety {
  background: #b71c1c; color: #fff; box-shadow: 0 8px 24px rgba(183, 28, 28, .30);
  width: 100%; margin-top: 6px; letter-spacing: 2px;
}
.btn-safety:hover:not(:disabled) { background: #d32f2f; box-shadow: 0 10px 28px rgba(183, 28, 28, .40); }
.btn-block { width: 100%; }

.foot { text-align: center; font-size: 11.5px; color: var(--c-text-3); margin-top: 22px; }
</style>
