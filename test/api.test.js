// Test backend API logic without binding to a network port (useful for sandbox/CI)
process.env.USE_MOCK = 'true';

const { handleRequest } = require('../server/router');
const { createSession, removeSession } = require('../server/session');
const { deleteConversationOwned } = require('../server/store');

const TEST_OPEN_ID = 'mock-api-user-' + process.pid;
const TEST_TOKEN = createSession({
  openId: TEST_OPEN_ID,
  name: 'Mock API User',
  userAccessToken: 'mock-user-access-token',
  refreshToken: 'mock-refresh-token',
  expireAt: Date.now() + 60 * 60 * 1000,
});

function makeRequest(method, pathname, body) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: pathname,
      headers: { host: 'localhost', authorization: `Bearer ${TEST_TOKEN}` },
      on: (event, cb) => {
        if (event === 'data' && chunks.length) {
          chunks.forEach(c => cb(c));
        } else if (event === 'end') {
          cb();
        }
      },
    };
    const res = {
      status: 200,
      headers: {},
      raw: '',
      writeHead: (status, headers) => {
        res.status = status;
        Object.assign(res.headers, headers);
      },
      setHeader: (key, value) => {
        res.headers[key] = value;
      },
      write: (data) => {
        res.raw += data ? String(data) : '';
      },
      end: (data) => {
        res.raw += data ? String(data) : '';
        try { res.body = res.raw ? JSON.parse(res.raw) : null; }
        catch (_e) { res.body = res.raw; }
        resolve(res);
      },
    };
    handleRequest(req, res);
  });
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}:`, err.message);
      failed++;
    }
  }

  await check('GET /api/config', async () => {
    const res = await makeRequest('GET', '/api/config');
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!res.body.config || res.body.config.apiKey !== '') throw new Error('unexpected or unsafe config');
  });

  let convId;
  await check('POST /api/conversations', async () => {
    const res = await makeRequest('POST', '/api/conversations', { title: 'test' });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!res.body.conversation || !res.body.conversation.id) {
      throw new Error('no conversation id');
    }
    convId = res.body.conversation.id;
  });

  await check('GET /api/conversations', async () => {
    const res = await makeRequest('GET', '/api/conversations');
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!res.body.conversations || res.body.conversations.length === 0) {
      throw new Error('no conversations');
    }
  });

  await check('GET /api/conversations/:id', async () => {
    const res = await makeRequest('GET', `/api/conversations/${convId}`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (res.body.conversation.title !== 'test') {
      throw new Error('unexpected title');
    }
  });

  await check('POST /api/conversations/:id/ask', async () => {
    const res = await makeRequest('POST', `/api/conversations/${convId}/ask`, { question: '清分单是什么' });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (typeof res.body !== 'string' || !res.body.includes('event: references') || !res.body.includes('event: done')) throw new Error('invalid SSE answer');
  });

  await check('GET /api/conversations/:id after ask', async () => {
    const res = await makeRequest('GET', `/api/conversations/${convId}`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (res.body.conversation.messages.length !== 2) {
      throw new Error(`expected 2 messages, got ${res.body.conversation.messages.length}`);
    }
  });

  if (convId) deleteConversationOwned(convId, TEST_OPEN_ID);
  removeSession(TEST_TOKEN);
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  removeSession(TEST_TOKEN);
  console.error(err);
  process.exit(1);
});
