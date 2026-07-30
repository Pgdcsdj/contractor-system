<template>
  <div class="category-page">
    <div class="card toolbar">
      <h2>题库分类管理</h2>
      <button class="btn btn-primary" @click="showAdd = true">➕ 新增分类</button>
    </div>

    <div class="card">
      <table class="data-table">
        <thead><tr><th>排序</th><th>分类名称</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="4" class="empty-cell">加载中…</td></tr>
          <tr v-else-if="categories.length === 0"><td colspan="4" class="empty-cell">暂无分类</td></tr>
          <tr v-for="c in categories" :key="c.id">
            <td>
              <input v-model.number="c.sort_order" class="sort-input" @change="updateCategory(c)" />
            </td>
            <td>
              <input v-model="c.name" class="name-input" @change="updateCategory(c)" />
            </td>
            <td class="mono">{{ formatDate(c.created_at) }}</td>
            <td>
              <button class="action-link danger" @click="deleteCategory(c)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增弹窗 -->
    <div v-if="showAdd" class="modal-overlay" @click.self="showAdd = false">
      <div class="modal">
        <h3>新增分类</h3>
        <div class="form-group" style="margin:16px 0">
          <label>分类名称</label>
          <input v-model="newName" class="form-input" placeholder="例如：高处作业培训" @keyup.enter="handleAdd" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showAdd = false">取消</button>
          <button class="btn btn-primary" @click="handleAdd" :disabled="!newName.trim()">确认</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { request } from '@/utils/request'

const categories = ref([])
const loading = ref(true)
const showAdd = ref(false)
const newName = ref('')

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
}

async function fetchCategories() {
  loading.value = true
  try {
    const res = await request.get('/api/admin/categories')
    categories.value = res.data?.data || []
  } catch {}
  loading.value = false
}

async function updateCategory(c) {
  try {
    await request.put(`/api/admin/categories/${c.id}`, { name: c.name, sort_order: c.sort_order })
  } catch (e) {
    alert('更新失败：' + (e.response?.data?.error || e.message))
    fetchCategories()
  }
}

async function deleteCategory(c) {
  if (!confirm(`确定删除分类"${c.name}"？`)) return
  try {
    await request.delete(`/api/admin/categories/${c.id}`)
    fetchCategories()
  } catch (e) {
    alert(e.response?.data?.error || '删除失败')
  }
}

async function handleAdd() {
  if (!newName.value.trim()) return
  try {
    await request.post('/api/admin/categories', { name: newName.value.trim() })
    showAdd.value = false
    newName.value = ''
    fetchCategories()
  } catch (e) {
    alert(e.response?.data?.error || '添加失败')
  }
}

onMounted(fetchCategories)
</script>

<style scoped>
.category-page { max-width: 600px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.toolbar h2 { font-size: 16px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th { text-align: left; padding: 12px 14px; background: #f8f9fa; color: var(--text-secondary); font-weight: 500; font-size: 13px; border-bottom: 1px solid var(--border); }
.data-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.data-table tr:last-child td { border-bottom: none; }
.empty-cell { text-align: center; padding: 30px; color: var(--text-secondary); }
.sort-input { width: 50px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; text-align: center; }
.name-input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; min-width: 180px; }
.name-input:focus, .sort-input:focus { outline: none; border-color: var(--primary); }
.mono { font-family: monospace; font-size: 12px; color: var(--text-secondary); }
.action-link { background: none; border: none; cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 6px; }
.action-link.danger { color: var(--danger); }
.action-link.danger:hover { background: #fce8e6; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
.modal h3 { font-size: 18px; margin-bottom: 8px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--primary); }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
</style>
