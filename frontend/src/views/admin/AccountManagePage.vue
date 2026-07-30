<template>
  <div class="account-manage-page">
    <div class="card">
      <div class="header">
        <h2>账号管理</h2>
        <button class="btn btn-primary" @click="openAdd">+ 新增账号</button>
      </div>

      <!-- 筛选栏 -->
      <div class="filter-bar">
        <select v-model="filters.role" class="filter-input" @change="fetchList">
          <option value="">全部角色</option>
          <option value="admin">admin</option>
          <option value="superadmin">superadmin</option>
          <option value="safety">safety</option>
        </select>
        <select v-model="filters.status" class="filter-input" @change="fetchList">
          <option value="">全部状态</option>
          <option value="1">启用</option>
          <option value="0">停用</option>
        </select>
        <input v-model="filters.keyword" class="filter-input" placeholder="搜索姓名/电话…" @input="onSearch" />
      </div>

      <!-- 表格 -->
      <div class="table-card">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>姓名</th>
              <th>电话</th>
              <th>角色</th>
              <th>归属单位</th>
              <th>状态</th>
              <th>最近登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="8" class="empty-cell"><div class="spinner" style="margin:0 auto"></div></td>
            </tr>
            <tr v-else-if="list.length === 0">
              <td colspan="8" class="empty-cell">暂无账号数据</td>
            </tr>
            <tr v-for="item in list" :key="item.id">
              <td class="mono">{{ item.id }}</td>
              <td><strong>{{ item.real_name }}</strong></td>
              <td>{{ item.phone || '-' }}</td>
              <td><span :class="['badge', roleBadge(item.role)]">{{ item.role }}</span></td>
              <td>{{ item.unit_name || '-' }}</td>
              <td><span :class="['badge', Number(item.status) === 1 ? 'badge-success' : 'badge-danger']">
                {{ Number(item.status) === 1 ? '启用' : '停用' }}
              </span></td>
              <td class="mono" style="font-size:12px">{{ fmtDate(item.last_login) }}</td>
              <td>
                <button class="action-link" @click="openEdit(item)">编辑</button>
                <button class="action-link" :class="Number(item.status) === 1 ? 'text-warning' : ''" @click="toggleStatus(item)">
                  {{ Number(item.status) === 1 ? '停用' : '启用' }}
                </button>
                <button class="action-link" @click="handleResetPwd(item)">重置密码</button>
                <button class="action-link danger" @click="handleDelete(item)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ isEditing ? '编辑账号' : '新增账号' }}</h3>
        <div class="edit-form">
          <div class="form-group">
            <label>姓名 <span class="req">*</span></label>
            <input v-model="form.real_name" class="form-input" placeholder="请输入姓名" />
          </div>
          <div class="form-group">
            <label>电话 <span class="req">*</span></label>
            <input v-model="form.phone" class="form-input" placeholder="请输入电话" />
          </div>
          <div class="form-group">
            <label>角色 <span class="req">*</span></label>
            <select v-model="form.role" class="form-input">
              <option value="safety">安全员 (safety)</option>
              <option value="admin">管理员 (admin)</option>
              <option value="superadmin">超级管理员 (superadmin)</option>
            </select>
          </div>
          <div class="form-group">
            <label>归属单位</label>
            <select v-model="form.unit_id" class="form-input">
              <option :value="null">请选择归属单位</option>
              <option v-for="u in units" :key="u.id" :value="u.id">{{ u.unit_name }}</option>
            </select>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showForm = false">取消</button>
          <button class="btn btn-primary" @click="handleSave" :disabled="saving || !form.real_name.trim() || !form.phone.trim()">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- toast -->
    <transition name="toast">
      <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { getAccounts, createAccount, updateAccount, deleteAccount, resetPassword } from '@/api/safety'
import { getContractorUnits } from '@/api/hazard'

const admin = useAdminStore()

const list = ref([])
const loading = ref(false)
const filters = reactive({ role: '', status: '', keyword: '' })
let searchTimer = null

const units = ref([])

const showForm = ref(false)
const isEditing = ref(false)
const editingId = ref(null)
const saving = ref(false)
const form = reactive({ real_name: '', phone: '', role: 'safety', unit_id: null })

const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
function showToast(msg, type = 'success') {
  toast.msg = msg
  toast.type = type
  toast.show = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3200)
}

function roleBadge(role) {
  if (role === 'superadmin') return 'badge-danger'
  if (role === 'admin') return 'badge-warning'
  return 'badge-info'
}

function fmtDate(v) {
  if (!v) return '-'
  return String(v).slice(0, 16).replace('T', ' ')
}

function buildParams() {
  const p = {}
  if (filters.role) p.role = filters.role
  if (filters.status) p.status = filters.status
  if (filters.keyword.trim()) p.keyword = filters.keyword.trim()
  return p
}

async function fetchList() {
  loading.value = true
  try {
    const res = await getAccounts(buildParams())
    list.value = res.data?.data?.list || res.data?.data || []
  } catch (e) {
    list.value = []
    showToast(e.response?.data?.error || '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(fetchList, 300)
}

function openAdd() {
  isEditing.value = false
  editingId.value = null
  form.real_name = ''
  form.phone = ''
  form.role = 'safety'
  form.unit_id = null
  showForm.value = true
}

function openEdit(item) {
  isEditing.value = true
  editingId.value = item.id
  form.real_name = item.real_name || ''
  form.phone = item.phone || ''
  form.role = item.role || 'safety'
  form.unit_id = item.unit_id != null ? Number(item.unit_id) : null
  showForm.value = true
}

async function handleSave() {
  if (!form.real_name.trim() || !form.phone.trim()) return
  saving.value = true
  try {
    const payload = {
      real_name: form.real_name.trim(),
      phone: form.phone.trim(),
      role: form.role,
      unit_id: form.unit_id,
    }
    if (isEditing.value) {
      await updateAccount(editingId.value, payload)
      showToast('账号已更新', 'success')
    } else {
      await createAccount(payload)
      showToast('账号已创建', 'success')
    }
    showForm.value = false
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '操作失败', 'error')
  } finally {
    saving.value = false
  }
}

async function toggleStatus(item) {
  const newStatus = Number(item.status) === 1 ? 0 : 1
  const actionLabel = newStatus === 1 ? '启用' : '停用'
  if (!confirm(`确认${actionLabel}账号「${item.real_name}」？`)) return
  try {
    await updateAccount(item.id, { status: newStatus })
    showToast(`账号已${actionLabel}`, 'success')
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '操作失败', 'error')
  }
}

async function handleResetPwd(item) {
  if (!confirm(`确认将账号「${item.real_name}」的密码重置为手机号？`)) return
  try {
    await resetPassword(item.id, {})
    showToast('密码已重置为手机号', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '重置失败', 'error')
  }
}

async function handleDelete(item) {
  // 不可删自己
  if (admin.user?.real_name === item.real_name) {
    return showToast('不能删除自己', 'error')
  }
  // 不可删最后一个 superadmin
  if (item.role === 'superadmin' || item.role === 'super_admin') {
    const superadmins = list.value.filter((x) => (x.role === 'superadmin' || x.role === 'super_admin') && Number(x.status) === 1)
    if (superadmins.length <= 1) {
      return showToast('至少保留一个 active 的 superadmin 账号', 'error')
    }
  }
  if (!confirm(`确认删除账号「${item.real_name}」？此操作不可恢复。`)) return
  try {
    await deleteAccount(item.id)
    showToast('账号已删除', 'success')
    fetchList()
  } catch (e) {
    showToast(e.response?.data?.error || '删除失败', 'error')
  }
}

async function loadUnits() {
  try {
    const res = await getContractorUnits()
    units.value = res.data?.data?.list || res.data?.data || []
  } catch {
    units.value = []
  }
}

onMounted(() => { fetchList(); loadUnits() })
</script>

<style scoped>
.account-manage-page { max-width: 1200px; }

.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header h2 { font-size: 18px; font-weight: 700; color: var(--c-text); }

.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.filter-input {
  padding: 9px 12px; border: 1px solid var(--c-border-strong); border-radius: var(--r);
  font-size: 14px; background: var(--c-surface); min-width: 140px;
}
.filter-input:focus { outline: none; border-color: var(--c-blue-600); }

.table-card { padding: 0; overflow-x: auto; }

.text-warning { color: var(--c-warning) !important; }

.action-link.danger { color: var(--c-danger); }
.action-link.danger:hover { background: var(--c-danger-bg); }

.req { color: var(--c-danger); }

.edit-form { display: flex; flex-direction: column; gap: 10px; margin: 16px 0; }

.toast {
  position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
  z-index: 2000; padding: 12px 20px; border-radius: 12px;
  font-size: 14px; font-weight: 600; color: #fff;
  box-shadow: var(--shadow-lg); max-width: 90vw;
}
.toast.success { background: var(--c-success); }
.toast.error { background: var(--c-danger); }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, -12px); }
</style>
