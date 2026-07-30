<template>
  <div class="categories-page">
    <div class="card">
      <div class="header">
        <h2>题库分类管理</h2>
        <button class="btn btn-primary" @click="showAdd = true">+ 新增分类</button>
      </div>

      <table class="data-table">
        <thead>
          <tr><th>排序</th><th>分类名称</th><th>创建时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="4" class="empty-cell">加载中…</td></tr>
          <tr v-else-if="list.length === 0"><td colspan="4" class="empty-cell">暂无分类，请新增</td></tr>
          <tr v-for="c in list" :key="c.id">
            <td>{{ c.sort_order }}</td>
            <td><strong>{{ c.name }}</strong></td>
            <td>{{ c.created_at ? new Date(c.created_at).toLocaleDateString() : '-' }}</td>
            <td>
              <button class="action-link" @click="editItem(c)">编辑</button>
              <button class="action-link danger" @click="deleteItem(c)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ editingId ? '编辑分类' : '新增分类' }}</h3>
        <div class="form-group">
          <label>分类名称</label>
          <input v-model="formName" class="form-input" placeholder="如：入场教育" />
        </div>
        <div class="form-group">
          <label>排序</label>
          <input v-model.number="formSort" type="number" class="form-input" min="0" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showForm = false">取消</button>
          <button class="btn btn-primary" @click="handleSave" :disabled="!formName.trim() || saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { request } from '@/utils/request'

const list = ref([])
const loading = ref(true)
const showForm = ref(false)
const editingId = ref(null)
const formName = ref('')
const formSort = ref(99)
const saving = ref(false)

async function fetchList() {
  loading.value = true
  try {
    const res = await request.get('/api/admin/categories')
    list.value = res.data?.data || []
  } catch { list.value = [] }
  loading.value = false
}

function editItem(c) {
  editingId.value = c.id
  formName.value = c.name
  formSort.value = c.sort_order
  showForm.value = true
}

function deleteItem(c) {
  if (!confirm(`确定删除分类"${c.name}"？`)) return
  request.delete(`/api/admin/categories/${c.id}`).then(() => fetchList()).catch(e => alert(e.response?.data?.error || '删除失败'))
}

async function handleSave() {
  saving.value = true
  try {
    if (editingId.value) {
      await request.put(`/api/admin/categories/${editingId.value}`, { name: formName.value, sort_order: formSort.value })
    } else {
      await request.post('/api/admin/categories', { name: formName.value, sort_order: formSort.value })
    }
    showForm.value = false
    fetchList()
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.error || e.message))
  } finally {
    saving.value = false
  }
}

onMounted(fetchList)
</script>

<style scoped>
.categories-page { max-width: 700px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header h2 { font-size: 18px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th { text-align: left; padding: 10px 14px; background: #f8f9fa; font-size: 13px; color: var(--text-secondary); border-bottom: 1px solid var(--border); }
.data-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.data-table tr:last-child td { border-bottom: none; }
.empty-cell { text-align: center; padding: 30px; color: var(--text-secondary); }
.action-link { background: none; border: none; color: var(--primary); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 6px; }
.action-link:hover { background: #e8f0fe; }
.action-link.danger { color: var(--danger); }
.action-link.danger:hover { background: #fce8e6; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 400px; }
.modal h3 { font-size: 18px; margin-bottom: 16px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--primary); }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.modal-actions .btn { width: auto; }
</style>
