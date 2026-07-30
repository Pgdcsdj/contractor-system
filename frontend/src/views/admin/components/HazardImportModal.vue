<template>
  <div v-if="visible" class="modal-overlay" @click.self="onClose">
    <div class="modal">
      <div class="modal-head">
        <h3>隐患批量导入</h3>
        <button class="modal-close" type="button" @click="onClose" aria-label="关闭">×</button>
      </div>

      <!-- 步骤 1：上传 -->
      <template v-if="step === 'upload'">
        <p class="modal-hint">
          支持 .xlsx / .xls / .csv。系统会自动识别列，遍历每个工作表（sheet）：每行「隐患排查项目」取该 sheet 标题；
          进度文本映射初始状态；已闭环（D3）项跳过不导；计划完成时间无法解析则置空待补。
        </p>
        <div
          class="file-upload"
          :class="{ dragover: isDragover }"
          @click="triggerFile"
          @dragover.prevent="isDragover = true"
          @dragleave="isDragover = false"
          @drop.prevent="handleDrop"
        >
          <span class="upload-icon">📂</span>
          <p>{{ fileRef ? fileRef.name : '点击或拖拽上传 .xlsx / .xls / .csv 文件' }}</p>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept=".xlsx,.xls,.csv"
          style="display: none"
          @change="handleFileChange"
        />
        <p v-if="parseError" class="parse-error">{{ parseError }}</p>

        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" @click="downloadTemplate">下载标准模板</button>
          <button class="btn btn-primary" type="button" @click="handleParse" :disabled="!fileRef || importing">
            {{ importing ? '解析中…' : '解析并预览' }}
          </button>
        </div>
      </template>

      <!-- 步骤 2：预览 -->
      <template v-else-if="step === 'preview'">
        <div class="summary-cards">
          <div class="sc sc-total"><div class="sc-num">{{ summary.totalRows || 0 }}</div><div class="sc-label">总行数</div></div>
          <div class="sc sc-valid"><div class="sc-num">{{ summary.valid || 0 }}</div><div class="sc-label">有效（将导入）</div></div>
          <div class="sc sc-error"><div class="sc-num">{{ summary.error || 0 }}</div><div class="sc-label">错误（不导入）</div></div>
          <div class="sc sc-skip"><div class="sc-num">{{ summary.skippedClosed || 0 }}</div><div class="sc-label">已闭环跳过</div></div>
        </div>

        <!-- 门禁提示：存在校验错误行时整批拒绝，不落库任何行（含有效行） -->
        <div v-if="hasErrorRows" class="gate-warning">
          ⚠️ 存在 {{ summary.error }} 条校验错误行，请修正 Excel 后重新上传。系统不会导入任何行（含有效行一并拒绝）。
        </div>

        <div class="sheet-tags" v-if="sheets.length">
          <span v-for="s in sheets" :key="s.sheetName" class="sheet-tag" :title="s.sheetName">
            {{ s.sheetName }}（{{ s.valid }}/{{ s.rowCount }}）
          </span>
        </div>

        <div class="filter-chips">
          <button :class="['chip', filterTab === 'all' ? 'active' : '']" @click="filterTab = 'all'">全部 ({{ rows.length }})</button>
          <button :class="['chip', filterTab === 'valid' ? 'active' : '']" @click="filterTab = 'valid'">有效 ({{ summary.valid || 0 }})</button>
          <button :class="['chip', filterTab === 'error' ? 'active' : '']" @click="filterTab = 'error'">错误 ({{ summary.error || 0 }})</button>
          <button :class="['chip', filterTab === 'skippedClosed' ? 'active' : '']" @click="filterTab = 'skippedClosed'">已闭环 ({{ summary.skippedClosed || 0 }})</button>
        </div>

        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>
                <th>状态</th><th>工作表</th><th>行</th><th>隐患排查项目</th><th>责任单位</th>
                <th>场所</th><th>等级</th><th>描述</th><th>责任人</th>
                <th>计划完成</th><th>初始状态</th><th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in filteredRows" :key="r.index" :class="['row-' + r.status]">
                <td><span :class="['st-badge', statusMeta(r.status).cls]">{{ statusMeta(r.status).label }}</span></td>
                <td class="cell-sheet" :title="r.sheetName">{{ r.sheetName }}</td>
                <td>{{ r.rowNo }}</td>
                <td>{{ r.data.hazard_investigation_item || '-' }}</td>
                <td>{{ r.data.unit_name || '-' }}</td>
                <td>{{ r.data.location || '-' }}</td>
                <td>{{ r.data.hazard_level || '-' }}</td>
                <td class="cell-desc" :title="r.data.description">{{ r.data.description || '-' }}</td>
                <td>{{ r.data.responsible_person || '-' }}</td>
                <td>{{ r.data.plan_finish_time || '（空）' }}</td>
                <td>{{ statusLabel(r.data.status) }}</td>
                <td class="cell-note">
                  <span v-if="r.status === 'error'" class="note-err">{{ r.errors.join('；') }}</span>
                  <span v-else-if="r.status === 'skippedClosed'" class="note-skip">已闭环，跳过</span>
                  <span v-else-if="r.warnings && r.warnings.length" class="note-warn">{{ r.warnings[0] }}</span>
                  <span v-else class="note-ok">可导入</span>
                </td>
              </tr>
              <tr v-if="filteredRows.length === 0">
                <td colspan="12" class="empty-cell">该分类下暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="previewWarnings.length" class="warn-box">
          <div class="warn-title">全局警告（前 {{ previewWarnings.length }} 条）</div>
          <ul>
            <li v-for="(w, i) in previewWarnings.slice(0, 20)" :key="i">{{ w }}</li>
          </ul>
        </div>

        <div class="modal-actions">
          <button class="btn btn-outline" type="button" @click="onClose" :disabled="confirming">取消</button>
          <button class="btn btn-primary" type="button" @click="handleConfirm" :disabled="confirming || hasErrorRows || (summary.valid || 0) === 0">
            {{ confirming ? '导入中…' : '确认导入 ' + (summary.valid || 0) + ' 条' }}
          </button>
        </div>
      </template>

      <!-- 步骤 3：报告 -->
      <template v-else-if="step === 'report'">
        <div v-if="isSuccess" class="report report-ok">
          <div class="report-icon">✅</div>
          <h4>导入完成</h4>
          <div class="report-stats">
            <div><b>{{ reportSummary.inserted || 0 }}</b><span>已导入</span></div>
            <div><b>{{ reportSummary.skippedClosed || 0 }}</b><span>已闭环跳过</span></div>
            <div><b>{{ reportSummary.error || 0 }}</b><span>错误未导入</span></div>
            <div><b>{{ reportSummary.total || 0 }}</b><span>合计</span></div>
          </div>
          <p v-if="reportData.importLogId" class="report-log">导入记录 ID：#{{ reportData.importLogId }}</p>

          <div v-if="reportData.failList && reportData.failList.length" class="fail-box">
            <div class="fail-title">未导入明细（{{ reportData.failList.length }}）</div>
            <ul>
              <li v-for="(f, i) in reportData.failList.slice(0, 30)" :key="i">
                [{{ f.sheetName }}] 第 {{ f.rowNo }} 行：{{ f.reason }}
              </li>
            </ul>
          </div>

          <div v-if="reportData.warnings && reportData.warnings.length" class="warn-box">
            <div class="warn-title">警告</div>
            <ul>
              <li v-for="(w, i) in reportData.warnings.slice(0, 20)" :key="i">{{ w }}</li>
            </ul>
          </div>
        </div>

        <div v-else class="report report-fail">
          <div class="report-icon">⚠️</div>
          <h4>{{ reportData.rejected ? '整批拒绝，库零变更' : '导入失败，已整批回退' }}</h4>
          <p class="report-fail-msg">{{ reportData.error || '库未变更' }}</p>
          <p v-if="reportData.failAtRow != null" class="report-fail-row">失败位置：约第 {{ reportData.failAtRow }} 行</p>

          <div v-if="reportData.failList && reportData.failList.length" class="fail-box">
            <div class="fail-title">未导入明细（{{ reportData.failList.length }}）</div>
            <ul>
              <li v-for="(f, i) in reportData.failList.slice(0, 30)" :key="i">
                [{{ f.sheetName }}] 第 {{ f.rowNo }} 行：{{ f.reason }}
              </li>
            </ul>
          </div>

          <p class="report-fail-hint">本次导入未发生任何数据变更，可修正文件后重试。</p>
        </div>

        <div class="modal-actions">
          <button class="btn btn-primary" type="button" @click="onClose">关闭</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { importHazards, confirmImportHazards, getImportTemplate } from '@/api/hazard'
import { statusLabel } from '@/utils/hazardStatus'

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'imported'])

const step = ref('upload')
const fileRef = ref(null)
const fileInput = ref(null)
const isDragover = ref(false)
const importing = ref(false)
const confirming = ref(false)
const parseError = ref('')
const previewData = ref(null)
const reportData = ref(null)
const filterTab = ref('all')

const summary = computed(() => previewData.value?.summary || {})
const sheets = computed(() => previewData.value?.sheets || [])
const rows = computed(() => previewData.value?.rows || [])
const previewWarnings = computed(() => previewData.value?.warnings || [])
const filteredRows = computed(() => {
  if (filterTab.value === 'all') return rows.value
  return rows.value.filter((r) => r.status === filterTab.value)
})
const isSuccess = computed(() => reportData.value && !reportData.value.rollback)
const reportSummary = computed(() => reportData.value?.summary || {})
// 门禁：预览阶段存在校验错误行（status==='error'）时，确认按钮禁用，整批拒绝
const hasErrorRows = computed(() => (summary.value.error || 0) > 0)

function statusMeta(s) {
  if (s === 'valid') return { label: '有效', cls: 'st-valid' }
  if (s === 'error') return { label: '错误', cls: 'st-error' }
  if (s === 'skippedClosed') return { label: '已闭环', cls: 'st-skip' }
  return { label: s, cls: 'st-skip' }
}

function onClose() {
  if (importing.value || confirming.value) return
  emit('close')
}

function triggerFile() {
  fileInput.value?.click()
}
function handleFileChange(e) {
  const f = e.target.files && e.target.files[0]
  if (f) fileRef.value = f
}
function handleDrop(e) {
  isDragover.value = false
  const f = e.dataTransfer.files && e.dataTransfer.files[0]
  if (f && /\.(xlsx|xls|csv)$/i.test(f.name)) fileRef.value = f
}

async function handleParse() {
  if (!fileRef.value || importing.value) return
  importing.value = true
  parseError.value = ''
  try {
    const res = await importHazards(fileRef.value)
    previewData.value = res.data?.data || {}
    step.value = 'preview'
    filterTab.value = 'all'
  } catch (e) {
    parseError.value = e.response?.data?.error || '解析失败，请检查文件格式'
  } finally {
    importing.value = false
  }
}

async function handleConfirm() {
  if (!fileRef.value || confirming.value) return
  confirming.value = true
  try {
    const res = await confirmImportHazards(fileRef.value)
    reportData.value = res.data?.data || {}
    step.value = 'report'
    emit('imported', reportData.value)
  } catch (e) {
    const resp = e.response?.data || {}
    const inner = resp.data || {}
    reportData.value = {
      rollback: true,
      rejected: !!inner.rejected,
      error: resp.error || '导入失败',
      failAtRow: inner.failAtRow ?? null,
      failList: inner.failList || [],
    }
    step.value = 'report'
  } finally {
    confirming.value = false
  }
}

async function downloadTemplate() {
  try {
    const res = await getImportTemplate()
    const blob = res.data
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '隐患导入模板.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    alert(e.response?.data?.error || '模板下载失败')
  }
}
</script>

<style scoped>
.modal { max-width: 900px; width: 100%; }
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.modal-close {
  background: none; border: none; font-size: 26px; line-height: 1; cursor: pointer;
  color: var(--text-secondary); padding: 0 4px; border-radius: 6px;
}
.modal-close:hover { background: rgba(0, 0, 0, 0.05); }
.modal-hint { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.7; }

.file-upload {
  border: 2px dashed var(--border); border-radius: 12px; padding: 28px; text-align: center;
  cursor: pointer; margin-bottom: 16px; transition: border-color 0.2s, background 0.2s;
}
.file-upload:hover, .file-upload.dragover { border-color: var(--primary); background: rgba(25, 118, 210, 0.06); }
.upload-icon { font-size: 34px; display: block; margin-bottom: 8px; }
.file-upload p { font-size: 13px; color: var(--text-secondary); word-break: break-all; }
.parse-error { color: var(--danger); font-size: 13px; margin: 8px 0; }

.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; }
.modal-actions .btn { width: auto; min-width: 120px; }

/* 门禁提示：存在校验错误行 */
.gate-warning {
  margin: 12px 0; padding: 10px 12px; border-radius: 8px;
  background: #fdecea; border: 1px solid #f5c6cb; color: var(--c-danger);
  font-size: 13px; font-weight: 600; line-height: 1.6;
}

/* 汇总卡片 */
.summary-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.sc { border-radius: 10px; padding: 12px; text-align: center; border: 1px solid var(--border); }
.sc-num { font-size: 22px; font-weight: 700; }
.sc-label { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.sc-total .sc-num { color: var(--text); }
.sc-valid .sc-num { color: var(--c-success); }
.sc-error .sc-num { color: var(--c-danger); }
.sc-skip .sc-num { color: var(--text-secondary); }

.sheet-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.sheet-tag {
  font-size: 12px; background: #f2f4f7; border: 1px solid var(--border); border-radius: 999px;
  padding: 3px 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.filter-chips { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.chip {
  font-size: 13px; padding: 5px 14px; border: 1px solid var(--border); border-radius: 999px;
  background: #fff; cursor: pointer; color: var(--text-secondary);
}
.chip.active { background: var(--primary); color: #fff; border-color: var(--primary); }

.preview-table-wrap { max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.preview-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.preview-table th, .preview-table td { padding: 7px 9px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.preview-table thead th { position: sticky; top: 0; background: #f8f9fa; z-index: 1; font-size: 12px; }
.preview-table tbody tr.row-error { background: #fdecea; }
.preview-table tbody tr.row-skippedClosed { background: #f3f4f6; color: var(--text-secondary); }
.cell-sheet { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-desc { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-note { max-width: 200px; }
.note-err { color: var(--c-danger); }
.note-skip { color: var(--text-secondary); }
.note-warn { color: #b26a00; }
.note-ok { color: var(--c-success); }
.empty-cell { text-align: center; padding: 24px; color: var(--text-secondary); }

.st-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.st-valid { background: #e6f4ea; color: var(--c-success); }
.st-error { background: #fdecea; color: var(--c-danger); }
.st-skip { background: #eceff1; color: var(--text-secondary); }

.warn-box { margin-top: 12px; background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 10px 12px; }
.warn-title { font-size: 12px; font-weight: 600; color: #8a6d00; margin-bottom: 4px; }
.warn-box ul { margin: 0; padding-left: 18px; }
.warn-box li { font-size: 12px; line-height: 1.8; color: #6b5500; }

/* 报告 */
.report { text-align: center; padding: 18px 8px; }
.report-icon { font-size: 40px; }
.report h4 { margin: 8px 0; font-size: 18px; }
.report-ok h4 { color: var(--c-success); }
.report-fail h4 { color: var(--c-danger); }
.report-stats { display: flex; justify-content: center; gap: 22px; margin: 14px 0; }
.report-stats div { display: flex; flex-direction: column; }
.report-stats b { font-size: 22px; color: var(--text); }
.report-stats span { font-size: 12px; color: var(--text-secondary); }
.report-log { font-size: 13px; color: var(--text-secondary); }
.report-fail-msg { color: var(--c-danger); font-weight: 600; }
.report-fail-row { font-size: 13px; color: var(--text); }
.report-fail-hint { font-size: 12px; color: var(--text-secondary); }
.fail-box { margin-top: 14px; text-align: left; background: #fdecea; border: 1px solid #f5c6cb; border-radius: 8px; padding: 10px 12px; }
.fail-title { font-size: 12px; font-weight: 600; color: var(--c-danger); margin-bottom: 4px; }
.fail-box ul { margin: 0; padding-left: 18px; max-height: 160px; overflow: auto; }
.fail-box li { font-size: 12px; line-height: 1.8; color: #a3302a; }
</style>
