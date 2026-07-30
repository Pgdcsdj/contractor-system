/**
 * AI 配置管理模块
 * 支持多 Provider：DeepSeek / SiliconFlow / Groq
 *
 * 使用方式：
 *   const { getProvider, listProviders, testConnection } = require('./aiConfig')
 *   const provider = getProvider()  // 读取当前激活的 Provider
 */

const fs = require('fs')
const path = require('path')

// ─── 配置文件路径 ────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'ai-config.json')

// ─── Provider 定义 ───────────────────────────────────────────────────────────
const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: {
      chat: 'deepseek-chat',
      reasoner: 'deepseek-reasoner',
    },
    supportsVision: false,
    freeQuota: 0, // 无免费额度
    pricePer1K: { input: 0.27, output: 2.19 }, // ¥/M tokens
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: {
      chat: 'deepseek-ai/DeepSeek-V3',         // DeepSeek V3，同等质量
      reasoner: 'deepseek-ai/DeepSeek-R1',     // DeepSeek R1，推理模型
      qwen: 'Qwen/Qwen2.5-72B-Instruct',       // Qwen，免费额度多
      yi: '01ai/Yi-34B',                       // 零一万物备选
      vision: 'Qwen/Qwen2-VL-72B-Instruct',    // 视觉模型，支持看图
    },
    supportsVision: true,
    freeQuota: 1000, // 每月1000次免费（DeepSeek-R1）
    pricePer1K: { input: 0.001, output: 0.001 }, // ¥/M tokens，极便宜
  },
  groq: {
    id: 'groq',
    name: 'Groq (Llama免费)',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: {
      chat: 'llama-3.3-70b-versatile',  // 免费主力
      reasoner: 'deepseek-r1-distill-qwen-32b', // 推理模型
    },
    supportsVision: false,
    freeQuota: 999999, // 几乎无限免费
    pricePer1K: { input: 0, output: 0 }, // 免费
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: {
      chat: 'gpt-4o',                          // GPT-4o，支持视觉
      vision: 'gpt-4o',                        // 同上
      reasoner: 'o3-mini',                     // 推理模型
    },
    supportsVision: true,
    freeQuota: 0,
    pricePer1K: { input: 0.005, output: 0.015 }, // $/1K tokens
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: {
      chat: 'kimi-k2.6',                       // Kimi K2.6，支持视觉
      vision: 'kimi-k2.6',                     // 同上
      reasoner: 'kimi-k2.6',                   // 推理模型
    },
    supportsVision: true,
    freeQuota: 0,
    pricePer1K: { input: 0.012, output: 0.012 }, // ¥/K tokens（按实际计费调整）
  },
}

// ─── 默认配置 ───────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  // 当前激活的 Provider
  provider: 'siliconflow', // 'deepseek' | 'siliconflow' | 'groq'
  // 各 Provider 的 API Key
  apiKeys: {
    deepseek: 'YOUR_DEEPSEEK_API_KEY_HERE',
    siliconflow: '',        // 管理员在后台配置
    groq: '',               // 管理员在后台配置
    moonshot: '',           // 管理员在后台配置
  },
  // 各功能使用的模型
  models: {
    question: 'chat',       // 出题用 chat 模型
    grading: 'chat',       // 评分用 chat 模型
  },
  // 出题参数
  questionConfig: {
    defaultCount: 10,       // 默认出题数量
    temperature: 0.3,       // 随机性（越低越稳定）
    maxTokens: 2000,
  },
  // 评分参数
  gradingConfig: {
    pointsPerItem: 2,       // 每个要点几分
    maxScore: 20,           // 简答题满分
  },
}

// ─── 配置读写 ───────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      return { ...DEFAULT_CONFIG, ...saved }
    }
  } catch (e) {
    console.warn('[AI Config] 读取失败，使用默认配置:', e.message)
  }
  return { ...DEFAULT_CONFIG }
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  console.log('[AI Config] 配置已保存到', CONFIG_PATH)
}

// ─── 核心函数 ───────────────────────────────────────────────────────────────

/**
 * 获取当前激活的 Provider 实例
 */
function getProvider() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]
  if (!provider) throw new Error(`未知的 Provider: ${config.provider}`)
  return provider
}

/**
 * 获取当前 API Key
 */
function getApiKey() {
  const config = loadConfig()
  const key = config.apiKeys[config.provider]
  if (!key) throw new Error(`Provider "${config.provider}" 未配置 API Key，请在后台设置`)
  return key
}

/**
 * 获取出题用的模型名称（实际模型ID）
 */
function getQuestionModel() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]
  if (!provider) return null
  const modelKey = config.models.question || 'chat'
  return provider.models[modelKey] || provider.models.chat
}

/**
 * 获取评分用的模型名称
 */
function getGradingModel() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]
  if (!provider) return null
  const modelKey = config.models.grading || 'chat'
  return provider.models[modelKey] || provider.models.chat
}

/**
 * 获取支持Vision的模型名称（用于图片理解出题）
 * 如果当前Provider不支持Vision，返回null
 */
function getVisionModel() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]
  if (!provider || !provider.supportsVision) return null
  const modelKey = config.models.vision || 'vision'
  return provider.models[modelKey] || provider.models.chat
}

/**
 * 检查当前Provider是否支持Vision
 */
function supportsVision() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]
  return !!provider && !!provider.supportsVision && !!getVisionModel()
}

/**
 * 获取当前完整配置（用于后台展示，隐藏真实Key）
 */
function getConfigSummary() {
  const config = loadConfig()
  const provider = PROVIDERS[config.provider]

  if (!provider) {
    console.error('[AI Config] 未知 Provider:', config.provider, '可用:', Object.keys(PROVIDERS))
    return {
      active: {
        provider: config.provider || 'unknown',
        providerName: '未知（Provider未注册）',
        model: null,
        hasKey: false,
        keyPreview: '未配置',
        freeQuota: 0,
        pricePer1K: { input: 0, output: 0 },
      },
      availableProviders: listProviders(),
    }
  }

  return {
    active: {
      provider: config.provider,
      providerName: provider.name,
      model: getQuestionModel(),
      hasKey: !!config.apiKeys[config.provider],
      keyPreview: config.apiKeys[config.provider]
        ? config.apiKeys[config.provider].slice(0, 8) + '****'
        : '未配置',
      freeQuota: provider.freeQuota,
      pricePer1K: provider.pricePer1K,
    },
    availableProviders: Object.values(PROVIDERS).map(p => ({
      id: p.id,
      name: p.name,
      models: p.models,
      freeQuota: p.freeQuota,
      pricePer1K: p.pricePer1K,
    })),
  }
}

/**
 * 更新配置
 */
function updateConfig(updates) {
  const config = loadConfig()
  const newConfig = { ...config, ...updates }
  // 合并嵌套对象
  if (updates.apiKeys) {
    newConfig.apiKeys = { ...config.apiKeys, ...updates.apiKeys }
  }
  if (updates.questionConfig) {
    newConfig.questionConfig = { ...config.questionConfig, ...updates.questionConfig }
  }
  if (updates.gradingConfig) {
    newConfig.gradingConfig = { ...config.gradingConfig, ...updates.gradingConfig }
  }
  saveConfig(newConfig)
  return newConfig
}

/**
 * 测试 API 连接
 */
async function testConnection(providerId, apiKey) {
  const provider = PROVIDERS[providerId]
  if (!provider) return { success: false, error: `未知的 Provider: ${providerId}` }

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.models.chat,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      }),
    })

    if (response.ok) {
      return { success: true, message: `${provider.name} 连接成功` }
    } else {
      const err = await response.json().catch(() => ({}))
      return { success: false, error: err.error?.message || `HTTP ${response.status}` }
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

/**
 * 列出所有 Provider
 */
function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    freeQuota: p.freeQuota,
    pricePer1K: p.pricePer1K,
  }))
}

module.exports = {
  PROVIDERS,
  loadConfig,          // 供内部模块使用
  getProvider,
  getApiKey,
  getQuestionModel,
  getGradingModel,
  getVisionModel,
  supportsVision,
  getConfigSummary,
  updateConfig,
  testConnection,
  listProviders,
}
