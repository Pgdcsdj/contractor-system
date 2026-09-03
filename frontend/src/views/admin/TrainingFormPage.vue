<template>
  <div class="form-page">
    <div class="page-nav">
      <button class="back-link" @click="$router.back()">← 返回列表</button>
    </div>

    <!-- 模式选择 -->
    <div v-if="!mode" class="card">
      <h2>📤 新建培训 — 选择创建方式</h2>
      <div class="mode-cards">
        <div class="mode-card" @click="mode = 'ai'">
          <div class="mode-icon">🤖</div>
          <div class="mode-title">AI 智能出题</div>
          <div class="mode-desc">上传培训素材（文档/视频），AI 自动生成题目</div>
          <div class="mode-arrow">→</div>
        </div>
        <div class="mode-card" @click="mode = 'import'">
          <div class="mode-icon">📥</div>
          <div class="mode-title">导入已有题库</div>
          <div class="mode-desc">支持 Excel 模板 / Word 试卷，按格式填写后一键导入</div>
          <div class="mode-arrow">→</div>
        </div>
        <div class="mode-card" @click="mode = 'image_violation'">
          <div class="mode-icon">🖼️</div>
          <div class="mode-title">违章图片识别</div>
          <div class="mode-desc">上传带图片的违章通报，AI 自动识别隐患并出题</div>
          <div class="mode-arrow">→</div>
        </div>
      </div>
    </div>

    <!-- ===== 模式 A：AI 智能出题 ===== -->
    <div v-else-if="mode === 'ai'" class="card">
      <div class="mode-header">
        <button class="back-link" @click="mode = null">← 切换方式</button>
        <h2>🤖 AI 智能出题</h2>
      </div>

      <div class="form-body">
        <div class="form-group">
          <label>培训标题 *</label>
          <input v-model="form.title" class="form-input" placeholder="例如：2026年5月钻井违章通报培训" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>素材类型</label>
            <select v-model="form.material_type" class="form-input">
              <option value="video">📹 视频通报</option>
              <option value="regulation">📄 制度文件</option>
              <option value="other">📁 其他</option>
            </select>
          </div>
          <div class="form-group">
            <label>题库分类</label>
            <select v-model="form.category_id" class="form-input">
              <option :value="null">未分类</option>
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>及格分数</label>
            <input v-model.number="form.pass_score" type="number" class="form-input" min="0" max="100" />
          </div>
          <div class="form-group">
            <label>答题时限（分钟）</label>
            <input v-model.number="form.time_limit" type="number" class="form-input" min="5" max="180" />
          </div>
          <div class="form-group">
            <label>默认模式</label>
            <select v-model="form.mode" class="form-input">
              <option v-for="(label, val) in MODE_LABELS" :key="val" :value="val">{{ label }}</option>
            </select>
          </div>
        </div>

        <!-- 文件上传 -->
        <div class="form-group">
          <label>培训素材（PDF/Word/视频）</label>
          <div class="file-upload-zone" @click="triggerFile" :class="{ dragover: isDragover }"
            @dragover.prevent="isDragover = true"
            @dragleave="isDragover = false"
            @drop.prevent="handleDrop">
            <span class="upload-icon">📂</span>
            <p>{{ selectedFile ? selectedFile.name : '点击或拖拽上传文件' }}</p>
            <p class="upload-hint">支持 PDF、Word、MP4，最大 100MB</p>
          </div>
          <input ref="fileInput" type="file" accept=".pdf,.doc,.docx,.mp4,.avi" style="display:none" @change="handleFileChange" />
          <div v-if="uploadProgress > 0 && uploadProgress < 100" class="progress-bar" style="margin-top:8px">
            <div class="progress-fill" :style="{ width: uploadProgress + '%' }"></div>
          </div>
        </div>

        <!-- AI 出题配置 -->
        <div class="form-group">
          <label>AI 出题配置</label>
          <div class="ai-config">
            <label class="checkbox-label">
              <input type="checkbox" v-model="form.ai_enabled" />
              启用 AI 自动出题（DeepSeek）
            </label>
            <div v-if="form.ai_enabled" class="ai-params">
              <div class="form-row">
                <div class="form-group">
                  <label>题目类型</label>
                  <select v-model="form.ai_question_types" class="form-input">
                    <option value="choice">单选题</option>
                    <option value="mixed">单选+多选+简答</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>题目数量</label>
                  <input v-model.number="form.ai_question_count" type="number" class="form-input" min="5" max="50" />
                </div>
                <div class="form-group">
                  <label>难度</label>
                  <select v-model.number="form.difficulty" class="form-input">
                    <option :value="1">1 - 基础（识记）</option>
                    <option :value="2">2 - 基础（复现）</option>
                    <option :value="3" selected>3 - 应用（默认）</option>
                    <option :value="4">4 - 深入（分析）</option>
                    <option :value="5">5 - 深入（综合）</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" @click="mode = null">上一步</button>
        <button class="btn btn-primary" @click="handleAiSubmit" :disabled="submitting || !form.title">
          {{ submitting ? '提交中…' : '上传素材并创建' }}
        </button>
      </div>

      <div v-if="result" class="result-msg" :class="result.error ? 'error' : 'ok'">
        {{ result.error || result.message }}
      </div>
    </div>

    <!-- ===== 模式 C：违章图片识别 ===== -->
    <div v-else-if="mode === 'image_violation'" class="card">
      <div class="mode-header">
        <button class="back-link" @click="mode = null">← 切换方式</button>
        <h2>🖼️ 违章图片识别题库</h2>
      </div>

      <div class="form-body">
        <div class="form-group">
          <label>培训标题 *</label>
          <input v-model="imgForm.title" class="form-input" placeholder="例如：2026年5月吊装违章图片识别培训" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>题库分类</label>
            <select v-model="imgForm.category_id" class="form-input">
              <option :value="null">未分类</option>
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>及格分数</label>
            <input v-model.number="imgForm.pass_score" type="number" class="form-input" min="0" max="100" />
          </div>
          <div class="form-group">
            <label>答题时限（分钟）</label>
            <input v-model.number="imgForm.time_limit" type="number" class="form-input" min="5" max="180" />
          </div>
          <div class="form-group">
            <label>默认模式</label>
            <select v-model="imgForm.mode" class="form-input">
              <option v-for="(label, val) in MODE_LABELS" :key="val" :value="val">{{ label }}</option>
            </select>
          </div>
        </div>

        <!-- 文件上传 -->
        <div class="form-group">
          <label>违章通报文档（含图片）*</label>
          <div class="file-upload-zone" @click="triggerImgFile" :class="{ dragover: imgDragover }"
            @dragover.prevent="imgDragover = true"
            @dragleave="imgDragover = false"
            @drop.prevent="handleImgDrop">
            <span class="upload-icon">🖼️</span>
            <p>{{ imgFile ? imgFile.name : '点击或拖拽上传 Word/PDF 文档' }}</p>
            <p class="upload-hint">支持 DOCX、PDF 格式，最大 20MB<br>文档中需包含违章现场照片</p>
          </div>
          <input ref="imgFileInput" type="file" accept=".docx,.pdf" style="display:none" @change="handleImgFileChange" />
          <div v-if="imgUploadProgress > 0 && imgUploadProgress < 100" class="progress-bar" style="margin-top:8px">
            <div class="progress-fill" :style="{ width: imgUploadProgress + '%' }"></div>
          </div>
        </div>

        <!-- AI 说明 -->
        <div class="form-group">
          <div class="ai-config" style="background: #fff7e6; border: 1px solid #ffd8a8;">
            <label class="checkbox-label" style="font-weight: 500; color: #d46b08;">
              <span>🧠</span> 将使用 AI Vision 模型分析图片中的隐患并自动出题
            </label>
            <p style="font-size: 12px; color: #ad6800; margin: 6px 0 0 26px; line-height: 1.5;">
              请确保后台 AI 配置中已设置支持图片理解的模型（如 Qwen2-VL 或 GPT-4o）。<br>
              当前默认出题 15 道（单选+多选+判断+填空），您可在题目审核页调整。
            </p>
            <div class="form-row" style="margin-top: 10px;">
              <div class="form-group" style="min-width: 120px;">
                <label style="font-size: 12px;">难度</label>
                <select v-model.number="imgForm.difficulty" class="form-input" style="font-size: 13px;">
                  <option :value="1">1 - 基础</option>
                  <option :value="2">2 - 基础</option>
                  <option :value="3" selected>3 - 应用（默认）</option>
                  <option :value="4">4 - 深入</option>
                  <option :value="5">5 - 深入</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" @click="mode = null">上一步</button>
        <button class="btn btn-primary" @click="handleImgSubmit" :disabled="imgSubmitting || !imgForm.title || !imgFile">
          {{ imgSubmitting ? '上传并分析中…' : '上传素材并出题' }}
        </button>
      </div>

      <div v-if="imgResult" class="result-msg" :class="imgResult.error ? 'error' : 'ok'">
        {{ imgResult.error || imgResult.message }}
      </div>
    </div>

    <!-- ===== 模式 B：导入已有题库 ===== -->
    <div v-else-if="mode === 'import'" class="card">
      <div class="mode-header">
        <button class="back-link" @click="mode = null">← 切换方式</button>
        <h2>📥 导入已有题库</h2>
      </div>

      <!-- 步骤1：填写基本信息 + 下载模板 -->
      <div v-if="!importStep || importStep === 1">
        <div class="form-body">
          <div class="form-group">
            <label>培训标题 *</label>
            <input v-model="importForm.title" class="form-input" placeholder="例如：2026年Q2安全培训考核" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>题库分类</label>
              <select v-model="importForm.category_id" class="form-input">
                <option :value="null">未分类</option>
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>及格分数</label>
              <input v-model.number="importForm.pass_score" type="number" class="form-input" min="0" max="100" />
            </div>
          <div class="form-group">
            <label>答题时限（分钟）</label>
            <input v-model.number="importForm.time_limit" type="number" class="form-input" min="5" max="180" />
          </div>
          <div class="form-group">
            <label>默认模式</label>
            <select v-model="importForm.mode" class="form-input">
              <option v-for="(label, val) in MODE_LABELS" :key="val" :value="val">{{ label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>难度</label>
            <select v-model.number="importForm.difficulty" class="form-input">
              <option :value="1">1 - 基础</option>
              <option :value="2">2 - 基础</option>
              <option :value="3" selected>3 - 应用（默认）</option>
              <option :value="4">4 - 深入</option>
              <option :value="5">5 - 深入</option>
            </select>
          </div>
        </div>

        <!-- 考试抽题配置（与题库导入页「🎯 考试抽题配置」字段、文案保持一致） -->
        <div class="exam-config">
          <h3>🎯 考试抽题配置</h3>
          <p class="hint">规定考试中各题型随机抽取数量与每题分数（题库题目通常 &gt;100 道，避免一次考完全部）。数量留空或填 0 表示考该题型全部题目；分数留空或填 0 表示沿用题目自身分值。仅「考试」模式生效，学习 / 练习模式使用全部题目。</p>
          <div class="config-row">
            <label>单选题 <input type="number" min="0" v-model.number="importForm.exam_single_num" placeholder="0" /></label>
            <label>多选题 <input type="number" min="0" v-model.number="importForm.exam_multiple_num" placeholder="0" /></label>
            <label>判断题 <input type="number" min="0" v-model.number="importForm.exam_judgment_num" placeholder="0" /></label>
          </div>
          <div class="config-row">
            <label>单选每题分 <input type="number" min="0" step="0.5" v-model.number="importForm.exam_single_score" placeholder="0" /></label>
            <label>多选每题分 <input type="number" min="0" step="0.5" v-model.number="importForm.exam_multiple_score" placeholder="0" /></label>
            <label>判断每题分 <input type="number" min="0" step="0.5" v-model.number="importForm.exam_judgment_score" placeholder="0" /></label>
          </div>
          <p v-if="examTotalScore > 0" class="hint">预计满分：<b>{{ examTotalScore }}</b> 分（数量 × 每题分，未填分数的题型按题目自身分值估算，简答题按题目分值计）</p>
        </div>
        </div><!-- /.form-body -->

        <!-- 导入模式切换（Excel / Word） -->
        <div class="import-tabs">
          <button :class="['tab', importTab === 'excel' ? 'active' : '']" @click="importTab = 'excel'">📊 Excel 模板</button>
          <button :class="['tab', importTab === 'docx' ? 'active' : '']" @click="importTab = 'docx'">📄 Word 试卷</button>
        </div>

        <!-- 步骤说明 -->
        <div class="import-steps">
          <div class="step-line">📋 操作步骤：</div>
          <template v-if="importTab === 'excel'">
            <div class="step-item"><span class="s-num">1</span> 点击下方按钮下载 Excel 模板</div>
            <div class="step-item"><span class="s-num">2</span> 按模板格式填写题目（支持单选/多选/判断/简答）</div>
            <div class="step-item"><span class="s-num">3</span> 上传填写好的 Excel 文件，一键导入</div>
          </template>
          <template v-else>
            <div class="step-item"><span class="s-num">1</span> 准备 Word 试题卷（.docx，必填）</div>
            <div class="step-item"><span class="s-num">2</span> （可选）准备参考答案 .docx，系统按章节标题自动识别题型与分值</div>
            <div class="step-item"><span class="s-num">3</span> 上传文件后一键导入，自动创建培训题库</div>
          </template>
        </div>

        <!-- Excel 模式：下载模板 + 上传 -->
        <template v-if="importTab === 'excel'">
          <div class="download-row">
            <button class="btn btn-outline" style="width:auto" @click="downloadTemplate" :disabled="downloading">
              {{ downloading ? '下载中…' : '📄 下载题库模板（Excel）' }}
            </button>
            <span class="template-hint">列：题型 | 题目内容 | 选项A~D | 正确答案 | 解析 | 分值</span>
          </div>
          <div class="form-body" style="margin-top:16px">
            <div class="form-group">
              <label>上传填写好的题库文件（.xlsx）</label>
              <div class="file-upload-zone small" @click="triggerImportFile" :class="{ dragover: importDragover }"
                @dragover.prevent="importDragover = true"
                @dragleave="importDragover = false"
                @drop.prevent="handleImportDrop">
                <span class="upload-icon">📂</span>
                <p>{{ importFile ? importFile.name : '选择 Excel 文件' }}</p>
              </div>
              <input ref="importFileInput" type="file" accept=".xlsx" style="display:none" @change="e => importFile = e.target.files[0]" />
            </div>
          </div>
        </template>

        <!-- Word 模式：试题卷 + 参考答案 -->
        <div v-else class="form-body" style="margin-top:16px">
          <div class="word-hint">上传「试题卷.docx」与「参考答案.docx」。系统按章节标题（选择题 / 判断题 / 简答题 / 案例分析题 …）自动识别题型与每题分值；参考答案可选，缺答案时客观题标记「缺少答案」、主观题参考答案留空。</div>
          <div class="form-group">
            <label>试题卷（.docx，必填）</label>
            <div class="file-upload-zone small" @click="triggerImportQFile" :class="{ dragover: importQDragover }"
              @dragover.prevent="importQDragover = true"
              @dragleave="importQDragover = false"
              @drop.prevent="handleImportQDrop">
              <span class="upload-icon">📄</span>
              <p>{{ importQFile ? importQFile.name : '选择试题卷文件' }}</p>
            </div>
            <input ref="importQInput" type="file" accept=".docx" style="display:none" @change="e => importQFile = e.target.files[0]" />
          </div>
          <div class="form-group">
            <label>参考答案（.docx，可选）</label>
            <div class="file-upload-zone small" @click="triggerImportAFile" :class="{ dragover: importADragover }"
              @dragover.prevent="importADragover = true"
              @dragleave="importADragover = false"
              @drop.prevent="handleImportADrop">
              <span class="upload-icon">📘</span>
              <p>{{ importAFile ? importAFile.name : '选择参考答案文件' }}</p>
            </div>
            <input ref="importAInput" type="file" accept=".docx" style="display:none" @change="e => importAFile = e.target.files[0]" />
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-outline" @click="mode = null">上一步</button>
          <button class="btn btn-primary" @click="handleImportSubmit" :disabled="importing || !importForm.title || (importTab === 'excel' ? !importFile : !importQFile)">
            {{ importing ? '导入中…' : '创建培训并导入' }}
          </button>
        </div>
      </div>

      <!-- 步骤2：导入结果 -->
      <div v-else>
        <div v-if="importResult">
          <!-- 错误（红） -->
          <div v-if="importResult.error" class="result-msg error">{{ importResult.error }}</div>
          <!-- 0 题警告（橙） -->
          <div v-else-if="importResult.data && importResult.data.zeroQuestion" class="result-msg warn">
            ⚠️ {{ importResult.message }}
            <div class="hint">常见原因：题型列未填写 / 文件不是 .xlsx / 表头不含「题型」列。请点下方「下载标准模板」对照填写后重试。</div>
          </div>
          <!-- 正常成功（绿） -->
          <div v-else class="result-msg ok">{{ importResult.message }}</div>

          <!-- 失败明细 -->
          <div v-if="importResult.data && importResult.data.failPreview && importResult.data.failPreview.length" class="fail-list">
            <div class="fail-title">失败明细（前 10 条）：</div>
            <div v-for="(f, i) in importResult.data.failPreview" :key="i" class="fail-item">第 {{ f.row }} 行：{{ f.error }}</div>
          </div>

          <!-- 复制错误详情 -->
          <div class="copy-row">
            <button class="btn btn-secondary" @click="copyImportDetail">复制错误详情</button>
            <span v-if="copied" class="copied-tip">已复制 ✓</span>
          </div>
        </div>

        <div v-if="importResult && (importResult.error || (importResult.data && importResult.data.zeroQuestion))" class="template-tip">
          <p>标准模板第 1 行应为：<code>题型 | 题目内容 | 选项A | 选项B | 选项C | 选项D | 正确答案 | 解析 | 分值</code></p>
          <button class="btn btn-secondary" :disabled="downloading" @click="downloadTemplate">
            {{ downloading ? '下载中…' : '下载标准模板' }}
          </button>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" @click="$router.push('/admin/trainings')">返回培训列表</button>
        </div>
      </div>
    </div>
  </div>

  <!-- AI 出题预览确认弹窗 -->
  <AIPreviewModal
    :visible="previewVisible"
    :questions="previewQuestions"
    :title="previewTitle"
    :difficulty="previewDifficulty"
    :loading="previewLoading"
    :loading-text="previewLoadingText"
    @confirm="_confirmPreview(previewMaterialId)"
    @regenerate="_startPreview(previewMaterialId, { count: form.ai_question_count, questionTypes: form.ai_question_types, difficulty: form.difficulty || 3 })"
    @cancel="_cancelPreview(previewMaterialId)"
  />
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { request } from '@/utils/request'
import { MODE_LABELS } from '@/utils/quizModes'
import AIPreviewModal from './components/AIPreviewModal.vue'

const router = useRouter()

// 上传前先把文件读进内存 Blob，避免磁盘源文件被 Excel/Word 占用或改写时触发 ERR_UPLOAD_FILE_CHANGED
async function fileToBlob(file) {
  if (!file) return file
  return new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' })
}

// ── 模式选择 ──
const mode = ref(null) // null | 'ai' | 'import' | 'image_violation'

// ── 预览确认状态 ──
const previewVisible = ref(false)
const previewQuestions = ref([])
const previewMaterialId = ref(null)
const previewLoading = ref(false)
const previewLoadingText = ref('AI 正在生成题目，请稍候…')
const previewDifficulty = ref(3)
const previewTitle = ref('')

// ── AI 出题模式 ──
const form = reactive({
  title: '',
  material_type: 'video',
  category_id: null,
  pass_score: 60,
  time_limit: 30,
  mode: 'exam',
  ai_enabled: false,
  ai_question_types: 'choice',
  ai_question_count: 10,
  difficulty: 3,
})
const categories = ref([])

const fileInput = ref(null)
const selectedFile = ref(null)
const isDragover = ref(false)
const uploadProgress = ref(0)
const submitting = ref(false)
const result = ref(null)

function triggerFile() { fileInput.value?.click() }
function handleFileChange(e) { selectedFile.value = e.target.files[0] }
function handleDrop(e) { isDragover.value = false; selectedFile.value = e.dataTransfer.files[0] }

async function handleAiSubmit() {
  submitting.value = true
  result.value = null

  try {
    const fd = new FormData()
    fd.append('title', form.title)
    fd.append('material_type', form.material_type)
    fd.append('pass_score', form.pass_score)
    fd.append('time_limit', form.time_limit)
    fd.append('mode', form.mode)
    if (form.category_id) fd.append('category_id', form.category_id)
    if (selectedFile.value) fd.append('file', selectedFile.value)
    fd.append('ai_enabled', form.ai_enabled)
    fd.append('ai_question_types', form.ai_question_types)
    fd.append('ai_question_count', form.ai_question_count)
    fd.append('difficulty', form.difficulty || 3)

    // 使用 preview 模式：上传时加 preview=true 参数，跳过异步 AI
    const res = await request.post('/api/material/upload?preview=true', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (e.total) uploadProgress.value = Math.round((e.loaded / e.total) * 100)
      },
    })

    const data = res.data?.data || {}
    const materialId = data.materialId
    if (!materialId) throw new Error('上传失败，未获取到素材ID')

    // 保存 preview 状态
    previewMaterialId.value = materialId
    previewTitle.value = form.title || selectedFile.value?.name || '培训素材'
    previewDifficulty.value = form.difficulty || 3

    // 调用 preview-ai 生成题目
    await _startPreview(materialId, {
      count: form.ai_question_count,
      questionTypes: form.ai_question_types,
      difficulty: form.difficulty || 3,
    })
  } catch (e) {
    result.value = { error: e.response?.data?.error || e.message || '创建失败' }
    previewVisible.value = false
  } finally {
    submitting.value = false
    uploadProgress.value = 0
  }
}

/**
 * 调用 preview-ai 生成题目并弹出预览弹窗
 */
async function _startPreview(materialId, config) {
  previewLoading.value = true
  previewLoadingText.value = 'AI 正在生成题目，请稍候…'
  previewVisible.value = true

  try {
    const res = await request.post('/api/material/' + materialId + '/preview-ai', {
      count: config.count || 10,
      questionTypes: config.questionTypes || 'choice',
      difficulty: config.difficulty || 3,
    })

    const data = res.data?.data || {}
    previewQuestions.value = data.questions || []
    previewLoading.value = false

    // 如果生成的题目为空，显示错误
    if (previewQuestions.value.length === 0) {
      previewLoadingText.value = 'AI 生成题目失败，请重试或检查素材内容'
      previewLoading.value = true
      setTimeout(() => {
        _cancelPreview(materialId)
      }, 2000)
    }
  } catch (e) {
    previewLoading.value = false
    previewLoadingText.value = 'AI 出题失败：' + (e.response?.data?.error || e.message)
    // 3秒后关闭弹窗
    setTimeout(() => {
      _cancelPreview(materialId)
    }, 3000)
  }
}

/**
 * 确认保存题目
 */
async function _confirmPreview(materialId) {
  try {
    const res = await request.post('/api/material/' + materialId + '/confirm-questions', {
      questions: previewQuestions.value,
    })
    previewVisible.value = false
    result.value = { message: res.data?.message || '题目已保存成功' }
    setTimeout(() => router.push('/admin/trainings'), 1500)
  } catch (e) {
    result.value = { error: e.response?.data?.error || '保存题目失败' }
    previewVisible.value = false
  }
}

/**
 * 取消（关闭预览弹窗）
 */
async function _cancelPreview(materialId) {
  try {
    await request.post('/api/material/' + materialId + '/cancel-ai')
  } catch (e) {
    // 取消失败不影响跳转
  }
  previewVisible.value = false
  result.value = { message: '已取消出题' }
  setTimeout(() => router.push('/admin/trainings'), 800)
}

// ── 图片违章识别模式 ──
const imgForm = reactive({
  title: '',
  category_id: null,
  pass_score: 60,
  time_limit: 30,
  mode: 'exam',
  difficulty: 3,
})
const imgFileInput = ref(null)
const imgFile = ref(null)
const imgDragover = ref(false)
const imgUploadProgress = ref(0)
const imgSubmitting = ref(false)
const imgResult = ref(null)

function triggerImgFile() { imgFileInput.value?.click() }
function handleImgFileChange(e) { imgFile.value = e.target.files[0] }
function handleImgDrop(e) { imgDragover.value = false; imgFile.value = e.dataTransfer.files[0] }

async function handleImgSubmit() {
  if (!imgForm.title || !imgFile.value) return
  imgSubmitting.value = true
  imgResult.value = null

  try {
    const fd = new FormData()
    fd.append('title', imgForm.title)
    fd.append('material_type', 'image_violation')
    fd.append('pass_score', imgForm.pass_score)
    fd.append('time_limit', imgForm.time_limit)
    fd.append('mode', imgForm.mode)
    if (imgForm.category_id) fd.append('category_id', imgForm.category_id)
    fd.append('file', await fileToBlob(imgFile.value), imgFile.value.name)
    fd.append('ai_enabled', 'true')
    fd.append('ai_question_types', 'mixed')
    fd.append('ai_question_count', 15)
    fd.append('difficulty', imgForm.difficulty || 3)

    const res = await request.post('/api/material/upload', fd, {
      onUploadProgress: (e) => {
        if (e.total) imgUploadProgress.value = Math.round((e.loaded / e.total) * 100)
      },
    })

    imgResult.value = { message: '素材上传成功！AI 正在分析图片并出题，请稍后到培训列表查看…' }
    setTimeout(() => router.push('/admin/trainings'), 2000)
  } catch (e) {
    imgResult.value = { error: e.response?.data?.error || '上传失败' }
  } finally {
    imgSubmitting.value = false
    imgUploadProgress.value = 0
  }
}

// ── 导入题库模式 ──
const importForm = reactive({
  title: '',
  category_id: null,
  pass_score: 60,
  time_limit: 30,
  mode: 'exam',
  difficulty: 3,
  // 考试随机抽题配置：数量 0 = 该题型全抽；每题分数 0 = 沿用题目自身分值（字段与 QuizImportPage 对齐）
  exam_single_num: 0,
  exam_multiple_num: 0,
  exam_judgment_num: 0,
  exam_single_score: 0,
  exam_multiple_score: 0,
  exam_judgment_score: 0,
})
// 预计满分 = Σ(数量 × 每题分)；未填数量的题型按全抽估算不可知，仅统计显式配置部分
const examTotalScore = computed(() => {
  const t = (n, s) => (Number(n) > 0 && Number(s) > 0 ? Number(n) * Number(s) : 0)
  return Math.round(
    (t(importForm.exam_single_num, importForm.exam_single_score) +
     t(importForm.exam_multiple_num, importForm.exam_multiple_score) +
     t(importForm.exam_judgment_num, importForm.exam_judgment_score)) * 10
  ) / 10
})
const importFileInput = ref(null)
const importFile = ref(null)
const importDragover = ref(false)
const importing = ref(false)
const downloading = ref(false)
const importStep = ref(1)
const importResult = ref(null)
// Word 试卷模式状态
const importTab = ref('excel') // 'excel' | 'docx'
const importQInput = ref(null)
const importAInput = ref(null)
const importQFile = ref(null)
const importAFile = ref(null)
const importQDragover = ref(false)
const importADragover = ref(false)

async function downloadTemplate() {
  downloading.value = true
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
    importResult.value = { error: e.response?.data?.error || '下载模板失败' }
  } finally {
    downloading.value = false
  }
}

function triggerImportFile() { importFileInput.value?.click() }
function handleImportDrop(e) { importDragover.value = false; importFile.value = e.dataTransfer.files[0] }

function triggerImportQFile() { importQInput.value?.click() }
function triggerImportAFile() { importAInput.value?.click() }
function handleImportQDrop(e) { importQDragover.value = false; importQFile.value = e.dataTransfer.files[0] }
function handleImportADrop(e) { importADragover.value = false; importAFile.value = e.dataTransfer.files[0] }

function isValidXlsx(file) { return !!file && /\.xlsx$/i.test(file.name) }
function isValidDocx(file) { return !!file && /\.docx$/i.test(file.name) }

async function handleImportSubmit() {
  const needFile = importTab.value === 'excel' ? importFile.value : importQFile.value
  if (!importForm.title || !needFile) return
  // 后缀校验：Excel 仅 .xlsx，Word 试题卷仅 .docx
  const ok = importTab.value === 'excel' ? isValidXlsx(importFile.value) : isValidDocx(importQFile.value)
  if (!ok) {
    importResult.value = { error: importTab.value === 'excel' ? '请上传 .xlsx 文件' : '请上传 .docx 文件' }
    return
  }
  importing.value = true
  importResult.value = null

  try {
    // 步骤1：创建培训（无文件；同时写入考试抽题配置）
    const createRes = await request.post('/api/material/create', {
      title: importForm.title,
      category_id: importForm.category_id,
      pass_score: importForm.pass_score,
      time_limit: importForm.time_limit,
      mode: importForm.mode,
      exam_single_num: Math.max(0, Number(importForm.exam_single_num) || 0),
      exam_multiple_num: Math.max(0, Number(importForm.exam_multiple_num) || 0),
      exam_judgment_num: Math.max(0, Number(importForm.exam_judgment_num) || 0),
      exam_single_score: Math.max(0, Number(importForm.exam_single_score) || 0),
      exam_multiple_score: Math.max(0, Number(importForm.exam_multiple_score) || 0),
      exam_judgment_score: Math.max(0, Number(importForm.exam_judgment_score) || 0),
    })
    const materialId = createRes.data?.data?.materialId
    if (!materialId) throw new Error('创建培训失败')

    // 步骤2：导入题目（Excel 用 file；Word 用 questions + 可选 answers）
    const fd = new FormData()
    fd.append('material_id', materialId)
    // 导入接口会按这些字段覆盖题库抽题配置，必须透传，否则前面的设置会被清零
    fd.append('exam_single_num', Math.max(0, Number(importForm.exam_single_num) || 0))
    fd.append('exam_multiple_num', Math.max(0, Number(importForm.exam_multiple_num) || 0))
    fd.append('exam_judgment_num', Math.max(0, Number(importForm.exam_judgment_num) || 0))
    fd.append('exam_single_score', Math.max(0, Number(importForm.exam_single_score) || 0))
    fd.append('exam_multiple_score', Math.max(0, Number(importForm.exam_multiple_score) || 0))
    fd.append('exam_judgment_score', Math.max(0, Number(importForm.exam_judgment_score) || 0))
    let url
    if (importTab.value === 'excel') {
      fd.append('file', await fileToBlob(importFile.value), importFile.value.name)
      url = '/api/admin/quiz-import/import'
    } else {
      fd.append('questions', await fileToBlob(importQFile.value), importQFile.value.name)
      if (importAFile.value) {
        if (!isValidDocx(importAFile.value)) throw new Error('参考答案必须是 .docx 文件')
        fd.append('answers', await fileToBlob(importAFile.value), importAFile.value.name)
      }
      url = '/api/admin/quiz-import/import-docx'
    }
    const importRes = await request.post(url, fd)

    const data = importRes.data?.data || importRes.data
    importResult.value = {
      message: `导入完成：成功 ${data.success} 题，失败 ${data.fail} 题`,
      data,
    }
    importStep.value = 2
  } catch (e) {
    importResult.value = { error: e.response?.data?.error || e.message || '导入失败' }
  } finally {
    importing.value = false
  }
}

// 复制导入错误/结果详情，便于用户直接粘贴给技术人员定位
const copied = ref(false)
async function copyImportDetail() {
  const text = JSON.stringify(importResult.value, null, 2)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

async function fetchCategories() {
  try {
    const res = await request.get('/api/admin/categories')
    categories.value = res.data?.data || []
  } catch {}
}

onMounted(fetchCategories)
</script>

<style scoped>
.form-page { max-width: 700px; }
.page-nav { margin-bottom: 16px; }
.back-link { background: none; border: none; color: var(--primary); font-size: 14px; cursor: pointer; }

/* ── 模式选择卡片 ── */
h2 { font-size: 18px; margin-bottom: 20px; }
.mode-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.mode-header h2 { margin: 0; }

.mode-cards { display: flex; gap: 16px; }
.mode-card {
  flex: 1;
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 24px 20px;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}
.mode-card:hover {
  border-color: var(--primary);
  background: #f0f7ff;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(26,115,232,0.1);
}
.mode-icon { font-size: 36px; margin-bottom: 12px; }
.mode-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.mode-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.mode-arrow {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 20px;
  color: var(--primary);
  opacity: 0;
  transition: opacity 0.2s;
}
.mode-card:hover .mode-arrow { opacity: 1; }

/* ── 表单通用 ── */
.form-body { display: flex; flex-direction: column; gap: 16px; }
.form-row { display: flex; gap: 12px; flex-wrap: wrap; }
.form-row .form-group { flex: 1; min-width: 140px; }
.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-group label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.form-input {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
}
.form-input:focus { outline: none; border-color: var(--primary); }

/* ── 文件上传 ── */
.file-upload-zone {
  border: 2px dashed var(--border);
  border-radius: 10px;
  padding: 28px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.file-upload-zone.small { padding: 18px; }
.file-upload-zone:hover, .file-upload-zone.dragover {
  border-color: var(--primary);
  background: #e8f0fe;
}
.upload-icon { font-size: 32px; display: block; margin-bottom: 8px; }
.file-upload-zone.small .upload-icon { font-size: 24px; margin-bottom: 4px; }
.upload-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

/* ── AI 配置 ── */
.ai-config { background: #f8f9fa; border-radius: 10px; padding: 14px; }
.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.ai-params { margin-top: 12px; }

/* ── 考试抽题配置（与 QuizImportPage 同名区块保持视觉一致）── */
.exam-config { margin: 16px 0; padding: 14px; background: #f8faff; border: 1px solid var(--border); border-radius: 10px; }
.exam-config h3 { font-size: 14px; margin-bottom: 6px; }
.exam-config .hint { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin: 0; }
.config-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.config-row label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-secondary); gap: 4px; flex: 1; min-width: 90px; }
.config-row input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; width: 100%; box-sizing: border-box; }
.config-row input:focus { outline: none; border-color: var(--primary); }

/* ── 导入模式切换 Tab ── */
.import-tabs { display: flex; gap: 8px; margin-top: 4px; }
.import-tabs .tab {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-secondary);
}
.import-tabs .tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }
.word-hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 10px 12px;
}

/* ── 导入步骤 ── */
.import-steps {
  background: #f8f9fa;
  border-radius: 10px;
  padding: 16px;
  margin-top: 16px;
}
.step-line { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.step-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); padding: 3px 0; }
.s-num {
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.download-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.template-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

/* ── 操作按钮 ── */
.form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
.form-actions .btn { width: auto; }

.result-msg {
  margin-top: 12px; padding: 10px 14px;
  border-radius: 8px; font-size: 14px;
}
.result-msg.ok { background: #e6f4ea; color: var(--success); padding: 12px 14px; border-radius: 8px; }
.result-msg.error { background: #fce8e6; color: var(--danger); padding: 12px 14px; border-radius: 8px; }
.result-msg.warn { background: #fff4e5; color: #b26a00; border: 1px solid #ffd8a8; padding: 12px 14px; border-radius: 8px; }
.result-msg.warn .hint { margin-top: 6px; font-size: 13px; opacity: 0.9; line-height: 1.6; }
.fail-list { margin-top: 12px; padding: 12px 14px; background: #fce8e6; border-radius: 8px; font-size: 13px; }
.fail-title { font-weight: 600; margin-bottom: 6px; color: var(--danger); }
.fail-item { padding: 2px 0; }
.copy-row { margin-top: 12px; }
.copied-tip { margin-left: 10px; color: var(--success); font-size: 13px; }
.template-tip {
  margin-top: 12px; padding: 12px 14px; border-radius: 8px;
  background: #fff8e1; border: 1px solid #fde293; font-size: 13px; color: #795548;
}
.template-tip code {
  display: inline-block; margin: 4px 0 10px; padding: 4px 8px;
  background: #fff; border-radius: 4px; font-size: 12px; color: #333;
  word-break: break-all;
}
</style>
