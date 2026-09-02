// 版本守卫：前端启动后比对线上 /api/version。
// 若线上版本号与本地打包版本不一致（说明服务端已部署新包），则自动强刷整页，
// 这样后续每次发布用户无需手动 Ctrl+F5，长期未刷新的旧标签页也会在数分钟内自动更新。
import { APP_VERSION } from '../version.js'

let started = false

async function check() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok) return
    const data = await res.json()
    const serverVersion = data && data.version
    if (serverVersion && serverVersion !== APP_VERSION) {
      console.log(`[版本守卫] 检测到线上新版本 ${serverVersion}（当前 ${APP_VERSION}），正在自动刷新…`)
      window.location.reload(true)
    }
  } catch (e) {
    // 网络异常时静默忽略，下次轮询再试
  }
}

export function startVersionGuard() {
  if (started) return
  started = true
  // 启动即查一次
  check()
  // 标签页重新可见时再查（用户从别的标签切回来）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  // 每 2 分钟轮询一次，兜底
  setInterval(check, 2 * 60 * 1000)
}
