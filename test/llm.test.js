'use strict';

/**
 * Test file for server/llm.js - Task 5: Streaming LLM + Web Search
 * Uses stub global.fetch to avoid real network calls.
 * Tests askLLMStream and askLLMGeneral exports.
 */

const assert = require('assert');
const { askLLMStream, askLLMGeneral, judgeRelevance, verifyRelevance, buildPrompt, planSearchQuery } = require('../server/llm');

// --- Helpers ---

const encoder = new TextEncoder();

function test_buildPrompt_exposes_source_date_for_freshness() {
  const prompt = buildPrompt('还有需求吗', [{
    title: '澳洲光储组周报_2026/07/15',
    content: 'PRD计划下周一评审',
  }]);
  assert.ok(prompt.includes('资料时间：2026/07/15'), '标题日期应进入模型上下文');
  assert.ok(prompt.includes('PRD计划下周一'));
  assert.ok(prompt.includes('按资料时间即2026-07-20'), '历史相对日期应确定性换算成绝对日期');
  assert.ok(prompt.includes('原计划于2026-07-20'), '已过期计划应被明确标成历史计划');
  console.log('✓ test_buildPrompt_exposes_source_date_for_freshness');
}

async function test_query_plan_keeps_generic_high_confidence_correction() {
  const originalFetch = global.fetch;
  const question = '云校流水线失败-' + Date.now();
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      keywords: '云效 流水线 失败', correctedQuestion: question.replace('云校', '云效'), expansions: ['云效流水线'], confidence: 0.96,
    }) } }] }) });
    const plan = await planSearchQuery(question, PROVIDER);
    assert.ok(plan.correctedQuestion.includes('云效'));
    assert.deepEqual(plan.expansions, ['云效流水线']);
    assert.equal(plan.confidence, 0.96);
    console.log('✓ test_query_plan_keeps_generic_high_confidence_correction');
  } finally { global.fetch = originalFetch; }
}

/**
 * Build a mock fetch response whose body is an async-iterable
 * yielding SSE chunks (Uint8Array) that can be read via getReader().
 *
 * chunks: array of strings like 'data: {...}\n\n'
 */
function makeMockResponse(chunks, status = 200) {
  // async generator over encoded chunks
  async function* gen() {
    for (const chunk of chunks) {
      yield encoder.encode(chunk);
    }
  }

  const iterable = gen();

  // Provide getReader() so implementation can use reader = body.getReader()
  const body = {
    getReader() {
      return {
        async read() {
          const result = await iterable.next();
          if (result.done) return { done: true, value: undefined };
          return { done: false, value: result.value };
        },
        releaseLock() {},
      };
    },
    // Also support for-await-of (Symbol.asyncIterator)
    [Symbol.asyncIterator]() {
      return iterable;
    },
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    body,
  };
}

/**
 * Build SSE data lines for a sequence of deltas.
 * Each entry: { content?, reasoning_content? }
 */
function sseChunks(deltas, model = 'test-model') {
  const lines = deltas.map(d => {
    const obj = {
      choices: [{ delta: d }],
      model,
    };
    return `data: ${JSON.stringify(obj)}\n\n`;
  });
  lines.push('data: [DONE]\n\n');
  return lines;
}

const PROVIDER = {
  id: 'test',
  name: 'Test Provider',
  model: 'test-model',
  baseUrl: 'https://api.test.com/v1',
  apiKey: 'sk-test-key',
};

const PROVIDER_NO_KEY = { ...PROVIDER, apiKey: '' };

// -------------------------
// Test 1: askLLMStream yields typed answer/reasoning deltas
// -------------------------
async function test_askLLMStream_yields_content_deltas() {
  const originalFetch = global.fetch;
  try {
    test_buildPrompt_exposes_source_date_for_freshness();
    await test_query_plan_keeps_generic_high_confidence_correction();
    const chunks = sseChunks([
      { content: '你' },
      { reasoning_content: '思考中...' },
      { content: '好' },
      { reasoning_content: '推理...' },
      { content: '！' },
    ]);

    global.fetch = async () => makeMockResponse(chunks);

    const docs = [{ title: '测试文档', content: '内容' }];
    const history = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }];

    const results = [];
    for await (const delta of askLLMStream('问题', docs, history, PROVIDER)) {
      results.push(delta);
    }

    assert.deepEqual(results, [
      { type: 'answer', text: '你' },
      { type: 'reasoning', text: '思考中...' },
      { type: 'answer', text: '好' },
      { type: 'reasoning', text: '推理...' },
      { type: 'answer', text: '！' },
    ]);
    console.log('✓ test_askLLMStream_yields_content_deltas');
  } finally {
    global.fetch = originalFetch;
  }
}

// -------------------------
// Test 2: askLLMStream throws when apiKey is empty
// -------------------------
async function test_askLLMStream_throws_without_api_key() {
  try {
    const gen = askLLMStream('问题', [], [], PROVIDER_NO_KEY);
    await gen.next(); // trigger first iteration
    console.assert(false, 'Should have thrown');
  } catch (e) {
    console.assert(
      e.message === '未配置 LLM API Key',
      `Expected '未配置 LLM API Key', got '${e.message}'`
    );
    console.log('✓ test_askLLMStream_throws_without_api_key');
  }
}

// -------------------------
// Test 3: askLLMGeneral degrades gracefully when tools not supported
// -------------------------
async function test_askLLMGeneral_degrades_on_tools_error() {
  const originalFetch = global.fetch;
  try {
    let callCount = 0;
    const successChunks = sseChunks([{ content: '联网结果' }]);

    global.fetch = async (url, options) => {
      callCount++;
      const body = JSON.parse(options.body);
      if (callCount === 1) {
        // First call with tools - simulate error (tools not supported)
        throw new Error('tools not supported by this model');
      }
      // Second call without tools - succeed
      console.assert(!body.tools, 'Second call should NOT have tools');
      return makeMockResponse(successChunks);
    };

    const results = [];
    for await (const delta of askLLMGeneral('联网问题', [], PROVIDER, true)) {
      results.push(delta);
    }

    console.assert(callCount === 2, `Expected 2 fetch calls, got ${callCount}`);
    assert.deepEqual(results, [{ type: 'answer', text: '联网结果' }]);
    console.log('✓ test_askLLMGeneral_degrades_on_tools_error');
  } finally {
    global.fetch = originalFetch;
  }
}

// -------------------------
// Test 4: askLLMGeneral without webSearch does not include tools
// -------------------------
async function test_askLLMGeneral_no_tools_when_websearch_false() {
  const originalFetch = global.fetch;
  try {
    let capturedBody = null;
    const chunks = sseChunks([{ content: '普通回答' }]);

    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return makeMockResponse(chunks);
    };

    const results = [];
    for await (const delta of askLLMGeneral('普通问题', [], PROVIDER, false)) {
      results.push(delta);
    }

    console.assert(!capturedBody.tools, 'Should NOT have tools when webSearch=false');
    assert.deepEqual(results, [{ type: 'answer', text: '普通回答' }]);
    console.log('✓ test_askLLMGeneral_no_tools_when_websearch_false');
  } finally {
    global.fetch = originalFetch;
  }
}

// -------------------------
// Test 5: askLLMStream handles multi-line chunks across buffers correctly
// -------------------------
async function test_askLLMStream_handles_split_chunks() {
  const originalFetch = global.fetch;
  try {
    // Split an SSE line across two Uint8Array chunks to test buffer logic
    const fullLine = `data: ${JSON.stringify({ choices: [{ delta: { content: '分块' } }] })}\n\n`;
    const mid = Math.floor(fullLine.length / 2);
    const part1 = fullLine.slice(0, mid);
    const part2 = fullLine.slice(mid);
    const done = 'data: [DONE]\n\n';

    const body = (() => {
      const parts = [encoder.encode(part1), encoder.encode(part2), encoder.encode(done)];
      let idx = 0;
      return {
        getReader() {
          return {
            async read() {
              if (idx >= parts.length) return { done: true, value: undefined };
              return { done: false, value: parts[idx++] };
            },
            releaseLock() {},
          };
        },
        [Symbol.asyncIterator]: undefined,
      };
    })();

    global.fetch = async () => ({ ok: true, status: 200, body });

    const results = [];
    for await (const delta of askLLMStream('问题', [], [], PROVIDER)) {
      results.push(delta);
    }

    assert.deepEqual(results, [{ type: 'answer', text: '分块' }]);
    console.log('✓ test_askLLMStream_handles_split_chunks');
  } finally {
    global.fetch = originalFetch;
  }
}

// -------------------------
// Test 6: 聊天判官收到结构化问答，长命中消息后的答案不能被 300 字截断
// -------------------------
async function test_chat_judge_keeps_answer_context() {
  const originalFetch = global.fetch;
  try {
    const seenBodies = [];
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      seenBodies.push(body);
      const isVerify = body.messages[0].content.includes('复核者');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: isVerify
          ? '[{"i":0,"ok":true}]'
          : '[{"i":0,"score":3,"rank":88}]' } }] }),
      };
    };
    const longMatch = '最近澳储油需求吗？' + '补充背景'.repeat(100);
    const item = {
      source: 'message',
      text: `[命中消息] ${longMatch}\n[后续回复1] 有，最近需求上涨约两成。`,
      matchText: longMatch,
      afterTexts: ['有，最近需求上涨约两成。'],
    };
    const question = `最近澳储油需求吗-${Date.now()}`;
    const judged = await judgeRelevance(question, [item], PROVIDER);
    assert.deepEqual(judged, [3]);
    assert.deepEqual(judged.ranks, [88]);
    assert.deepEqual(await verifyRelevance(question, [item], PROVIDER), [true]);
    for (const body of seenBodies) {
      assert.equal(body.model, PROVIDER.model, '缓存身份不得污染发给模型API的model参数');
      const prompt = body.messages[1].content;
      assert.ok(prompt.includes('类型：CHAT'), '判官必须知道候选是聊天');
      assert.ok(prompt.includes('有，最近需求上涨约两成'), '长问句后的答案必须完整送入判官');
    }
    console.log('✓ test_chat_judge_keeps_answer_context');
  } finally {
    global.fetch = originalFetch;
  }
}

async function test_judge_failure_is_explicit() {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(
      () => judgeRelevance(`judge-outage-${Date.now()}`, [{ text: '粗召回噪音' }], PROVIDER),
      /relevance judge unavailable/,
    );
    console.log('✓ test_judge_failure_is_explicit');
  } finally {
    global.fetch = originalFetch;
  }
}

async function test_judge_batches_all_candidates_without_truncation() {
  const originalFetch = global.fetch;
  try {
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const prompt = body.messages[1].content;
      const count = (prompt.match(/^\[\d+\]$/gm) || []).length;
      const response = Array.from({ length: count }, (_, i) => ({ i, score: 2, rank: 50 + i }));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
    };
    const question = `judge-batches-${Date.now()}`;
    const items = Array.from({ length: 17 }, (_, i) => ({ text: `候选${i}` }));
    const judged = await judgeRelevance(question, items, PROVIDER);
    assert.equal(calls, 3, '默认每批8条，17条候选应并行拆成3批');
    assert.deepEqual(judged, items.map(() => 2), '分批不得遗漏或改变候选顺序');
    assert.equal(judged.ranks.length, items.length);
    console.log('✓ test_judge_batches_all_candidates_without_truncation');
  } finally {
    global.fetch = originalFetch;
  }
}

// -------------------------
// Run all tests
// -------------------------
(async () => {
  try {
    await test_askLLMStream_yields_content_deltas();
    await test_askLLMStream_throws_without_api_key();
    await test_askLLMGeneral_degrades_on_tools_error();
    await test_askLLMGeneral_no_tools_when_websearch_false();
    await test_askLLMStream_handles_split_chunks();
    await test_chat_judge_keeps_answer_context();
    await test_judge_failure_is_explicit();
    await test_judge_batches_all_candidates_without_truncation();
    console.log('llm ok');
  } catch (err) {
    console.error('FAIL:', err);
    process.exit(1);
  }
})();
