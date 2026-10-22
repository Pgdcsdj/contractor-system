<template>
  <div class="notify-config-page">
    <div class="card">
      <div class="header">
        <div>
          <h2>钉钉通知设置</h2>
          <p class="sub">隐患相关消息发往钉钉群的开关、频次与接收范围（即时生效，无需重启）</p>
        </div>
        <!-- 总开关 -->
        <label class="master-switch">
          <span class="master-label">{{ form.enabled ? '通知已开启' : '通知已暂停' }}</span>
          <input type="checkbox" v-model="form.enabled" @change="onMasterToggle" />
          <span class="track" :class="{ on: form.enabled }"><span class="thumb"></span></span>
        </label>
      </div>

      <p v-if="!form.enabled" class="paused-banner">
        ⏸ 当前已暂停全部钉钉群通知。开启上方开关即恢复（仍受下方各事件开关约束）。
      </p>

      <!-- 事件开关 -->
      <section class="group">
        <h3 class="group-title">① 提醒什么内容（事件开关）</h3>
        <p class="group-hint">关闭某项即不再发送该类通知。带「运行中」标签的为当前实际在发的通知。</p>
        <div class="switch-list">
          <label v-for="ev in EVENT_DEFS" :key="ev.key" class="switch-row" :class="{ dim: !form.enabled }">
            <input type="checkbox" v-model="form.events[ev.key]" :disabled="!form.enabled" />
            <span class="switch-box"><span class="switch-thumb"></span></span>
            <span class="switch-text">
              <strong>{{ ev.label }}<span v-if="ev.live" class="live-tag">运行中</span></strong>
              <small>{{ ev.desc }}</small>
            </span>
          </label>
        </div>
      </section>

      <!-- 频次 -->
      <section class="group">
        <h3 class="group-title">② 发送频次</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>超期提醒间隔</label>
            <select v-model.number="form.frequency.overdue_interval_days" class="form-input" :disabled="!form.enabled">
              <option v-for="o in OVERDUE_INTERVALS" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
            <small>超期隐患合并提醒的发送间隔（默认每天一次）</small>
          </div>
          <div class="form-group">
            <label>超期扫描间隔（分钟）</label>
            <input type="number" min="5" max="1440" v-model.number="form.frequency.scan_interval_min" class="form-input" :disabled="!form.enabled" />
            <small>系统多久扫一次超期隐患（影响发现及时性，不影响通知频次）</small>
          </div>
          <div class="form-group">
            <label>未整改周报发送日</label>
            <select v-model.number="form.frequency.weekly_excel_day" class="form-input" :disabled="!form.enabled">
              <option v-for="w in WEEK_DAYS" :key="w.v" :value="w.v">{{ w.label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>未整改周报时刻（小时 0-23）</label>
            <input type="number" min="0" max="23" v-model.number="form.frequency.weekly_excel_hour" class="form-input" :disabled="!form.enabled" />
          </div>
          <div class="form-group">
            <label>周通报发送日 <em class="muted">（周通报当前停用）</em></label>
            <select v-model.number="form.frequency.weekly_day" class="form-input" :disabled="!form.enabled">
              <option v-for="w in WEEK_DAYS" :key="w.v" :value="w.v">{{ w.label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>周通报时刻（小时） <em class="muted">（周通报当前停用）</em></label>
            <input type="number" min="0" max="23" v-model.number="form.frequency.weekly_hour" class="form-input" :disabled="!form.enabled" />
          </div>
        </div>
      </section>

      <!-- @范围 -->
      <section class="group">
        <h3 class="group-title">③ 提醒发给谁（@范围）</h3>
        <div class="switch-list">
          <label v-for="at in AT_DEFS" :key="at.key" class="switch-row" :class="{ dim: !form.enabled }">
            <input type="checkbox" v-model="form.at_scope[at.key]" :disabled="!form.enabled" />
            <span class="switch-box"><span class="switch-thumb"></span></span>
            <span class="switch-text">
              <strong>{{ at.label }}</strong>
              <small>{{ at.desc }}</small>
            </span>
          </label>
        </div>
      </section>

      <div class="footer-actions">
        <p v-if="msg" class="msg" :class="msgType">{{ msg }}</p>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存配置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { request } from '@/utils/request'

const loading = ref(false)
const saving = ref(false)
const msg = ref('')
const msgType = ref('')

const EVENT_DEFS = [
  { key: 'overdue', label: '超期合并提醒', desc: '隐患超期未闭环时，按责任人合并提醒', live: true },
  { key: 'weekly_excel', label: '未整改隐患周报', desc: '每周生成未整改清单 Excel + 钉钉统计', live: true },
  { key: 'report', label: '新隐患上报', desc: '有人录入新隐患时通知相关人（开启即恢复）' },
  { key: 'assign', label: '整改分派', desc: '隐患分派时通知责任人（开启即恢复）' },
  { key: 'verify', label: '验收结果', desc: '隐患验收通过/退回时通知（开启即恢复）' },
  { key: 'weekly', label: '周通报', desc: '每周隐患闭环统计（开启即恢复）' },
  { key: 'daily_digest', label: '每日摘要', desc: '每日录入隐患汇总（开启即恢复）' },
]
const WEEK_DAYS = [
  { v: 1, label: '周一' }, { v: 2, label: '周二' }, { v: 3, label: '周三' },
  { v: 4, label: '周四' }, { v: 5, label: '周五' }, { v: 6, label: '周六' }, { v: 7, label: '周日' },
]
const OVERDUE_INTERVALS = [
  { v: 1, label: '每天' }, { v: 2, label: '每 2 天' }, { v: 3, label: '每 3 天' }, { v: 7, label: '每周（每 7 天）' },
]
const AT_DEFS = [
  { key: 'owner', label: '@整改责任人', desc: '超期/分派时 @ 责任人手机' },
  { key: 'party_a', label: '@甲方联系人', desc: '通知业务主管部门（甲方）联系人' },
  { key: 'safety_office', label: '@安全环保室', desc: '通知项目部安全环保室' },
]

const form = reactive({ enabled: true, events: {}, frequency: {}, at_scope: {} })
const DEFAULTS = { enabled: true, events: {}, frequency: {}, at_scope: {} }

function deepClone(o) { return JSON.parse(JSON.stringify(o)) }

function mergeInto(target, src) {
  target.enabled = !!src.enabled
  Object.assign(target.events, src.events || {})
  Object.assign(target.frequency, src.frequency || {})
  Object.assign(target.at_scope, src.at_scope || {})
}

async function load() {
  loading.value = true
  try {
    const res = await request.get('/api/notify-config')
    const d = res.data?.data || {}
    mergeInto(form, { enabled: d.enabled, events: d.events, frequency: d.frequency, at_scope: d.at_scope })
    Object.assign(DEFAULTS, deepClone({ enabled: d.enabled, events: d.events, frequency: d.frequency, at_scope: d.at_scope }))
  } catch (e) {
    msg.value = e.response?.data?.error || '加载失败'
    msgType.value = 'error'
  } finally {
    loading.value = false
  }
}

function onMasterToggle() {
  // 总开关变化仅更新状态，保存时落库
  msg.value = ''
}

async function save() {
  saving.value = true
  msg.value = ''
  try {
    const res = await request.put('/api/notify-config', deepClone(form))
    const d = res.data?.data || {}
    mergeInto(form, { enabled: d.enabled, events: d.events, frequency: d.frequency, at_scope: d.at_scope })
    msg.value = '已保存，配置立即生效'
    msgType.value = 'success'
  } catch (e) {
    msg.value = e.response?.data?.error || '保存失败'
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.notify-config-page { max-width: 880px; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 16px; }
.header h2 { font-size: 18px; margin: 0; }
.sub { font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; line-height: 1.6; }

/* 总开关 */
.master-switch { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; cursor: pointer; }
.master-label { font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.master-switch input { display: none; }
.track { width: 52px; height: 28px; border-radius: 999px; background: #cbd5e1; position: relative; transition: background .2s; }
.track.on { background: var(--primary); }
.thumb { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: left .2s; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.track.on .thumb { left: 27px; }

.paused-banner { background: #fff7e6; border: 1px solid #ffd8a8; color: #b45309; padding: 10px 14px; border-radius: 10px; font-size: 13px; margin: 4px 0 16px; }

.group { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px; }
.group-title { font-size: 15px; margin: 0 0 4px; }
.group-hint { font-size: 12.5px; color: var(--text-secondary); margin: 0 0 12px; }

.switch-list { display: flex; flex-direction: column; gap: 8px; }
.switch-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; transition: background .15s; }
.switch-row:hover { background: #f8fafc; }
.switch-row.dim { opacity: .5; }
.switch-row input { display: none; }
.switch-box { width: 42px; height: 24px; border-radius: 999px; background: #cbd5e1; position: relative; flex-shrink: 0; transition: background .2s; }
.switch-box .switch-thumb { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left .2s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch-row input:checked + .switch-box { background: var(--primary); }
.switch-row input:checked + .switch-box .switch-thumb { left: 21px; }
.switch-text { display: flex; flex-direction: column; line-height: 1.4; }
.switch-text strong { font-size: 14px; display: flex; align-items: center; gap: 8px; }
.switch-text small { font-size: 12px; color: var(--text-secondary); }
.live-tag { background: #e6f4ea; color: #2e7d32; font-size: 11px; padding: 1px 7px; border-radius: 6px; font-weight: 600; }

.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.form-group { display: flex; flex-direction: column; }
.form-group label { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-group .muted { color: #b45309; font-style: normal; font-size: 11px; }
.form-input { padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: #fff; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--primary); }
.form-group small { font-size: 11.5px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5; }

.footer-actions { display: flex; align-items: center; gap: 16px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
.msg { font-size: 13px; margin: 0; }
.msg.success { color: #2e7d32; }
.msg.error { color: var(--danger); }

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
  .header { flex-direction: column; }
}
</style>
