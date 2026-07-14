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
const BASE_CONFIG = { pageSize: 9, topK: 3, providerId: 'custom', custom: { model: 'm', baseUrl: 'http://x', apiKey: 'sk-test' } };
const NO_KEY_CONFIG = { pageSize: 9, topK: 3, providerId: 'custom', custom: { model: 'm', baseUrl: 'http://x', apiKey: '' } };

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
function loadRagWithMocks({ searchDocsMock, fetchDocMock, askLLMStreamMock, askLLMGeneralMock }) {
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
        enrichReferences: async (token, results) => results, // pass-through
      },
    };

    // Inject llm mock
    require.cache[llmPath] = {
      id: llmPath, filename: llmPath, loaded: true,
      exports: {
        askLLMStream:   askLLMStreamMock   || (async function*() { yield '默认回答'; }),
        askLLMGeneral:  askLLMGeneralMock  || (async function*() { yield '默认联网'; }),
        extractKeywords: async (q) => q, // pass-through
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
        yield '回答第一段';
        yield '回答第二段';
      },
    });

    const events = await collect(runRAGStream(USER, '问题', HISTORY, false, BASE_CONFIG));

    // Must have at least 3 events: references, ≥1 token, sources
    if (events.length < 3) throw new Error(`too few events: ${events.length}`);

    // First event: references
    if (events[0].type !== 'references') throw new Error(`first event type=${events[0].type}`);
    if (!Array.isArray(events[0].references)) throw new Error('references not array');

    // Last event: sources
    const last = events[events.length - 1];
    if (last.type !== 'sources') throw new Error(`last event type=${last.type}`);
    if (!Array.isArray(last.sources)) throw new Error('sources not array');

    // Middle events: all tokens
    const middle = events.slice(1, -1);
    for (const ev of middle) {
      if (ev.type !== 'token') throw new Error(`middle event type=${ev.type}`);
    }

    // At least 2 token events (matching our mock yields)
    if (middle.length < 2) throw new Error(`expected ≥2 token events, got ${middle.length}`);

    // sources only contains docs with content
    const srcTitles = last.sources.map(s => s.title);
    if (!srcTitles.includes('文档A')) throw new Error('sources missing 文档A');
    if (srcTitles.includes('文档B')) throw new Error('sources should not include 文档B (no content)');
  });

  // ── Test 2: searchDocs 返回空 → references:[] + "未找到" token ──────────────
  await check('searchDocs 返回空数组 → references:[] + 未找到 token', async () => {
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => [],
    });

    const events = await collect(runRAGStream(USER, '找不到', HISTORY, false, BASE_CONFIG));

    if (events[0].type !== 'references') throw new Error(`first type=${events[0].type}`);
    if (events[0].references.length !== 0) throw new Error('expected empty references');

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
    if (!combined.includes('搜索飞书文档失败')) {
      throw new Error(`error token "${combined}" missing expected prefix "搜索飞书文档失败"`);
    }
  });

  // ── Test 4: webSearch=true → 走 askLLMGeneral 分支 ───────────────────────────
  await check('webSearch=true 走 askLLMGeneral 分支', async () => {
    let streamCalled = false;
    let generalCalled = false;

    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async () => FAKE_RESULTS,
      fetchDocMock: async (userAccessToken, item) => item.type === 'docx' ? FAKE_DOC_A : FAKE_DOC_B,
      askLLMStreamMock: async function*() {
        streamCalled = true;
        yield '文档问答';
      },
      askLLMGeneralMock: async function*(question, history, provider, webSearch) {
        generalCalled = true;
        if (!webSearch) throw new Error('webSearch should be true');
        yield '联网回答';
      },
    });

    const events = await collect(runRAGStream(USER, '联网问题', HISTORY, true, BASE_CONFIG));

    if (streamCalled) throw new Error('askLLMStream should NOT be called for webSearch=true');
    if (!generalCalled) throw new Error('askLLMGeneral should be called for webSearch=true');

    // references must come before tokens
    const refIdx = events.findIndex(e => e.type === 'references');
    const firstTokenIdx = events.findIndex(e => e.type === 'token');
    if (refIdx < 0) throw new Error('no references event');
    if (firstTokenIdx >= 0 && refIdx > firstTokenIdx) throw new Error('references must come before tokens');

    const tokenEvs = events.filter(e => e.type === 'token');
    if (tokenEvs.length === 0) throw new Error('no token events');
    const combined = tokenEvs.map(e => e.delta).join('');
    if (!combined.includes('联网回答')) throw new Error(`token "${combined}" doesn't include 联网回答`);
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
    if (!combined.includes('未配置')) throw new Error(`token "${combined}" missing 未配置`);
  });

  // ── Test 6: userAccessToken 安全：fetchDoc 收到正确的 userAccessToken ─────────
  await check('fetchDoc 只用 user.userAccessToken（不用 openId）', async () => {
    const seen = [];
    const runRAGStream = loadRagWithMocks({
      searchDocsMock: async (uaToken) => { seen.push({ fn: 'search', uaToken }); return FAKE_RESULTS; },
      fetchDocMock: async (uaToken, item) => { seen.push({ fn: 'fetch', uaToken }); return { title: item.title, content: 'x' }; },
      askLLMStreamMock: async function*() { yield '答'; },
    });

    await collect(runRAGStream(USER, 'q', HISTORY, false, BASE_CONFIG));

    for (const call of seen) {
      if (call.uaToken !== USER.userAccessToken) {
        throw new Error(`${call.fn} got wrong token: ${call.uaToken}`);
      }
    }
  });

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('rag ok');
}

runTests().catch(err => { console.error('FAIL:', err); process.exit(1); });
