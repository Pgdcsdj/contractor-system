/**
 * QuizPage 组件测试（@vue/test-utils + mocked store/router）
 *
 * 验证（关键回归点）：
 *  - 运行模式严格来自 route.query.mode（用 normalizeMode 规整，兜底 exam）
 *  - 不被素材返回的默认 mode 覆盖
 *  - trainingId 来自 route.params.id
 *  - fetchQuiz 实际以 (trainingId, 运行时mode) 调用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const route = vi.hoisted(() => ({ params: { id: '123' }, query: { mode: 'study' } }))
const fetchQuizMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push, replace }),
}))
vi.mock('@/stores/quiz', () => ({
  useQuizStore: () => ({
    fetchQuiz: fetchQuizMock,
    setAnswer: vi.fn(),
    resetAnswers: vi.fn(),
    answers: {},
    currentQuiz: null,
    timeLeft: 0,
  }),
}))

import QuizPage from '@/views/QuizPage.vue'

function seedRoute(id, mode) {
  route.params = { id: String(id) }
  route.query = mode === undefined ? {} : { mode }
}

beforeEach(() => {
  localStorage.clear()
  push.mockClear()
  replace.mockClear()
  fetchQuizMock.mockReset()
  fetchQuizMock.mockResolvedValue({
    materialId: 123, title: 'T', mode: 'exam', // 素材默认模式为 exam
    timeLimit: 30, passScore: 60, attemptLimit: 0, totalScore: 0, aiGrading: false,
    questions: [{ id: 1, type: 'single', question: 'Q1', options: ['A', 'B'], answer: 0, analysis: 'x', score: 5 }],
  })
})

it('运行模式来自 route.query.mode，不被素材默认 mode 覆盖', async () => {
  seedRoute(123, 'study')
  const wrapper = mount(QuizPage)
  await flushPromises()
  await nextTick()
  // 关键：mode 应为 query 的 'study'，而非素材返回的 'exam'
  expect(wrapper.vm.mode).toBe('study')
  expect(wrapper.vm.trainingId).toBe(123)
  expect(fetchQuizMock).toHaveBeenCalledWith(123, 'study')
  wrapper.unmount()
})

it('query.mode 缺失时回退 exam', async () => {
  seedRoute(9, undefined)
  const wrapper = mount(QuizPage)
  await flushPromises()
  await nextTick()
  expect(wrapper.vm.mode).toBe('exam')
  expect(fetchQuizMock).toHaveBeenCalledWith(9, 'exam')
  wrapper.unmount()
})
