/**
 * 统一日期展示：后端 mysql2 把 DATETIME 序列化为 UTC ISO 串（...Z），
 * 直接 slice(0,16) 会少 8 小时且带 T。此处按浏览器本地时区还原墙上时间。
 */
export function fmtDT(v, withSec = false) {
  if (!v) return ''
  const p = (n) => String(n).padStart(2, '0')
  const fromDate = (d) =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${withSec ? ':' + p(d.getSeconds()) : ''}`
  if (v instanceof Date) return fromDate(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, withSec ? 19 : 16)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, withSec ? 19 : 16)
  return fromDate(d)
}

/** 仅日期 YYYY-MM-DD（DATE 型字段，避免 UTC 串跨日） */
export function fmtDate(v) {
  if (!v) return ''
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return fmtDT(v).slice(0, 10)
}
