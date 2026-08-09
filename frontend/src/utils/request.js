import axios from 'axios'
import { useAuthStore } from '@/stores/auth'

// admin 接口前缀（请求需注入 admin token；401 时跳 /admin/login）
const ADMIN_API_PREFIXES = [
  '/api/admin',
  '/api/record',
  '/api/material',
  '/api/ai/config',
  '/api/contractor-units',
  '/api/hazard',
  '/api/rectify-unit-biz', // ← 本次新增，修复隐患设置页误跳 /login 的 Bug
  '/api/safety',    // ← 安全员登录（公开，但走 admin token 存储复用）
  '/api/account',   // ← 账号管理（admin/superadmin）
  '/api/data',      // ← 数据备份/导出（admin/superadmin）
  '/api/contractor-docs', // ← 承包商开工资料（admin/superadmin）
  '/api/quality',   // ← 出题质量量化校验与追踪（admin/superadmin）
]

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// 请求拦截：自动注入 JWT（员工 / 管理员）
request.interceptors.request.use((config) => {
  // 管理员接口用 admin token，员工接口用普通 token
  const isAdminApi = ADMIN_API_PREFIXES.some((prefix) =>
    config.url?.startsWith(prefix)
  )
  if (isAdminApi) {
    const adminToken = localStorage.getItem('tnb_admin_token')
    if (adminToken) config.headers.Authorization = `Bearer ${adminToken}`
  } else {
    const token = localStorage.getItem('tnb_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  // 上传 / AI 出题类请求放宽超时：大文件 + COS 上传 + 模型响应耗时，
  // 默认 15s 易被 axios 主动掐断，表现为「上传失败」。与 nginx proxy_read_timeout(300s) 对齐，
  // 避免前端先于网关掐断。其他请求保持 15s。
  // 质量校验类接口（check/enrich/keypoints/export）内部会多次调用大模型，
  // 与出题接口同样放宽到 300s，避免 15s 超时导致「校验失败」误报。
  // 数据备份/导出（/api/data/backup、/api/data/export）需全表扫描 + 拼装多 Sheet，
  // 实测生成 4.5MB 文件约 9~15s，手机端网络下极易顶破 15s 默认超时，
  // 故一并放宽到 300s，避免误报「备份失败」。
  // 答题提交（/api/quiz/.../submit、/api/quiz/wrong-practice/submit）同理：
  // 大题量（上千题）提交时服务端需逐题评分 + 错题闭环写入，且返回体含整卷 gradedList，
  // 手机端网络下整体耗时可逼近 15s，超时会被 axios 掐断并误入离线队列（错题不落库）。
  // 故将答题提交类接口也放宽到 300s，与 nginx proxy_read_timeout 对齐。
  if (
    config.url &&
    /\/upload|preview-ai|confirm-questions|\/api\/quality\/|\/api\/data\/|\/api\/quiz\//.test(config.url)
  ) {
    config.timeout = 300000
  }
  return config
})

// 响应拦截：401 → 跳转对应登录页
request.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const url = err.config?.url || ''
      // 登录类接口（/api/admin/login、/api/safety/login）失败不跳转，由页面自行提示
      if (url.includes('/login')) {
        return Promise.reject(err)
      }
      localStorage.removeItem('tnb_admin_token')
      localStorage.removeItem('tnb_admin_user')
      // 清除员工端（培训端）会话，避免 401 整页刷新后 localStorage 仍残留
      // 员工 token，导致 isLoggedIn 持续为真、反复跳 /quiz 形成死循环
      localStorage.removeItem('tnb_token')
      localStorage.removeItem('tnb_user')
      // 跳回各自登录页。拼接 Vite base（生产 /tnb/，开发 /），确保三端跳转目标
      // 与 base 一致，线上能正确回到 /tnb/login、/tnb/admin/login、/tnb/safety/login
      const base = import.meta.env.BASE_URL || '/'
      if (url.startsWith('/api/safety')) {
        window.location.href = base + 'safety/login'
      } else if (ADMIN_API_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        window.location.href = base + 'admin/login'
      } else {
        window.location.href = base + 'login'
      }
    }
    return Promise.reject(err)
  }
)

export { request }
