/**
 * 隐患闭环状态机共享常量（Sprint 2）
 *
 * 供 hazardLoop.js / hazardDict.js / 前端 复用，保证前后端枚举一致。
 * 状态主链：reported(已上报) → assigned(已分派) → rectifying(整改中)
 *          → verifying(待验收) → closed(已闭环)
 * is_overdue 为独立标记位，不进入主状态链。
 */

// ─── 状态机主链 ──────────────────────────────────────────────────────────────
const STATUS = {
  reported:  'reported',
  assigned:  'assigned',
  rectifying: 'rectifying',
  verifying: 'verifying',
  closed:    'closed',
}

// 各状态允许的“前态”（用于接口校验）
// key = 目标状态，value = 允许的来源状态数组
const ALLOWED_PREV = {
  assigned:   ['reported'],                 // 分派：仅已上报
  rectifying: ['assigned', 'rectifying'],   // 整改中 / 重新整改（退回）
  verifying:  ['rectifying'],               // 标记完成 → 待验收
  closed:     ['verifying'],                // 验收通过 → 闭环
}

// ─── 整改进度（明细状态）──────────────────────────────────────────────────────
const RECTIFY_STATUS = {
  none:  '未整改',
  doing: '整改中',
  done:  '已完成',
}

// ─── 隐患等级（与 t_hazard.hazard_level 取值一致）─────────────────────────────
const LEVELS = ['重大隐患', '较大隐患', '一般隐患']

// ─── 字典类型枚举 ────────────────────────────────────────────────────────────
const DICT_TYPES = {
  level:    'level',
  rectify_unit:       'rectify_unit',       // 整改单位（独立维护）
  business_dept:      'business_dept',      // 业务部门（复用 t_hazard.business_dept 列）
  business_dept_head: 'business_dept_head', // 业务部门负责人
  center_station:     'center_station',     // 生产场站（位置两级联动 · 录入页下拉源）
  well_site:          'well_site',          // 施工点（位置两级联动 · 录入页下拉源）
  facility:           'facility',           // 设施（type 技术值保留，UI 已移除）
  hazard_investigation_item: 'hazard_investigation_item', // 隐患排查项目（录入页下拉源，入库为自由文本）
}

// 合法的字典 type 集合（GET/POST/PATCH/DELETE 统一校验用）
const VALID_TYPES = Object.values(DICT_TYPES)

// ─── 状态 → 中文标签 ─────────────────────────────────────────────────────────
const STATUS_LABEL = {
  reported:  '已上报',
  assigned:  '已分派',
  rectifying: '整改中',
  verifying: '待验收',
  closed:    '已闭环',
}

// ─── 校验辅助 ────────────────────────────────────────────────────────────────
/**
 * 校验某状态能否流转到目标状态
 * @param {string} current 当前状态
 * @param {string} target  目标状态
 * @returns {boolean}
 */
function canTransition(current, target) {
  const allowed = ALLOWED_PREV[target]
  if (!allowed) return false
  return allowed.includes(current)
}

// ─── Sprint 3 超期升级阈值（env 可覆盖，含默认）───────────────────────────────
const OVERDUE_ESCALATE_OFFICER_DAYS = Number(process.env.OVERDUE_ESCALATE_OFFICER_DAYS) || 3
const OVERDUE_ESCALATE_OFFICE_DAYS  = Number(process.env.OVERDUE_ESCALATE_OFFICE_DAYS)  || 7
const SEVERE_OVERDUE_DAYS           = Number(process.env.SEVERE_OVERDUE_DAYS)           || 15

/**
 * 单角色分级 @ 目标判定（纯函数，Sprint 3 / P0-3）
 *
 * 规则（PRD §3.5 Q3 / 架构 §8.3）：
 *   - overdueDays ≤ 3      → 责任人
 *   - 3 < overdueDays ≤ 7  → 单位安全员（缺失手机则回退责任人）
 *   - overdueDays > 7      → 安全环保室（缺失手机则回退责任人）
 *
 * @param {Object} input
 * @param {string} [input.responsible_person]   责任人姓名
 * @param {string} [input.responsible_phone]    责任人手机
 * @param {string} [input.officer_name]         单位安全员姓名
 * @param {string} [input.officer_phone]        单位安全员手机
 * @param {string} [input.safety_office_mobile] 安全环保室代表手机
 * @param {number} input.overdueDays            超期天数
 * @param {Object} [thresholds]                 覆盖默认阈值 { officerDays, officeDays }
 * @returns {{ ownerName:string, ownerMobile:string, roleLabel:string }}
 */
function chooseEscalationTarget(input = {}, thresholds = {}) {
  const officerDays = Number(thresholds.officerDays ?? OVERDUE_ESCALATE_OFFICER_DAYS)
  const officeDays  = Number(thresholds.officeDays  ?? OVERDUE_ESCALATE_OFFICE_DAYS)
  const {
    responsible_person = '',
    responsible_phone = '',
    officer_name = '',
    officer_phone = '',
    safety_office_mobile = '',
    overdueDays = 0,
  } = input

  if (overdueDays > officeDays && safety_office_mobile) {
    return { ownerName: '安全环保室', ownerMobile: safety_office_mobile, roleLabel: '安全环保室' }
  }
  if (overdueDays > officerDays && officer_phone) {
    return { ownerName: officer_name || '单位安全员', ownerMobile: officer_phone, roleLabel: '单位安全员' }
  }
  return {
    ownerName: responsible_person || '责任人',
    ownerMobile: responsible_phone || '',
    roleLabel: '责任人',
  }
}

module.exports = {
  STATUS,
  ALLOWED_PREV,
  RECTIFY_STATUS,
  LEVELS,
  DICT_TYPES,
  VALID_TYPES,
  STATUS_LABEL,
  canTransition,
  OVERDUE_ESCALATE_OFFICER_DAYS,
  OVERDUE_ESCALATE_OFFICE_DAYS,
  SEVERE_OVERDUE_DAYS,
  chooseEscalationTarget,
}
