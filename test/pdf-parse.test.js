'use strict';

const assert = require('assert/strict');
const { parseFile, _internals } = require('../server/parse');

function buildSinglePagePdf(contentStream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

(async () => {
  // 基线：普通 literal string PDF。
  const literal = buildSinglePagePdf('BT /F1 18 Tf 72 720 Td (General parser text extraction baseline) Tj ET');
  const literalParsed = await parseFile('literal.pdf', literal);
  assert.equal(literalParsed.kind, 'pdf');
  assert.match(literalParsed.text, /General parser text/);

  // 泛化失败类：十六进制字符串是合法 PDF 文本，旧手写 Tj 正则只识别 (...)，会错误判成扫描件。
  const hex = buildSinglePagePdf('BT /F1 18 Tf 72 720 Td <48656C6C6F2050444620576F726C6420666F72206B6E6F776C656467652062617365> Tj ET');
  const hexParsed = await parseFile('hex-text.pdf', hex);
  assert.match(hexParsed.text, /Hello PDF World for knowledge base/);

  // 反例：真正没有文字的 PDF 必须明确走 OCR，不得生成空知识文档。
  const blank = buildSinglePagePdf('q 1 0 0 1 0 0 cm Q');
  await assert.rejects(
    () => parseFile('scan.pdf', blank),
    e => e && e.code === 'OCR_NEEDED' && /OCR/.test(e.message),
  );

  // 破损文件不是扫描件，不得错误提示配置 OCR。
  await assert.rejects(
    () => parseFile('broken.pdf', Buffer.from('%PDF-1.4\nbroken')),
    e => e && e.code === 'UNSUPPORTED' && /损坏|不完整/.test(e.message),
  );

  // CJK item 边界不会人为插入空格，保证中文检索分词不被破坏。
  assert.equal(
    _internals.normalizePdfPageText([{ str: '澳洲', hasEOL: false }, { str: '储能', hasEOL: true }]),
    '澳洲储能',
  );

  console.log('✓ PDF.js 解析普通/十六进制文本 PDF；扫描件、损坏文件与 CJK 规范化分流正确');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
