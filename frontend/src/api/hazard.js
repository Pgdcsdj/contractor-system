/**
 * 隐患相关接口封装（Sprint 2）
 *
 * 全部走 /api/hazard*，request.js 已自动注入管理员 token。
 */
import { request } from '@/utils/request'

/** 获取隐患字典（level） */
export function getHazardDict(type) {
  return request.get('/api/hazard-dict', { params: { type } })
}

/** 获取承包商单位列表（上报表单下拉用） */
export function getContractorUnits(params = {}) {
  return request.get('/api/contractor-units', { params: { pageSize: 200, ...params } })
}

/** 获取责任单位（unit_name）去重列表，用于闭环页「全部单位」下拉筛选 */
export function getHazardsUnitNames(params = {}) {
  return request.get('/api/hazards/unit-names', { params })
}

/** 上传单张隐患照片，返回 { url, key, photoId } */
export function uploadHazardPhoto(file, photoType = 'report') {
  const form = new FormData()
  form.append('file', file)
  form.append('photo_type', photoType)
  return request.post('/api/hazard/photo/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

/** 隐患上报 */
export function reportHazard(payload) {
  return request.post('/api/hazards', payload)
}

/** 隐患看板列表（筛选 + 分页） */
export function getHazards(params = {}) {
  return request.get('/api/hazards', { params })
}

/** 隐患详情（含照片） */
export function getHazardDetail(id) {
  return request.get(`/api/hazards/${id}`)
}

/** 获取某隐患的全部照片（调用方按 photo_type 拆分为上报/整改两组） */
export function getHazardPhotos(hazardId) {
  return request.get(`/api/hazard/photo/${hazardId}`)
}

/** 更新隐患基础信息（仅基础字段，状态流转由 assign/rectify/verify 接口负责） */
export function updateHazard(id, payload) {
  return request.patch(`/api/hazards/${id}`, payload)
}

/** 删除单条隐患（软删除；安全员仅能删自己录入的） */
export function deleteHazard(id) {
  return request.delete(`/api/hazards/${id}`)
}

/** 分派 */
export function assignHazard(id, payload = {}) {
  return request.patch(`/api/hazards/${id}/assign`, payload)
}

/** 整改代录 */
export function rectifyHazard(id, payload = {}) {
  return request.patch(`/api/hazards/${id}/rectify`, payload)
}

/** 验收 */
export function verifyHazard(id, payload = {}) {
  return request.patch(`/api/hazards/${id}/verify`, payload)
}

/** 超期手动通知 */
export function triggerOverdueNotify(ids) {
  return request.post('/api/hazards/overdue/notify', { ids })
}

/** 隐患批量删除，ids 为编号数组 */
export function deleteHazards(ids) {
  return request.delete('/api/hazards/batch', { data: { ids } })
}

/** 新增隐患字典项（level） */
export function createHazardDict(payload) {
  return request.post('/api/hazard-dict', payload)
}

/** 更新隐患字典项（动态更新传入字段，body 需带 type 校验） */
export function updateHazardDict(id, payload) {
  return request.patch(`/api/hazard-dict/${id}`, payload)
}

/** 删除隐患字典项（type 作为 query 参数） */
export function deleteHazardDict(id, type) {
  return request.delete(`/api/hazard-dict/${id}`, { params: { type } })
}

/** 隐患批量导入（xlsx/csv），file 为 File 对象。
 *  走管理员 / 安全员 token：安全员登录后 token 同样存于 tnb_admin_token，
 *  此处显式注入，确保工作台调用 /api/hazards/import 携带正确身份（录入人归属生效）。
 *  返回预览结果（不落库），结构见设计 §D.1。 */
export function importHazards(file, importType = '') {
  const fd = new FormData()
  fd.append('file', file)
  // 导入类型：'' = 普通台账导入；'video_supervision' = 视频督查导入
  if (importType) fd.append('import_type', importType)
  const token =
    localStorage.getItem('tnb_admin_token') || localStorage.getItem('tnb_token') || ''
  return request.post('/api/hazards/import', fd, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

/** 确认导入（事务批量落库），重新上传同一文件，后端重新解析保证一致。
 *  成功返回 §D.2 结构；事务失败返回 { success:false, error, data:{ rollback:true, failAtRow } }。 */
export function confirmImportHazards(file, importType = '') {
  const fd = new FormData()
  fd.append('file', file)
  // 与预览保持一致的导入类型，保证两次解析结果相同
  if (importType) fd.append('import_type', importType)
  const token =
    localStorage.getItem('tnb_admin_token') || localStorage.getItem('tnb_token') || ''
  return request.post('/api/hazards/import/confirm', fd, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

/** 下载标准导入模板（返回 Blob）。 */
export function getImportTemplate() {
  return request.get('/api/hazards/import/template', { responseType: 'blob' })
}

/** 查询历史导入记录（t_import_log），数据管理页「导入记录」区块使用。 */
export function getImportLogs() {
  return request.get('/api/hazards/import/logs')
}

/** 导入位置字典（生产场站 / 施工点），file 为 .xlsx File。
 *  后端读取「生产场站」「施工点」两个 sheet，各取第 2 列作为字典项（INSERT IGNORE 幂等）。
 *  复用管理员 token（与 importHazards 一致），确保鉴权通过。 */
export function importLocationDict(file) {
  const fd = new FormData()
  fd.append('file', file)
  const token =
    localStorage.getItem('tnb_admin_token') || localStorage.getItem('tnb_token') || ''
  return request.post('/api/hazard-dict/import-locations', fd, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

/** 获取整改单位 → 业务口 关联列表 */
export function getRectifyUnitBiz() {
  return request.get('/api/rectify-unit-biz')
}

/** 新增 / 更新整改单位 → 业务口 关联（按整改单位 upsert） */
export function saveRectifyUnitBiz(payload) {
  return request.post('/api/rectify-unit-biz', payload)
}

/** 删除单条关联（仅删关联行，不删字典项） */
export function deleteRectifyUnitBiz(id) {
  return request.delete('/api/rectify-unit-biz/' + id)
}

// ─── 问题依据库（标准依据）───────────────────────────────────────────────────
/** 列表（?page&pageSize&keyword） */
export function getStandardBasisList(params = {}) {
  return request.get('/api/hazards/standard-basis', { params })
}

/** 单条匹配（录入页自动匹配用） */
export function matchStandardBasis(category) {
  return request.post('/api/hazards/standard-basis/match', { category })
}

/** 新增 */
export function createStandardBasis(payload) {
  return request.post('/api/hazards/standard-basis', payload)
}

/** 修改 */
export function updateStandardBasis(id, payload) {
  return request.put(`/api/hazards/standard-basis/${id}`, payload)
}

/** 删除 */
export function deleteStandardBasis(id) {
  return request.delete(`/api/hazards/standard-basis/${id}`)
}

/** 导入（xlsx），file 为 File 对象 */
export function importStandardBasis(file) {
  const fd = new FormData()
  fd.append('file', file)
  return request.post('/api/hazards/standard-basis/import', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

/** 下载模板（Blob） */
export function getStandardBasisTemplate() {
  return request.get('/api/hazards/standard-basis/template', { responseType: 'blob' })
}

/** 导出（Blob） */
export function exportStandardBasis() {
  return request.get('/api/hazards/standard-basis/export', { responseType: 'blob' })
}
