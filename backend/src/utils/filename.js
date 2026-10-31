// 文件名解码工具
// 问题背景：中文文件名在部分运行环境（multer / Express 接收 multipart 时）会被以
// Latin-1 / CP1252 方式错误解码，存入 DB 后表现为 mojibake，例如：
//   "éåå·´æ¯æ¥è§é¢..."  ← 实际应为 "通南巴每日视频..."
// 还原原理：mojibake 的每个字符其实是原 UTF-8 字节被当成一个 Latin-1 码点（0x80-0xFF），
// 因此把字符串按 latin1 还原成字节，再按 utf8 解读即可恢复中文。
//
// 安全策略：仅当字符串含 Latin-1 高位字节（0x80-0xFF）且还原结果含中文字符时才采用，
// 否则保持原样，避免误伤「本身就是合法 UTF-8 中文」或「含拉丁重音字符」的文件名。

function decodeFilename(name) {
  if (!name || typeof name !== 'string') return name

  // 判断是否存在 Latin-1 高位字节（0x80-0xFF）。
  // 注：合法 UTF-8 中文在 JS 字符串中是码点 > 255 的真实汉字，不属于该区间；
  // 只有被误读为 Latin-1 的 mojibake 才会落在该区间，由此区分两类情况。
  let hasHighByte = false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c >= 0x80 && c <= 0xff) {
      hasHighByte = true
      break
    }
  }
  if (!hasHighByte) return name

  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8')
    // 还原后若含 CJK 字符（常见区 U+4E00-U+9FFF，含中文文件名场景），判定为成功还原。
    if (/[一-鿿]/.test(decoded)) return decoded
    return name
  } catch (e) {
    return name
  }
}

module.exports = { decodeFilename }
