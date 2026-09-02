'use strict';

/**
 * test/rag.test.js — TDD for server/rag.js (Task 6)
 *
 * Strategy: mock feishu.js and llm.js via require.cache injection
 * before requiring rag.js. This avoids real network calls.
 *
 * Event order under test:
 *   webSearch=false: references → token(s) → sources
 *   webSearch=true:  references → token(s) → sources (via askLLMGeneral)
 *   empty results:   references:[] → token("未找到")
 *   searchDocs error: references:[] → token(error message, no uncaught throw)
 *   no apiKey:       references → token(⚠️ 未配置) — no uncaught throw
 */

const path = require('path');
const Module = require('module');

// ── helpers ──────────────────────────────────────────────────────────────────

/** collect all events from the async generator */
async function collect(gen) {
  const events = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

const USER = { openId: 'u001', userAccessToken: 'tok-user' };
const HISTORY = [];
const BASE_CONFIG = { pageSize: 9, topK: 3, providerId: 'custom', model: 'm', baseUrl: 'http://x', apiKey: 'sk-test' };
const NO_KEY_CONFIG = { pageSize: 9, topK: 3, providerId: 'custom', model: 'm', baseUrl: 'http://x', apiKey: '' };

const FAKE_RESULTS = [
  { index: 1, title: '文档A', type: 'docx', token: 'tokA', url: 'https://feishu.cn/docx/tokA', owner: 'u1', editTime: '' },
  { index: 2, title: '文档B', type: 'sheet', token: 'tokB', url: 'https://feishu.cn/sheets/tokB', owner: 'u1', editTime: '' },
];
const FAKE_DOC_A = { title: '文档A', content: '正文A' };
const FAKE_DOC_B = { title: '文档B', content: '' }; // sheet → no content

// ── inject mocks into require.cache before rag.js is loaded ──────────────────

/**
 * Build a fresh mocked rag module with custom feishu/llm behavior.
 * Each call returns a brand-new module instance with the injected mocks.
 */
function loadRagWithMocks({ searchDocsMock, searchMessagesMock, fetchDocMock, askLLMStreamMock, askLLMGeneralMock, judgeRelevanceMock, verifyRelevanceMock }) {
  // Resolve absolute paths so require.cache keys match
  const feishuPath = require.resolve('../server/feishu');
  const llmPath    = require.resolve('../server/llm');
  const ragPath    = require.resolve('../server/rag');

  // Save originals
  const origFeishu = require.cache[feishuPath];
  const origLlm    = require.cache[llmPath];
  const origRag    = require.cache[ragPath];

  try {
    // Inject feishu mock
    require.cache[feishuPath] = {
      id: feishuPath, filename: feishuPath, loaded: true,
      exports: {
        searchDocs: searchDocsMock || (async () => FAKE_RESULTS),
        fetchDoc:   fetchDocMock   || (async (token, item) => item.type === 'docx' ? FAKE_DOC_A : FAKE_DOC_B),
        searchMessages: searchMessagesMock || (async () => []),
        enrichReferences: async (token, results) => results, // pass-through
        parseFeishuDocUrls: () => [], // 无粘贴链接
        findAnchorBlock: async () => '',
      },
    };

    // Inject llm mock
    require.cache[llmPath] = {
      id: llmPath, filename: llmPath, loaded: true,
      exports: {
        askLLMStream:   askLLMStreamMock   || (async function*() { yield { type: 'answer', text: '默认回答' }; }),
        askLLMGeneral:  askLLMGeneralMock  || (async function*() { yield { type: 'answer', text: '未找到相关文档' }; }),
        planSearchQuery: async (q) => ({ keywords: q, correctedQuestion: '', expansions: [], confidence: 0 }),
        classifyNeedsDoc: async () => true,
        clarifyQuestion: async () => '',
        condenseQuery: async q => q,
        expandQueries: async () => [],
        judgeRelevance: judgeRelevanceMock || (async (_q, items) => items.map(() => 3)),
        verifyRelevance: verifyRelevanceMock || (async (_q, items) => items.map(() => true)),
        detectConflict: async () => '',
      },
    };

    // Delete rag from cache so it re-requires with our mocks
    delete require.cache[ragPath];

    const { runRAGStream } = require('../server/rag');
    return runRAGStream;
  } finally {
    // Always restore originals (rag stays fresh each call; feishu/llm restored)
    if (origFeishu) require.cache[feishuPath] = origFeishu;
    else delete require.cache[feishuPath];

    if (origLlm) require.cache[llmPath] = origLlm;
    else delete require.cache[llmPath];

    // Re-delete rag so next loadRagWithMocks gets a fresh copy
    delete require.cache[require.resolve('../server/rag')];

    if (origRag) require.cache[require.resolve('../server/rag')] = origRag;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    failed++;
  }
}

async function runTests() {

  // ── Test 1: webSearch=false 事件顺序 references → token(s) → sources ────────
  await check('webSearch=false 事件顺序 references → tokens → sources', async () => {
    const tokens = [];
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async (userAccessToken, query, pageSize) => {
        if (userAccessToken !== USER.userAccessToken) throw new Error('wrong token');
        return FAKE_RESULTS;
      },
      fetchDocMock: async (userAccessToken, item) => {
        return item.type === 'docx' ? FAKE_DOC_A : FAKE_DOC_B;
      },
      askLLMStreamMock: async function*(q, docs, hist, provider) {
        yield { type: 'answer', text: '回答第一段' };
        yield { type: 'answer', text: '回答第二段' };
      },
    });

    // 忽略 status 进度事件；新顺序：tokens → references → sources
    const events = (await collect(runRAGStream(USER, '问题', HISTORY, false, BASE_CONFIG)))
      .filter(e => e.type !== 'status');

    const types = events.map(e => e.type);
    const tokenEvs = events.filter(e => e.type === 'token');
    const refEv = events.find(e => e.type === 'references');
    const last = events[events.length - 1];

    if (tokenEvs.length < 2) throw new Error(`expected ≥2 token events, got ${tokenEvs.length}`);
    if (!refEv || !Array.isArray(refEv.references)) throw new Error('missing references event');
    if (last.type !== 'sources' || !Array.isArray(last.sources)) throw new Error(`last event type=${last.type}`);

    // token 必须在 references 之前（先出答案，再出参考资料）
    if (types.indexOf('token') > types.indexOf('references')) throw new Error('tokens should stream before references');

    const srcTitles = last.sources.map(s => s.title);
    if (!srcTitles.includes('文档A')) throw new Error('sources missing 文档A');
    if (srcTitles.includes('文档B')) throw new Error('sources should not include 文档B (no content)');
  });

  // ── Test 2: searchDocs 返回空 → references:[] + "未找到" token ──────────────
  await check('searchDocs 返回空数组 → references:[] + 未找到 token', async () => {
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => [],
    });

    const events = (await collect(runRAGStream(USER, '找不到', HISTORY, false, BASE_CONFIG)))
      .filter(e => e.type !== 'status');

    const refEv = events.find(e => e.type === 'references');
    if (!refEv) throw new Error('missing references event');
    if (refEv.references.length !== 0) throw new Error('expected empty references');

    const tokenEvs = events.filter(e => e.type === 'token');
    if (tokenEvs.length === 0) throw new Error('no token event emitted');
    const combined = tokenEvs.map(e => e.delta).join('');
    if (!combined.includes('未找到')) throw new Error(`token text "${combined}" doesn't include 未找到`);
  });

  // ── Test 3: searchDocs 抛错 → 不让 runRAGStream 抛未捕获异常 ────────────────
  await check('searchDocs 抛错 → 转为 token 提示，不抛未捕获异常', async () => {
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => { throw new Error('飞书 502 Bad Gateway'); },
    });

    let threw = false;
    let events;
    try {
      events = await collect(runRAGStream(USER, '问题', HISTORY, false, BASE_CONFIG));
    } catch (err) {
      threw = true;
    }

    if (threw) throw new Error('runRAGStream should NOT throw when searchDocs fails');

    // Should have emitted references:[]
    const refEv = events.find(e => e.type === 'references');
    if (!refEv) throw new Error('no references event');
    if (refEv.references.length !== 0) throw new Error('references should be empty on error');

    // Should have emitted at least one token with error info
    const tokenEvs = events.filter(e => e.type === 'token');
    if (tokenEvs.length === 0) throw new Error('no error token emitted');
    const combined = tokenEvs.map(e => e.delta).join('');
    if (!combined.includes('搜索文档失败')) {
      throw new Error(`error token "${combined}" missing expected prefix "搜索文档失败"`);
    }
  });

  // ── Test 4: webSearch=true → 走统一主管道，askLLMStream 带 webSearch=true ──────
  // （不再有独立的 askLLMGeneral 分支：联网也经过检索/法官，参考只留相关文档）
  await check('webSearch=true 走统一管道(askLLMStream带联网)', async () => {
    let streamCalled = false;
    let streamWebSearch = null;

    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => FAKE_RESULTS,
      fetchDocMock: async (userAccessToken, item) => item.type === 'docx' ? FAKE_DOC_A : FAKE_DOC_B,
      askLLMStreamMock: async function* (question, docs, history, provider, webSearch) {
        streamCalled = true;
        streamWebSearch = webSearch;
        yield { type: 'answer', text: '联网回答' };
      },
      askLLMGeneralMock: async function* () { throw new Error('askLLMGeneral 不应再被调用（已统一到主管道）'); },
    });

    const events = await collect(runRAGStream(USER, '联网问题', HISTORY, true, BASE_CONFIG));

    if (!streamCalled) throw new Error('askLLMStream 应被调用（统一管道）');
    if (streamWebSearch !== true) throw new Error('askLLMStream 应收到 webSearch=true');
    if (events.findIndex(e => e.type === 'references') < 0) throw new Error('no references event');
    const combined = events.filter(e => e.type === 'token').map(e => e.delta).join('');
    if (!combined.includes('联网回答')) throw new Error(`token "${combined}" 不含 联网回答`);
  });

  // ── Test 5: apiKey 缺失 → 转为 ⚠️ token，不崩溃 ─────────────────────────────
  await check('apiKey 缺失 → 转为 ⚠️ token 而不崩溃', async () => {
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => FAKE_RESULTS,
      fetchDocMock: async (userAccessToken, item) => item.type === 'docx' ? FAKE_DOC_A : FAKE_DOC_B,
      askLLMStreamMock: async function*() {
        throw new Error('未配置 LLM API Key');
      },
    });

    let threw = false;
    let events;
    try {
      events = await collect(runRAGStream(USER, '问题', HISTORY, false, NO_KEY_CONFIG));
    } catch (err) {
      threw = true;
    }

    if (threw) throw new Error('runRAGStream should NOT throw on missing API key');

    const tokenEvs = events.filter(e => e.type === 'token');
    const combined = tokenEvs.map(e => e.delta).join('');
    if (!combined.includes('API Key')) throw new Error('token missing API Key hint: '+combined);
  });

  // ── Test 6: userAccessToken 安全：fetchDoc 收到正确的 userAccessToken ─────────
  await check('fetchDoc 只用 user.userAccessToken（不用 openId）', async () => {
    const seen = [];
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async (uaToken) => { seen.push({ fn: 'search', uaToken }); return FAKE_RESULTS; },
      fetchDocMock: async (uaToken, item) => { seen.push({ fn: 'fetch', uaToken }); return { title: item.title, content: 'x' }; },
      askLLMStreamMock: async function*() { yield { type: 'answer', text: '答' }; },
    });

    await collect(runRAGStream(USER, 'q', HISTORY, false, BASE_CONFIG));

    for (const call of seen) {
      if (call.uaToken !== USER.userAccessToken) {
        throw new Error(`${call.fn} got wrong token: ${call.uaToken}`);
      }
    }
  });

  // ── Test 7: 已带正文的聊天不占用远程文档 readPool ────────────────────────────
  await check('聊天候选不会占满 readPool 并挤掉文档', async () => {
    const fetched = [];
    const messages = Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      title: `聊天${i + 1}`,
      type: 'message',
      token: `msg${i + 1}`,
      source: 'message',
      matchText: '澳储油需求',
      afterTexts: ['需求上涨约两成'],
      content: '[命中消息] 澳储油需求\n[后续回复1] 需求上涨约两成',
      url: '', owner: '', editTime: '',
    }));
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => [{ index: 1, title: '储油文档', type: 'docx', token: 'doc1', url: 'https://feishu.cn/docx/doc1' }],
      searchMessagesMock: async () => messages,
      fetchDocMock: async (_token, item) => { fetched.push(item.token); return { title: item.title, content: '澳储油需求上涨约一成' }; },
      askLLMStreamMock: async function* () { yield { type: 'answer', text: '回答' }; },
    });

    await collect(runRAGStream(USER, '澳储油需求', HISTORY, false, { ...BASE_CONFIG, readPool: 1, retrievalOnly: true }));
    if (!fetched.includes('doc1')) throw new Error(`文档在精排前被聊天挤掉，实际读取：${JSON.stringify(fetched)}`);
  });

  // ── Test 8: 生成上下文、参考和置信度必须使用同一组 Top K ────────────────
  await check('Top K 同时约束生成上下文、参考和置信度', async () => {
    const messages = Array.from({ length: 4 }, (_, i) => ({
      index: i + 1,
      title: `相关聊天${i + 1}`,
      type: 'message', token: `topk-msg-${i + 1}`, source: 'message',
      matchText: `澳储需求进展 ${i + 1}`,
      afterTexts: [`第${i + 1}条有效回答`],
      content: `[命中消息] 澳储需求进展 ${i + 1}\n[后续回复1] 第${i + 1}条有效回答`,
      url: '', owner: '', editTime: '',
    }));
    let generatedDocs = null;
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => [],
      searchMessagesMock: async () => messages,
      askLLMStreamMock: async function* (_q, docs) {
        generatedDocs = docs;
        yield { type: 'answer', text: '回答 [1]' };
      },
    });

    const events = await collect(runRAGStream(USER, '澳储需求进展', HISTORY, false, {
      ...BASE_CONFIG, topK: 2, adaptiveEvidence: false, adversarial: false,
    }));
    const refs = events.find(e => e.type === 'references');
    const conf = events.find(e => e.type === 'confidence');
    if (!generatedDocs || generatedDocs.length !== 2) throw new Error(`生成实际收到 ${generatedDocs && generatedDocs.length} 条，期望 2 条`);
    if (!refs || refs.references.length !== 2) throw new Error(`参考实际 ${refs && refs.references.length} 条，期望 2 条`);
    if (!conf || conf.confidence.sources !== 2) throw new Error(`置信度来源数 ${conf && conf.confidence.sources}，期望 2`);
  });

  // ── Test 9: 命中聊天问句时，后续回答必须进入法官并成为证据 ────────────────
  await check('澳储问句命中后，后续聊天回答进入法官与最终证据', async () => {
    let judged = null;
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => [],
      searchMessagesMock: async () => [{
        index: 1, title: '澳储还有需求吗，最近', type: 'message', token: 'au-chat-1', source: 'message',
        matchText: '澳储还有需求吗，最近', afterTexts: ['第二期部分需求已经启动，先借调资源。'],
        content: '[命中消息] 澳储还有需求吗，最近\n[后续回复1] 第二期部分需求已经启动，先借调资源。', url: 'https://feishu.example/chat/1',
      }],
      judgeRelevanceMock: async (_q, items) => { judged = items; return items.map(() => 3); },
    });
    const events = await collect(runRAGStream(USER, '澳储还有需求吗？', HISTORY, false, { ...BASE_CONFIG, retrievalOnly: true, adversarial: false }));
    const refs = events.find(e => e.type === 'references');
    if (!judged || !judged[0] || judged[0].afterTexts[0].indexOf('第二期') < 0) throw new Error('法官没有看到问句后的回答');
    if (!refs || refs.references.length !== 1 || refs.references[0].token !== 'au-chat-1') throw new Error('聊天回答未进入最终证据');
  });

  await check('法官同分时按证据质量排序，而不是按字面向量排序', async () => {
    const messages = [
      { index: 1, title: '字面相似但只提供局部线索', type: 'message', token: 'vague', source: 'message', matchText: '澳储还有需求吗', afterTexts: ['昨天的需求说明好像不涉及澳储'], content: '[命中消息] 澳储还有需求吗\n[后续回复1] 昨天的需求说明好像不涉及澳储', url: '' },
      { index: 2, title: '直接回答二期需求', type: 'message', token: 'direct', source: 'message', matchText: '澳储项目进展', afterTexts: ['第二期部分需求已经启动'], content: '[命中消息] 澳储项目进展\n[后续回复1] 第二期部分需求已经启动', url: '' },
    ];
    const judge = async (_q, items) => { const s = items.map(() => 2); Object.defineProperty(s, 'ranks', { value: items.map(x => (x.afterTexts || []).join('').includes('已经启动') ? 60 : 95) }); return s; };
    const runRAGStream = loadRagWithMocks({ searchDocsMock: async () => [], searchMessagesMock: async () => messages, judgeRelevanceMock: judge });
    const events = await collect(runRAGStream(USER, '澳储还有需求吗？', HISTORY, false, { ...BASE_CONFIG, retrievalOnly: true, adversarial: false }));
    const refs = events.find(e => e.type === 'references');
    if (!refs || refs.references[0].token !== 'direct') throw new Error('直接答案没有排在字面相似线索之前');
  });

  await check('明确项目状态不因法官一次1分抖动被淘汰', async () => {
    const messages = [{
      index: 1, title: '澳储第二期需求已经启动', type: 'message', token: 'direct-state', source: 'message',
      matchText: '澳储第二期需求已经启动', afterTexts: [],
      content: '[命中消息] 澳储第二期需求已经启动，正在安排开发。', url: '',
    }];
    const judge = async (_q, items) => {
      const scores = items.map(() => 1);
      Object.defineProperty(scores, 'ranks', { value: items.map(() => 30) });
      return scores;
    };
    const runRAGStream = loadRagWithMocks({ searchDocsMock: async () => [], searchMessagesMock: async () => messages, judgeRelevanceMock: judge });
    const events = await collect(runRAGStream(USER, '澳储还有需求吗？', HISTORY, false, { ...BASE_CONFIG, retrievalOnly: true, adversarial: false }));
    const refs = events.find(e => e.type === 'references');
    if (!refs || refs.references[0].token !== 'direct-state') throw new Error('明确状态证据被法官抖动淘汰');
  });

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('rag ok');
}

runTests().catch(err => { console.error('FAIL:', err); process.exit(1); });
