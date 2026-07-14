'use strict';

/**
 * Test file for server/llm.js - Task 5: Streaming LLM + Web Search
 * Uses stub global.fetch to avoid real network calls.
 * Tests askLLMStream and askLLMGeneral exports.
 */

const { askLLMStream, askLLMGeneral } = require('../server/llm');

// --- Helpers ---

const encoder = new TextEncoder();

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
// Test 1: askLLMStream yields content deltas, ignores reasoning_content
// -------------------------
async function test_askLLMStream_yields_content_deltas() {
  const originalFetch = global.fetch;
  try {
    const chunks = sseChunks([
      { content: '你' },
      { reasoning_content: '思考中...' },  // should be ignored
      { content: '好' },
      { reasoning_content: '推理...' },     // should be ignored
      { content: '！' },
    ]);

    global.fetch = async () => makeMockResponse(chunks);

    const docs = [{ title: '测试文档', content: '内容' }];
    const history = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }];

    const results = [];
    for await (const delta of askLLMStream('问题', docs, history, PROVIDER)) {
      results.push(delta);
    }

    console.assert(
      JSON.stringify(results) === JSON.stringify(['你', '好', '！']),
      `Expected ['你', '好', '！'], got ${JSON.stringify(results)}`
    );
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
    console.assert(
      JSON.stringify(results) === JSON.stringify(['联网结果']),
      `Expected ['联网结果'], got ${JSON.stringify(results)}`
    );
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
    console.assert(
      JSON.stringify(results) === JSON.stringify(['普通回答']),
      `Expected ['普通回答'], got ${JSON.stringify(results)}`
    );
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

    console.assert(
      JSON.stringify(results) === JSON.stringify(['分块']),
      `Expected ['分块'], got ${JSON.stringify(results)}`
    );
    console.log('✓ test_askLLMStream_handles_split_chunks');
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
    console.log('llm ok');
  } catch (err) {
    console.error('FAIL:', err);
    process.exit(1);
  }
})();
