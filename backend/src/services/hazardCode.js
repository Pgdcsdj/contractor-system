/**
 * 隐患编号生成服务（Sprint 2 / P0-1 / Q8）
 *
 * 规则：YH-{yyyy}-{4位序号}，按年重置。
 * 取当年 report_time 最大值 + 1，不足 4 位前补 0。
 * 并发低（管理员单人录入），无需序列表；如需更强一致可由架构师改为序列表。
 */

/**
 * 生成下一个隐患编号
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string>} 形如 YH-2026-0001
 */
async function generateHazardCode(pool) {
  const year = new Date().getFullYear()
  const likePattern = `YH-${year}-%`

  const [rows] = await pool.execute(
    `SELECT MAX(CAST(SUBSTRING_INDEX(hazard_code, '-', -1) AS UNSIGNED)) AS maxSeq
       FROM t_hazard
      WHERE YEAR(report_time) = ? AND hazard_code LIKE ?`,
    [year, likePattern]
  )

  const maxSeq = Number(rows[0]?.maxSeq || 0)
  const seq = String(maxSeq + 1).padStart(4, '0')
  return `YH-${year}-${seq}`
}

module.exports = { generateHazardCode }
