/**
 * progressStorage 单元测试（localStorage 持久化的断点续做）
 *
 * 验证：
 *  - save → load 往返正确
 *  - key 含 materialId + mode
 *  - clear 后 hasProgress 为 false
 *  - listInProgress 能正确列出
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadProgress,
  saveProgress,
  clearProgress,
  listInProgress,
  hasProgress,
} from '@/utils/progressStorage'

beforeEach(() => {
  localStorage.clear()
})

describe('save / load 往返', () => {
  it('保存后读回 answers / currentIndex / elapsedSec 正确', () => {
    saveProgress(1, 'study', { answers: { 10: 'A', 11: 'B' }, currentIndex: 2, elapsedSec: 35 })
    const p = loadProgress(1, 'study')
    expect(p).toEqual({
      answers: { 10: 'A', 11: 'B' },
      currentIndex: 2,
      elapsedSec: 35,
      updatedAt: expect.any(Number),
    })
  })

  it('key 包含 materialId 与 mode', () => {
    saveProgress(7, 'practice', { answers: { 1: 'x' } })
    expect(localStorage.getItem('tnb_quiz_progress_7_practice')).not.toBeNull()
  })

  it('缺失进度返回 null', () => {
    expect(loadProgress(99, 'exam')).toBeNull()
  })

  it('materialId / mode 缺失时不写入', () => {
    saveProgress(null, 'study', { answers: { 1: 'a' } })
    expect(listInProgress()).toHaveLength(0)
  })
})

describe('clear / hasProgress', () => {
  it('clear 后 hasProgress 为 false', () => {
    saveProgress(1, 'study', { answers: { 1: 'a' } })
    expect(hasProgress(1, 'study')).toBe(true)
    clearProgress(1, 'study')
    expect(hasProgress(1, 'study')).toBe(false)
  })

  it('未作答任何内容时 hasProgress 为 false', () => {
    saveProgress(1, 'study', { answers: {}, currentIndex: 0, elapsedSec: 0 })
    expect(hasProgress(1, 'study')).toBe(false)
  })

  it('仅 elapsedSec > 0 也视为有进度', () => {
    saveProgress(1, 'study', { answers: {}, currentIndex: 0, elapsedSec: 12 })
    expect(hasProgress(1, 'study')).toBe(true)
  })
})

describe('listInProgress', () => {
  it('列出所有断点进度（按 materialId_mode）', () => {
    saveProgress(1, 'study', { answers: { 1: 'a' } })
    saveProgress(2, 'exam', { answers: { 2: 'b' }, currentIndex: 1 })
    const list = listInProgress()
    expect(list).toHaveLength(2)
    expect(list.map((x) => `${x.materialId}_${x.mode}`).sort()).toEqual(['1_study', '2_exam'])
  })

  it('忽略无关 localStorage key', () => {
    localStorage.setItem('tnb_device_id', 'device_x')
    localStorage.setItem('tnb_token', 'tok')
    saveProgress(1, 'study', { answers: { 1: 'a' } })
    expect(listInProgress()).toHaveLength(1)
  })

  it('非法 mode 后缀的 key 不会被列入', () => {
    localStorage.setItem('tnb_quiz_progress_3_unknown', JSON.stringify({ answers: { 1: 'a' } }))
    expect(listInProgress()).toHaveLength(0)
  })
})
