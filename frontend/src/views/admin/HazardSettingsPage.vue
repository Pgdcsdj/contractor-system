<template>
  <div class="hazard-settings-page">
    <div class="card">
      <div class="header">
        <h2>隐患模块设置</h2>
        <button class="btn btn-primary" v-if="activeTab !== 'rectify_biz'" @click="openAdd">
          + 新增{{ currentTab.label }}
        </button>
        <button class="btn btn-primary" v-else @click="openAddBiz">
          + 新增关联
        </button>
        <button class="btn btn-outline" v-if="isLocationTab" @click="showLocImport = true">导入位置</button>
      </div>

      <!-- 分段 Tab：数组驱动（隐患分类 / 隐患分级 / 责任单位·业务口 / 业务部门负责人） -->
      <div class="tabs">
        <button
          v-for="t in DICT_TABS"
          :key="t.type"
          class="tab"
          :class="{ active: activeTab === t.type }"
          @click="activeTab = t.type"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 通用字典表：根据 activeTab 渲染 dictMap[activeTab]（责任单位·业务口 用独立关联区） -->
      <table v-if="activeTab !== 'rectify_biz'" class="data-table">
        <thead>
          <tr>
            <th>排序</th>
            <th>编码</th>
            <th>名称</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loadingMap[activeTab]">
            <td :colspan="colspan" class="empty-cell">加载中…</td>
          </tr>
          <tr v-else-if="currentList.length === 0">
            <td :colspan="colspan" class="empty-cell">暂无{{ currentTab.label }}，请新增</td>
          </tr>
          <tr v-for="item in currentList" :key="item.id">
            <td>{{ item.sort_order }}</td>
            <td><code class="code-cell">{{ item.code }}</code></td>
            <td><strong>{{ item.name }}</strong></td>
            <td>
              <button class="action-link" @click="openEdit(item, activeTab)">编辑</button>
              <button class="action-link danger" @click="removeItem(item, activeTab)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 责任单位·业务口 关联维护区（替换原 整改单位 / 业务部门 两个独立 Tab） -->
      <div v-else class="biz-link-area">
        <p class="hint">责任单位与对应业务口（业务归口）关联维护。新增关联时会自动把责任单位、业务口写入各自字典。</p>
        <table class="data-table">
          <thead>
            <tr>
              <th>责任单位</th>
              <th>业务口（业务部门）</th>
              <th>负责人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="bizLinksLoading">
              <td colspan="4" class="empty-cell">加载中…</td>
            </tr>
            <tr v-else-if="bizLinks.length === 0">
              <td colspan="4" class="empty-cell">暂无关联，请新增</td>
            </tr>
            <tr v-for="item in bizLinks" :key="item.id">
              <td><strong>{{ item.rectify_unit }}</strong></td>
              <td>{{ item.business_dept || '（无）' }}</td>
              <td>{{ item.head_name || '（未设）' }}{{ item.head_phone ? ' / ' + item.head_phone : '' }}</td>
              <td>
                <button class="action-link" @click="editBizLink(item)">编辑</button>
                <button class="action-link danger" @click="deleteBizLink(item)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增/编辑弹窗（通用：code / name / sort；默认等级仅 category） -->
    <div v-if="showForm" class="modal-overlay" @click.self="showForm = false">
      <div class="modal">
        <h3>{{ title }}</h3>
        <div class="form-group">
          <label>编码 (code)</label>
          <input v-model="formCode" class="form-input" :disabled="!!editingId" placeholder="如：A 或 重大" />
        </div>
        <div class="form-group">
          <label>名称 (name)</label>
          <input v-model="formName" class="form-input" placeholder="如：作业 或 重大" />
        </div>
        <div class="form-group">
          <label>排序</label>
          <input v-model.number="formSort" type="number" class="form-input" min="0" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showForm = false">取消</button>
          <button class="btn btn-primary" @click="handleSave" :disabled="!formCode.trim() || !formName.trim() || saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 新增关联弹窗（整改单位 + 业务口） -->
    <div v-if="showBizForm" class="modal-overlay" @click.self="showBizForm = false">
      <div class="modal">
        <h3>{{ editingBizId ? '编辑责任单位·业务口关联' : '新增责任单位·业务口关联' }}</h3>
        <div class="form-group">
          <label>责任单位</label>
          <input v-model="newRectifyUnit" class="form-input" placeholder="如：某承包商单位" />
        </div>
        <div class="form-group">
          <label>业务口（业务归口，可自定义）</label>
          <input v-model="newBiz" class="form-input" placeholder="如：生产组" />
        </div>
        <div class="form-group">
          <label>负责人姓名</label>
          <input v-model="newHeadName" class="form-input" placeholder="如：张三" />
        </div>
        <div class="form-group">
          <label>负责人电话</label>
          <input v-model="newHeadPhone" class="form-input" type="tel" placeholder="11 位手机号（选填）" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showBizForm = false">取消</button>
          <button class="btn btn-primary" @click="submitAddBiz" :disabled="!newRectifyUnit.trim() || savingBiz">
            {{ savingBiz ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 导入位置字典弹窗（生产场站 / 施工点，T07） -->
    <div v-if="showLocImport" class="modal-overlay" @click.self="showLocImport = false">
      <div class="modal">
        <h3>导入位置字典（{{ currentTab.label }}）</h3>
        <p class="modal-hint">上传 .xlsx，文件需含「生产场站」「施工点」两个工作表，各取第 2 列作为字典项（INSERT IGNORE 幂等，重复项自动跳过）。</p>
        <div class="form-group">
          <input type="file" accept=".xlsx,.xls" @change="onLocFileChange" />
        </div>
        <p v-if="locImportMsg" class="loc-msg" :class="locImportType">{{ locImportMsg }}</p>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showLocImport = false" :disabled="locImporting">取消</button>
          <button class="btn btn-primary" @click="submitLocImport" :disabled="!locFile || locImporting">
            {{ locImporting ? '导入中…' : '开始导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import {
  getHazardDict,
  createHazardDict,
  updateHazardDict,
  deleteHazardDict,
  getRectifyUnitBiz,
  saveRectifyUnitBiz,
  deleteRectifyUnitBiz,
  importLocationDict,
} from '@/api/hazard'

// 隐患等级枚举（与后端 LEVELS 保持一致：重大隐患 / 较大隐患 / 一般隐患）
const LEVELS = ['重大隐患', '较大隐患', '一般隐患']

// 字典 Tab 配置（数组驱动；原「整改单位」「业务部门」合并为「整改单位·业务口」关联维护区）
const DICT_TABS = [
  { type: 'level', label: '隐患分级' },
  { type: 'business_dept', label: '业务口' },
  { type: 'rectify_biz', label: '责任单位·业务口' },
  { type: 'center_station', label: '生产场站' },
  { type: 'well_site', label: '施工点' },
  { type: 'hazard_investigation_item', label: '隐患排查项目' },
]

const activeTab = ref('level')
const isCategory = computed(() => activeTab.value === 'category')
// 表格列数（含默认等级列为 5，否则 4）
const colspan = computed(() => (isCategory.value ? 5 : 4))

const dictMap = reactive({})
const loadingMap = reactive({})

const showForm = ref(false)
const editingId = ref(null)
const formType = ref('category')
const formCode = ref('')
const formName = ref('')
const formDefaultLevel = ref('一般')
const formSort = ref(99)
const saving = ref(false)

const currentTab = computed(
  () => DICT_TABS.find((t) => t.type === activeTab.value) || DICT_TABS[0]
)
// 当前 activeTab 对应的字典列表
const currentList = computed(() => dictMap[activeTab.value] || [])

const title = computed(() => {
  const prefix = editingId.value ? '编辑' : '新增'
  return `${prefix}${currentTab.value.label}`
})

// ─── 责任单位·业务口 关联区状态 ──────────────────────────────────────────────
const bizLinks = ref([])
const bizLinksLoading = ref(false)
const showBizForm = ref(false)
const newRectifyUnit = ref('')
const newBiz = ref('')
const newHeadName = ref('')
const newHeadPhone = ref('')
const editingBizId = ref(null)
const editingBizOldUnit = ref('')
const savingBiz = ref(false)

// 通用加载某个 type 的字典项
async function loadType(type) {
  loadingMap[type] = true
  try {
    const res = await getHazardDict(type)
    dictMap[type] = res.data?.data || []
  } catch {
    dictMap[type] = []
  } finally {
    loadingMap[type] = false
  }
}

// 加载整改单位 → 业务口 关联列表
async function loadBizLinks() {
  bizLinksLoading.value = true
  try {
    const res = await getRectifyUnitBiz()
    const list = res.data?.data || []
    bizLinks.value = list
  } catch {
    bizLinks.value = []
  } finally {
    bizLinksLoading.value = false
  }
}

function openAdd() {
  formType.value = activeTab.value
  editingId.value = null
  formCode.value = ''
  formName.value = ''
  formDefaultLevel.value = '一般'
  formSort.value = 99
  showForm.value = true
}

function openEdit(item, type) {
  formType.value = type
  editingId.value = item.id
  formCode.value = item.code
  formName.value = item.name
  formDefaultLevel.value = item.default_level || '一般'
  formSort.value = item.sort_order
  showForm.value = true
}

async function handleSave() {
  if (!formCode.value.trim() || !formName.value.trim()) return
  saving.value = true
  try {
    const payload = {
      type: formType.value,
      code: formCode.value.trim(),
      name: formName.value.trim(),
      sort_order: Number(formSort.value) || 0,
    }
    if (editingId.value) {
      await updateHazardDict(editingId.value, payload)
    } else {
      await createHazardDict(payload)
    }
    showForm.value = false
    await loadType(formType.value)
  } catch (e) {
    alert(e.response?.data?.error || '操作失败')
  } finally {
    saving.value = false
  }
}

// 表格内联修改默认等级（仅 category）
async function onDefaultLevelChange(item) {
  try {
    await updateHazardDict(item.id, { type: 'category', default_level: item.default_level })
  } catch (e) {
    alert(e.response?.data?.error || '操作失败')
    loadType('category') // 失败回滚
  }
}

function removeItem(item, type) {
  const label = DICT_TABS.find((t) => t.type === type)?.label || '项'
  if (!confirm(`确定删除${label}"${item.name}"？`)) return
  deleteHazardDict(item.id, type)
    .then(() => loadType(type))
    .catch((e) => alert(e.response?.data?.error || '操作失败'))
}

// ─── 责任单位·业务口 关联区操作 ──────────────────────────────────────────────
function openAddBiz() {
  editingBizId.value = null
  editingBizOldUnit.value = ''
  newRectifyUnit.value = ''
  newBiz.value = ''
  newHeadName.value = ''
  newHeadPhone.value = ''
  showBizForm.value = true
}

// 编辑关联：打开弹窗并预填
function editBizLink(item) {
  editingBizId.value = item.id
  editingBizOldUnit.value = item.rectify_unit
  newRectifyUnit.value = item.rectify_unit
  newBiz.value = item.business_dept || ''
  newHeadName.value = item.head_name || ''
  newHeadPhone.value = item.head_phone || ''
  showBizForm.value = true
}

// 新增 / 编辑关联：写关联 + 自动补字典（整改单位 / 业务口），再重新加载
async function submitAddBiz() {
  const ru = newRectifyUnit.value.trim()
  if (!ru) {
    alert('责任单位不能为空')
    return
  }
  savingBiz.value = true
  try {
    // 编辑带 id，新增不带；负责人信息一并提交
    const payload = {
      rectify_unit: ru,
      business_dept: newBiz.value || '',
      head_name: newHeadName.value.trim(),
      head_phone: newHeadPhone.value.trim(),
    }
    if (editingBizId.value) payload.id = editingBizId.value
    await saveRectifyUnitBiz(payload)

    // 自动补字典：整改单位
    const ruDict = (await getHazardDict('rectify_unit')).data?.data || []
    if (editingBizId.value && ru !== editingBizOldUnit.value) {
      // 编辑且改名：更新旧名对应的字典项，找不到则新建
      const oldItem = ruDict.find((d) => (d.name || d.code) === editingBizOldUnit.value)
      if (oldItem) {
        await updateHazardDict(oldItem.id, { type: 'rectify_unit', code: ru, name: ru })
      } else {
        await createHazardDict({ type: 'rectify_unit', code: ru, name: ru, sort_order: 99 })
      }
    } else if (!editingBizId.value) {
      // 新增：不存在则创建
      if (!ruDict.some((d) => (d.name || d.code) === ru)) {
        await createHazardDict({ type: 'rectify_unit', code: ru, name: ru, sort_order: 99 })
      }
    }

    // 自动补字典：业务口（若已填且不在 business_dept 字典；新增/编辑均适用）
    if (newBiz.value) {
      const bizDict = (await getHazardDict('business_dept')).data?.data || []
      if (!bizDict.some((d) => (d.name || d.code) === newBiz.value)) {
        await createHazardDict({ type: 'business_dept', code: newBiz.value, name: newBiz.value, sort_order: 99 })
      }
    }

    // 重置状态
    showBizForm.value = false
    newRectifyUnit.value = ''
    newBiz.value = ''
    newHeadName.value = ''
    newHeadPhone.value = ''
    editingBizId.value = null
    editingBizOldUnit.value = ''
    await loadBizLinks()
    await loadType('rectify_unit')
    await loadType('business_dept')
  } catch (e) {
    alert(e.response?.data?.error || '操作失败')
  } finally {
    savingBiz.value = false
  }
}

// 删除关联：仅删关联行，不删字典项
async function deleteBizLink(item) {
  if (!confirm(`确定删除关联「${item.rectify_unit} → ${item.business_dept || '（无）'}」？仅删除关联，不删字典项。`)) return
  try {
    await deleteRectifyUnitBiz(item.id)
    await loadBizLinks()
  } catch (e) {
    alert(e.response?.data?.error || '操作失败')
  }
}

// 切到关联 Tab 时刷新列表（业务口下拉常驻加载）
watch(activeTab, (val) => {
  if (val === 'rectify_biz') loadBizLinks()
})

// ─── 位置字典导入（生产场站 / 施工点，T07） ──────────────────────────────
const showLocImport = ref(false)
const locFile = ref(null)
const locImporting = ref(false)
const locImportMsg = ref('')
const locImportType = ref('success')
const isLocationTab = computed(() => activeTab.value === 'center_station' || activeTab.value === 'well_site')

function onLocFileChange(e) {
  const f = e.target.files && e.target.files[0]
  locFile.value = f ? f : null
}

async function submitLocImport() {
  if (!locFile.value || locImporting.value) return
  locImporting.value = true
  locImportMsg.value = ''
  try {
    const res = await importLocationDict(locFile.value)
    const d = res.data?.data || {}
    locImportType.value = 'success'
    locImportMsg.value = d.message || '导入完成'
    showLocImport.value = false
    locFile.value = null
    await loadType(activeTab.value)
  } catch (e) {
    locImportType.value = 'error'
    locImportMsg.value = e.response?.data?.error || '导入失败'
  } finally {
    locImporting.value = false
  }
}

onMounted(() => {
  // 预加载全部字典类型
  const tasks = DICT_TABS.map((t) => loadType(t.type))
  loadBizLinks()
  return Promise.all(tasks)
})
</script>

<style scoped>
.hazard-settings-page { max-width: 860px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header h2 { font-size: 18px; }

.tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.tab {
  padding: 8px 18px; border: 1px solid var(--border); background: #fff;
  border-radius: 8px; font-size: 14px; cursor: pointer; color: var(--text-secondary);
  transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }

.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table th {
  text-align: left; padding: 10px 14px; background: #f8f9fa; font-size: 13px;
  color: var(--text-secondary); border-bottom: 1px solid var(--border);
}
.data-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.data-table tr:last-child td { border-bottom: none; }
.empty-cell { text-align: center; padding: 30px; color: var(--text-secondary); }

.hint { font-size: 13px; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.6; }

.code-cell {
  font-family: monospace; background: #f2f4f7; padding: 2px 6px;
  border-radius: 4px; font-size: 13px;
}
.level-select {
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; background: #fff; cursor: pointer;
}
.action-link {
  background: none; border: none; color: var(--primary); cursor: pointer;
  font-size: 13px; padding: 4px 8px; border-radius: 6px;
}
.action-link:hover { background: #e8f0fe; }
.action-link.danger { color: var(--danger); }
.action-link.danger:hover { background: #fce8e6; }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.modal { background: #fff; border-radius: 16px; padding: 28px; width: 100%; max-width: 420px; }
.modal h3 { font-size: 18px; margin-bottom: 16px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 14px; box-sizing: border-box; background: #fff;
}
.form-input:focus { outline: none; border-color: var(--primary); }
.form-input:disabled { background: #f2f4f7; color: var(--text-secondary); cursor: not-allowed; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.modal-actions .btn { width: auto; }

.loc-msg { font-size: 13px; margin: 0 0 12px; line-height: 1.6; padding: 10px 12px; border-radius: 8px; }
.loc-msg.success { background: #e6f4ea; color: #2e7d32; }
.loc-msg.error { background: #fdecea; color: #c62828; }
</style>
