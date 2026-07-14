// Test backend API logic without binding to a network port (useful for sandbox/CI)
process.env.USE_MOCK = 'true';

const { handleRequest } = require('../server/router');

function makeRequest(method, pathname, body) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: pathname,
      headers: { host: 'localhost' },
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
      writeHead: (status, headers) => {
        res.status = status;
        Object.assign(res.headers, headers);
      },
      setHeader: (key, value) => {
        res.headers[key] = value;
      },
      end: (data) => {
        res.body = data ? JSON.parse(data) : null;
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
    if (!res.body.config || res.body.config.larkCliPath !== 'lark-cli') {
      throw new Error('unexpected config');
    }
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
    if (!res.body.answer || !res.body.mock) throw new Error('no mock answer');
    if (!res.body.references || res.body.references.length === 0) {
      throw new Error('no references');
    }
    if (!res.body.sources || res.body.sources.length === 0) {
      throw new Error('no sources');
    }
  });

  await check('GET /api/conversations/:id after ask', async () => {
    const res = await makeRequest('GET', `/api/conversations/${convId}`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (res.body.conversation.messages.length !== 2) {
      throw new Error(`expected 2 messages, got ${res.body.conversation.messages.length}`);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
