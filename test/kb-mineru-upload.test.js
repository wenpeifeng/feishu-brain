'use strict';

process.env.USE_MOCK = 'true';
process.env.DEFAULT_LLM_KEY = '';
process.env.OCR_API_URL = '';
process.env.OCR_API_KEY = '';
process.env.MINERU_ENABLED = 'true';
process.env.MINERU_API_URL = 'http://127.0.0.1:8000';
process.env.MINERU_BACKEND = 'hybrid-engine';
process.env.MINERU_EFFORT = 'medium';
process.env.MINERU_TIMEOUT_MS = '10000';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { handleRequest } = require('../server/router');
const { createSession, removeSession } = require('../server/session');
const { listDocs, getDoc } = require('../server/kb');

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
  const originalFetch = global.fetch;
  const openId = `mineru-upload-api-${process.pid}`;
  const token = createSession({
    openId,
    name: 'MinerU Upload Test',
    userAccessToken: 'test-user-token',
    refreshToken: 'test-refresh-token',
    expireAt: Date.now() + 60 * 60 * 1000,
  });
  const kbFile = path.join(__dirname, '..', 'data', 'kb', crypto.createHash('md5').update(openId).digest('hex') + '.json');
  try {
    global.fetch = async url => {
      assert.equal(url, 'http://127.0.0.1:8000/file_parse');
      return new Response(JSON.stringify({
        backend: 'hybrid-engine',
        version: '3.4.4',
        results: {
          report: { md_content: '# 项目状态\n\n| 模块 | 进度 |\n| --- | --- |\n| 本地解析 | 100% |' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const sourcePdf = buildSinglePagePdf('q 1 0 0 1 0 0 cm Q');
    const mineruResult = await request(token, { filename: 'structured.pdf', dataBase64: sourcePdf.toString('base64') });
    assert.equal(mineruResult.status, 200);
    assert.equal(mineruResult.body.kind, 'mineru-md');
    assert.equal(mineruResult.body.parser, 'mineru-3.4.4');
    assert.equal(mineruResult.body.degraded, false);
    const stored = getDoc(openId, listDocs(openId)[0].id);
    assert.match(stored.content, /\| 模块 \| 进度 \|/, 'MinerU Markdown 表格必须原样进入知识库');

    global.fetch = async () => { throw new TypeError('local service stopped'); };
    const textPdf = buildSinglePagePdf('BT /F1 18 Tf 72 720 Td <48656C6C6F205044462066616C6C6261636B2074657874207769746820656E6F7567682063686172616374657273> Tj ET');
    const degraded = await request(token, { filename: 'text-fallback.pdf', dataBase64: textPdf.toString('base64') });
    assert.equal(degraded.status, 200);
    assert.equal(degraded.body.parser, 'pdfjs');
    assert.equal(degraded.body.degraded, true);
    assert.match(degraded.body.warning, /已降级为本地文本解析/);

    const scanFailure = await request(token, { filename: 'scan-no-fallback.pdf', dataBase64: sourcePdf.toString('base64') });
    assert.equal(scanFailure.status, 503);
    assert.equal(scanFailure.body.needOcr, false);
    assert.match(scanFailure.body.error, /MinerU.*无法继续降级/);

    console.log('✓ PDF 优先走本机 MinerU；文本 PDF 可观测降级；扫描件不伪装成普通 OCR 配置问题');
  } finally {
    global.fetch = originalFetch;
    removeSession(token);
    fs.rmSync(kbFile, { force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
