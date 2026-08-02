/**
 * AIPreviewModal 组件测试
 *
 * 测试范围：
 * - 弹窗显隐控制（visible prop）
 * - 加载态显示（spinner + loadingText）
 * - 题目卡片渲染（数量、题型标签、选项、正确答案高亮、解析）
 * - 三个按钮的 emit 事件（confirm / regenerate / cancel）
 *
 * 注意：组件使用 <Teleport to="body">，故内容渲染在 document.body
 *       需通过 document.body.querySelector 查找 DOM 元素
 *
 * 运行方式：
 *   node vitest.mjs run (or: npx vitest run)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

import AIPreviewModal from '@/views/admin/components/AIPreviewModal.vue'

// ─── 辅助：生成测试题目 ────────────────────────────────────────────────
function makeQuestion(overrides = {}) {
  return {
    type: 'single',
    question: '这是一道测试题目？',
    options: [
      { label: '选项A', value: 'A' },
      { label: '选项B', value: 'B' },
      { label: '选项C', value: 'C' },
      { label: '选项D', value: 'D' },
    ],
    answer: 'A',
    explanation: '这是题目的解析内容',
    ...overrides,
  }
}

function makeQuestions(count) {
  return Array.from({ length: count }, (_, i) =>
    makeQuestion({ question: `第 ${i + 1} 题测试内容？` })
  )
}

// ─── DOM 辅助（针对 Teleport 到 body 的内容）───────────────────────────
function $(selector) {
  return document.body.querySelector(selector)
}
function $$(selector) {
  return document.body.querySelectorAll(selector)
}

// ─── 挂载辅助 ──────────────────────────────────────────────────────────
function createWrapper(props = {}) {
  return mount(AIPreviewModal, {
    props: {
      visible: true,
      questions: makeQuestions(3),
      title: '测试培训标题',
      difficulty: 3,
      loading: false,
      loadingText: 'AI 正在生成题目，请稍候…',
      ...props,
    },
    attachTo: document.body,
  })
}

beforeEach(() => {
  // 每个测试前清理 body，避免 Teleport 残留
  document.body.innerHTML = ''
})

// ═════════════════════════════════════════════════════════════════════════
describe('AIPreviewModal.vue', () => {
  // ── 1. visible=true → 弹窗渲染 ──────────────────────────────────────
  it('visible=true → 弹窗渲染', async () => {
    const wrapper = createWrapper()
    await nextTick()
    expect($('.preview-overlay')).toBeTruthy()
    expect($('.preview-modal')).toBeTruthy()
    wrapper.unmount()
  })

  it('visible=false → 弹窗不渲染', async () => {
    const wrapper = createWrapper({ visible: false })
    await nextTick()
    expect($('.preview-overlay')).toBeFalsy()
    wrapper.unmount()
  })

  // ── 2. loading=true → spinner + loadingText 显示 ──────────────────
  it('loading=true → spinner + loadingText 显示', async () => {
    const wrapper = createWrapper({ loading: true, loadingText: 'AI 正在拼命生成中…' })
    await nextTick()
    expect($('.preview-loading')).toBeTruthy()
    expect($('.spinner')).toBeTruthy()
    expect($('.loading-text').textContent).toBe('AI 正在拼命生成中…')
    // loading 为 true 时，不显示题目卡片
    expect($('.preview-body')).toBeFalsy()
    wrapper.unmount()
  })

  it('loading=false → 不显示 spinner', async () => {
    const wrapper = createWrapper({ loading: false })
    await nextTick()
    expect($('.preview-loading')).toBeFalsy()
    expect($('.spinner')).toBeFalsy()
    wrapper.unmount()
  })

  // ── 3. 3 道题 → 3 张卡片渲染 ─────────────────────────────────────
  it('3 道题 → 3 张 question-card 渲染', async () => {
    const wrapper = createWrapper()
    await nextTick()
    const cards = $$('.question-card')
    expect(cards).toHaveLength(3)
    // 验证每张卡片有题干
    expect(cards[0].querySelector('.q-stem').textContent).toContain('第 1 题')
    expect(cards[1].querySelector('.q-stem').textContent).toContain('第 2 题')
    expect(cards[2].querySelector('.q-stem').textContent).toContain('第 3 题')
    wrapper.unmount()
  })

  it('0 道题 → 0 张卡片', async () => {
    const wrapper = createWrapper({ questions: [] })
    await nextTick()
    expect($$('.question-card')).toHaveLength(0)
    // 但仍应显示数量徽章
    expect($('.count-badge').textContent).toContain('0 题')
    wrapper.unmount()
  })

  // ── 4. 单选题 → 正确答案高亮（.is-correct 类） ──────────────────
  it('单选题 → 正确答案选项有 .is-correct 类', async () => {
    const questions = [
      makeQuestion({
        type: 'single',
        question: '安全方针是什么？',
        options: [
          { label: '安全第一', value: 'A' },
          { label: '预防为主', value: 'B' },
          { label: '综合治理', value: 'C' },
          { label: '全部都是', value: 'D' },
        ],
        answer: 'D',
        explanation: '安全生产方针是"安全第一、预防为主、综合治理"',
      }),
    ]
    const wrapper = createWrapper({ questions })
    await nextTick()

    const optionDivs = $$('.q-option')
    expect(optionDivs).toHaveLength(4)

    // 只有 answer='D' 对应的选项（第 4 个，索引 3）应有 is-correct 类
    expect(optionDivs[3].classList.contains('is-correct')).toBe(true)
    expect(optionDivs[0].classList.contains('is-correct')).toBe(false)
    expect(optionDivs[1].classList.contains('is-correct')).toBe(false)
    expect(optionDivs[2].classList.contains('is-correct')).toBe(false)
    wrapper.unmount()
  })

  it('多选题 → 多个正确答案高亮', async () => {
    const questions = [
      makeQuestion({
        type: 'multiple',
        question: '以下哪些是安全色？',
        options: [
          { label: '红色', value: 'A' },
          { label: '蓝色', value: 'B' },
          { label: '黄色', value: 'C' },
          { label: '绿色', value: 'D' },
        ],
        answer: 'ABC',
        explanation: '安全色有红、蓝、黄、绿',
      }),
    ]
    const wrapper = createWrapper({ questions })
    await nextTick()

    const optionDivs = $$('.q-option')
    expect(optionDivs).toHaveLength(4)

    // 答案 ABC → 索引 0,1,2 应有 is-correct
    expect(optionDivs[0].classList.contains('is-correct')).toBe(true)
    expect(optionDivs[1].classList.contains('is-correct')).toBe(true)
    expect(optionDivs[2].classList.contains('is-correct')).toBe(true)
    // 索引 3（D）不应有
    expect(optionDivs[3].classList.contains('is-correct')).toBe(false)
    wrapper.unmount()
  })

  // ── 5. 点击确认 → emit confirm ──────────────────────────────────
  it('点击确认按钮 → emit confirm', async () => {
    const wrapper = createWrapper()
    await nextTick()
    const confirmBtn = $('.btn-primary')
    expect(confirmBtn).toBeTruthy()
    confirmBtn.click()
    expect(wrapper.emitted('confirm')).toBeTruthy()
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  // ── 6. 点击重新生成 → emit regenerate ──────────────────────────
  it('点击重新生成按钮 → emit regenerate', async () => {
    const wrapper = createWrapper()
    await nextTick()
    const regenerateBtn = $('.btn-outline')
    expect(regenerateBtn).toBeTruthy()
    regenerateBtn.click()
    expect(wrapper.emitted('regenerate')).toBeTruthy()
    expect(wrapper.emitted('regenerate')).toHaveLength(1)
    wrapper.unmount()
  })

  // ── 7. 点击取消 → emit cancel ──────────────────────────────────
  it('点击取消按钮 → emit cancel', async () => {
    const wrapper = createWrapper()
    await nextTick()
    const cancelBtn = $('.btn-text')
    expect(cancelBtn).toBeTruthy()
    cancelBtn.click()
    expect(wrapper.emitted('cancel')).toBeTruthy()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('点击遮罩层 → emit cancel', async () => {
    const wrapper = createWrapper()
    await nextTick()
    const overlay = $('.preview-overlay')
    expect(overlay).toBeTruthy()
    // 点击遮罩本身（非子元素）
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('cancel')).toBeTruthy()
    wrapper.unmount()
  })

  // ── 8. 难度徽章显示 ─────────────────────────────────────────────
  it('difficulty=1 → 显示 Lv.1 基础', async () => {
    const wrapper = createWrapper({ difficulty: 1 })
    await nextTick()
    expect($('.difficulty-badge').textContent).toContain('Lv.1')
    wrapper.unmount()
  })

  it('difficulty=5 → 显示 Lv.5 深入', async () => {
    const wrapper = createWrapper({ difficulty: 5 })
    await nextTick()
    expect($('.difficulty-badge').textContent).toContain('Lv.5')
    wrapper.unmount()
  })

  // ── 9. 题型标签 ────────────────────────────────────────────────
  it('题型标签正确渲染', async () => {
    const questions = [
      makeQuestion({ type: 'single', question: '单选' }),
      makeQuestion({ type: 'multiple', question: '多选' }),
      makeQuestion({ type: 'judge', question: '判断' }),
      makeQuestion({ type: 'fill', question: '填空' }),
      makeQuestion({ type: 'essay', question: '简答' }),
    ]
    const wrapper = createWrapper({ questions })
    await nextTick()
    const badges = $$('.q-type-badge')
    expect(badges).toHaveLength(5)
    expect(badges[0].textContent).toBe('单选题')
    expect(badges[1].textContent).toBe('多选题')
    expect(badges[2].textContent).toBe('判断题')
    expect(badges[3].textContent).toBe('填空题')
    expect(badges[4].textContent).toBe('简答题')
    wrapper.unmount()
  })

  // ── 10. 解析显示 ────────────────────────────────────────────────
  it('有 explanation 时显示解析区块', async () => {
    const questions = [makeQuestion({ explanation: '这是一段详细的解析' })]
    const wrapper = createWrapper({ questions })
    await nextTick()
    expect($('.q-analysis')).toBeTruthy()
    expect($('.q-analysis').textContent).toContain('这是一段详细的解析')
    wrapper.unmount()
  })

  it('无 explanation 且无 analysis 时不显示解析区块', async () => {
    const questions = [makeQuestion({ explanation: '', analysis: '' })]
    const wrapper = createWrapper({ questions })
    await nextTick()
    expect($('.q-analysis')).toBeFalsy()
    wrapper.unmount()
  })
})
