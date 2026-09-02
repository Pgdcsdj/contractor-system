<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <img :src="logoUrl" class="brand-mark-img" alt="通南巴气田安全管理" />
        <div class="brand-text">
          <h1>通南巴承包商系统</h1>
          <p class="sub">安全隐患整改闭环管理平台</p>
        </div>
      </div>

      <div class="form">
        <div class="form-group">
          <label>管理员账号</label>
          <input v-model="username" class="form-input" placeholder="请输入账号" @keyup.enter="handleLogin" />
        </div>
        <div class="form-group">
          <label>密码</label>
          <input v-model="password" type="password" class="form-input" placeholder="请输入密码" @keyup.enter="handleLogin" />
        </div>
        <p v-if="errorMsg" class="error-msg"><Icon name="alert" :size="15" /> {{ errorMsg }}</p>
        <button class="btn btn-primary btn-block" @click="handleLogin" :disabled="loading">
          <Icon v-if="loading" name="loop" :size="18" class="spin" />
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
import logoUrl from '@/assets/logo.jpg'

const router = useRouter()
const admin = useAdminStore()

const username = ref('')
const password = ref('')
const loading = ref(false)
const errorMsg = ref('')

async function handleLogin() {
  if (!username.value || !password.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    await admin.login(username.value, password.value)
    router.push('/admin/dashboard')
  } catch (e) {
    errorMsg.value = e.response?.data?.error || '用户名或密码错误'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(46, 139, 214, .18), transparent 60%),
    linear-gradient(135deg, var(--c-navy-800) 0%, var(--c-navy-900) 100%);
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
.brand-mark-img {
  width: 56px; height: 56px; border-radius: 14px; flex-shrink: 0;
  object-fit: contain;
  background: #fff;
  box-shadow: 0 6px 18px rgba(29, 111, 184, .45);
}
.brand-text h1 { font-size: 19px; font-weight: 700; color: var(--c-text); }
.sub { font-size: 12.5px; color: var(--c-text-3); margin-top: 3px; }

.form { text-align: left; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; color: var(--c-text-2); margin-bottom: 6px; font-weight: 500; }

.error-msg { display: flex; align-items: center; gap: 6px; color: var(--c-danger); font-size: 13px; margin-bottom: 12px; }
.btn-block { width: 100%; margin-top: 6px; letter-spacing: 2px; }
.spin { animation: spin .9s linear infinite; }

.foot { text-align: center; font-size: 11.5px; color: var(--c-text-3); margin-top: 22px; }
</style>
