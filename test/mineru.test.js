'use strict';

const assert = require('assert/strict');

process.env.MINERU_ENABLED = 'true';
process.env.MINERU_API_URL = 'http://127.0.0.1:8000';
process.env.MINERU_BACKEND = 'hybrid-engine';
process.env.MINERU_EFFORT = 'medium';
process.env.MINERU_TIMEOUT_MS = '10000';

const mineru = require('../server/mineru');

(async () => {
  const originalFetch = global.fetch;
  try {
    assert.equal(mineru.config().enabled, true);
    assert.equal(mineru.config().baseUrl, 'http://127.0.0.1:8000');
    assert.throws(
      () => mineru._internals.normalizeBaseUrl('http://mineru.net'),
      e => e && e.code === 'MINERU_CONFIG' && /禁止文件意外出网/.test(e.message),
      '默认必须拒绝公网 MinerU 地址',
    );

    let captured;
    global.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        backend: 'hybrid-engine',
        version: '3.4.4',
        results: {
          document: { md_content: '# 标题\n\n| 字段 | 状态 |\n| --- | --- |\n| 解析 | 完成 |' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const parsed = await mineru.parseToMarkdown('../sample.pdf', Buffer.from('%PDF-local-fixture'));
    assert.equal(captured.url, 'http://127.0.0.1:8000/file_parse');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.body.get('backend'), 'hybrid-engine');
    assert.equal(captured.options.body.get('effort'), 'medium');
    assert.equal(captured.options.body.get('return_md'), 'true');
    assert.equal(captured.options.body.get('response_format_zip'), 'false');
    assert.equal(captured.options.body.get('files').name, 'sample.pdf', '不能把客户端路径传给 MinerU');
    assert.match(parsed.text, /\| 字段 \| 状态 \|/);
    assert.equal(parsed.kind, 'mineru-md');
    assert.equal(parsed.parser, 'mineru-3.4.4');

    global.fetch = async () => new Response(JSON.stringify({
      backend: 'hybrid-engine',
      version: '3.4.4',
      results: { document: { md_content: '' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    await assert.rejects(
      () => mineru.parseToMarkdown('empty.pdf', Buffer.from('%PDF-empty')),
      e => e && e.code === 'MINERU_EMPTY',
    );

    console.log('✓ MinerU 本机地址限制、multipart 参数、Markdown 响应和空结果保护通过');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
