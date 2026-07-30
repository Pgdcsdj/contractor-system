/**
 * 隐患模块路由（Sprint 1 / S1-4：照片上传）
 *
 * POST /api/hazard/photo/upload      上传隐患照片 → 存 COS → 写 t_hazard_photo
 * GET  /api/hazard/photo/:hazardId   某隐患的全部照片列表
 *
 * 说明：
 *   - 照片存腾讯云 COS（CVM 只存 URL），与 t_material_image.url 同机制
 *   - 上传需管理员 token（Sprint 1 内部验证用）；Sprint 2 隐患上报表单上线后
 *     改为现场员工 token 鉴权
 *   - hazard_id 可选：提供则写入 t_hazard_photo 并回填主表首图（photo_url / rectify_photo_url）
 */

const express = require('express')
const multer  = require('multer')
const { pool } = require('../db/db')
const { uploadFile } = require('../services/cosUpload')
const { verifyAdminToken } = require('../services/adminAuth')

const router = express.Router()

// ─── JWT 鉴权中间件 ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录管理员账号' })
  }
  const payload = verifyAdminToken(authHeader.slice(7))
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.admin = payload
  next()
}

// ─── 图片上传（JPG/PNG/WEBP，10MB，存内存）───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase()
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('只支持 JPG / PNG / WEBP 图片格式'))
    }
  },
})

// ─── POST /api/hazard/photo/upload ───────────────────────────────────────────
router.post('/photo/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片文件' })

  const { hazard_id, photo_type = 'report' } = req.body
  const safeType = ['report', 'rectify'].includes(photo_type) ? photo_type : 'report'

  try {
    // 1. 上传 COS
    const { url, key } = await uploadFile(req.file.buffer, req.file.originalname, 'hazards')

    let photoId = null
    // 2. 若关联隐患，写一对多表 + 回填主表首图
    if (hazard_id) {
      const [r] = await pool.execute(
        'INSERT INTO t_hazard_photo (hazard_id, photo_url, photo_type) VALUES (?, ?, ?)',
        [Number(hazard_id), url, safeType]
      )
      photoId = r.insertId

      if (safeType === 'report') {
        await pool.execute(
          'UPDATE t_hazard SET photo_url = ? WHERE id = ? AND (photo_url IS NULL OR photo_url = "")',
          [url, Number(hazard_id)]
        )
      } else {
        await pool.execute(
          'UPDATE t_hazard SET rectify_photo_url = ? WHERE id = ? AND (rectify_photo_url IS NULL OR rectify_photo_url = "")',
          [url, Number(hazard_id)]
        )
      }
    }

    res.json({ success: true, data: { url, key, photoId } })
  } catch (err) {
    console.error('[hazard photo upload]', err.message)
    const isCosError = /credentials|SecretId|SecretKey|bucket|Bucket|403|404|NoSuch/i.test(err.message || '')
    if (isCosError) {
      res.status(500).json({ error: 'COS上传失败：' + err.message })
    } else {
      res.status(500).json({ error: err.message })
    }
  }
})

// ─── GET /api/hazard/photo/:hazardId ─────────────────────────────────────────
router.get('/photo/:hazardId', adminAuth, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, photo_url, photo_type, created_at FROM t_hazard_photo WHERE hazard_id = ? ORDER BY id ASC',
    [req.params.hazardId]
  )
  res.json({ success: true, data: rows })
})

module.exports = router
