'use strict';

process.env.USE_MOCK = 'true';
// 上传解析集成测试只验证 PDF → 文本 → 本地关键词索引。
// 显式屏蔽开发机 .env 的默认向量 key，避免单测意外访问外部 embedding 服务。
process.env.DEFAULT_LLM_KEY = '';
process.env.OCR_API_URL = '';
process.env.OCR_API_KEY = '';
process.env.MINERU_ENABLED = '';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { handleRequest } = require('../server/router');
const { createSession, removeSession } = require('../server/session');

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
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += String(offset).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function request(token, body) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = {
      method: 'POST',
      url: '/api/kb/upload',
      headers: { host: 'localhost', authorization: `Bearer ${token}` },
      on(event, cb) {
        if (event === 'data') cb(data);
        if (event === 'end') cb();
      },
    };
    const res = {
      status: 0,
      raw: '',
      setHeader() {},
      writeHead(status) { this.status = status; },
      write(chunk) { this.raw += String(chunk || ''); },
      end(chunk) {
        this.raw += String(chunk || '');
        this.body = JSON.parse(this.raw);
        resolve(this);
      },
    };
    handleRequest(req, res);
  });
}

(async () => {
  const openId = `pdf-upload-api-${process.pid}`;
  const token = createSession({
    openId,
    name: 'PDF Upload Test',
    userAccessToken: 'test-user-token',
    refreshToken: 'test-refresh-token',
    expireAt: Date.now() + 60 * 60 * 1000,
  });
  const kbFile = path.join(__dirname, '..', 'data', 'kb', crypto.createHash('md5').update(openId).digest('hex') + '.json');
  try {
    const validPdf = buildSinglePagePdf('BT /F1 18 Tf 72 720 Td <48656C6C6F205044462075706C6F616420696E746567726174696F6E2074657374> Tj ET');
    const valid = await request(token, { filename: 'hex-text.pdf', dataBase64: validPdf.toString('base64') });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.ok, true);
    assert.equal(valid.body.kind, 'pdf');
    assert.ok(valid.body.chars >= 20);

    const blankPdf = buildSinglePagePdf('q 1 0 0 1 0 0 cm Q');
    const blank = await request(token, { filename: 'scan.pdf', dataBase64: blankPdf.toString('base64') });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.ok, false);
    assert.equal(blank.body.needOcr, true);
    assert.match(blank.body.error, /OCR/);

    const broken = await request(token, { filename: 'broken.pdf', dataBase64: Buffer.from('%PDF broken').toString('base64') });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.needOcr, false);
    assert.match(broken.body.error, /损坏|不完整/);

    console.log('✓ PDF 上传 API：文本入库、扫描件 OCR 分流、损坏文件错误码与文案通过');
  } finally {
    removeSession(token);
    fs.rmSync(kbFile, { force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
