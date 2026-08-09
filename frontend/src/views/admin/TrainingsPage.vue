<template>
  <div class="trainings-page">
    <!-- 操作栏 -->
    <div class="toolbar card">
      <div class="filter-group">
        <select v-model="filterStatus" class="filter-select">
          <option value="">全部状态</option>
          <option value="pending">待发布</option>
          <option value="published">已发布</option>
          <option value="closed">已关闭</option>
        </select>
      </div>
      <router-link to="/admin/trainings/new" class="btn btn-primary" style="width:auto">
        ➕ 新建培训
      </router-link>
    </div>

    <!-- 列表 -->
    <div class="card list-card">
      <div v-if="loading" class="loading"><div class="spinner"></div></div>
      <div v-else-if="filtered.length === 0" class="empty-state" style="padding:40px">
        <div class="icon">📚</div>
        <p>暂无培训</p>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>培训标题</th>
            <th>分类</th>
            <th>类型</th>
            <th>题目数</th>
            <th>及格分</th>
            <th>时限</th>
            <th>状态</th>
            <th>AI</th>
            <th>发布时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filtered" :key="t.id">
            <td><strong>{{ t.title }}</strong></td>
            <td><span v-if="t.category_name" class="badge badge-info">{{ t.category_name }}</span><span v-else class="badge badge-muted">未分类</span></td>
            <td>
              <span class="badge badge-info">{{ typeLabel(t.material_type) }}</span>
            </td>
            <td>{{ t.total_questions || 0 }}</td>
            <td>{{ t.pass_score ?? 60 }}分</td>
            <td>{{ t.time_limit ?? 30 }}分钟</td>
            <td>
              <span :class="['badge', statusBadge(t.status)]">
                {{ statusLabel(t.status) }}
              </span>
            </td>
            <td>
              <span v-if="t.ai_status === 0" class="badge badge-muted">未触发</span>
              <span v-else-if="t.ai_status === 1" class="badge badge-info">出题中…</span>
              <span v-else-if="t.ai_status === 2" class="badge badge-success">已就绪</span>
              <span v-else-if="t.ai_status === 3" class="badge badge-danger">出题失败</span>
              <span v-else class="badge badge-muted">{{ t.ai_status }}</span>
            </td>
            <td>{{ t.published_at ? formatDate(t.published_at) : '-' }}</td>
            <td>
              <div class="action-btns">
                <button
                  class="action-link primary"
                  @click="$router.push('/admin/trainings/' + t.id + '/questions')"
                >
                  题目
                </button>
                <button
                  class="action-link primary"
                  @click="$router.push('/admin/trainings/' + t.id + '/import')"
                >
                  导入
                </button>
                <button
                  class="action-link quality"
                  @click="$router.push('/admin/quality/' + t.id)"
                >
                  质量
                </button>
                <button
                  v-if="t.status === 'pending' && t.total_questions > 0"
                  class="action-link success"
                  @click="publishForm = { ...t }; showQuickPublish = true"
                >
                  发布
                </button>
                <button
                  v-if="t.status === 'published' || t.status === 'closed'"
                  class="action-link qrcode"
                  @click="showQRCode(t)"
                >
                  QR
                </button>
                <button
                  v-if="t.status === 'published'"
                  class="action-link warning"
                  @click="closeTraining(t.id)"
                >
                  关闭
                </button>
                <button
                  class="action-link danger"
                  @click="deleteTraining(t.id)"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- QR 码弹窗 -->
    <div v-if="qrVisible" class="modal-overlay" @click.self="closeQRModal">
      <div class="qr-modal card">
        <h3 class="qr-title">{{ qrTrainingTitle }}</h3>
        <div class="qr-img-wrap">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="二维码" class="qr-img" />
          <div v-else class="qr-loading">生成中…</div>
        </div>
        <p class="qr-hint">员工微信/浏览器扫码即可答题</p>
        <div class="qr-url-box">
          <input :value="qrQuizUrl" readonly class="qr-url-input" @click="$event.target.select()" />
          <button class="btn btn-sm" @click="copyUrl">复制</button>
        </div>
        <div class="qr-actions">
          <button class="btn btn-primary" @click="printQR">🖨️ 打印</button>
          <button class="btn btn-secondary" @click="closeQRModal">关闭</button>
        </div>
      </div>
    </div>

    <!-- 发布弹窗 -->
    <div v-if="showQuickPublish" class="modal-overlay" @click.self="showQuickPublish = false">
      <div class="modal">
        <h3>发布题库</h3>
        <p class="modal-hint">选择分类和目标人群后发布</p>
        <div class="form-group">
          <label>题库分类</label>
          <select v-model="publishForm.category_id" class="form-input">
            <option :value="null">未分类</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>目标人群</label>
          <select v-model="publishForm.target_type" class="form-input">
            <option value="all">全员</option>
            <option value="unit">指定承包商所有人员</option>
            <option value="specific">指定人员</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showQuickPublish = false">取消</button>
          <button class="btn btn-primary" @click="handleQuickPublish" :disabled="publishing">
            {{ publishing ? '发布中…' : '确认发布' }}
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { request } from '@/utils/request'
import QRCode from 'qrcode'

const router = useRouter()
const trainings = ref([])
const loading = ref(true)
const filterStatus = ref('')
const publishing = ref(null)

// ── 发布弹窗 ──
const showQuickPublish = ref(false)
const publishForm = ref({ id: null, category_id: null, target_type: 'all', target_value: [] })
const categories = ref([])

// ── QR 码状态 ──
const qrVisible = ref(false)
const qrTrainingTitle = ref('')
const qrDataUrl = ref('')
const qrQuizUrl = ref('')

const filtered = computed(() => {
  if (!filterStatus.value) return trainings.value
  return trainings.value.filter((t) => t.status === filterStatus.value)
})

const typeMap = { video: '视频通报', regulation: '制度文件', other: '其他' }
const statusMap = { pending: '待发布', published: '已发布', closed: '已关闭' }

function typeLabel(t) { return typeMap[t] || t }
function statusLabel(s) { return statusMap[s] || s }
function statusBadge(s) {
  return { pending: 'badge-warning', published: 'badge-success', closed: 'badge-danger' }[s] || ''
}
function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth()+1}月${d.getDate()}日`
}

async function publishTraining(id) {
  publishing.value = id
  try {
    await request.post(`/api/material/${id}/publish`)
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '发布失败')
  } finally {
    publishing.value = null
  }
}

async function handleQuickPublish() {
  publishing.value = true
  try {
    await request.post(`/api/material/${publishForm.value.id}/publish`, {
      category_id: publishForm.value.category_id || null,
      target_type: publishForm.value.target_type || 'all',
      target_value: publishForm.value.target_value?.length ? publishForm.value.target_value : null,
    })
    showQuickPublish.value = false
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '发布失败：' + (e.message || '请求出错'))
  } finally {
    publishing.value = false
  }
}

async function closeTraining(id) {
  if (!confirm('确定关闭该培训？关闭后员工无法再答题')) return
  try {
    await request.post(`/api/material/${id}/close`)
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '操作失败')
  }
}

async function deleteTraining(id) {
  if (!confirm('确定删除该培训？此操作不可恢复')) return
  try {
    await request.delete(`/api/material/${id}`)
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '删除失败')
  }
}

// ── QR 码功能 ──
async function showQRCode(training) {
  qrTrainingTitle.value = training.title
  qrVisible.value = true
  qrDataUrl.value = ''

  // 获取服务器公网地址（从系统配置读取，未配置则用当前 origin）
  let baseUrl = window.location.origin
  try {
    const res = await request.get('/api/admin/settings')
    const publicUrl = res.data?.data?.server_public_url
    if (publicUrl) baseUrl = publicUrl.replace(/\/+$/, '')
  } catch {}

  const url = `${baseUrl}/quiz/${training.id}`
  qrQuizUrl.value = url

  try {
    qrDataUrl.value = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (e) {
    alert('二维码生成失败')
    closeQRModal()
  }
}

function closeQRModal() {
  qrVisible.value = false
  qrDataUrl.value = ''
  qrQuizUrl.value = ''
  qrTrainingTitle.value = ''
}

function printQR() {
  if (!qrDataUrl.value) return
  const win = window.open('', '_blank')
  if (!win) { alert('请允许弹出窗口'); return }
  win.document.write(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8">
    <title>打印二维码 - ${qrTrainingTitle.value}</title>
    <style>
      body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; flex-direction: column; font-family: sans-serif; }
      h2 { margin-bottom: 10px; font-size: 18px; color: #333; }
      img { width: 300px; height: 300px; }
      p { margin-top: 8px; font-size: 14px; color: #666; text-align: center; word-break: break-all; max-width: 400px; }
      @media print { body { margin: 0; } img { width: 280px; height: 280px; } .no-print { display: none; } }
    </style>
    </head><body>
      <h2>${qrTrainingTitle.value}</h2>
      <img src="${qrDataUrl.value}" alt="二维码" />
      <p>${qrQuizUrl.value}</p>
      <p class="no-print" style="margin-top:30px;color:#999;font-size:12px">浏览器打印请按 Ctrl+P 或 Cmd+P</p>
      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 500);
        }
      <\/script>
    </body></html>
  `)
  win.document.close()
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(qrQuizUrl.value)
    alert('已复制链接')
  } catch {
    // fallback
    const input = document.querySelector('.qr-url-input')
    if (input) { input.select(); document.execCommand('copy') }
  }
}

async function fetchTrainings() {
  loading.value = true
  try {
    const res = await request.get('/api/material/list')
    trainings.value = res.data?.data || []
  } catch {}
  loading.value = false
}

onMounted(() => { fetchTrainings(); initPublish() })

async function initPublish() {
  try {
    const res = await request.get('/api/admin/categories')
    categories.value = res.data?.data || []
  } catch {}
}
</script>

<style scoped>
.trainings-page { max-width: 1100px; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.filter-group { display: flex; gap: 8px; }
.filter-select {
  padding: 9px 12px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 14px; background: #fff;
}
.list-card { padding: 0; overflow: hidden; }

.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th {
  text-align: left; padding: 12px 14px;
  background: #f8f9fa; color: var(--text-secondary);
  font-weight: 500; font-size: 13px;
  border-bottom: 1px solid var(--border);
}
.data-table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: #f8f9fa; }

.badge-info { background: #e8f0fe; color: #1a73e8; }
.badge-muted { background: #f0f0f0; color: #999; }
.action-link.primary { color: #1a73e8; }
.action-link.primary:hover { background: #e8f0fe; }

.action-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.action-link {
  background: none; border: none; cursor: pointer;
  font-size: 13px; font-weight: 500; padding: 3px 8px;
  border-radius: 6px; text-decoration: none;
}
.action-link.success { color: var(--success); }
.action-link.success:hover { background: #e6f4ea; }
.action-link.qrcode { color: #1a73e8; }
.action-link.qrcode:hover { background: #e8f0fe; }
.action-link.quality { color: #7b1fa2; }
.action-link.quality:hover { background: #f3e5f5; }
.action-link.warning { color: #e37400; }
.action-link.warning:hover { background: #fef7e0; }
.action-link.danger { color: var(--danger); }
.action-link.danger:hover { background: #fce8e6; }

/* ── QR 弹窗 / 发布弹窗 ── */
.modal-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.45);
  display: flex; justify-content: center; align-items: center;
}
.modal {
  background: #fff; border-radius: 16px; padding: 28px; width: 100%;
  max-width: 440px; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
}
.modal h3 { font-size: 18px; margin-bottom: 4px; }
.modal-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; font-weight: 500; }
.form-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--primary); }
.multi-select { max-height: 160px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; cursor: pointer; }
.user-select-list { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-top: 4px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.qr-modal {
  width: 380px; padding: 28px 24px; text-align: center;
  border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.15);
}
.qr-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
.qr-img-wrap {
  width: 200px; height: 200px; margin: 0 auto 12px;
  display: flex; justify-content: center; align-items: center;
}
.qr-img { width: 200px; height: 200px; }
.qr-loading { color: var(--text-secondary); font-size: 14px; }
.qr-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; }
.qr-url-box {
  display: flex; gap: 6px; margin-bottom: 20px;
}
.qr-url-input {
  flex: 1; padding: 8px 10px; font-size: 12px; color: #666;
  border: 1px solid var(--border); border-radius: 6px;
  background: #f8f9fa; cursor: text;
}
.qr-actions { display: flex; gap: 10px; justify-content: center; }
.btn-sm { padding: 6px 14px; font-size: 13px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); background: #fff; }
.btn-sm:hover { background: #f0f0f0; }
</style>
