<template>
  <div class="import-page">
    <div class="page-nav">
      <button class="back-link" @click="$router.back()">← 返回题库列表</button>
    </div>

    <div class="card">
      <h2>📥 导入题目</h2>
      <p class="hint">从 Excel 模板批量导入题目到当前题库</p>

      <div class="step-list">
        <div class="step">
          <span class="step-num">1</span>
          <span>下载模板</span>
          <a :href="templateUrl" class="btn btn-outline btn-sm">📄 下载模板</a>
        </div>
        <div class="step">
          <span class="step-num">2</span>
          <span>按模板格式填写题目</span>
        </div>
        <div class="step">
          <span class="step-num">3</span>
          <span>上传 Excel 文件导入</span>
          <div class="file-upload" @click="triggerFile">
            <span>📂 {{ selectedFile ? selectedFile.name : '选择文件' }}</span>
          </div>
          <input ref="fileInput" type="file" accept=".xlsx" style="display:none" @change="e => selectedFile = e.target.files[0]" />
        </div>
      </div>

      <div class="exam-config">
        <h3>🎯 考试抽题配置</h3>
        <p class="hint">规定考试中各题型随机抽取数量（题库题目通常 &gt;100 道，避免一次考完全部）。留空或填 0 表示考该题型全部题目。</p>
        <div class="config-row">
          <label>单选题 <input type="number" min="0" v-model="examSingle" placeholder="0" /></label>
          <label>多选题 <input type="number" min="0" v-model="examMultiple" placeholder="0" /></label>
          <label>判断题 <input type="number" min="0" v-model="examJudgment" placeholder="0" /></label>
        </div>
        <div class="config-row" style="margin-top:14px;">
          <label>及格分数(%) <input type="number" min="0" max="100" v-model="passScore" placeholder="如 60" /></label>
          <label>考试时长(分钟) <input type="number" min="1" v-model="timeLimit" placeholder="如 45" /></label>
        </div>
        <p class="hint" style="margin-top:8px;">及格分按百分比判定（得分÷卷面满分×100 ≥ 设定值）；留空表示不改当前值。</p>
        <div class="form-actions" style="justify-content:flex-start;margin-top:12px;">
          <button class="btn btn-primary" @click="saveConfig" :disabled="savingConfig">{{ savingConfig ? '保存中…' : '保存考试配置' }}</button>
          <span v-if="configMsg" class="config-msg" :class="configOk ? 'ok' : 'err'">{{ configMsg }}</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" @click="$router.back()">取消</button>
        <button class="btn btn-primary" @click="handleImport" :disabled="!selectedFile || importing">
          {{ importing ? '导入中…' : '开始导入' }}
        </button>
      </div>

      <div v-if="result" class="result-box" :class="result.fail > 0 ? 'has-fail' : 'all-ok'">
        <p>✅ 成功 {{ result.success }} 条</p>
        <p v-if="result.fail > 0">❌ 失败 {{ result.fail }} 条</p>
        <div v-if="result.failPreview?.length" class="fail-list">
          <div v-for="f in result.failPreview" :key="f.row" class="fail-item">
            第 {{ f.row }} 行: {{ f.error }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '@/utils/request'

const route = useRoute()
const router = useRouter()
const materialId = route.params.id
const fileInput = ref(null)
const selectedFile = ref(null)
const importing = ref(false)
const result = ref(null)
const examSingle = ref(0)
const examMultiple = ref(0)
const examJudgment = ref(0)
const passScore = ref(null)
const timeLimit = ref(null)
const savingConfig = ref(false)
const configMsg = ref('')
const configOk = ref(false)

onMounted(async () => {
  try {
    const res = await request.get(`/api/material/${materialId}/detail`)
    const d = res.data?.data || res.data
    if (d) {
      examSingle.value = d.exam_single_num ?? 0
      examMultiple.value = d.exam_multiple_num ?? 0
      examJudgment.value = d.exam_judgment_num ?? 0
      passScore.value = (d.pass_score === undefined || d.pass_score === null) ? null : d.pass_score
      timeLimit.value = (d.time_limit === undefined || d.time_limit === null) ? null : d.time_limit
    }
  } catch (e) { /* 预填失败不阻断 */ }
})

async function saveConfig() {
  savingConfig.value = true
  configMsg.value = ''
  try {
    const payload = {
      exam_single_num: Number(examSingle.value) || 0,
      exam_multiple_num: Number(examMultiple.value) || 0,
      exam_judgment_num: Number(examJudgment.value) || 0,
    }
    if (passScore.value !== null && passScore.value !== '') payload.pass_score = Number(passScore.value)
    if (timeLimit.value !== null && timeLimit.value !== '') payload.time_limit = Number(timeLimit.value)
    const res = await request.put(`/api/material/${materialId}/exam-config`, payload)
    configOk.value = true
    configMsg.value = (res.data && (res.data.message || (res.data.data && res.data.data.message))) || '考试配置已保存'
  } catch (e) {
    configOk.value = false
    configMsg.value = (e.response && e.response.data && e.response.data.error) || '保存失败'
  } finally {
    savingConfig.value = false
  }
}

const templateUrl = computed(() => `/api/admin/quiz-import/template`)

function triggerFile() { fileInput.value?.click() }

async function handleImport() {
  if (!selectedFile.value) return
  importing.value = true
  result.value = null
  try {
    const fd = new FormData()
    fd.append('file', selectedFile.value)
    fd.append('material_id', materialId)
    fd.append('exam_single_num', Number(examSingle.value) || 0)
    fd.append('exam_multiple_num', Number(examMultiple.value) || 0)
    fd.append('exam_judgment_num', Number(examJudgment.value) || 0)
    const res = await request.post('/api/admin/quiz-import/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    result.value = res.data?.data || res.data
  } catch (e) {
    result.value = { success: 0, fail: 1, failPreview: [{ row: 0, error: e.response?.data?.error || '导入失败' }] }
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.import-page { max-width: 600px; }
.page-nav { margin-bottom: 16px; }
.back-link { background: none; border: none; color: var(--primary); font-size: 14px; cursor: pointer; }
.hint { font-size: 13px; color: var(--text-secondary); margin: 8px 0 20px; }
.step-list { display: flex; flex-direction: column; gap: 14px; margin: 20px 0; }
.step { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.step-num { width: 24px; height: 24px; border-radius: 50%; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.file-upload { padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--primary); }
.file-upload:hover { background: #e8f0fe; }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.exam-config { margin: 20px 0; padding: 14px; background: #f8faff; border: 1px solid var(--border); border-radius: 10px; }
.exam-config h3 { font-size: 14px; margin-bottom: 6px; }
.config-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.config-row label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-secondary); gap: 4px; flex: 1; min-width: 90px; }
.config-row input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; width: 100%; box-sizing: border-box; }
.form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
.result-box { margin-top: 16px; padding: 14px; border-radius: 8px; font-size: 14px; }
.result-box.has-fail { background: #fce8e6; }
.result-box.all-ok { background: #e6f4ea; }
.fail-list { margin-top: 8px; }
.fail-item { font-size: 12px; color: var(--danger); padding: 2px 0; }
.config-msg { font-size: 13px; margin-left: 10px; }
.config-msg.ok { color: var(--primary); }
.config-msg.err { color: var(--danger); }
</style>
