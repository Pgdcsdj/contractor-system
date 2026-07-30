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
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '@/utils/request'

const route = useRoute()
const router = useRouter()
const materialId = route.params.id
const fileInput = ref(null)
const selectedFile = ref(null)
const importing = ref(false)
const result = ref(null)

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
.form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
.result-box { margin-top: 16px; padding: 14px; border-radius: 8px; font-size: 14px; }
.result-box.has-fail { background: #fce8e6; }
.result-box.all-ok { background: #e6f4ea; }
.fail-list { margin-top: 8px; }
.fail-item { font-size: 12px; color: var(--danger); padding: 2px 0; }
</style>
