/**
 * stores/quiz.js 单元测试（用 mock 的 @/utils/request）
 *
 * 验证：
 *  - fetchQuizList 将 item.mode 映射为 m.mode（缺失回退 exam）
 *  - fetchQuiz(id, 'study') 实际请求 ?mode=study
 *  - submitQuiz 的 payload 含 mode / attemptNo / durationSec
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/utils/request', () => ({
  request: { get: vi.fn(), post: vi.fn() },
}))
vi.mock('@/utils/crypto', () => ({
  hashAnswers: () => 'sig-mock',
}))
vi.mock('@/utils/offlineDb', () => ({
  offlineDb: {
    saveQuizList() {},
    getQuizList: () => Promise.resolve([]),
    saveQuiz() {},
    getQuiz() {},
    addPendingRecord() {},
    getPendingRecords: () => Promise.resolve([]),
  },
}))

import { createPinia, setActivePinia } from 'pinia'
import { useQuizStore } from '@/stores/quiz'
import { request } from '@/utils/request'
import { QUIZ_MODES } from '@/utils/quizModes'

beforeEach(() => {
  setActivePinia(createPinia())
  request.get.mockReset()
  request.post.mockReset()
})

describe('fetchQuizList', () => {
  it('将 item.mode 映射为 m.mode，缺失时回退 exam', async () => {
    request.get.mockResolvedValue({
      data: {
        data: [
          { id: 1, title: 'T1', mode: 'practice', question_cnt: 3, created_at: '2024', time_limit: 30, pass_score: 60, score: 0, max_score: 0, completed: false },
          { id: 2, title: 'T2', question_cnt: 3, created_at: '2024', time_limit: 30 }, // 无 mode
        ],
      },
    })
    const store = useQuizStore()
    const list = await store.fetchQuizList()
    expect(list[0].mode).toBe('practice')
    expect(list[1].mode).toBe(QUIZ_MODES.EXAM)
  })
})

describe('fetchQuiz', () => {
  const sampleDetail = {
    materialId: 123, title: 'T', mode: 'exam',
    timeLimit: 30, passScore: 60, attemptLimit: 0, totalScore: 0, aiGrading: false,
    questions: [],
  }

  it('传入 mode 时请求带 ?mode=', async () => {
    request.get.mockResolvedValue({ data: { data: sampleDetail } })
    const store = useQuizStore()
    await store.fetchQuiz(123, 'study')
    expect(request.get).toHaveBeenCalledWith('/api/quiz/123', { params: { mode: 'study' } })
  })

  it('未传 mode 时 params 为空对象', async () => {
    request.get.mockResolvedValue({ data: { data: sampleDetail } })
    const store = useQuizStore()
    await store.fetchQuiz(9)
    expect(request.get).toHaveBeenCalledWith('/api/quiz/9', { params: {} })
  })
})

describe('submitQuiz', () => {
  it('payload 包含 mode / attemptNo / durationSec', async () => {
    request.post.mockResolvedValue({ data: { ok: true } })
    const store = useQuizStore()
    store.setAnswer(1, 'A')
    const res = await store.submitQuiz(123, { mode: 'study', attemptNo: 2, durationSec: 30 })
    expect(request.post).toHaveBeenCalledWith(
      '/api/quiz/123/submit',
      expect.objectContaining({ mode: 'study', attemptNo: 2, durationSec: 30 })
    )
    expect(res.ok).toBe(true)
  })

  it('未指定 mode 时 payload 默认 exam', async () => {
    request.post.mockResolvedValue({ data: { ok: true } })
    const store = useQuizStore()
    store.setAnswer(1, 'A')
    await store.submitQuiz(123)
    expect(request.post.mock.calls[0][1].mode).toBe(QUIZ_MODES.EXAM)
  })
})
