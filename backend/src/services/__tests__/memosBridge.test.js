'use strict'

/**
 * 个人工作日志（Memos）桥接 / 联动 冒烟测试
 * ───────────────────────────────────────────────────────────────────────────
 * 运行：node --test src/services/__tests__/memosBridge.test.js
 * 说明：本测试不依赖真实 Memos / 钉钉服务，全部走「配置未就绪」的优雅降级分支，
 *      验证桥接层在缺密钥时既不崩溃、也不抛出，符合设计纪律。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const config = require('../../config/memos.config')
const dingtalkClient = require('../../services/dingtalkClient')
const memosClient = require('../../services/memosClient')
const hazardMemosHook = require('../../services/hazardMemosHook')

test('memos.config：缺环境变量时给出安全默认值且不抛错', () => {
  assert.equal(typeof config.memos.baseUrl, 'string')
  assert.ok(config.memos.baseUrl.startsWith('http://127.0.0.1:5230'))
  assert.equal(typeof config.cookieDomain, 'string')
  assert.equal(config.cookieDomain, '.choiceeffect.store')
  // 未配置密钥 → 派生标志为 false
  assert.equal(config.dingtalk.configured, false)
  assert.equal(config.memos.safetyPatConfigured, false)
})

test('dingtalkClient.authorizeUrl：构造合法的钉钉授权 URL', () => {
  const url = dingtalkClient.authorizeUrl('test-state-123')
  assert.ok(url.startsWith('https://login.dingtalk.com/oauth2/auth?'))
  assert.ok(url.includes('response_type=code'))
  assert.ok(url.includes('scope=openid'))
  assert.ok(url.includes('state=test-state-123'))
  assert.ok(url.includes('prompt=consent'))
})

test('memosClient.signInAsSafetyOfficer：缺安全员账号时拒绝但不崩溃', async () => {
  // 测试环境未配置 MEMOS_SAFETY_USERNAME/PASSWORD
  await assert.rejects(
    () => memosClient.signInAsSafetyOfficer(),
    /安全员账号未配置/
  )
})

test('memosClient.createMemoAsSafety：缺 PAT 时拒绝（供 hook 捕获后跳过）', async () => {
  await assert.rejects(
    () => memosClient.createMemoAsSafety('测试内容', 'PRIVATE', ['隐患', '安全员']),
    /安全员 PAT 未配置/
  )
})

test('hazardMemosHook.onTransition：缺 PAT 时优雅跳过（resolve 不抛）', async () => {
  // 捕获 console.warn，确认走了「跳过」分支
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    await hazardMemosHook.onTransition(
      { id: 1, hazard_code: 'H-001', responsible_person: '张三', status: 'reported' },
      null,
      'reported'
    )
  } finally {
    console.warn = origWarn
  }
  assert.ok(warns.some((w) => w.includes('MEMOS_SAFETY_PAT')), '应打印跳过警告')
})

test('hazardMemosHook.onTransition：即使内部异常也绝不 reject（不阻断隐患流转）', async () => {
  // 即便 createMemoAsSafety 抛错（缺 PAT），onTransition 也已被内部 try/catch 包裹
  await assert.doesNotReject(
    hazardMemosHook.onTransition(
      { id: 2, hazard_code: 'H-002', responsible_person: '李四' },
      'reported',
      'assigned'
    )
  )
})
