/**
 * offlineDb.js - 内存存储（不依赖 IndexedDB/Dexie，避免 CSP 问题）
 * 后续弱网环境需要时再接入 IndexedDB
 */

// 内存存储
const _store = {
  quizzes: new Map(),
  quizList: [],
  pendingRecords: [],
}

export const offlineDb = {
  async saveQuiz(trainingId, quiz) {
    _store.quizzes.set(String(trainingId), { trainingId, ...quiz, cachedAt: Date.now() })
  },
  async getQuiz(trainingId) {
    return _store.quizzes.get(String(trainingId)) || null
  },
  async saveQuizList(list) {
    _store.quizList = list
  },
  async getQuizList() {
    return _store.quizList
  },
  async addPendingRecord(record) {
    _store.pendingRecords.push({ ...record, id: Date.now(), synced: false })
  },
  async getPendingRecords() {
    return _store.pendingRecords.filter(r => !r.synced)
  },
  async markRecordSynced(id) {
    const rec = _store.pendingRecords.find(r => r.id === id)
    if (rec) rec.synced = true
  },
  async syncPendingRecords() {
    // 内存模式暂不支持自动同步
    return { synced: 0 }
  },
  async clearUserSession() {
    // 不需要清理
  },
  onNetworkChange() {
    // 暂不实现
  },
}
