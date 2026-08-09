<template>
  <div class="settings-page">
    <!-- AI 出题配置 -->
    <div class="card">
      <h3 class="section-title">🤖 AI 出题配置</h3>

      <div class="form-group">
        <label>AI 服务商</label>
        <select v-model="aiProvider" class="form-input" style="padding: 9px 12px;">
          <option value="deepseek">DeepSeek 官方</option>
          <option value="moonshot">Moonshot (Kimi)</option>
          <option value="siliconflow">硅基流动 (SiliconFlow)</option>
          <option value="groq">Groq (Llama免费)</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>

      <div class="form-group">
        <label>API Key</label>
        <div class="input-with-btn">
          <input
            v-model="aiApiKey"
            :type="showKey ? 'text' : 'password'"
            class="form-input"
            placeholder="sk-xxxxxxxxxxxxxxxx"
          />
          <button class="toggle-btn" @click="showKey = !showKey">{{ showKey ? '🙈' : '👁' }}</button>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>API 地址</label>
          <input v-model="aiApiUrl" class="form-input" placeholder="https://api.xxx.com/v1" />
        </div>
        <div class="form-group">
          <label>模型名称</label>
          <input v-model="aiModel" class="form-input" placeholder="模型名称" />
        </div>
      </div>

      <button class="btn btn-primary" style="width:auto" @click="saveSettings('deepseek')" :disabled="saving">
        {{ saving === 'deepseek' ? '保存中…' : '保存配置' }}
      </button>
      <p v-if="savedKey === 'deepseek'" class="save-ok">✅ 配置已保存</p>
    </div>

    <!-- 腾讯云 COS 配置 -->
    <div class="card">
      <h3 class="section-title">☁️ 腾讯云 COS 配置</h3>
      <div class="form-group">
        <label>Secret ID</label>
        <input v-model="settings.cos_secret_id" class="form-input" placeholder="AKIDxxxxxxxxxxxx" />
      </div>
      <div class="form-group">
        <label>Secret Key</label>
        <input v-model="settings.cos_secret_key" type="password" class="form-input" placeholder="xxxxxxxxxxxx" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Bucket 名称</label>
          <input v-model="settings.cos_bucket" class="form-input" placeholder="tnb-training" />
        </div>
        <div class="form-group">
          <label>地域（Region）</label>
          <input v-model="settings.cos_region" class="form-input" placeholder="ap-chengdu" />
        </div>
      </div>
      <button class="btn btn-primary" style="width:auto" @click="saveSettings('cos')" :disabled="saving">
        {{ saving === 'cos' ? '保存中…' : '保存配置' }}
      </button>
      <p v-if="savedKey === 'cos'" class="save-ok">✅ 配置已保存</p>
    </div>

    <!-- 安全设置 -->
    <div class="card">
      <h3 class="section-title">🔒 安全设置</h3>
      <div class="form-group">
        <label>修改管理员密码</label>
        <input v-model="settings.new_password" type="password" class="form-input" placeholder="新密码（留空不修改）" />
      </div>
      <button class="btn btn-primary" style="width:auto" @click="saveSettings('password')" :disabled="saving">
        {{ saving === 'password' ? '保存中…' : '修改密码' }}
      </button>
      <p v-if="savedKey === 'password'" class="save-ok">✅ 密码已修改</p>
    </div>

    <!-- 服务器地址（用于二维码） -->
    <div class="card">
      <h3 class="section-title">📱 服务器地址</h3>
      <p class="field-desc">员工扫码答题时访问的公网地址，例如 http://123.456.789.0:3000 或 https://your-domain.com</p>
      <div class="form-group">
        <label>公网地址</label>
        <input v-model="settings.server_public_url" class="form-input" placeholder="留空则使用当前页面地址" />
      </div>
      <button class="btn btn-primary" style="width:auto" @click="saveSettings('server_url')" :disabled="saving">
        {{ saving === 'server_url' ? '保存中…' : '保存配置' }}
      </button>
      <p v-if="savedKey === 'server_url'" class="save-ok">✅ 配置已保存</p>
    </div>

    <!-- 系统信息 -->
    <div class="card info-card">
      <h3 class="section-title">ℹ️ 系统信息</h3>
      <div class="info-grid">
        <div class="info-item"><span class="info-label">系统版本</span><span class="info-val">{{ APP_VERSION }}</span></div>
        <div class="info-item"><span class="info-label">后端版本</span><span class="info-val">{{ backendVersion }}</span></div>
        <div class="info-item"><span class="info-label">构建时间</span><span class="info-val">{{ BUILD_DATE }}</span></div>
        <div class="info-item"><span class="info-label">Node.js</span><span class="info-val">v20.x</span></div>
        <div class="info-item"><span class="info-label">MySQL</span><span class="info-val">v8.0</span></div>
        <div class="info-item"><span class="info-label">部署环境</span><span class="info-val">Docker</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { request } from '@/utils/request'
import { APP_VERSION, BUILD_DATE } from '@/version'

const showKey = ref(false)
const saving = ref(null)
const savedKey = ref(null)
const backendVersion = ref('—')

const settings = reactive({
  deepseek_api_key: '',
  deepseek_api_url: 'https://api.deepseek.com/v1',
  deepseek_model: 'deepseek-chat',
  cos_secret_id: '',
  cos_secret_key: '',
  cos_bucket: 'tnb-training',
  cos_region: 'ap-chengdu',
  server_public_url: '',
  new_password: '',
})

// AI 配置（对接 ai-config.json）
const aiProvider = ref('deepseek')
const aiApiKey = ref('')
const aiApiUrl = ref('')
const aiModel = ref('')
const availableProviders = ref([])

async function saveSettings(key) {
  saving.value = key
  try {
    // AI 配置同时保存到 ai-config.json（真正生效）
    if (key === 'deepseek') {
      await request.put('/api/ai/config', {
        provider: aiProvider.value,
        apiKeys: { [aiProvider.value]: aiApiKey.value },
        models: {
          question: 'chat',
          grading: 'chat',
          vision: 'vision',
        },
      })
      // 同时保存到 t_system_config（兼容原有逻辑）
      await request.post('/api/admin/settings', {
        key,
        data: {
          ...settings,
          deepseek_api_key: aiApiKey.value,
          deepseek_api_url: aiApiUrl.value || availableProviders.value.find(p => p.id === aiProvider.value)?.baseUrl || '',
          deepseek_model: aiModel.value,
        },
      })
    } else {
      await request.post('/api/admin/settings', { key, data: settings })
    }
    savedKey.value = key
    setTimeout(() => { savedKey.value = null }, 2500)
    if (key === 'password') settings.new_password = ''
  } catch (e) {
    alert(e.response?.data?.error || e.response?.data?.detail || '保存失败')
  } finally {
    saving.value = null
  }
}

async function loadSettings() {
  // 加载系统配置
  try {
    const res = await request.get('/api/admin/settings')
    if (res.data?.data) {
      Object.assign(settings, res.data.data)
    }
  } catch {}

  // 加载 AI 配置（真正生效的配置）
  try {
    const res = await request.get('/api/ai/config')
    const data = res.data?.data
    if (data?.active) {
      aiProvider.value = data.active.provider || 'deepseek'
      aiApiKey.value = '' // 隐藏完整Key，由用户重新输入
      const p = data.availableProviders?.find(p => p.id === aiProvider.value)
      aiApiUrl.value = p?.baseUrl || ''
      aiModel.value = data.active.model || ''
      availableProviders.value = data.availableProviders || []
    }
  } catch {
    // 降级：从系统配置猜测
    aiProvider.value = settings.deepseek_api_url?.includes('moonshot') ? 'moonshot' : 'deepseek'
    aiApiUrl.value = settings.deepseek_api_url || 'https://api.deepseek.com/v1'
    aiModel.value = settings.deepseek_model || 'deepseek-chat'
    aiApiKey.value = settings.deepseek_api_key || ''
  }
}

onMounted(() => {
  loadSettings()
  loadVersion()
})

// 拉取后端版本（公开接口，无需鉴权）
async function loadVersion() {
  try {
    const res = await request.get('/api/version')
    backendVersion.value = res.data?.version || '未知'
  } catch {
    backendVersion.value = '获取失败'
  }
}
</script>

<style scoped>
.settings-page { max-width: 700px; display: flex; flex-direction: column; gap: 16px; }

.card { padding: 20px; }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }

.form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.form-group label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.form-input {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
}
.form-input:focus { outline: none; border-color: var(--primary); }

.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }

.input-with-btn { display: flex; gap: 8px; }
.input-with-btn .form-input { flex: 1; }
.toggle-btn { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 0 12px; cursor: pointer; font-size: 16px; }

.save-ok { color: var(--success); font-size: 13px; margin-top: 8px; }

.info-card { background: #f8f9fa; }
.field-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.6; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.info-item { display: flex; justify-content: space-between; padding: 8px 12px; background: #fff; border-radius: 8px; }
.info-label { font-size: 13px; color: var(--text-secondary); }
.info-val { font-size: 13px; font-weight: 600; }
</style>
