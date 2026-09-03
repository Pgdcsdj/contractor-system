<template>
  <div class="import-page">
    <div class="page-nav">
      <button class="back-link" @click="$router.back()">← 返回题库列表</button>
    </div>

    <div class="card">
      <h2>📥 导入题目</h2>
      <p class="hint">支持从 Excel 模板或 Word 试卷（.docx）批量导入题目，含主观题（简答 / 案例分析）。</p>

      <div class="mode-tabs">
        <button :class="['tab', mode === 'excel' ? 'active' : '']" @click="mode = 'excel'">📊 Excel 模板</button>
        <button :class="['tab', mode === 'docx' ? 'active' : '']" @click="mode = 'docx'">📄 Word 试卷</button>
      </div>

      <!-- Excel 模式 -->
      <div v-if="mode === 'excel'" class="mode-body">
        <div class="step-list">
          <div class="step">
            <span class="step-num">1</span>
            <span>下载模板</span>
            <button class="btn btn-outline btn-sm" @click="downloadTemplate">📄 下载模板</button>
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
      </div>

      <!-- Word 模式 -->
      <div v-else class="mode-body">
        <p class="hint">上传「试题卷.docx」与「参考答案.docx」。系统按章节标题（选择题 / 判断题 / 简答题 / 案例分析题 …）自动识别题型与每题分值，主观题参考答案整段存入题库。<br/>参考答案可选；若缺答案，客观题将标记「缺少答案」、主观题参考答案留空。</p>
        <div class="step-list">
          <div class="step">
            <span class="step-num">1</span>
            <span>试题卷（必填）</span>
            <div class="file-upload" @click="triggerQ">
              <span>📄 {{ qFile ? qFile.name : '选择试题卷 .docx' }}</span>
            </div>
            <input ref="qInput" type="file" accept=".docx" style="display:none" @change="e => qFile = e.target.files[0]" />
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <span>参考答案（可选）</span>
            <div class="file-upload" @click="triggerA">
              <span>📘 {{ aFile ? aFile.name : '选择参考答案 .docx' }}</span>
            </div>
            <input ref="aInput" type="file" accept=".docx" style="display:none" @change="e => aFile = e.target.files[0]" />
          </div>
        </div>
      </div>

      <div class="exam-config">
        <h3>🎯 考试抽题配置</h3>
        <p class="hint">规定考试中各题型随机抽取数量与每题分数（题库题目通常 &gt;100 道，避免一次考完全部）。数量留空或填 0 表示考该题型全部题目；分数留空或填 0 表示沿用题目自身分值。</p>
        <div class="config-row">
          <label>单选题 <input type="number" min="0" v-model="examSingle" placeholder="0" /></label>
          <label>多选题 <input type="number" min="0" v-model="examMultiple" placeholder="0" /></label>
          <label>判断题 <input type="number" min="0" v-model="examJudgment" placeholder="0" /></label>
        </div>
        <div class="config-row">
          <label>单选每题分 <input type="number" min="0" step="0.5" v-model="examSingleScore" placeholder="0" /></label>
          <label>多选每题分 <input type="number" min="0" step="0.5" v-model="examMultipleScore" placeholder="0" /></label>
          <label>判断每题分 <input type="number" min="0" step="0.5" v-model="examJudgmentScore" placeholder="0" /></label>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" @click="$router.back()">取消</button>
        <button class="btn btn-primary" @click="handleImport" :disabled="!canImport || importing">
          {{ importing ? '导入中…' : '开始导入' }}
        </button>
      </div>

      <div v-if="result" class="result-box" :class="result.fail > 0 ? 'has-fail' : 'all-ok'">
        <p>✅ 成功 {{ result.success }} 条</p>
        <p v-if="result.fail > 0">❌ 失败 {{ result.fail }} 条</p>
        <div v-if="result.data?.validation" class="val-box">
          <span>题型分布：</span>
          <span v-if="result.data.validation.perType">单选 {{ result.data.validation.perType.single }} · 多选 {{ result.data.validation.perType.multiple }} · 判断 {{ result.data.validation.perType.judgment }} · 简答/案例 {{ result.data.validation.perType.essay }}</span>
        </div>
        <div v-if="result.failPreview?.length" class="fail-list">
          <div v-for="f in result.failPreview" :key="f.row || f.index" class="fail-item">
            第 {{ f.row || f.index }} 项: {{ f.error }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '@/utils/request'

const route = useRoute()
const router = useRouter()
const materialId = route.params.id
const mode = ref('excel')
const fileInput = ref(null)
const qInput = ref(null)
const aInput = ref(null)
const selectedFile = ref(null)
const qFile = ref(null)
const aFile = ref(null)
const importing = ref(false)
const result = ref(null)
const examSingle = ref(0)
const examMultiple = ref(0)
const examJudgment = ref(0)
// 每题分数：0 = 沿用题目自身分值
const examSingleScore = ref(0)
const examMultipleScore = ref(0)
const examJudgmentScore = ref(0)

const canImport = computed(() => {
  if (mode.value === 'excel') return !!selectedFile.value
  return !!qFile.value
})

function triggerFile() { fileInput.value?.click() }
function triggerQ() { qInput.value?.click() }
function triggerA() { aInput.value?.click() }

// 将 File 读入内存 Blob 后再上传：避免源文件（如正被 Excel 打开）在上传途中被改写，
// 触发浏览器 ERR_UPLOAD_FILE_CHANGED 而中断上传（表现为「无反应/导入失败」）。
async function fileToBlob(file) {
  const buf = await file.arrayBuffer()
  return new Blob([buf], { type: file.type || 'application/octet-stream' })
}

// 下载 Excel 导入模板：走 axios（自动带 tnb_admin_token），避免 <a href> 无鉴权 401
async function downloadTemplate() {
  try {
    const res = await request.get('/api/admin/quiz-import/template', {
      responseType: 'blob',
    })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = '题库导入模板.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(e.response?.data?.error || '下载模板失败')
  }
}

async function handleImport() {
  if (!canImport.value || importing.value) return
  importing.value = true
  result.value = null
  try {
    const fd = new FormData()
    fd.append('material_id', materialId)
    fd.append('exam_single_num', Number(examSingle.value) || 0)
    fd.append('exam_multiple_num', Number(examMultiple.value) || 0)
    fd.append('exam_judgment_num', Number(examJudgment.value) || 0)
    fd.append('exam_single_score', Number(examSingleScore.value) || 0)
    fd.append('exam_multiple_score', Number(examMultipleScore.value) || 0)
    fd.append('exam_judgment_score', Number(examJudgmentScore.value) || 0)
    let url
    if (mode.value === 'excel') {
      // 读入内存后上传，规避源文件被占用导致的上传中断
      fd.append('file', await fileToBlob(selectedFile.value), selectedFile.value.name)
      url = '/api/admin/quiz-import/import'
    } else {
      fd.append('questions', await fileToBlob(qFile.value), qFile.value.name)
      if (aFile.value) fd.append('answers', await fileToBlob(aFile.value), aFile.value.name)
      url = '/api/admin/quiz-import/import-docx'
    }
    // 不显式设置 Content-Type，交由 axios 自动携带 multipart boundary
    const res = await request.post(url, fd)
    result.value = res.data?.data || res.data
  } catch (e) {
    result.value = { success: 0, fail: 1, failPreview: [{ error: e.response?.data?.error || '导入失败，请关闭文件后重试' }] }
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.import-page { max-width: 640px; }
.page-nav { margin-bottom: 16px; }
.back-link { background: none; border: none; color: var(--primary); font-size: 14px; cursor: pointer; }
.hint { font-size: 13px; color: var(--text-secondary); margin: 8px 0 20px; line-height: 1.6; }
.mode-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.tab { padding: 8px 16px; border: 1px solid var(--border); border-radius: 8px; background: #fff; cursor: pointer; font-size: 14px; color: var(--text-secondary); }
.tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }
.mode-body { margin: 8px 0 4px; }
.step-list { display: flex; flex-direction: column; gap: 14px; margin: 20px 0; }
.step { display: flex; align-items: center; gap: 10px; font-size: 14px; flex-wrap: wrap; }
.step-num { width: 24px; height: 24px; border-radius: 50%; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.file-upload { padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--primary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.val-box { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
.fail-list { margin-top: 8px; }
.fail-item { font-size: 12px; color: var(--danger); padding: 2px 0; }
</style>
