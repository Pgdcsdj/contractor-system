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
      <div class="toolbar-right">
        <button class="btn btn-outline" style="width:auto" :disabled="exportingList" @click="exportList">
          {{ exportingList ? '导出中…' : '📋 导出清单' }}
        </button>
        <router-link to="/admin/trainings/new" class="btn btn-primary" style="width:auto">
          ➕ 新建培训
        </router-link>
      </div>
    </div>

    <!-- 列表 -->
    <div class="card list-card">
      <div v-if="loading" class="loading"><div class="spinner"></div></div>
      <div v-else-if="filtered.length === 0" class="empty-state" style="padding:40px">
        <div class="icon">📚</div>
        <p>暂无培训</p>
      </div>
      <div v-else class="table-wrap">
        <table class="data-table train-table">
        <thead>
          <tr>
            <th class="col-title">培训标题</th>
            <th class="col-cat">分类</th>
            <th class="col-type">模式</th>
            <th class="col-num">题目数</th>
            <th class="col-score">及格分</th>
            <th class="col-time">时限</th>
            <th class="col-status">状态</th>
            <th class="col-target">目标人群</th>
            <th class="col-ai">AI</th>
            <th class="col-date">发布时间</th>
            <th class="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filtered" :key="t.id">
            <td class="title-cell col-title" :title="t.title"><strong>{{ t.title }}</strong></td>
            <td class="col-cat"><span v-if="t.category_name" class="badge badge-info">{{ t.category_name }}</span><span v-else class="badge badge-muted">未分类</span></td>
            <td class="col-type">
              <span class="badge" :class="modeBadge(t.mode)">{{ modeLabel(t.mode) }}</span>
            </td>
            <td class="col-num">{{ t.total_questions || 0 }}</td>
            <td class="nowrap col-score">{{ t.pass_score ?? 60 }}分</td>
            <td class="nowrap col-time">{{ t.time_limit ?? 30 }}分钟</td>
            <td class="col-status">
              <span :class="['badge', statusBadge(t.status)]">
                {{ statusLabel(t.status) }}
              </span>
            </td>
            <td class="col-target">
              <span class="badge badge-muted" :title="targetLabel(t)">{{ targetShort(t) }}</span>
            </td>
            <td class="col-ai">
              <span v-if="t.ai_status === 0" class="badge badge-muted">未触发</span>
              <span v-else-if="t.ai_status === 1" class="badge badge-info">出题中…</span>
              <span v-else-if="t.ai_status === 2" class="badge badge-success">已就绪</span>
              <span v-else-if="t.ai_status === 3" class="badge badge-danger">出题失败</span>
              <span v-else class="badge badge-muted">{{ t.ai_status }}</span>
            </td>
            <td class="nowrap col-date">{{ t.published_at ? formatDate(t.published_at) : '-' }}</td>
            <td class="col-ops">
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
                <!-- 考试随机抽题组卷配置（仅考试模式生效） -->
                <button
                  :class="['action-link', 'examcfg', { configured: examConfigured(t) }]"
                  :title="examConfigTip(t)"
                  @click="openExamConfig(t)"
                >
                  🎯 抽题{{ examConfigLabel(t) }}
                </button>
                <button
                  class="action-link export"
                  title="导出该题库全部题目（xlsx）"
                  @click="exportQuestions(t)"
                >
                  导出
                </button>
                <button
                  v-if="t.status === 'pending' && t.total_questions > 0"
                  class="action-link success"
                  @click="publishForm = { ...t }; showQuickPublish = true"
                >
                  发布
                </button>
                <button
                  v-if="t.status === 'closed'"
                  class="action-link success"
                  title="重新上线，保留原目标人群与考试配置"
                  @click="republish(t)"
                >
                  重新发布
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
          <select v-model="publishForm.target_type" class="form-input" @change="onTargetTypeChange">
            <option value="all">全员</option>
            <option value="unit">指定承包商所有人员</option>
            <option value="position">指定岗位（管理岗/操作岗）</option>
            <option value="specific">指定人员</option>
          </select>
        </div>
        <div v-if="publishForm.target_type === 'position'" class="form-group">
          <label>选择岗位（可多选）</label>
          <div class="multi-select">
            <label v-for="p in allPositions" :key="p" class="checkbox-label">
              <input type="checkbox" :value="p" v-model="publishForm.target_value" />
              {{ p }}
            </label>
          </div>
        </div>
        <div v-if="publishForm.target_type === 'unit'" class="form-group">
          <label>选择承包商单位（可多选）</label>
          <select v-model="filterGridL2" class="form-input" style="margin-bottom:8px">
            <option value="">全部板块</option>
            <option v-for="g in gridL2Options" :key="g" :value="g">{{ g }}</option>
          </select>
          <div class="multi-select">
            <label v-for="u in filteredUnits" :key="u.id" class="checkbox-label">
              <input type="checkbox" :value="u.unit_name" v-model="publishForm.target_value" />
              {{ u.unit_name }}
            </label>
          </div>
        </div>
        <div v-if="publishForm.target_type === 'specific'" class="form-group">
          <label>选择人员（已加载 {{ allUsers.length }} 人，可输入姓名筛选）</label>
          <input v-model="userSearch" class="form-input" placeholder="输入姓名筛选…" @input="filterUsers" />
          <div v-if="filteredUsers.length" class="user-select-list">
            <label v-for="u in filteredUsers" :key="u.id" class="checkbox-label">
              <input type="checkbox" :value="u.id" v-model="publishForm.target_value" />
              {{ u.name }} ({{ u.unit || '-' }})
            </label>
          </div>
          <div v-else-if="!loadingUsers" class="user-empty">未找到匹配人员</div>
          <div v-if="loadingUsers" class="user-empty">加载人员中…</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showQuickPublish = false">取消</button>
          <button class="btn btn-primary" @click="handleQuickPublish" :disabled="publishing">
            {{ publishing ? '发布中…' : '确认发布' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 考试抽题配置弹窗 -->
    <div v-if="showExamConfig" class="modal-overlay" @click.self="showExamConfig = false">
      <div class="modal">
        <h3>🎯 考试配置</h3>
        <p class="modal-hint">{{ examConfigForm.title }}</p>
        <div class="config-row">
          <label>
            考试时长（分钟）
            <input type="number" min="1" max="600" v-model.number="examConfigForm.time_limit" placeholder="30" />
          </label>
          <label>
            及格分（百分比）
            <input type="number" min="0" max="100" v-model.number="examConfigForm.pass_score" placeholder="60" />
          </label>
        </div>
        <p class="exam-tip">
          设置考试时各题型<b>随机抽取</b>的题目数量与<b>每题分数</b>。数量留空或填 <b>0</b> 表示该题型<b>全部抽取</b>；
          三项均为 0 则考题库全部题目；分数留空或填 <b>0</b> 表示沿用题目自身分值。<br />
          仅 <b>考试</b> 模式生效，学习 / 练习模式始终使用全部题目。
        </p>
        <div class="config-row">
          <label>
            单选题
            <input type="number" min="0" v-model.number="examConfigForm.exam_single_num" placeholder="0" />
          </label>
          <label>
            多选题
            <input type="number" min="0" v-model.number="examConfigForm.exam_multiple_num" placeholder="0" />
          </label>
          <label>
            判断题
            <input type="number" min="0" v-model.number="examConfigForm.exam_judgment_num" placeholder="0" />
          </label>
        </div>
        <div class="config-row">
          <label>
            单选每题分
            <input type="number" min="0" step="0.5" v-model.number="examConfigForm.exam_single_score" placeholder="0" />
          </label>
          <label>
            多选每题分
            <input type="number" min="0" step="0.5" v-model.number="examConfigForm.exam_multiple_score" placeholder="0" />
          </label>
          <label>
            判断每题分
            <input type="number" min="0" step="0.5" v-model.number="examConfigForm.exam_judgment_score" placeholder="0" />
          </label>
        </div>
        <div class="config-row" style="margin-top:10px;align-items:center">
          <label style="flex:0 0 auto">默认模式</label>
          <select v-model="examConfigForm.mode" class="form-input" style="max-width:220px">
            <option v-for="(label, val) in MODE_LABELS" :key="val" :value="val">{{ label }}</option>
          </select>
          <span class="mode-tip">扫码进入 / 学员默认进入的模式</span>
        </div>
        <p v-if="examConfigForm.mode && examConfigForm.mode !== 'exam'" class="mode-warn">
          ⚠️ 该题库默认模式为「{{ MODE_LABELS[examConfigForm.mode] || examConfigForm.mode }}」，
          抽题配置仅在以「考试」模式作答时生效。
        </p>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showExamConfig = false">取消</button>
          <button class="btn btn-primary" @click="saveExamConfig" :disabled="savingExamConfig">
            {{ savingExamConfig ? '保存中…' : '保存' }}
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
import { MODE_LABELS } from '@/utils/quizModes'
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

// ── 发布目标人群：单位 / 指定人员 ──
const allUnits = ref([])
const filterGridL2 = ref('')
const gridL2Options = [
  '钻前工程',
  '钻井工程',
  '试气作业工程',
  '地面工程',
  '生产运行',
  '工程监督',
  '后勤保障',
]
const filteredUnits = computed(() =>
  filterGridL2.value ? allUnits.value.filter(u => u.grid_l2 === filterGridL2.value) : allUnits.value
)
const allPositions = ref(['管理岗', '操作岗', '中层干部'])
const userSearch = ref('')
const allUsers = ref([])
const loadingUsers = ref(false)
const searchTimer = ref(null)

const filteredUsers = computed(() => {
  // 后端已按 keyword 过滤返回结果，直接展示
  return allUsers.value
})

function onTargetTypeChange() {
  publishForm.value.target_value = []
  userSearch.value = ''
  filterGridL2.value = ''
  if (publishForm.value.target_type === 'specific') loadAllUsers('')
}

function filterUsers() {
  clearTimeout(searchTimer.value)
  // 把搜索词发给后端，跨全库检索（不再只筛本地前100条）
  searchTimer.value = setTimeout(() => {
    loadAllUsers(userSearch.value.trim())
  }, 250)
}

async function loadAllUsers(keyword = '') {
  loadingUsers.value = true
  try {
    const res = await request.get('/api/admin/users', { params: { pageSize: 200, keyword } })
    allUsers.value = res.data?.data?.list || []
  } catch (e) {
    console.error('[loadAllUsers]', e)
    allUsers.value = []
  } finally {
    loadingUsers.value = false
  }
}

// ── QR 码状态 ──
const qrVisible = ref(false)
const qrTrainingTitle = ref('')
const qrDataUrl = ref('')
const qrQuizUrl = ref('')

const filtered = computed(() => {
  if (!filterStatus.value) return trainings.value
  return trainings.value.filter((t) => t.status === filterStatus.value)
})

const statusMap = { pending: '待发布', published: '已发布', closed: '已关闭' }

function statusLabel(s) { return statusMap[s] || s }
function targetLabel(t) {
  const type = t.target_type || 'all'
  try {
    const val = typeof t.target_value === 'string' ? JSON.parse(t.target_value || 'null') : t.target_value
    if (type === 'unit')      return '承包商：' + (val && val.length ? val.join('、') : '全部')
    if (type === 'position')  return '岗位：' + (val && val.length ? val.join('、') : '未选')
    if (type === 'specific')  return '指定人员 ' + (val && val.length ? val.length : 0) + ' 人'
    return '全员'
  } catch {
    return '全员'
  }
}
function statusBadge(s) {
  return { pending: 'badge-warning', published: 'badge-success', closed: 'badge-danger' }[s] || ''
}
// 三模式：study 学习 / practice 练习 / exam 考试
const modeMap = { study: '学习', practice: '练习', exam: '考试' }
function modeLabel(m) { return modeMap[m] || m || '-' }
function modeBadge(m) {
  return { study: 'badge-info', practice: 'badge-warning', exam: 'badge-success' }[m] || 'badge-muted'
}
// 列表里的紧凑写法（完整内容见 title 提示）
function targetShort(t) {
  const type = t.target_type || 'all'
  let val = t.target_value
  try { val = typeof val === 'string' ? JSON.parse(val || 'null') : val } catch { val = null }
  const n = Array.isArray(val) ? val.length : 0
  if (type === 'unit') return n ? `承包商${n}` : '承包商'
  if (type === 'position') return n ? `岗位${n}` : '岗位'
  if (type === 'specific') return `指定${n}人`
  return '全员'
}
function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth()+1}月${d.getDate()}日`
}

// ── 考试随机抽题配置 ──
const showExamConfig = ref(false)
const savingExamConfig = ref(false)
const examConfigForm = ref({
  id: null,
  title: '',
  mode: 'exam',
  time_limit: 30,
  pass_score: 60,
  exam_single_num: 0,
  exam_multiple_num: 0,
  exam_judgment_num: 0,
  exam_single_score: 0,
  exam_multiple_score: 0,
  exam_judgment_score: 0,
})

// 该题库是否已配置了抽题（三项之和 > 0）
function examConfigured(t) {
  return (Number(t?.exam_single_num) || 0) + (Number(t?.exam_multiple_num) || 0) + (Number(t?.exam_judgment_num) || 0) > 0
}

// 按钮上显示的抽题数量，例：「 15/10/5」（未配置时返回空串）
function examConfigLabel(t) {
  if (!examConfigured(t)) return ''
  return ` ${Number(t.exam_single_num) || 0}/${Number(t.exam_multiple_num) || 0}/${Number(t.exam_judgment_num) || 0}`
}

// 鼠标悬停提示：分别说明各题型抽题数（0 表示全抽）
function examConfigTip(t) {
  if (!examConfigured(t)) return '设置考试随机抽题数量（当前：考全部题目）'
  const n = (v) => (Number(v) || 0) > 0 ? `${v} 题` : '全抽'
  return `考试抽题 — 单选 ${n(t.exam_single_num)} / 多选 ${n(t.exam_multiple_num)} / 判断 ${n(t.exam_judgment_num)}`
}

function openExamConfig(t) {
  examConfigForm.value = {
    id: t.id,
    title: t.title,
    mode: t.mode || 'exam',
    time_limit: Number(t.time_limit) || 30,
    pass_score: Number(t.pass_score ?? 60),
    exam_single_num: Number(t.exam_single_num) || 0,
    exam_multiple_num: Number(t.exam_multiple_num) || 0,
    exam_judgment_num: Number(t.exam_judgment_num) || 0,
    exam_single_score: Number(t.exam_single_score) || 0,
    exam_multiple_score: Number(t.exam_multiple_score) || 0,
    exam_judgment_score: Number(t.exam_judgment_score) || 0,
  }
  showExamConfig.value = true
}

async function saveExamConfig() {
  if (!examConfigForm.value.id) return
  savingExamConfig.value = true
  try {
    await request.put(`/api/material/${examConfigForm.value.id}/exam-config`, {
      mode: examConfigForm.value.mode,
      time_limit: Math.min(600, Math.max(1, Number(examConfigForm.value.time_limit) || 30)),
      pass_score: Math.min(100, Math.max(0, Number(examConfigForm.value.pass_score) || 0)),
      exam_single_num: Math.max(0, Number(examConfigForm.value.exam_single_num) || 0),
      exam_multiple_num: Math.max(0, Number(examConfigForm.value.exam_multiple_num) || 0),
      exam_judgment_num: Math.max(0, Number(examConfigForm.value.exam_judgment_num) || 0),
      exam_single_score: Math.max(0, Number(examConfigForm.value.exam_single_score) || 0),
      exam_multiple_score: Math.max(0, Number(examConfigForm.value.exam_multiple_score) || 0),
      exam_judgment_score: Math.max(0, Number(examConfigForm.value.exam_judgment_score) || 0),
    })
    showExamConfig.value = false
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '保存失败')
  } finally {
    savingExamConfig.value = false
  }
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

// ── 重新发布（已关闭的题库再次上线，保留原目标人群与考试配置）──────────────
async function republish(t) {
  const tip = `确认重新发布「${t.title}」？\n\n` +
    `• 题目 ${t.total_questions || 0} 道，发布后承包商可再次进入答题\n` +
    `• 原目标人群（${targetLabel(t)}）与考试配置保持不变\n` +
    `• 历史答题记录保留，不会清空`
  if (!confirm(tip)) return
  try {
    const res = await request.post(`/api/material/${t.id}/republish`)
    alert(res.data?.message || '已重新发布')
    await fetchTrainings()
  } catch (e) {
    alert(e.response?.data?.error || '重新发布失败')
  }
}

// ── 导出（题目 / 清单）────────────────────────────────────────────────────
const exportingList = ref(false)

function downloadBlob(res, filename) {
  const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

async function exportQuestions(t) {
  try {
    const res = await request.get(`/api/material/${t.id}/export`, { responseType: 'blob', timeout: 300000 })
    downloadBlob(res, `${String(t.title || '题库').slice(0, 40)}_题库导出.xlsx`)
  } catch (e) {
    alert('导出失败：' + (e.message || '请求出错'))
  }
}

async function exportList() {
  exportingList.value = true
  try {
    const res = await request.get('/api/material/export-list', { responseType: 'blob', timeout: 300000 })
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    downloadBlob(res, `题库清单_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.xlsx`)
  } catch (e) {
    alert('导出清单失败：' + (e.message || '请求出错'))
  } finally {
    exportingList.value = false
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
    const [catRes, optRes] = await Promise.all([
      request.get('/api/admin/categories'),
      request.get('/api/contractor-units/options'),
    ])
    categories.value = catRes.data?.data || []
    allUnits.value = optRes.data?.data || []
  } catch {}
}
</script>

<style scoped>
/* 自适应宽度：随容器撑满，容器变窄时横向滚动而非挤压内容 */
.trainings-page { max-width: 100%; }

.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.filter-group { display: flex; gap: 8px; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }
.nowrap { white-space: nowrap; }
.filter-select {
  padding: 9px 12px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 14px; background: #fff;
}
.list-card { padding: 0; overflow: hidden; }

/* ===== 题库列表：自适应表格 ===== */
.table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.train-table {
  table-layout: fixed;
  width: 100%;
  min-width: 960px; /* 11 列的最小可读宽度；低于此宽度才横向滚动 */
}
.train-table th,
.train-table td { white-space: nowrap; overflow: hidden; }
.list-card .train-table th,
.list-card .train-table td { padding: 10px 8px; }
.train-table th { white-space: nowrap; }
.train-table .col-title { width: 186px; white-space: normal; }
.train-table .col-cat { width: 74px; }
.train-table .col-type { width: 56px; }
.train-table .col-num { width: 58px; text-align: center; }
.train-table .col-score { width: 58px; text-align: center; }
.train-table .col-time { width: 62px; text-align: center; }
.train-table .col-status { width: 64px; }
.train-table .col-target { width: 78px; }
.train-table .col-ai { width: 68px; }
.train-table .col-date { width: 78px; }
.train-table .col-ops { width: 178px; white-space: normal; }
/* 紧凑徽章：左右内边距收窄，避免「专项培训」被截成「专项…」 */
.train-table .badge { padding-left: 5px; padding-right: 5px; }

/* 标题最多两行，超出省略；完整标题在 hover title 提示里 */
.title-cell strong {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; white-space: normal; word-break: break-word;
  line-height: 1.45; font-weight: 600;
}
/* 徽章单行不换行；超宽省略 */
.train-table .badge {
  display: inline-block; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  vertical-align: middle;
}

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
/* 列表内操作按钮排紧一些，控制在 2 行内 */
.train-table .action-btns { gap: 2px 3px; }
.train-table .action-link { padding: 2px 4px; font-size: 12px; }
.train-table th.col-num,
.train-table th.col-score,
.train-table th.col-time { text-align: center; }
.action-link {
  background: none; border: none; cursor: pointer;
  font-size: 13px; font-weight: 500; padding: 3px 8px;
  border-radius: 6px; text-decoration: none;
}
.action-link.success { color: var(--success); }
.action-link.success:hover { background: #e6f4ea; }
.action-link.qrcode { color: #1a73e8; }
.action-link.qrcode:hover { background: #e8f0fe; }
.action-link.export { color: #0b7285; }
.action-link.export:hover { background: #e3f4f7; }
.action-link.quality { color: #7b1fa2; }
.action-link.quality:hover { background: #f3e5f5; }
.action-link.examcfg { color: #c2740b; }
.action-link.examcfg:hover { background: #fbf1e0; }
/* 已配置过抽题数量的题库：按钮加粗高亮，便于一眼识别 */
.action-link.examcfg.configured { color: #b45309; font-weight: 700; }

/* ── 考试抽题配置弹窗 ── */
.exam-tip {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 14px;
}
.config-row { display: flex; gap: 10px; flex-wrap: wrap; }
.config-row label {
  flex: 1;
  min-width: 90px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.config-row input {
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  width: 100%;
  box-sizing: border-box;
}
.config-row input:focus { outline: none; border-color: var(--primary); }
.mode-warn {
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  background: #fff7e6;
  color: #ad6800;
  font-size: 12px;
  line-height: 1.6;
}
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
.user-empty { margin-top: 6px; font-size: 13px; color: var(--text-secondary); text-align: center; padding: 8px; }
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
