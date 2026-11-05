/**
 * 承包商安全活动 · 公开填报入口地址
 * 公开页路由为 /activity（免登录），挂在 Vite base（生产 /tnb/）之下。
 */
export function activitySubmitUrl() {
  const base = import.meta.env.BASE_URL || '/'
  return `${window.location.origin}${base.replace(/\/$/, '')}/activity`
}

/** 新窗口打开填报入口；返回是否成功（被浏览器拦截时为 false） */
export function openActivitySubmit() {
  const url = activitySubmitUrl()
  const w = window.open(url, '_blank', 'noopener')
  return { url, opened: Boolean(w) }
}
