// server/parse.js —— 把上传的文件字节解析成纯文本，用于入知识库。
// 覆盖：txt/md/csv/json/log（直接读）、docx/xlsx/pptx（ZIP+XML，Node 内置 zlib 解）、
// 文本型 PDF（Mozilla PDF.js，支持字体映射/对象流/多页）。图片 / 扫描件 PDF -> OCR。
//
// 设计原则（贴合"缺哪个 key 只挡哪个功能"）：
//   - 文本类 / Office / 文本 PDF：无需外部服务 key、直接解析。
//   - 图片、以及"解析不出文字的 PDF（多为扫描件）"：抛 OCR_NEEDED，由上层决定是否调 OCR。
'use strict';

const zlib = require('zlib');
const path = require('path');

class OcrNeededError extends Error {
  constructor(msg) { super(msg || '需要 OCR'); this.code = 'OCR_NEEDED'; }
}
class UnsupportedError extends Error {
  constructor(msg) { super(msg); this.code = 'UNSUPPORTED'; }
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// ── 最小 ZIP 读取：解出 { entryName -> Buffer(解压后) }。走中央目录，只支持 store(0)/deflate(8)。
function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UnsupportedError('不是有效的 ZIP/Office 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const rawEntry = buf.slice(dataStart, dataStart + compSize);
      try { files[name] = method === 8 ? zlib.inflateRawSync(rawEntry) : rawEntry; } catch (_e) { /* 跳过 */ }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

// 从 XML 里按「文档顺序」抽文本标签内容，并在段落标签结束处补换行。textTag/paraTag 传标签名。
function xmlText(xml, textTag, paraTag) {
  const re = new RegExp('<' + textTag + '(?:\\s[^>]*)?>([^<]*)</' + textTag + '>|</' + paraTag + '>', 'g');
  let out = '', m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else out += '\n';
  }
  return out;
}

function parseDocx(buf) {
  const f = unzip(buf);
  const xml = (f['word/document.xml'] || Buffer.alloc(0)).toString('utf8');
  return xmlText(xml, 'w:t', 'w:p').replace(/\n{3,}/g, '\n\n').trim();
}

function parsePptx(buf) {
  const f = unzip(buf);
  const slides = Object.keys(f).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => (parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))));
  let out = '';
  for (const s of slides) {
    const t = xmlText(f[s].toString('utf8'), 'a:t', 'a:p').trim();
    if (t) out += t + '\n\n';
  }
  return out.trim();
}

function parseXlsx(buf) {
  const f = unzip(buf);
  const shared = (f['xl/sharedStrings.xml'] || Buffer.alloc(0)).toString('utf8');
  const strings = xmlText(shared, 't', 'si');
  let cells = '';
  for (const k of Object.keys(f)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) {
      cells += ' ' + xmlText(f[k].toString('utf8'), 'v', 'row');
    }
  }
  return (strings + '\n' + cells).replace(/\n{3,}/g, '\n\n').trim();
}

// ── 文本型 PDF ──────────────────────────────────────────────────────────────────
let pdfJsPromise;
function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      // legacy build 会尝试为“页面渲染”加载 Canvas polyfill；本服务只抽文本，不需要 DOMMatrix/Path2D。
      // 仅过滤这两条已知、与文本解析无关的提示，其他 PDF.js 警告仍照常输出。
      const originalWarn = console.warn;
      const originalLog = console.log;
      const filtered = function (fallback, args) {
        const msg = String(args[0] || '');
        if (!/^Warning: Cannot polyfill `(DOMMatrix|Path2D)`/.test(msg)) fallback.apply(console, args);
      };
      console.warn = function (...args) { filtered(originalWarn, args); };
      console.log = function (...args) { filtered(originalLog, args); };
      try {
        return await import('pdfjs-dist/legacy/build/pdf.mjs');
      } finally {
        console.warn = originalWarn;
        console.log = originalLog;
      }
    })();
  }
  return pdfJsPromise;
}

function normalizePdfPageText(items) {
  let out = '';
  for (const item of items || []) {
    if (!item || typeof item.str !== 'string') continue;
    const text = item.str.replace(/\0/g, '');
    if (text) out += text + (item.hasEOL ? '\n' : ' ');
    else if (item.hasEOL) out += '\n';
  }
  // PDF.js 的 text item 边界不等于自然词边界。英文 item 间保留空格，
  // 连续 CJK 与中文标点之间去掉人工空格，避免破坏中文 BM25/向量切块。
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1')
    .replace(/ +(?=[，。！？；：、）》】』」])/g, '')
    .replace(/([（《【『「]) +/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parsePdfText(buf) {
  const pdfjs = await loadPdfJs();
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    const maxPages = Math.max(1, Number(process.env.PDF_MAX_PAGES) || 500);
    if (pdf.numPages > maxPages) {
      throw new UnsupportedError(`PDF 共 ${pdf.numPages} 页，超过当前 ${maxPages} 页上限，请拆分后上传`);
    }
    const pages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = normalizePdfPageText(content.items);
      if (text) pages.push(text);
      page.cleanup();
    }
    return pages.join('\n\n').trim();
  } catch (e) {
    if (e && e.code === 'UNSUPPORTED') throw e;
    if (e && (e.name === 'PasswordException' || e.code === 1 || e.code === 2)) {
      throw new UnsupportedError('PDF 已加密或需要密码，请解除密码保护后重新上传');
    }
    if (e && ['InvalidPDFException', 'MissingPDFException', 'UnexpectedResponseException'].includes(e.name)) {
      throw new UnsupportedError('PDF 文件损坏或内容不完整，请重新导出后上传');
    }
    throw e;
  } finally {
    try { await loadingTask.destroy(); } catch (_e) { /* best effort */ }
  }
}

const OCR_KINDS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif', 'heic']);

/**
 * 解析文件为纯文本。
 * @returns {{ text: string, kind: string }}
 * @throws OcrNeededError（图片/扫描件PDF）| UnsupportedError（不认识的格式）
 */
async function parseFile(filename, buf) {
  const ext = extOf(filename);
  if (['txt', 'md', 'markdown', 'csv', 'json', 'log', 'text', 'tsv'].includes(ext)) {
    return { text: buf.toString('utf8').trim(), kind: ext };
  }
  if (ext === 'docx') return { text: parseDocx(buf), kind: 'docx' };
  if (ext === 'pptx') return { text: parsePptx(buf), kind: 'pptx' };
  if (ext === 'xlsx') return { text: parseXlsx(buf), kind: 'xlsx' };
  if (ext === 'pdf') {
    const t = await parsePdfText(buf);
    if (t.replace(/\s/g, '').length < 20) throw new OcrNeededError('这个 PDF 像是扫描件，需要 OCR 才能读出文字');
    return { text: t, kind: 'pdf' };
  }
  if (OCR_KINDS.has(ext)) throw new OcrNeededError('图片需要 OCR 才能提取文字');
  if (['doc', 'xls', 'ppt'].includes(ext)) throw new UnsupportedError('暂不支持旧版 .' + ext + '，请另存为 .' + ext + 'x 后上传');
  throw new UnsupportedError('暂不支持的文件类型：.' + ext);
}

module.exports = {
  parseFile,
  OcrNeededError,
  UnsupportedError,
  extOf,
  OCR_KINDS,
  _internals: { parsePdfText, normalizePdfPageText },
};
