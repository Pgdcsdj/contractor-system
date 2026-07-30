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

  if (lowerExt === 'pdf') {
    // PDF 图片提取较复杂，当前版本仅提取文字
    return { text: '[PDF素材，当前版本仅支持Word文档自动提取图片。请手动上传图片或切换为Word格式。]', images: [] }
  }

  // 图片文件直接返回
  if (['jpg', 'jpeg', 'png'].includes(lowerExt)) {
    return { text: '[图片素材，请在审核页补充文字描述]', images: [{ buffer, filename: `image.${lowerExt}` }] }
  }

  return { text: '[未知格式，无法自动提取内容]', images: [] }
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
}
