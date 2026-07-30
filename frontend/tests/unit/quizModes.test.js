/**
 * quizModes.normalizeMode 单元测试
 *
 * 覆盖培训三模式（study/practice/exam）的规范化行为：
 *  - 合法小写值原样返回
 *  - 非法 / 空值回退 exam
 *  - 大写输入应大小写不敏感地规整为小写（与后端 normalizeModeParam 行为一致）
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeMode,
  isValidMode,
  isRevealing,
  getModeLabel,
  MODE_ORDER,
  QUIZ_MODES,
} from '@/utils/quizModes'

describe('normalizeMode', () => {
  it('合法小写值原样返回', () => {
    expect(normalizeMode('study')).toBe('study')
    expect(normalizeMode('practice')).toBe('practice')
    expect(normalizeMode('exam')).toBe('exam')
  })

  it('非法/BOGUS 值回退 exam', () => {
    expect(normalizeMode('BOGUS')).toBe('exam')
    expect(normalizeMode('学习')).toBe('exam')
    expect(normalizeMode('')).toBe('exam')
  })

  it('undefined / null 回退 exam', () => {
    expect(normalizeMode(undefined)).toBe('exam')
    expect(normalizeMode(null)).toBe('exam')
  })

  it('大写输入应大小写不敏感地规整为小写（与后端一致）', () => {
    expect(normalizeMode('STUDY')).toBe('study')
    expect(normalizeMode('PRACTICE')).toBe('practice')
    expect(normalizeMode('EXAM')).toBe('exam')
  })

  it('支持自定义回退值', () => {
    expect(normalizeMode('BOGUS', 'practice')).toBe('practice')
    expect(normalizeMode(undefined, 'study')).toBe('study')
  })
})

describe('isValidMode', () => {
  it('仅 study/practice/exam 合法', () => {
    expect(isValidMode('study')).toBe(true)
    expect(isValidMode('practice')).toBe(true)
    expect(isValidMode('exam')).toBe(true)
    expect(isValidMode('STUDY')).toBe(false)
    expect(isValidMode('x')).toBe(false)
  })
})

describe('isRevealing', () => {
  it('学习/练习揭示答案，考试不揭示', () => {
    expect(isRevealing('study')).toBe(true)
    expect(isRevealing('practice')).toBe(true)
    expect(isRevealing('exam')).toBe(false)
  })
})

describe('MODE_ORDER / getModeLabel', () => {
  it('MODE_ORDER 顺序为 study,practice,exam', () => {
    expect(MODE_ORDER).toEqual([QUIZ_MODES.STUDY, QUIZ_MODES.PRACTICE, QUIZ_MODES.EXAM])
  })
  it('getModeLabel 返回中文标签，非法值回退考试', () => {
    expect(getModeLabel('study')).toBe('学习')
    expect(getModeLabel('practice')).toBe('练习')
    expect(getModeLabel('exam')).toBe('考试')
    expect(getModeLabel('BOGUS')).toBe('考试')
  })
})
