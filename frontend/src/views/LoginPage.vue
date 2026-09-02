<template>
  <div class="login-page">
    <!-- 顶部品牌 -->
    <div class="brand">
      <div class="brand-logo"><img :src="logoUrl" class="brand-img" alt="通南巴气田安全管理" /></div>
      <h1 class="brand-title">通南巴项目部</h1>
      <p class="brand-sub">承包商安全培训考核</p>
    </div>

    <!-- 登录区域 -->
    <div class="card login-card" v-if="!showRegister">
      <h2 class="section-title">登录</h2>
      <div class="form-group">
        <input v-model="name" class="form-input" placeholder="姓名" type="text" @keyup.enter="handleManualLogin" />
      </div>
      <div class="form-group">
        <input v-model="idCard" class="form-input" placeholder="身份证后4位" type="text" maxlength="4" @keyup.enter="handleManualLogin" />
      </div>
      <button class="btn btn-primary full-btn" @click="handleManualLogin" :disabled="loading || !name || !idCard">
        {{ loading ? '验证中…' : '开始答题' }}
      </button>
      <p class="toggle-link" @click="showRegister = true">没有账号？点击注册</p>
    </div>

    <!-- 注册区域 -->
    <div class="card register-card" v-else>
      <h2 class="section-title">临时注册</h2>
      <p class="register-hint">未录入系统的承包商人员，请先注册</p>
      <div class="form-group">
        <input v-model="regName" class="form-input" placeholder="姓名 *" type="text" />
      </div>
      <div class="form-group">
        <input v-model="regIdCard" class="form-input" placeholder="身份证号 *" type="text" maxlength="18" />
      </div>
      <div class="form-group">
        <input v-model="regUnit" class="form-input" placeholder="所属承包商单位" type="text" />
      </div>
      <div class="form-group">
        <input v-model="regSupervisingUnit" class="form-input" placeholder="主管单位（甲方）" type="text" />
      </div>
      <div class="form-group">
        <input v-model="regPhone" class="form-input" placeholder="手机号" type="text" />
      </div>
      <button class="btn btn-primary full-btn" @click="handleRegister" :disabled="loading || !regName || !regIdCard">
        {{ loading ? '提交中…' : '注册并开始答题' }}
      </button>
      <p class="toggle-link" @click="showRegister = false">已有账号？点击登录</p>
    </div>

    <!-- 错误提示 -->
    <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>

    <!-- 离线记录提示 -->
    <div v-if="pendingCount > 0" class="pending-hint" @click="$router.push('/offline-records')">
      您有 {{ pendingCount }} 条离线答题记录待上传
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import logoUrl from '@/assets/logo.jpg'
// offlineDb 动态加载，已移除静态导入

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const showRegister = ref(false)
const name = ref('')
const idCard = ref('')
const regName = ref('')
const regIdCard = ref('')
const regUnit = ref('')
const regSupervisingUnit = ref('')
const regPhone = ref('')
const loading = ref(false)
const errorMsg = ref('')
const pendingCount = ref(0)

onMounted(async () => {
  // 首页表单跳转带参：?name=&last4= → 预填并自动登录，直达答题
  if (route.query.name && route.query.last4) {
    name.value = String(route.query.name)
    idCard.value = String(route.query.last4)
    await handleManualLogin()
    return
  }
  if (auth.isLoggedIn) {
    router.replace(route.query.redirect || '/quiz')
    return
  }
  try {
    const { offlineDb } = await import('@/utils/offlineDb')
    const pending = await offlineDb.getPendingRecords()
    pendingCount.value = pending.length
  } catch {}
})

async function handleManualLogin() {
  if (!name.value || !idCard.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    await auth.manualLogin(name.value, idCard.value)
    router.replace(route.query.redirect || '/quiz')
  } catch (e) {
    errorMsg.value = e.response?.data?.error || '登录失败，请检查姓名和身份证后4位'
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  if (!regName.value || !regIdCard.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    await auth.register({
      name: regName.value,
      id_card: regIdCard.value,
      unit: regUnit.value,
      supervising_unit: regSupervisingUnit.value,
      phone: regPhone.value,
    })
    router.replace(route.query.redirect || '/quiz')
  } catch (e) {
    errorMsg.value = e.response?.data?.error || '注册失败，请检查信息'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px 30px;
  background: linear-gradient(160deg, #e8f0fe 0%, #f5f5f5 100%);
}

.brand { text-align: center; margin-bottom: 28px; }
.brand-logo { display: flex; justify-content: center; margin-bottom: 14px; }
.brand-img {
  width: 110px; height: 110px; border-radius: 50%;
  object-fit: contain;
  box-shadow: 0 8px 28px rgba(26,115,232,.35);
  background: #fff;
}
.brand-title { font-size: 24px; font-weight: 700; color: #1a73e8; }
.brand-sub { font-size: 15px; color: #5f6368; margin-top: 5px; }

.card { width: 100%; max-width: 400px; padding: 24px; }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; text-align: center; }
.register-hint { font-size: 13px; color: var(--text-secondary); text-align: center; margin-bottom: 16px; }

.form-group { margin-bottom: 10px; }
.form-input {
  width: 100%;
  padding: 12px 14px;
  border: 2px solid var(--border);
  border-radius: 10px;
  font-size: 15px;
  background: #fff;
  box-sizing: border-box;
}
.form-input:focus { outline: none; border-color: var(--primary); }

.full-btn { width: 100%; margin-top: 4px; }

.toggle-link {
  text-align: center;
  margin-top: 14px;
  font-size: 13px;
  color: var(--primary);
  cursor: pointer;
}
.toggle-link:hover { text-decoration: underline; }

.error-msg {
  color: var(--danger);
  font-size: 13px;
  text-align: center;
  margin-top: 12px;
}

.pending-hint {
  margin-top: 20px;
  background: var(--warning);
  color: #000;
  padding: 10px 20px;
  border-radius: 99px;
  font-size: 13px;
  cursor: pointer;
}
</style>
