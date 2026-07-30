/**
 * ResultPage 组件测试（@vue/test-utils + mocked router / global fetch）
 *
 * 验证（关键回归点）：
 *  - resultMode 严格取自返回记录 result.mode（非素材默认）
 *  - retakeQuiz 跳转 /quiz/<trainingId>?mode=<resultMode>
 *  - result.mode 缺失时回退 exam
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { trainingId: '5' }, query: {} }),
  useRouter: () => ({ push, replace }),
}))

import ResultPage from '@/views/ResultPage.vue'

beforeEach(() => {
  push.mockClear()
  replace.mockClear()
  fetchMock.mockReset()
  global.fetch = fetchMock
})

const OK_RESULT = {
  mode: 'practice', score: 80, maxScore: 100, passScore: 60,
  passRate: 80, passed: true, submittedAt: '2024-01-01', reviewList: [],
}

it('resultMode 严格取自 result.mode', async () => {
  fetchMock.mockResolvedValue({ json: async () => ({ success: true, data: OK_RESULT }) })
  const wrapper = mount(ResultPage)
  await flushPromises()
  await nextTick()
  expect(wrapper.vm.resultMode).toBe('practice')
  wrapper.unmount()
})

it('retakeQuiz 跳转带 ?mode=<resultMode>', async () => {
  fetchMock.mockResolvedValue({ json: async () => ({ success: true, data: OK_RESULT }) })
  const wrapper = mount(ResultPage)
  await flushPromises()
  await nextTick()
  wrapper.vm.retakeQuiz()
  expect(push).toHaveBeenCalledWith('/quiz/5?mode=practice')
  wrapper.unmount()
})

it('result.mode 缺失时回退 exam', async () => {
  const { mode, ...rest } = OK_RESULT
  fetchMock.mockResolvedValue({ json: async () => ({ success: true, data: rest }) })
  const wrapper = mount(ResultPage)
  await flushPromises()
  await nextTick()
  expect(wrapper.vm.resultMode).toBe('exam')
  wrapper.unmount()
})
