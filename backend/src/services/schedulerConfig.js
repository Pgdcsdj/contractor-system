/**
 * 隐患定时任务配置（Sprint 3 / P0-7）
 *
 * 全部从 env 读取，带默认值；集中收口扫描频率 / 周报时刻 / 安全环保室手机。
 * 升级阈值常量定义在 constants/hazardStates.js（此处不重复定义，避免两处真相）。
 */

/**
 * 安全读取数字型 env（'' / 非法值回退默认；'0' 等合法 0 值保留）
 * @param {string|undefined} v
 * @param {number} def
 * @returns {number}
 */
function num(v, def) {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

const schedulerConfig = {
  /** 超期扫描间隔（分钟），默认 60 */
  scanIntervalMin: num(process.env.OVERDUE_SCAN_INTERVAL_MIN, 60),

  /** 周报发送时刻（默认 周一 09:00） */
  weeklyDay:  num(process.env.WEEKLY_REPORT_DAY, 1),  // 1 = 周一（与 Date.getDay 对齐）
  weeklyHour: num(process.env.WEEKLY_REPORT_HOUR, 9),
  weeklyMin:  num(process.env.WEEKLY_REPORT_MIN, 0),

  /** 安全环保室代表手机号（群内 @ 用），未配置则升级回退 @责任人 */
  safetyOfficeMobile: process.env.DINGTALK_SAFETY_OFFICE_MOBILE || '',

  /**
   * 安全环保室代表手机号数组（群内 @ 用，支持多人）。
   * 由 DINGTALK_SAFETY_OFFICE_MOBILE 按 , / 、 拆分；保留单值 safetyOfficeMobile 向下兼容。
   */
  safetyOfficeMobiles: (process.env.DINGTALK_SAFETY_OFFICE_MOBILE || '')
    .split(/[,\/、]/)
    .map((s) => s.trim())
    .filter(Boolean),
}

module.exports = schedulerConfig
