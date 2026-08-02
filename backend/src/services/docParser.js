/**
 * 文档解析服务
 * 从 Word (docx) 和 PDF 中提取文字内容和内嵌图片
 *
 * 使用方式：
 *   const { extractFromBuffer } = require('./docParser')
 *   const { text, images } = await extractFromBuffer(buffer, 'docx')
 */

const AdmZip = require('adm-zip')
const xml2js = require('xml2js')

// PDF 解析库采用 vendor 化（相对路径引入），避免依赖服务器 node_modules 持久化
const pdfParse = require('../lib/pdf-parse')

// 老版本 Word (.doc, OLE2 复合文档) 解析采用 vendor 化的 word-extractor（相对路径引入）
const WordExtractor = require('../lib/word-extractor')

/**
 * 根据文件类型自动选择解析器
 * @param {Buffer} buffer  文件内容
 * @param {string} ext     文件扩展名（不含点）
 * @returns {{text: string, images: Array<{buffer: Buffer, filename: string}>}}
 */
async function extractFromBuffer(buffer, ext) {
  const lowerExt = (ext || '').toLowerCase()

  if (lowerExt === 'docx') {
    return extractFromDocx(buffer)
  }

  if (lowerExt === 'doc') {
    return extractFromDoc(buffer)
  }

  if (lowerExt === 'pdf') {
    return extractFromPdf(buffer)
  }

  // 图片文件直接返回
  if (['jpg', 'jpeg', 'png'].includes(lowerExt)) {
    return { text: '[图片素材，请在审核页补充文字描述]', images: [{ buffer, filename: `image.${lowerExt}` }] }
  }

  return { text: '[未知格式，无法自动提取内容]', images: [] }
}

/**
 * 从 PDF 文件中提取文字内容
 * 基于 vendor 化的 pdf-parse（相对路径 require，不依赖服务器 node_modules）。
 * PDF 解析对损坏/加密/扫描件等场景会失败或返回空，统一容错为占位文字，
 * 保证调用方（出题流程）始终拿到字符串而非抛错。
 * @param {Buffer} buffer PDF 文件内容
 * @returns {{text: string, images: Array}}
 */
async function extractFromPdf(buffer) {
  try {
    const data = await pdfParse(buffer)
    const text = (data.text || '').trim()
    if (text.length < 20) {
      return { text: '[PDF解析结果为空，可能为扫描件/图片型PDF，请在审核页手动补充题目内容]', images: [] }
    }
    console.log(`[docParser] PDF解析完成：${text.length} 字符，${data.numpages || 0} 页`)
    return { text, images: [] }
  } catch (err) {
    console.error('[docParser] PDF解析失败:', err.message)
    return { text: '[PDF解析失败：' + err.message + '，请在审核页手动补充题目内容]', images: [] }
  }
}

/**
 * 从老版本 Word .doc（OLE2 复合文档）中提取文字
 * 使用 vendor 化的 word-extractor（相对路径 require，不依赖服务器 node_modules）。
 * @param {Buffer} buffer
 * @returns {{text: string, images: Array}}
 */
async function extractFromDoc(buffer) {
  try {
    const extractor = new WordExtractor()
    const extracted = await extractor.extract(buffer)
    const text = (extracted.getBody() || '').trim()
    if (text.length < 20) {
      return { text: '[Word文档内容提取过少，可能为加密或图片型文档，请在审核页手动补充]', images: [] }
    }
    console.log(`[docParser] DOC解析完成：${text.length} 字符`)
    return { text, images: [] }
  } catch (err) {
    console.error('[docParser] DOC解析失败:', err.message)
    return { text: '[Word文档解析失败：' + err.message + '，请在审核页手动补充]', images: [] }
  }
}

/**
 * 从 DOCX 文件中提取文字和图片
 * DOCX 本质上是 ZIP 文件，结构如下：
 *   - word/document.xml   → 正文内容
 *   - word/media/*.png    → 内嵌图片
 */
async function extractFromDocx(buffer) {
  try {
    const zip = new AdmZip(buffer)
    const zipEntries = zip.getEntries()

    // ── 1. 提取文字 ──────────────────────────────────────────
    const docXmlEntry = zipEntries.find(e => e.entryName === 'word/document.xml')
    let text = ''
    if (docXmlEntry) {
      const docXml = docXmlEntry.getData().toString('utf8')
      text = await extractTextFromDocXml(docXml)
    }

    // 如果文字太少（小于50字符），可能是加密或格式异常
    if (text.length < 50) {
      text = '[文档内容提取不完整，可能为加密文档或格式异常，请在审核页手动补充]'
    }

    // ── 2. 提取图片 ──────────────────────────────────────────
    const images = []
    const mediaEntries = zipEntries.filter(e =>
      e.entryName.startsWith('word/media/') &&
      !e.entryName.endsWith('/') &&
      /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(e.entryName)
    )

    for (const entry of mediaEntries) {
      const filename = entry.entryName.split('/').pop()
      images.push({
        buffer: entry.getData(),
        filename,
      })
    }

    // 按文件名排序，保持文档中的图片顺序
    images.sort((a, b) => a.filename.localeCompare(b.filename))

    console.log(`[docParser] DOCX解析完成：文字 ${text.length} 字符，图片 ${images.length} 张`)
    return { text, images }

  } catch (err) {
    console.error('[docParser] DOCX解析失败:', err.message)
    return { text: '[文档解析失败：' + err.message + ']', images: [] }
  }
}

/**
 * 从 word/document.xml 中提取纯文本
 * 简单实现：提取所有 <w:t> 标签的文本内容
 */
async function extractTextFromDocXml(xml) {
  try {
    const parser = new xml2js.Parser({ explicitArray: false })
    const doc = await parser.parseStringPromise(xml)

    const paragraphs = []
    const body = doc['w:document']?.['w:body']
    if (!body) return ''

    // body 中可能直接是 w:p 或包含 w:p 的数组
    const pElements = body['w:p']
    if (!pElements) return ''

    const pArray = Array.isArray(pElements) ? pElements : [pElements]

    for (const p of pArray) {
      const paraText = extractTextFromParagraph(p)
      if (paraText.trim()) {
        paragraphs.push(paraText.trim())
      }
    }

    return paragraphs.join('\n')
  } catch (err) {
    console.error('[docParser] XML解析失败:', err.message)
    // 降级：用正则提取 <w:t> 标签内容
    return extractTextWithRegex(xml)
  }
}

/**
 * 从单个段落中提取文本
 */
function extractTextFromParagraph(p) {
  const texts = []
  const rElements = p['w:r']
  if (!rElements) return ''

  const rArray = Array.isArray(rElements) ? rElements : [rElements]
  for (const r of rArray) {
    const t = r['w:t']
    if (t) {
      // w:t 可能是字符串或对象（带属性时）
      texts.push(typeof t === 'string' ? t : (t._ || ''))
    }
  }
  return texts.join('')
}

/**
 * 正则降级提取：直接匹配 <w:t> 标签内容
 */
function extractTextWithRegex(xml) {
  const texts = []
  const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g
  let match
  while ((match = regex.exec(xml)) !== null) {
    texts.push(match[1])
  }
  return texts.join('')
}

module.exports = {
  extractFromBuffer,
  extractFromDocx,
  extractFromPdf,
  extractFromDoc,
}
