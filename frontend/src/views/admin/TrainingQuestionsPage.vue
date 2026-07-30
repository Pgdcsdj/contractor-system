<template>
  <div class="questions-page">
    <div class="page-nav">
      <button class="back-link" @click="$router.push('/admin/trainings')">← 返回列表</button>
    </div>

    <div class="card" v-if="loading">
      <div class="loading"><div class="spinner"></div></div>
    </div>

    <template v-else>
      <!-- 培训信息 -->
      <div class="card info-card">
        <h2>{{ material.title }}</h2>
        <div class="info-row">
          <span class="badge" :class="aiStatusBadge">{{ aiStatusLabel }}</span>
          <span>共 <strong>{{ questions.length }}</strong> 道题</span>
        </div>
        <div class="info-actions">
          <button class="btn btn-primary" @click="showPublish = true" :disabled="questions.length === 0">
            发布题库
          </button>
          <button class="btn btn-outline" @click="$router.push(`/admin/trainings/${material.id}/import`)">
            📥 导入题目
          </button>
          <a :href="`/api/admin/quiz-import/export/${material.id}`" class="btn btn-outline" target="_blank">
            📤 导出题目
          </a>
          <button class="btn btn-outline" @click="retryAi" v-if="material.ai_status === 3">
            重新AI出题
          </button>
        </div>
      </div>

      <!-- 发布弹窗 -->
      <div v-if="showPublish" class="modal-overlay" @click.self="showPublish = false">
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
            <select v-model="publishForm.target_type" class="form-input" @change="onTargetTypeChange">
              <option value="all">全员</option>
              <option value="unit">指定承包商所有人员</option>
              <option value="specific">指定人员</option>
            </select>
          </div>
          <div v-if="publishForm.target_type === 'unit'" class="form-group">
            <label>选择承包商单位（可多选）</label>
            <div class="multi-select">
              <label v-for="u in allUnits" :key="u" class="checkbox-label">
                <input type="checkbox" :value="u" v-model="publishForm.target_value" />
                {{ u }}
              </label>
            </div>
          </div>
          <div v-if="publishForm.target_type === 'specific'" class="form-group">
            <label>搜索并选择人员</label>
            <input v-model="userSearch" class="form-input" placeholder="输入姓名搜索…" @input="searchUsers" />
            <div v-if="searchResults.length" class="user-select-list">
              <label v-for="u in searchResults" :key="u.id" class="checkbox-label">
                <input type="checkbox" :value="u.id" v-model="publishForm.target_value" />
                {{ u.name }} ({{ u.unit || '-' }})
              </label>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-outline" @click="showPublish = false">取消</button>
            <button class="btn btn-primary" @click="handlePublish" :disabled="publishing">
              {{ publishing ? '发布中…' : '确认发布' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 题目列表 -->
      <div class="card" v-if="questions.length === 0" style="padding:40px;text-align:center">
        <p style="color:var(--text-secondary);font-size:15px">暂无题目，请上传有效的通报文件触发AI出题</p>
      </div>

      <div v-for="(q, i) in questions" :key="q.id" class="card question-card">
        <div class="q-header">
          <span class="q-number">第 {{ i + 1 }} 题</span>
          <span class="badge badge-info">{{ typeLabel(q.type) }}</span>
          <span class="q-score">{{ q.score || 5 }}分</span>
        </div>
        <div class="q-body">
          <div v-if="q.image_url" class="q-image-wrapper">
            <img :src="q.image_url" class="q-image-thumb" alt="配图" />
          </div>
          <p class="q-text">{{ q.question }}</p>
          <div v-if="q.options" class="q-options">
            <div v-for="(opt, k) in parsedOptions(q.options)" :key="k" class="q-option">
              <span :class="{ highlight: q.answer && q.answer.includes(k) }">
                {{ k }}. {{ opt }}
              </span>
            </div>
          </div>
          <div class="q-meta">
            <span v-if="q.answer" class="q-answer">✅ 答案：<strong>{{ q.answer }}</strong></span>
            <span v-if="q.analysis" class="q-analysis">💡 {{ q.analysis }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '@/utils/request'

const route = useRoute()
const router = useRouter()
const material = ref({})
const questions = ref([])
const loading = ref(true)

const typeMap = { single: '单选题', multiple: '多选题', judgment: '判断题', essay: '简答题' }
const aiStatusMap = {
  0: { label: '未触发', cls: 'badge-muted' },
  1: { label: '出题中…', cls: 'badge-info' },
  2: { label: '出题成功', cls: 'badge-success' },
  3: { label: '出题失败', cls: 'badge-danger' },
}

const aiStatusLabel = computed(() => aiStatusMap[material.value.ai_status]?.label || '未知')
const aiStatusBadge = computed(() => aiStatusMap[material.value.ai_status]?.cls || '')

function typeLabel(t) { return typeMap[t] || t }

function parsedOptions(opts) {
  if (!opts) return {}
  if (typeof opts === 'string') {
    try { return JSON.parse(opts) } catch { return {} }
  }
  return opts
}

// ── 发布弹窗状态 ──
const showPublish = ref(false)
const publishing = ref(false)
const categories = ref([])
const allUnits = ref([])
const userSearch = ref('')
const searchResults = ref([])
const searchTimer = ref(null)
const publishForm = ref({ category_id: null, target_type: 'all', target_value: [] })

function onTargetTypeChange() {
  publishForm.value.target_value = []
  searchResults.value = []
  userSearch.value = ''
}

function searchUsers() {
  clearTimeout(searchTimer.value)
  if (!userSearch.value.trim()) { searchResults.value = []; return }
  searchTimer.value = setTimeout(async () => {
    try {
      const res = await request.get('/api/admin/users', { params: { keyword: userSearch.value, pageSize: 50 } })
      searchResults.value = res.data?.data?.list || []
    } catch { searchResults.value = [] }
  }, 300)
}

async function fetchCategories() {
  try {
    const [catRes, unitRes] = await Promise.all([
      request.get('/api/admin/categories'),
      request.get('/api/admin/filter-options'),
    ])
    categories.value = catRes.data?.data || []
    allUnits.value = unitRes.data?.data?.units || []
  } catch {}
}

async function handlePublish() {
  publishing.value = true
  try {
    const payload = {
      category_id: publishForm.value.category_id,
      target_type: publishForm.value.target_type,
      target_value: publishForm.value.target_value.length > 0 ? publishForm.value.target_value : null,
    }
    await request.post(`/api/material/${route.params.id}/publish`, payload)
    alert('题库已发布！')
    showPublish.value = false
    router.push('/admin/trainings')
  } catch (e) {
    alert('发布失败：' + (e.response?.data?.error || e.message))
  } finally {
    publishing.value = false
  }
}

async function fetchQuestions() {
  loading.value = true
  try {
    const res = await request.get(`/api/material/${route.params.id}/questions`)
    material.value = res.data?.data?.material || {}
    questions.value = res.data?.data?.questions || []
  } catch (e) {
    alert('获取题目失败：' + (e.response?.data?.error || e.message))
  }
  loading.value = false
}

async function retryAi() {
  try {
    await request.post(`/api/material/${route.params.id}/retry-ai`)
    alert('已重新触发AI出题，请稍后刷新查看')
    fetchQuestions()
  } catch (e) {
    alert('操作失败：' + (e.response?.data?.error || e.message))
  }
}

onMounted(() => { fetchQuestions(); fetchCategories() })
</script>

<style scoped>
.questions-page { max-width: 800px; }
.page-nav { margin-bottom: 16px; }
.back-link { background: none; border: none; color: var(--primary); font-size: 14px; cursor: pointer; }
.info-card { margin-bottom: 16px; }
.info-card h2 { font-size: 18px; margin-bottom: 8px; }
.info-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 14px; color: var(--text-secondary); }
.info-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* 发布弹窗 */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 480px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
.modal h3 { font-size: 18px; margin-bottom: 4px; }
.modal-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; font-weight: 500; }
.form-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--primary); }
.multi-select { max-height: 160px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; cursor: pointer; }
.user-select-list { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-top: 4px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.info-card h2 { font-size: 18px; margin-bottom: 8px; }
.info-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 14px; color: var(--text-secondary); }
.info-actions { display: flex; gap: 8px; }
.question-card { margin-bottom: 12px; padding: 16px; }
.q-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.q-number { font-weight: 600; font-size: 14px; }
.q-score { font-size: 12px; color: var(--text-secondary); margin-left: auto; }
.q-image-wrapper { margin-bottom: 10px; text-align: center; }
.q-image-thumb {
  max-width: 100%;
  max-height: 180px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: contain;
}
.q-text { font-size: 15px; line-height: 1.6; margin-bottom: 10px; }
.q-options { margin-bottom: 8px; }
.q-option { padding: 4px 0; font-size: 14px; }
.q-option .highlight { color: var(--success); font-weight: 500; }
.q-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; }
.q-answer { color: var(--success); }
.q-analysis { color: #666; }
.badge-muted { background: #f0f0f0; color: #999; }
</style>
