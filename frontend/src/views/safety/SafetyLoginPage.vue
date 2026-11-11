<template>
  <div class="safety-login-page">
    <div class="login-card">
      <div class="brand">
        <img :src="logoUrl" class="brand-icon-img" alt="通南巴气田安全管理" />
        <div class="brand-text">
          <h1>通南巴安全隐患整改系统</h1>
          <p class="sub">安全员 · 管理员统一入口</p>
        </div>
      </div>

      <!-- 凭据方式切换：安全员用姓名+电话，管理员/超管用账号+密码 -->
      <div class="mode-switch">
        <button type="button" class="mode-btn" :class="{ on: mode === 'name' }" @click="switchMode('name')">
          姓名 + 电话
        </button>
        <button type="button" class="mode-btn" :class="{ on: mode === 'account' }" @click="switchMode('account')">
          账号 + 密码
        </button>
      </div>

      <div class="form">
        <template v-if="mode === 'name'">
          <div class="form-group">
            <label>姓名</label>
            <input v-model="real_name" class="form-input" placeholder="请输入姓名" @keyup.enter="handleLogin" />
          </div>
          <div class="form-group">
            <label>电话</label>
            <input v-model="phone" type="password" class="form-input" placeholder="请输入电话（安全验证）" @keyup.enter="handleLogin" />
          </div>
        </template>
        <template v-else>
          <div class="form-group">
            <label>账号</label>
            <input v-model="username" class="form-input" placeholder="请输入管理员账号" @keyup.enter="handleLogin" />
          </div>
          <div class="form-group">
            <label>密码</label>
            <input v-model="password" type="password" class="form-input" placeholder="请输入登录密码" @keyup.enter="handleLogin" />
          </div>
        </template>

        <p class="mode-hint">
          {{ mode === 'name'
            ? '安全员请用姓名 + 电话登录；管理员、超级管理员请切换到「账号 + 密码」。'
            : '管理员、超级管理员请用管理端账号密码登录，登录后同样进入安全员工作台。' }}
        </p>
        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <button class="btn btn-safety btn-block" @click="handleLogin" :disabled="loading || !canSubmit">
          {{ loading ? '登录中…' : '登 录' }}
        </button>
      </div>

      <p class="foot">中石化通南巴项目部 · 安全环保室</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import { safetyLogin } from '@/api/safety'
import logoUrl from '@/assets/logo.jpg'

const router = useRouter()
const admin = useAdminStore()

const mode = ref('name')          // 'name' = 姓名+电话 | 'account' = 账号+密码
const real_name = ref('')
const phone = ref('')
const username = ref('')
const password = ref('')
const loading = ref(false)
const errorMsg = ref('')

const canSubmit = computed(() => {
  return mode.value === 'name'
    ? !!real_name.value.trim() && !!phone.value.trim()
    : !!username.value.trim() && !!password.value.trim()
})

function switchMode(m) {
  if (mode.value === m) return
  mode.value = m
  errorMsg.value = ''
  // 清空另一组输入，避免切换后残留旧凭据被误提交
  if (m === 'name') { username.value = ''; password.value = '' }
  else { real_name.value = ''; phone.value = '' }
}

async function handleLogin() {
  if (!canSubmit.value) return
  loading.value = true
  errorMsg.value = ''
  const isAccount = mode.value === 'account'
  try {
    const payload = isAccount
      ? { mode: 'account', username: username.value.trim(), password: password.value.trim() }
      : { real_name: real_name.value.trim(), phone: phone.value.trim() }
    const res = await safetyLogin(payload)
    const data = res.data
    const token = data.token
    const userInfo = {
      real_name: data.real_name,
      phone: isAccount ? '' : phone.value.trim(),
      // 本入口一律以安全员身份进入工作台；管理员要进后台请另用 /admin/login
      role: 'safety',
      unit_id: data.unit_id || null,
    }
    localStorage.setItem('tnb_admin_token', token)
    localStorage.setItem('tnb_admin_user', JSON.stringify(userInfo))
    admin.token = token
    admin.user = userInfo
    router.push('/safety/workbench')
  } catch (e) {
    errorMsg.value = e.response?.data?.error ||
      (isAccount ? '账号或密码验证失败' : '姓名或电话验证失败')
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
.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
.brand-icon-img {
  width: 56px; height: 56px; border-radius: 14px; flex-shrink: 0;
  object-fit: contain;
  background: #fff;
  box-shadow: 0 6px 18px rgba(29,111,184,.45);
}
.brand-text h1 { font-size: 17px; font-weight: 700; color: var(--c-text); line-height: 1.3; }
.sub { font-size: 12.5px; color: var(--c-text-3); margin-top: 3px; }

/* 模式切换：不用 .btn 类，避开全局 .btn{width:100%} */
.mode-switch { display: flex; gap: 8px; margin-bottom: 20px; }
.mode-btn {
  flex: 1 1 0; width: auto; padding: 9px 6px;
  border: 1px solid var(--c-border, #e0e0e0); border-radius: 8px;
  background: transparent; color: var(--c-text-2);
  font-size: 13px; font-family: inherit; cursor: pointer;
  transition: all .18s;
}
.mode-btn:hover { border-color: #b71c1c; }
.mode-btn.on {
  border-color: #b71c1c; background: #b71c1c; color: #fff; font-weight: 600;
}

.form { text-align: left; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; color: var(--c-text-2); margin-bottom: 6px; font-weight: 500; }
.mode-hint {
  font-size: 11.5px; color: var(--c-text-3); line-height: 1.6;
  margin: -2px 0 12px;
}
.error-msg { color: var(--c-danger); font-size: 13px; margin-bottom: 12px; }

.btn-safety {
  background: #b71c1c; color: #fff; box-shadow: 0 8px 24px rgba(183, 28, 28, .30);
  width: 100%; margin-top: 6px; letter-spacing: 2px;
}
.btn-safety:hover:not(:disabled) { background: #d32f2f; box-shadow: 0 10px 28px rgba(183, 28, 28, .40); }
.btn-block { width: 100%; }

.foot { text-align: center; font-size: 11.5px; color: var(--c-text-3); margin-top: 22px; }
</style>
