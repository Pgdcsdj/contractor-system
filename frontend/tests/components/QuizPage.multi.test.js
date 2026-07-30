/**
 * QuizPage 多选题交互测试（@vue/test-utils + mocked store/router）
 *
 * 验证本次改动（问题 2：多选题交互）：
 *  - 多选题 isMultiple 为真、顶部出现「已选择 X 个选项」提示
 *  - 点击选项 -> toggleMulti 触发 -> 该行 .option-item.selected 出现、计数 +1、提示同步
 *  - 再次点击同一选项 -> 取消选中（selected 消失、计数回 0）、store.answers[id] 数组正确增删
 *  - 点击两个不同选项 -> 两者都 selected、计数 2
 *  - 切到单选题 -> isMultiple 为假、.multi-hint 不出现、单选走 .option-radio 逻辑
 *
 * 不修改 request.js、不写 responsible_phone、不部署。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

// 通过 vi.hoisted 持有可在 factory 与用例间共享的引用（避免 TDZ 问题）
const { h } = vi.hoisted(() => ({ h: { store: null } }))

const push = vi.fn()
const replace = vi.fn()
const route = vi.hoisted(() => ({ params: { id: '123' }, query: { mode: 'exam' } }))

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push, replace }),
}))

// mock quiz store：使用 reactive 代理，保证 computeds（multiSelectedCount）能随作答更新
vi.mock('@/stores/quiz', () => {
  const store = reactive({
    answers: {},
    currentQuiz: null,
    timeLeft: 0,
    fetchQuiz: vi.fn(),
    setAnswer(id, ans) { store.answers[id] = ans },
    resetAnswers() { Object.keys(store.answers).forEach(k => delete store.answers[k]) },
  })
  h.store = store
  return { useQuizStore: () => store }
})

import QuizPage from '@/views/QuizPage.vue'

const multiQ = {
  id: 1, type: 'multiple', question: '以下哪些属于违章行为？',
  options: ['未系安全带', '未戴安全帽', '正常操作', '违规接电'],
  answer: '0,1', analysis: '解析', score: 5,
}
const singleQ = {
  id: 2, type: 'single', question: '安全生产的方针是？',
  options: ['安全第一', '效益第一'],
  answer: '0', analysis: '解析', score: 5,
}

beforeEach(() => {
  localStorage.clear()
  push.mockClear()
  replace.mockClear()
  Object.keys(h.store.answers).forEach(k => delete h.store.answers[k])
  h.store.fetchQuiz.mockReset()
  h.store.fetchQuiz.mockResolvedValue({
    materialId: 123, title: 'T', mode: 'exam',
    timeLimit: 30, passScore: 60, attemptLimit: 0, totalScore: 0, aiGrading: false,
    questions: [multiQ, singleQ],
  })
})

async function mountQuiz() {
  const wrapper = mount(QuizPage)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('多选题交互（问题 2）', () => {
  it('多选题：isMultiple 为真、出现「已选择 0 个选项」提示', async () => {
    const wrapper = await mountQuiz()
    expect(wrapper.vm.isMultiple).toBe(true)
    expect(wrapper.find('.multi-hint').exists()).toBe(true)
    expect(wrapper.find('.multi-hint').text()).toContain('已选择 0 个选项')
    wrapper.unmount()
  })

  it('点击一个选项：toggleMulti 触发、.option-item.selected 出现、计数变 1、store.answers[id]=[0]', async () => {
    const wrapper = await mountQuiz()
    const opts = wrapper.findAll('.option-item')
    expect(opts).toHaveLength(4)

    await opts[0].trigger('click')
    await nextTick()

    expect(wrapper.findAll('.option-item.selected')).toHaveLength(1)
    expect(wrapper.vm.multiSelectedCount).toBe(1)
    expect(wrapper.find('.multi-hint').text()).toContain('已选择 1 个选项')
    // 复选框内出现选中勾
    expect(wrapper.find('.option-item.selected .option-checkbox').exists()).toBe(true)
    expect(h.store.answers[1]).toEqual([0])
    wrapper.unmount()
  })

  it('再次点击同一选项：取消选中（selected 消失、计数回 0）、store.answers[id]=[]', async () => {
    const wrapper = await mountQuiz()
    const opts = wrapper.findAll('.option-item')

    await opts[1].trigger('click')
    await nextTick()
    expect(wrapper.findAll('.option-item.selected')).toHaveLength(1)
    expect(h.store.answers[1]).toEqual([1])

    await opts[1].trigger('click')
    await nextTick()

    expect(wrapper.findAll('.option-item.selected')).toHaveLength(0)
    expect(wrapper.vm.multiSelectedCount).toBe(0)
    expect(wrapper.find('.multi-hint').text()).toContain('已选择 0 个选项')
    expect(h.store.answers[1]).toEqual([])
    wrapper.unmount()
  })

  it('点击两个不同选项：两者都 selected、计数 2、store.answers[id]=[0,1]', async () => {
    const wrapper = await mountQuiz()
    const opts = wrapper.findAll('.option-item')

    await opts[0].trigger('click')
    await nextTick()
    await opts[1].trigger('click')
    await nextTick()

    expect(wrapper.findAll('.option-item.selected')).toHaveLength(2)
    expect(wrapper.vm.multiSelectedCount).toBe(2)
    expect(wrapper.find('.multi-hint').text()).toContain('已选择 2 个选项')
    expect(h.store.answers[1]).toEqual([0, 1])
    wrapper.unmount()
  })

  it('切到单选题：isMultiple 为假、.multi-hint 不出现、走 .option-radio 逻辑', async () => {
    const wrapper = await mountQuiz()

    await wrapper.vm.nextQuestion()
    await nextTick()

    expect(wrapper.vm.currentQuestion.type).toBe('single')
    expect(wrapper.vm.isMultiple).toBe(false)
    expect(wrapper.find('.multi-hint').exists()).toBe(false)
    expect(wrapper.find('.option-radio').exists()).toBe(true)

    // 单选点击 -> 该行 selected、store.answers[id] 为数字索引
    const opts = wrapper.findAll('.option-item')
    await opts[0].trigger('click')
    await nextTick()
    expect(wrapper.findAll('.option-item.selected')).toHaveLength(1)
    expect(h.store.answers[2]).toBe(0)
    wrapper.unmount()
  })
})
