#!/usr/bin/env node
/**
 * 构建前置校验：禁止在源码不完整的目录上执行 vite build。
 *
 * 背景（2026-08-07 事故）：服务器 /root/frontend 源码停留在 7-19 旧版
 * （缺 views/contractor/ 目录、缺 ContractorDocManage/ContractorDocSubmit 页面），
 * 有人在服务器上直接 npx vite build，用旧源码覆盖了线上完整 dist，
 * 导致「开工资料上报 / 管理」页面 chunk 消失、页面 404。
 *
 * 本脚本在每次 build 前检查关键源码文件必须存在，缺失即 exit(1) 阻止构建，
 * 无论谁在哪个环境（本地/服务器/CI）执行构建，残缺源码都不可能产出并覆盖线上产物。
 *
 * 注意：本文件用 .cjs 后缀（CommonJS），不受 package.json "type":"module" 影响，
 * Node 18/20/22 均可直接运行。
 *
 * 用法：node scripts/verify-src.cjs [rootPath]   （rootPath 默认取脚本上一级目录）
 */
'use strict'

const fs = require('fs')
const path = require('path')

// 允许用命令行参数指定项目根目录（便于测试拦截逻辑），默认脚本上一级
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..')

// 关键源码文件清单（相对项目根）。历史事故中缺失的页面放在最前。
const REQUIRED_FILES = [
  'src/router/index.js',
  // —— 本次事故涉及的开工资料模块（7-19 旧版源码缺失它们）——
  'src/views/contractor/ContractorDocSubmit.vue',
  'src/views/admin/ContractorDocManage.vue',
  'src/views/admin/ContractorUnitsPage.vue',
  // —— 管理员端核心页面 ——
  'src/views/admin/LayoutPage.vue',
  'src/views/admin/LoginPage.vue',
  'src/views/admin/DashboardPage.vue',
  'src/views/admin/TrainingsPage.vue',
  'src/views/admin/HazardLoopPage.vue',
  'src/views/admin/HazardReportPage.vue',
  'src/views/admin/DataManagePage.vue',
  'src/views/admin/SettingsPage.vue',
  'src/views/admin/UsersPage.vue',
  // —— 学员端 / 安全员端核心页面 ——
  'src/views/LoginPage.vue',
  'src/views/QuizPage.vue',
  'src/views/QuizListPage.vue',
  'src/views/safety/SafetyLayout.vue',
  'src/views/safety/SafetyWorkbench.vue',
  'src/views/safety/SafetyReportForm.vue',
  'src/views/safety/SafetyRectifyList.vue',
]

// 关键目录必须存在（本次事故根因之一是 contractor 目录整体缺失）
const REQUIRED_DIRS = [
  'src/views/contractor',
  'src/views/safety',
  'src/views/admin/components',
]

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const missingFiles = REQUIRED_FILES.filter((rel) => !fs.existsSync(path.join(root, rel)))
const missingDirs = REQUIRED_DIRS.filter((rel) => !isDir(path.join(root, rel)))

if (missingFiles.length > 0 || missingDirs.length > 0) {
  console.error(`[verify-src] ✗ 源码不完整，禁止构建！项目根目录: ${root}`)
  if (missingDirs.length > 0) {
    console.error(`  缺失目录 ${missingDirs.length} 个:`)
    for (const d of missingDirs) console.error(`    - ${d}`)
  }
  if (missingFiles.length > 0) {
    console.error(`  缺失关键文件 ${missingFiles.length} 个:`)
    for (const f of missingFiles) console.error(`    - ${f}`)
  }
  console.error('[verify-src] 请先同步完整源码（与本地 root/frontend 一致），再执行构建。')
  process.exit(1)
}

console.log(
  `[verify-src] ✓ 源码完整性校验通过（${REQUIRED_FILES.length} 个关键文件 + ${REQUIRED_DIRS.length} 个关键目录全部存在）@ ${root}`
)
