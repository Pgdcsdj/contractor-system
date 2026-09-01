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
        <!-- 导入类型：由入口决定；locked 时锁定不可改 -->
        <div class="import-type-row">
          <label>导入类型</label>
          <select v-if="!locked" v-model="importType" class="form-input">
            <option value="ledger">普通台账导入</option>
            <option value="video_supervision">视频督查导入</option>
          </select>
          <span v-else class="type-badge" :class="importType === 'video_supervision' ? 'badge-vs' : 'badge-ledger'">{{ lockedLabel }}</span>
          <span v-if="importType === 'video_supervision'" class="type-hint">
            将以「视频督查」作为隐患排查项目默认值
          </span>
        </div>

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

        <!-- .xls（Excel 97-2003）自动转换提示：明确告知截图不会进系统 -->
        <div v-if="isXlsSource" class="xls-notice">
          ⚠️ 已自动将 .xls 转为 .xlsx 导入（仅含文字，不含图片）。如需现场截图进系统，请将原文件另存为 .xlsx 后上传。
        </div>
        <div v-if="converting" class="convert-info">正在将 .xls 转换为 .xlsx…</div>
        <div v-if="convertInfo && !convertInfo.overLimit && !converting" class="convert-info">
          .xls 转换完成：{{ toMB(convertInfo.originalSize) }} → <b>{{ toMB(convertInfo.convertedSize) }}</b>
          （共 {{ convertInfo.sheetCount }} 个工作表，已剔除图片等非文字内容）
        </div>
        <p v-if="convertError" class="parse-error">{{ convertError }}</p>

        <!-- 视频督查 xlsx 压缩进度 / 结果（仅压缩时展示） -->
        <div v-if="compressProgress.active" class="compress-box">
          <div class="compress-label">
            正在压缩内嵌截图… {{ compressProgress.phase === 'compress' ? '逐张压缩' : '重新打包' }}
            <span v-if="compressProgress.total">（{{ compressProgress.done }}/{{ compressProgress.total }}）</span>
          </div>
          <div class="compress-bar"><div class="compress-bar-inner" :style="{ width: compressPct + '%' }"></div></div>
        </div>
        <p v-if="compressError" class="parse-error">{{ compressError }}</p>
        <div v-if="compressInfo && !compressInfo.skipped && !compressInfo.overLimit" class="compress-info">
          原文件 {{ toMB(compressInfo.originalSize) }} → 压缩后
          <b>{{ toMB(compressInfo.finalSize) }}</b>
          （含 {{ compressInfo.imageCount }} 张截图，实际压缩 {{ compressInfo.compressedCount }} 张，迭代 {{ compressInfo.rounds }} 轮）
        </div>
        <div v-if="compressInfo && compressInfo.skipped" class="compress-info compress-skip">
          无需压缩（非 xlsx 或无内嵌截图），将直接上传原文件
        </div>
        <div v-if="compressInfo && compressInfo.overLimit" class="compress-info compress-over">
          已压到最小仍 {{ toMB(compressInfo.finalSize) }}，超过 5MB 上限，请拆分文件
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" @click="downloadTemplate">下载标准模板</button>
          <button class="btn btn-primary" type="button" @click="handleParse" :disabled="!fileRef || importing || converting">
            {{ converting ? '转换中…' : importing ? '解析中…' : '解析并预览' }}
          </button>
        </div>
      </template>

      <!-- 步骤 2：预览 -->
      <template v-else-if="step === 'preview'">
        <!-- .xls 来源：预览区同样明示「无截图」，避免用户以为截图已入库 -->
        <div v-if="isXlsSource" class="xls-notice">
          ⚠️ 已自动将 .xls 转为 .xlsx 导入（仅含文字，不含图片）。如需现场截图进系统，请将原文件另存为 .xlsx 后上传。
        </div>

        <div class="summary-cards">
          <div class="sc sc-total"><div class="sc-num">{{ summary.totalRows || 0 }}</div><div class="sc-label">总行数</div></div>
          <div class="sc sc-valid"><div class="sc-num">{{ summary.valid || 0 }}</div><div class="sc-label">有效（将导入）</div></div>
          <div class="sc sc-error"><div class="sc-num">{{ summary.error || 0 }}</div><div class="sc-label">错误（不导入）</div></div>
          <div class="sc sc-skip"><div class="sc-num">{{ summary.skippedClosed || 0 }}</div><div class="sc-label">已闭环跳过</div></div>
        </div>

        <!-- 视频督查截图解析结果（逐行确认匹配是否正确） -->
        <div v-if="imageStats" class="screenshot-banner">
          截图解析：共 <b>{{ imageStats.total }}</b> 张，已匹配 <b>{{ imageStats.matched }}</b> 张，
          未定位 <b>{{ imageStats.orphan }}</b> 张（锚点方式：{{ imageStats.anchorMode }}）
        </div>

        <!-- 门禁提示：存在校验错误行时仅跳过，valid 行正常导入 -->
        <div v-if="hasErrorRows" class="gate-warning">
          ⚠️ 存在 {{ summary.error }} 条校验错误行，系统将跳过这些行，仅导入 {{ summary.valid || 0 }} 条有效行。请核对后确认。
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
                <th>场所</th><th>等级</th><th>描述</th><th>标准依据</th><th>责任人</th>
                <th>计划完成</th><th>初始状态</th>
                <th v-if="showScreenshotCol">截图</th>
                <th>说明</th>
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
                <td>{{ r.data.standard_basis || '-' }}</td>
                <td>{{ r.data.responsible_person || '-' }}</td>
                <td>{{ r.data.plan_finish_time || '（空）' }}</td>
                <td>{{ statusLabel(r.data.status) }}</td>
                <td v-if="showScreenshotCol" class="cell-shot">
                  <span v-if="photoCount(r) > 0" class="shot-badge">{{ photoCount(r) }} 张</span>
                  <span v-else class="shot-none">—</span>
                </td>
                <td class="cell-note">
                  <span v-if="r.status === 'error'" class="note-err">{{ r.errors.join('；') }}</span>
                  <span v-else-if="r.status === 'skippedClosed'" class="note-skip">已闭环，跳过</span>
                  <span v-else-if="r.warnings && r.warnings.length" class="note-warn">{{ r.warnings[0] }}</span>
                  <span v-else class="note-ok">可导入</span>
                </td>
              </tr>
              <tr v-if="filteredRows.length === 0">
                <td :colspan="showScreenshotCol ? 14 : 13" class="empty-cell">该分类下暂无数据</td>
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
          <button class="btn btn-primary" type="button" @click="handleConfirm" :disabled="confirming || (summary.valid || 0) === 0">
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

          <!-- 视频督查截图关联结果 -->
          <div v-if="reportData.photoResult" class="photo-result">
            关联截图 <b>{{ reportData.photoResult.uploaded }}</b> 张，
            失败 <b>{{ reportData.photoResult.failed }}</b> 张，
            未定位 <b>{{ reportData.photoResult.orphan }}</b> 张
          </div>
          <div v-if="reportData.photoResult && reportData.photoResult.warnings && reportData.photoResult.warnings.length" class="warn-box">
            <div class="warn-title">截图关联警告</div>
            <ul>
              <li v-for="(w, i) in reportData.photoResult.warnings.slice(0, 20)" :key="i">{{ w }}</li>
            </ul>
          </div>

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
import { ref, computed, watch } from 'vue'
import { importHazards, confirmImportHazards, getImportTemplate } from '@/api/hazard'
import { statusLabel } from '@/utils/hazardStatus'
import { compressXlsxImages, shouldCompress, toMB } from '@/utils/xlsxImageCompress'
import { convertXlsToXlsx, isXlsFile, HARD_LIMIT_BYTES } from '@/utils/xlsToXlsx'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 父组件预选的导入类型：'' = 弹窗内自由选；'ledger' = 普通台账导入（锁定）；'video_supervision' = 视频督查导入（锁定）
  importType: { type: String, default: '' },
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
// 本地导入类型：默认 'ledger'（普通台账导入）。
// 父组件通过 importType prop 预选时，弹窗锁定为该类型（不可切换）；prop 为空则弹窗内自由选。
const importType = ref(props.importType || 'ledger')
// 父组件传入非空类型时锁定，下拉改为固定徽章
const locked = computed(() => !!props.importType)
const lockedLabel = computed(() =>
  importType.value === 'video_supervision' ? '视频督查导入' : '普通台账导入'
)

// 父组件每次以不同入口打开弹窗时，同步预选的导入类型
watch(
  () => props.importType,
  (v) => {
    importType.value = v || 'ledger'
    resetCompress() // 切换导入类型后压缩缓存失效
  }
)
watch(
  () => props.visible,
  (v) => {
    if (v) importType.value = props.importType || 'ledger'
  }
)

const summary = computed(() => previewData.value?.summary || {})
const sheets = computed(() => previewData.value?.sheets || [])
const rows = computed(() => previewData.value?.rows || [])
const previewWarnings = computed(() => previewData.value?.warnings || [])
const imageStats = computed(() => previewData.value?.imageStats || null)
// 视频督查导入且预览返回了逐行截图统计时，才展示「截图」列
const showScreenshotCol = computed(
  () => importType.value === 'video_supervision' && !!imageStats.value && !!imageStats.value.perRow && Object.keys(imageStats.value.perRow).length > 0
)
function photoCount(r) {
  if (!imageStats.value || !imageStats.value.perRow) return 0
  return imageStats.value.perRow[`${r.sheetName}#${r.rowNo}`] || 0
}
const filteredRows = computed(() => {
  if (filterTab.value === 'all') return rows.value
  return rows.value.filter((r) => r.status === filterTab.value)
})
const isSuccess = computed(() => reportData.value && !reportData.value.rollback)
const reportSummary = computed(() => reportData.value?.summary || {})
// 门禁：预览阶段存在校验错误行（status==='error'）时，确认按钮禁用，整批拒绝
const hasErrorRows = computed(() => (summary.value.error || 0) > 0)

// ─── 视频督查 xlsx 前端压缩（上传前）───
// compressedFileRef 缓存压缩结果，确保「预览 / 确认」两次上传是同一份字节（设计 §7.8）
const compressedFileRef = ref(null)
const compressInfo = ref(null)
const compressProgress = ref({ phase: '', done: 0, total: 0, active: false })
const compressError = ref('')
const compressPct = computed(() => {
  const p = compressProgress.value
  if (!p.total) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

// ─── .xls（Excel 97-2003）→ .xlsx 前端转换（方案 C）───
// 后端 5MB 红线不动；.xls 直出必被拒，故先用 SheetJS 读出「文字单元格」重建为 .xlsx。
// 已知限制：社区版 SheetJS 读 .xls 不保留图片 → 转换后不含现场截图，UI 必须明示。
const convertedFileRef = ref(null)   // .xls → .xlsx 中间产物缓存
const convertInfo = ref(null)        // { originalSize, convertedSize, sheetCount, overLimit }
const convertError = ref('')
const converting = ref(false)
// 当前选中的原始文件是否为 .xls（决定是否展示「转换后无截图」提示）
const isXlsSource = computed(() => isXlsFile(fileRef.value))

function resetCompress() {
  compressedFileRef.value = null
  compressInfo.value = null
  compressError.value = ''
  compressProgress.value = { phase: '', done: 0, total: 0, active: false }
  convertedFileRef.value = null
  convertInfo.value = null
  convertError.value = ''
  converting.value = false
}

/**
 * 确保拿到「.xls 转换后的 .xlsx」：非 .xls 原样返回。
 * 转换结果缓存到 convertedFileRef，两次上传（预览 / 确认）复用同一份字节。
 * @returns {Promise<File|null>} null = 转换后仍超 5MB 或转换失败且原文件超限（应阻断上传）
 */
async function ensureXlsConverted() {
  const src = fileRef.value
  if (!src) return null
  if (!isXlsFile(src)) return src
  if (convertedFileRef.value) return convertedFileRef.value

  converting.value = true
  convertError.value = ''
  try {
    const res = await convertXlsToXlsx(src)
    convertInfo.value = res
    if (res.overLimit) {
      convertError.value = `转换后文件仍 ${toMB(res.convertedSize)}，超过 5MB 上限，请将该表拆分为多个文件，或用 Excel 另存为 .xlsx 后上传`
      return null
    }
    convertedFileRef.value = res.file
    return res.file
  } catch (e) {
    const msg = (e && e.message) || '未知错误'
    console.warn('[.xls 转换] 失败：', msg)
    // 转换失败：原文件在 5MB 内则降级直传（后端能解析 .xls）；超限则阻断并提示
    if ((src.size || 0) <= HARD_LIMIT_BYTES) {
      convertInfo.value = null
      convertError.value = `.xls 自动转换失败（${msg}），已改用原文件上传`
      convertedFileRef.value = src
      return src
    }
    convertError.value = `.xls 自动转换失败（${msg}），且原文件 ${toMB(src.size)} 超过 5MB 上限，请用 Excel 另存为 .xlsx 后上传`
    return null
  } finally {
    converting.value = false
  }
}

/**
 * 确保拿到「待上传文件」：.xls 先转 .xlsx；视频督查 .xlsx 再压缩；其余直出。
 * 最终结果统一缓存在 compressedFileRef，保证预览 / 确认两次上传字节一致（设计 §7.8）。
 * @returns {Promise<File|null>} null = 被 overLimit 阻断（调用方应中止上传）
 */
async function ensureCompressed() {
  if (compressedFileRef.value) return compressedFileRef.value
  // ① .xls → .xlsx（非 .xls 原样透传）
  const src = await ensureXlsConverted()
  if (!src) return null
  // ② 非视频督查 .xlsx：无需压缩，直接作为统一上传缓存
  if (!shouldCompress(src, importType.value)) {
    compressedFileRef.value = src
    return src
  }
  compressProgress.value = { phase: '', done: 0, total: 0, active: true }
  compressError.value = ''
  try {
    const res = await compressXlsxImages(src, (p) => {
      compressProgress.value = { phase: p.phase, done: p.done, total: p.total, active: true }
    })
    compressInfo.value = res
    compressProgress.value.active = false
    if (res.skipped) {
      // 无内嵌图（.xls 转出的 .xlsx 必走此分支）：直出
      compressedFileRef.value = src
      return src
    }
    if (res.overLimit) {
      compressError.value = `已尽力压缩（每张截图已压至 200KB 以内）仍超过 5MB，请将文件拆分为多个批次导入`
      return null
    }
    compressedFileRef.value = res.file
    return res.file
  } catch (e) {
    compressProgress.value.active = false
    // 压缩失败：若原文件本身 >5MB（HARD_LIMIT_BYTES），上传后端必触发 413，
    // 故阻断并提示拆分，避免无意义的 413；否则降级用（转换后的）原文件上传。
    if ((src.size || 0) > HARD_LIMIT_BYTES) {
      console.warn('[视频督查压缩] 失败且原文件超 5MB，阻断上传：', e && e.message)
      compressError.value = '截图压缩失败，且原文件超过 5MB，请拆分为多个文件后重试'
      return null
    }
    console.warn('[视频督查压缩] 失败，降级使用原文件：', e && e.message)
    compressedFileRef.value = src
    return src
  }
}

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
  if (f) {
    fileRef.value = f
    resetCompress()
  }
}
function handleDrop(e) {
  isDragover.value = false
  const f = e.dataTransfer.files && e.dataTransfer.files[0]
  if (f && /\.(xlsx|xls|csv)$/i.test(f.name)) {
    fileRef.value = f
    resetCompress()
  }
}

async function handleParse() {
  if (!fileRef.value || importing.value) return
  importing.value = true
  parseError.value = ''
  try {
    // 视频督查 .xlsx：先压缩再上传；压缩后结果缓存到 compressedFileRef（两次上传同一字节）
    const file = await ensureCompressed()
    if (!file) {
      importing.value = false
      return // 被 overLimit 阻断，不进入预览
    }
    const res = await importHazards(file, importType.value)
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
    // 复用 compressedFileRef 缓存（.xls 转换 / xlsx 压缩结果），两次上传字节一致（设计 §7.8）
    const file = await ensureCompressed()
    if (!file) {
      confirming.value = false
      return
    }
    const res = await confirmImportHazards(file, importType.value)
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

/* 导入类型选择 */
.import-type-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.import-type-row label { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; }
.import-type-row .form-input {
  width: auto; min-width: 170px; padding: 6px 10px; font-size: 13px;
  border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text);
}
.type-hint { font-size: 12px; color: var(--primary); }
.type-badge { font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px; border: 1px solid transparent; }
.badge-ledger { background: #eef2f7; color: var(--text); border-color: var(--border); }
.badge-vs { background: rgba(25, 118, 210, 0.1); color: var(--primary); border-color: rgba(25, 118, 210, 0.3); }

.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; }
.modal-actions .btn { width: auto; min-width: 120px; }

/* 门禁提示：存在校验错误行（仅跳过，非整批拒绝） */
.gate-warning {
  margin: 12px 0; padding: 10px 12px; border-radius: 8px;
  background: #fff7e6; border: 1px solid #ffd591; color: #ad6800;
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

/* 压缩进度 / 结果（视频督查 xlsx） */
.compress-box { margin: 10px 0; }
.compress-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.compress-bar { height: 6px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
.compress-bar-inner { height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.2s; }
.compress-info {
  margin-top: 8px; font-size: 12.5px; color: var(--text-secondary);
  background: #eef6ee; border: 1px solid #cfe8cf; border-radius: 8px; padding: 7px 10px;
}
.compress-info.compress-skip { background: #f3f4f6; border-color: var(--border); }
.compress-info.compress-over { background: #fdecea; border-color: #f5c6cb; color: var(--c-danger); }

/* .xls → .xlsx 自动转换提示 */
.xls-notice {
  margin: 10px 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; line-height: 1.7;
  background: #fff8e1; border: 1px solid #ffe082; color: #8a6d00; font-weight: 600;
}
.convert-info {
  margin-top: 8px; font-size: 12.5px; color: var(--text-secondary);
  background: #eef2f7; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
}
.convert-info b { color: var(--text); }

/* 截图解析横幅（预览） */
.screenshot-banner {
  margin: 12px 0; padding: 8px 12px; border-radius: 8px; font-size: 13px;
  background: rgba(25, 118, 210, 0.08); border: 1px solid rgba(25, 118, 210, 0.25); color: var(--primary);
}
.screenshot-banner b { color: var(--text); }

/* 预览表「截图」列 */
.cell-shot { text-align: center; white-space: nowrap; }
.shot-badge {
  display: inline-block; min-width: 34px; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; background: #e6f4ea; color: var(--c-success);
}
.shot-none { color: var(--text-secondary); }

/* 报告：截图关联结果 */
.photo-result {
  margin: 12px auto 0; font-size: 14px; color: var(--text-secondary);
  background: #eef6ee; border: 1px solid #cfe8cf; border-radius: 8px; padding: 8px 14px; display: inline-block;
}
.photo-result b { color: var(--c-success); }

</style>
