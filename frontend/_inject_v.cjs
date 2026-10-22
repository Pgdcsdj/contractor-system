'use strict'
// 构建产物缓存击穿：给 dist/index.html 中 /tnb/assets/* 引用追加 ?v=时间戳
const fs = require('fs')
const path = require('path')
const p = path.join(__dirname, 'dist', 'index.html')
if (!fs.existsSync(p)) { console.error('dist/index.html 不存在'); process.exit(1) }
let s = fs.readFileSync(p, 'utf8')
const ts = Date.now()
const re = /(src|href)="(\/tnb\/assets\/[^"]+)"/g
let n = 0
s = s.replace(re, (m, attr, url) => { n++; return `${attr}="${url}?v=${ts}"` })
fs.writeFileSync(p, s)
console.log(`[inject] 已为 ${n} 处 /tnb/assets 引用追加 ?v=${ts}`)
