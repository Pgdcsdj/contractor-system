/**
 * 腾讯云 COS 上传服务
 *
 * 功能：
 *   - 后端签名上传（SecretKey 不暴露给前端）
 *   - 上传素材文件（PDF/DOCX/图片）
 *   - 删除文件
 *
 * 环境变量（必须配置）：
 *   COS_SECRET_ID    腾讯云 SecretId
 *   COS_SECRET_KEY   腾讯云 SecretKey
 *   COS_BUCKET       存储桶名称，如 tnb-training-1258000000
 *   COS_REGION       地域，如 ap-chengdu
 */

const COS = require('cos-nodejs-sdk-v5')
const path = require('path')

const cosClient = new COS({
  SecretId:  process.env.COS_SECRET_ID  || '',
  SecretKey: process.env.COS_SECRET_KEY || '',
})

const BUCKET = process.env.COS_BUCKET || 'tnb-training-1258000000'
const REGION = process.env.COS_REGION || 'ap-chengdu'

/**
 * 上传文件到 COS
 * @param {Buffer}  buffer    文件内容
 * @param {string}  filename  原始文件名
 * @param {string}  subdir    子目录，如 'materials'
 * @returns {{ url: string, key: string }}
 */
async function uploadFile(buffer, filename, subdir = 'materials') {
  const ext      = path.extname(filename).toLowerCase()
  const ts       = Date.now()
  const key      = `${subdir}/${ts}_${Math.random().toString(36).slice(2, 8)}${ext}`

  await cosClient.putObject({
    Bucket: BUCKET,
    Region: REGION,
    Key:    key,
    Body:   buffer,
  })

  const url = `https://${BUCKET}.cos.${REGION}.myqcloud.com/${key}`
  return { url, key }
}

/**
 * 删除 COS 文件
 */
async function deleteFile(key) {
  await cosClient.deleteObject({ Bucket: BUCKET, Region: REGION, Key: key })
}

module.exports = { uploadFile, deleteFile }
