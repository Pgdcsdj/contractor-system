/**
 * MySQL 连接池
 * 使用 mysql2/promise，支持连接池复用
 */

const mysql = require('mysql2/promise')

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || '127.0.0.1',
  port:               Number(process.env.DB_PORT || 3306),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'tnb_training',
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+08:00',
})

/**
 * 测试数据库连通性
 */
async function testConnection() {
  const conn = await pool.getConnection()
  await conn.query('SELECT 1')
  conn.release()
  return true
}

module.exports = { pool, testConnection }
