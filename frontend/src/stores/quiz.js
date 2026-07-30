import { defineStore } from 'pinia'
import { ref } from 'vue'
import { request } from '@/utils/request'
import { hashAnswers } from '@/utils/crypto'
import { QUIZ_MODES } from '@/utils/quizModes'

// 延迟加载 offlineDb（Dexie 初始化会被 CSP 阻止；当前为内存实现）
let _offlineDb = null
async function getOfflineDb() {
  if (!_offlineDb) {
    try {
      _offlineDb = (await import('@/utils/offlineDb')).offlineDb
    } catch {
      _offlineDb = {
        saveQuizList() {},
        getQuizList() { return Promise.resolve([]) },
        saveQuiz() {},
        getQuiz() { return Promise.resolve(null) },
        addPendingRecord() {},
        getPendingRecords() { return Promise.resolve([]) },
      }
    }
  }
  return _offlineDb
}

/**
 * 将答案序列化为后端可接收的字符串
 *  - 单选/判断：直接 String(answer)
 *  - 多选：数组 -> "0,1" 形式（与后端 normalizeAnswer 的多选比较逻辑对齐）
 * @param {*} ans
 * @returns {string}
 */
function serializeAnswer(ans) {
  if (ans == null) return ''
  if (Array.isArray(ans)) return ans.map(String).join(',')
  return String(ans)
}

export const useQuizStore = defineStore('quiz', () => {
  const quizzes = ref([])
  const currentQuiz = ref(null)
  const answers = ref({})
  const timeLeft = ref(0)

  // ── 加载待答列表（已下发 mode / time_limit / pass_score / attempt_limit / completed 等）──
  async function fetchQuizList() {
    try {
      const res = await request.get('/api/quiz/list')
      const raw = res.data?.data || []
      quizzes.value = raw.map(item => {
        const mode = item.mode || QUIZ_MODES.EXAM
        const maxScore = item.max_score ?? 0
        const passScore = item.pass_score ?? 60
        const score = item.score ?? 0
        const passed = maxScore > 0
          ? (score / maxScore * 100) >= passScore
          : false
        return {
          trainingId:     item.id,
          title:          item.title,
          totalQuestions: item.question_cnt,
          publishedAt:    item.created_at,
          timeLimit:      item.time_limit || 30,
          mode,
          categoryId:     item.category_id,
          categoryName:   item.category_name || '',
          attemptLimit:   item.attempt_limit ?? 0,
          aiGrading:      item.ai_grading === 1,
          completed:      !!item.completed,
          score,
          maxScore,
          passScore,
          passed,
        }
      })
      // 缓存到本地（失败不影响返回数据）
      getOfflineDb().then(db => db.saveQuizList(quizzes.value)).catch(() => {})
      return quizzes.value
    } catch (err) {
      console.warn('[fetchQuizList] 网络请求失败', err)
      try { return await (await getOfflineDb()).getQuizList() } catch { return [] }
    }
  }

  // ── 获取题目（支持 mode：study/practice/exam）──
  async function fetchQuiz(trainingId, mode) {
    const params = {}
    if (mode && Object.values(QUIZ_MODES).includes(mode)) {
      params.mode = mode
    }
    try {
      const res = await request.get(`/api/quiz/${trainingId}`, { params })
      const d = res.data.data
      const quizData = {
        materialId:   d.materialId ?? Number(trainingId),
        title:        d.title,
        // 注意：后端始终返回 material 自身的 mode；
        // 真正决定"是否揭示答案"的是请求时的 mode（已由调用方传入并保存）。
        mode:         d.mode || QUIZ_MODES.EXAM,
        timeLimit:    d.timeLimit ?? d.time_limit ?? 30,
        passScore:    d.passScore ?? d.pass_score ?? 60,
        attemptLimit: d.attemptLimit ?? d.attempt_limit ?? 0,
        totalScore:   d.totalScore || 0,
        questions:    d.questions || [],
        aiGrading:    !!d.aiGrading,
      }
      currentQuiz.value = quizData
      getOfflineDb().then(db => db.saveQuiz(trainingId, quizData)).catch(() => {})
      timeLeft.value = quizData.timeLimit * 60
      return quizData
    } catch (err) {
      console.warn('[fetchQuiz] 网络请求失败', err?.response?.status, err?.response?.data?.error || err.message)
      // 离线兜底（内存缓存）
      try { return await (await getOfflineDb()).getQuiz(trainingId) } catch { return null }
    }
  }

  // 设置单题答案（保持原行为）
  function setAnswer(questionId, answer) {
    answers.value[questionId] = answer
  }

  // 清空答案（进入新题库 / 退出时重置 store 状态）
  function resetAnswers() {
    answers.value = {}
  }

  // ── 提交答题（支持 mode / attemptNo / durationSec）──
  async function submitQuiz(trainingId, opts = {}) {
    const {
      mode = QUIZ_MODES.EXAM,
      attemptNo = 1,
      durationSec = 0,
    } = opts

    const submitTime = new Date().toISOString()
    const payload = {
      mode,
      attemptNo: Number(attemptNo) || 1,
      durationSec: Number(durationSec) || 0,
      isOffline: false,
      answers: Object.entries(answers.value).map(([qid, ans]) => ({
        questionId: Number(qid),
        answer: serializeAnswer(ans),
      })),
    }
    payload.answerHash = hashAnswers(answers.value, submitTime)

    try {
      const res = await request.post(`/api/quiz/${trainingId}/submit`, payload)
      // 提交成功后清空本地答案
      answers.value = {}
      currentQuiz.value = null
      return { ok: true, data: res.data }
    } catch (err) {
      // 网络失败 -> 写入离线待上传队列（保持既有离线逻辑）
      try {
        const db = await getOfflineDb()
        await db.addPendingRecord({
          ...payload,
          trainingId,
          deviceId: await getDeviceId(),
          createdAt: submitTime,
        })
      } catch (e) {
        console.warn('[离线存储失败]', e)
      }
      return { ok: false, offline: true }
    }
  }

  async function getDeviceId() {
    let id = localStorage.getItem('tnb_device_id')
    if (!id) {
      id = 'device_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      localStorage.setItem('tnb_device_id', id)
    }
    return id
  }

  return {
    quizzes, currentQuiz, answers, timeLeft,
    fetchQuizList, fetchQuiz, setAnswer, resetAnswers, submitQuiz,
  }
})
