/**
 * QuizListPage 组件测试（@vue/test-utils + mocked store/router）
 *
 * 验证：
 *  - 每个素材渲染 学习/练习/考试 三个按钮
 *  - mode==='study' 的素材，学习按钮显示"默认"标签
 *  - 存在断点进度时按钮显示"继续作答"
 *  - 点击按钮跳转 /quiz/<id>?mode=<modeKey>
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: {}, params: {} }),
}))
vi.mock('@/stores/quiz', () => ({
  useQuizStore: () => ({
    fetchQuizList: vi.fn().mockResolvedValue([
      { trainingId: 1, title: '安全生产培训', mode: 'study', totalQuestions: 5, timeLimit: 30, passScore: 60, completed: false },
    ]),
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { name: '张三' } }),
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

import QuizListPage from '@/views/QuizListPage.vue'

beforeEach(() => {
  localStorage.clear()
  push.mockClear()
})

it('渲染三个模式按钮，study 显示"默认"标签', async () => {
  const wrapper = mount(QuizListPage)
  await flushPromises()
  await nextTick()
  const buttons = wrapper.findAll('.btn-mode')
  expect(buttons).toHaveLength(3)
  // MODE_ORDER = [study, practice, exam]
  expect(buttons[0].text()).toContain('学习')
  expect(buttons[0].find('.default-tag').exists()).toBe(true) // m.mode === 'study'
  expect(buttons[1].text()).toContain('练习')
  expect(buttons[1].find('.default-tag').exists()).toBe(false)
  expect(buttons[2].text()).toContain('考试')
  wrapper.unmount()
})

it('存在断点进度时按钮显示"继续作答"', async () => {
  localStorage.setItem(
    'tnb_quiz_progress_1_study',
    JSON.stringify({ answers: { 1: 'A' }, currentIndex: 0, elapsedSec: 0 })
  )
  const wrapper = mount(QuizListPage)
  await flushPromises()
  await nextTick()
  const buttons = wrapper.findAll('.btn-mode')
  expect(buttons[0].text()).toContain('继续作答')
  expect(buttons[0].find('.default-tag').exists()).toBe(true)
  wrapper.unmount()
})

it('点击模式按钮跳转带正确 ?mode= 的路由', async () => {
  const wrapper = mount(QuizListPage)
  await flushPromises()
  await nextTick()
  const buttons = wrapper.findAll('.btn-mode')
  await buttons[0].trigger('click') // study
  expect(push).toHaveBeenCalledWith('/quiz/1?mode=study')
  await buttons[1].trigger('click') // practice
  expect(push).toHaveBeenCalledWith('/quiz/1?mode=practice')
  await buttons[2].trigger('click') // exam
  expect(push).toHaveBeenCalledWith('/quiz/1?mode=exam')
  wrapper.unmount()
})
