require('../server/env');
const assert = require('assert');
const { chunkText, cosine, tokenize, lexicalScore, rankDocs, embed } = require('../server/semantic');

// ── chunkText ──────────────────────────────────────────────────────────────
// 短文本 → 单块
{
  const c = chunkText('短短一句话');
  assert.equal(c.length, 1);
  assert.equal(c[0].offset, 0);
  assert.equal(c[0].text, '短短一句话');
}
// 长文本 → 多块，带偏移，覆盖全文，段落非空
{
  const long = Array.from({ length: 30 }, (_, i) => `这是第${i}段内容，讲述了一些事情。`).join('\n');
  const cs = chunkText(long, { size: 120, overlap: 30 });
  assert.ok(cs.length > 1, '长文应切多块');
  assert.ok(cs.every(c => c.text.length > 0), '无空块');
  assert.ok(cs.every((c, i) => i === 0 || c.offset > cs[i - 1].offset), 'offset 递增');
  // 覆盖：最后一块应触及结尾附近
  assert.ok(cs[cs.length - 1].offset + cs[cs.length - 1].text.length >= long.length - 5, '覆盖到结尾');
}
// 空/异常输入不炸
assert.deepEqual(chunkText(''), []);
assert.deepEqual(chunkText(null), []);
// 重叠不导致死循环（极端参数）
{
  const cs = chunkText('a'.repeat(1000), { size: 100, overlap: 99 });
  assert.ok(cs.length > 0 && cs.length < 200, '不死循环且块数合理');
}

// ── cosine ─────────────────────────────────────────────────────────────────
assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, '同向=1');
assert.ok(Math.abs(cosine([1, 0], [0, 1]) - 0) < 1e-9, '正交=0');
assert.equal(cosine([1, 0], null), 0, '空→0');
assert.equal(cosine([1, 0], [1, 0, 0]), 0, '维度不等→0');

// ── tokenize / lexicalScore ─────────────────────────────────────────────────
{
  const t = tokenize('电价 ABC123');
  assert.ok(t.includes('电价'), '含 bigram 电价');
  assert.ok(t.includes('电') && t.includes('价'), '含 unigram');
  assert.ok(t.includes('abc123'), '拉丁数字小写整取');
}
{
  // 含"辅助服务"的段落分应高于无关段落
  const q = tokenize('辅助服务市场');
  const hi = lexicalScore(q, '辅助服务市场是以调频备用为标的的市场');
  const lo = lexicalScore(q, '今天天气很好我们去公园散步');
  assert.ok(hi > lo, '相关段落词法分更高');
  assert.equal(lexicalScore([], 'x'), 0, '空 query→0');
}

// ── rankDocs（词法路径，无 embedConfig）──────────────────────────────────────
(async () => {
  const docs = [
    { title: 'A', content: '第一段讲天气。\n\n第二段讲辅助服务市场是以调频备用为交易标的物的市场，非常重要。\n\n第三段讲午饭。' },
    { title: 'B', content: '完全无关的内容，讲述历史故事和人物传记。'.repeat(5) },
  ];
  const r = await rankDocs('辅助服务市场 调频', docs, { topChunks: 3, chunkSize: 60, chunkOverlap: 10 });
  assert.equal(r.method, 'lexical', '无 embedConfig 走词法');
  assert.ok(r.docs.length >= 1, '有命中文档');
  assert.equal(r.docs[0].title, 'A', '含关键词的 A 排第一');
  assert.ok(/辅助服务/.test(r.docs[0].content), '喂给LLM的是命中段落');
  assert.ok(r.docs[0]._anchorText && /辅助服务|调频/.test(r.docs[0]._anchorText), '锚点段落是最相关段');
  assert.ok(typeof r.docs[0]._score === 'number', '带分数');

  // 无正文 → method none，不丢文档
  const empty = await rankDocs('x', [{ title: 'C', content: '' }]);
  assert.equal(empty.method, 'none');

  // embed 抛错 → 自动降级词法（模拟坏 embedConfig）
  const degrade = await rankDocs('辅助服务', docs, {
    embedConfig: { url: 'http://127.0.0.1:9/none', model: 'x', apiKey: 'bad' },
    topChunks: 2, chunkSize: 60,
  });
  assert.equal(degrade.method, 'lexical', 'embed 失败→降级词法');
  assert.ok(degrade.docs.length >= 1, '降级后仍有结果');

  // 聊天按一个问答证据单元处理：匹配分只看命中问句，送判官/生成时必须保留长问句后的短答。
  const longQuestion = '澳储油需求'.repeat(60);
  const chat = await rankDocs('澳储油需求', [{
    title: '聊天命中', source: 'message', token: 'm1',
    matchText: longQuestion,
    afterTexts: ['最近需求增加约两成。'],
    content: `[命中消息] ${longQuestion}\n[后续回复1] 最近需求增加约两成。`,
  }], { topChunks: 3, chunkSize: 80, keepRatio: 0 });
  assert.equal(chat.docs.length, 1, '聊天候选不应被长文本切碎后丢掉回答');
  assert.ok(chat.docs[0].content.includes('增加约两成'), '聊天完整回答必须进入证据正文');
  assert.ok(chat.docs[0]._anchorText.includes('增加约两成'), '聊天判官锚点必须包含后续回答');

  // maxChunks 粗筛必须给每篇候选至少一次入场机会，不能被单篇长文档占满。
  const fair = await rankDocs('储油需求', [
    { title: '超长文档', content: Array.from({ length: 12 }, (_, i) => `储油需求 主段${i} ${'甲'.repeat(40)}`).join('\n\n') },
    { title: '短聊天', source: 'message', matchText: '最近澳储油需求吗', content: '[命中消息] 最近澳储油需求吗\n[后续回复1] 有，需求上涨。' },
    { title: '短文档', content: '储油需求正在上涨。' },
  ], { maxChunks: 3, topChunks: 3, chunkSize: 55, keepRatio: 0 });
  assert.ok(fair.docs.some(d => d.title === '短聊天'), '长文档不能在向量前挤掉聊天');
  assert.ok(fair.docs.some(d => d.title === '短文档'), '长文档不能在向量前挤掉短文档');

  // 显式 vectorFloor 必须是真闸门，不能在全部低分时偷偷保留最高的一个。
  const originalFetch = global.fetch;
  try {
    const nonce = Date.now().toString(36);
    let embedCall = 0;
    global.fetch = async (_url, init) => {
      const input = JSON.parse(init.body).input;
      embedCall++;
      return { ok: true, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: embedCall === 1 ? [1, 0] : [0, 1] })) }) };
    };
    const belowFloor = await rankDocs(`query-${nonce}`, [{ title: '低分候选', content: `evidence-${nonce}` }], {
      embedConfig: { url: 'https://embed.test', model: `test-${nonce}`, apiKey: 'x' },
      vectorFloor: 0.4,
      keepRatio: 0,
    });
    assert.equal(belowFloor.method, 'vector');
    assert.deepEqual(belowFloor.docs, [], '全部低于向量阈值时必须返回空');
  } finally {
    global.fetch = originalFetch;
  }

  // 同名 embedding 模型来自不同端点时不能共享向量缓存（可能是不同版本/向量空间）。
  try {
    const nonce = Date.now().toString(36) + '-endpoint';
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }; };
    await embed([nonce], { url: 'https://embed-a.test', model: 'same-name', apiKey: 'x' });
    await embed([nonce], { url: 'https://embed-b.test', model: 'same-name', apiKey: 'x' });
    assert.equal(calls, 2, '不同端点必须分别计算 embedding');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('✅ semantic.test.js 全部通过');
})().catch(e => { console.error('❌', e); process.exit(1); });
