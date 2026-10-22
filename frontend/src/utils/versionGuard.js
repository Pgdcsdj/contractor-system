// 版本守卫：前端启动后比对线上 /api/version。
// 若线上版本号与本地打包版本不一致（说明服务端已部署新包），则自动强刷整页，
// 这样后续每次发布用户无需手动 Ctrl+F5，长期未刷新的旧标签页也会自动更新。
//
// 防死亡螺旋：同一会话最多“自动刷新一次”。若刷新后版本仍不一致（通常是前端未及时
// 重新构建部署），则不再硬刷，而是顶部弹出提示条，交由用户手动刷新，避免无限刷新。
import { APP_VERSION } from '../version.js'

let started = false
const RELOAD_FLAG = '__vg_reloaded__'

// 轻量提示条（纯 DOM，避免依赖组件库）
function showStaleBanner(serverVersion) {
  if (document.getElementById('__vg_banner__')) return
  const bar = document.createElement('div')
  bar.id = '__vg_banner__'
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff9800;color:#fff;' +
    'font-size:14px;line-height:1.4;padding:10px 16px;display:flex;align-items:center;' +
    'justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.2);font-family:sans-serif'
  const text = document.createElement('span')
  text.textContent = `检测到新版本（线上 ${serverVersion} / 本地 ${APP_VERSION}），请刷新页面以更新`
  const btn = document.createElement('button')
  btn.textContent = '立即刷新'
  btn.style.cssText =
    'margin-left:12px;border:0;border-radius:4px;background:#fff;color:#e65100;' +
    'padding:4px 12px;cursor:pointer;font-size:13px;font-weight:600'
  btn.onclick = () => window.location.reload()
  bar.appendChild(text)
  bar.appendChild(btn)
  document.body.appendChild(bar)
}

async function check() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok) return
    const data = await res.json()
    const serverVersion = data && data.version
    if (!serverVersion || serverVersion === APP_VERSION) return
    console.log(`[版本守卫] 检测到线上新版本 ${serverVersion}（当前 ${APP_VERSION}）`)
    // 已自动刷新过一次仍不一致 → 转提示条，避免无限刷新
    if (sessionStorage.getItem(RELOAD_FLAG)) {
      console.warn('[版本守卫] 自动刷新后版本仍不一致，转为手动提示')
      showStaleBanner(serverVersion)
      return
    }
    sessionStorage.setItem(RELOAD_FLAG, '1')
    console.log('[版本守卫] 正在自动刷新…')
    window.location.reload()
  } catch (e) {
    // 网络异常时静默忽略，下次轮询再试
  }
}

export function startVersionGuard() {
  if (started) return
  started = true
  check()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  setInterval(check, 2 * 60 * 1000)
}
