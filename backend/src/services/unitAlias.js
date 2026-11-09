/**
 * 单位别名表 —— 抹平历史录入习惯（简称 / 旧名 / 冗余写法）
 *
 * key   : normUnit(原始值) 的输出，规则见 importService.normUnit / importUser.normUnit
 *         （NFKC → 去括号及内容 → 去全部空白 → 去集团前缀 → 异写归一 → 去末尾标点 → toUpperCase）
 * value : 网格化管理库（t_contractor_unit）在册标准全称
 *
 * 维护约定：
 *   1. 新增别名只需在下方追加一行，无需改匹配逻辑；
 *   2. value 必须与 t_contractor_unit.unit_name 完全一致，否则仍会被导入门禁拦下；
 *   3. key 请填「归一化后」的写法（去掉了括号内容、空白、集团前缀、末尾标点并大写）。
 *
 * 引入背景（2026-11-09）：
 *   注册与历史导入未做规范，库里出现过「天然气产销厂」「天然气产销厂通南巴项目组」
 *   「（产销厂）」「西南钻井」「中原井下 812 队的多种写法」等变体，导入时被门禁拒绝。
 *   用户已确认对应关系：812 系列统一归「中原井下ZY-812队」（id=24，试气812队 id=27 已退场）；
 *   产销厂系列统一归「天然气产销厂通南巴项目部」（id=35）；
 *   人员表的「西南钻井」统一归「西南钻井分公司」（id=235）。
 */

// 隐患导入 + 人员导入共用（等价改写，不损失精度）
const COMMON_ALIASES = {
  // ── 天然气产销厂系（网格化 id=35「天然气产销厂通南巴项目部」）──
  '天然气产销厂': '天然气产销厂通南巴项目部',
  '天然气产销厂通南巴项目组': '天然气产销厂通南巴项目部',
  '产销厂': '天然气产销厂通南巴项目部',

  // ── 中原井下 812 队（网格化 id=24「中原井下ZY-812队」）──
  // 原「中原井下812队」(id=22)、「中原井下试气812队」(id=27) 均已退场，同为一家单位
  '中原井下812队': '中原井下ZY-812队',
  '中原井下SY812队': '中原井下ZY-812队',
  '中原井下ZYSY812队': '中原井下ZY-812队',
  '中原井下ZY812队': '中原井下ZY-812队',
  '中原井下试气812队': '中原井下ZY-812队',
  '中原井下试油气812队': '中原井下ZY-812队',
  'ZY812队': '中原井下ZY-812队',
  'SY812': '中原井下ZY-812队',
}

// 仅人员导入启用：把「只写到公司层级」的写法收口到公司节点
// 隐患责任单位必须精确到队/站（考核口径），故隐患导入不启用「西南钻井」这条，
// 以免把隐患降精度挂到三级单位；隐患导入仍会提示改正。
const PERSONNEL_ONLY_ALIASES = {
  '西南钻井': '西南钻井分公司', // 网格化 id=235，三级
}

const HAZARD_ALIASES = { ...COMMON_ALIASES }
const PERSONNEL_ALIASES = { ...COMMON_ALIASES, ...PERSONNEL_ONLY_ALIASES }

/**
 * 查别名
 * @param {string} normalized  normUnit() 之后的原始值
 * @param {'hazard'|'personnel'} scope 使用场景
 * @returns {string|null} 标准全称，未命中返回 null
 */
function lookupAlias(normalized, scope) {
  if (!normalized) return null
  const table = scope === 'personnel' ? PERSONNEL_ALIASES : HAZARD_ALIASES
  return table[normalized] || null
}

module.exports = { HAZARD_ALIASES, PERSONNEL_ALIASES, lookupAlias }
