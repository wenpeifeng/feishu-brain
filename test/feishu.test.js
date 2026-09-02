// test/feishu.test.js — TDD for server/feishu.js
// Stubs global.fetch; asserts user token, parsing, content fetch, error catch.

const { searchDocs, fetchDoc, searchMessages } = require('../server/feishu');

const USER_TOKEN = 'THE_USER_TOKEN';

async function run() {
  let passed = 0;
  let failed = 0;
  const originalFetch = global.fetch;

  function check(name, fn) {
    return fn()
      .then(() => { console.log(`✓ ${name}`); passed++; })
      .catch((err) => { console.error(`✗ ${name}:`, err.message); failed++; });
  }

  // ── Test 1: searchDocs sends correct Authorization header ──────────────────
  await check('searchDocs 用 userAccessToken 作 Authorization Bearer', async () => {
    let capturedInit;
    global.fetch = async (url, init) => {
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            has_more: false,
            total: 1,
            docs_entities: [
              { docs_token: 'tkABC', docs_type: 'docx', title: '清分单说明', owner_id: 'user_001' },
            ],
          },
        }),
      };
    };

    await searchDocs(USER_TOKEN, '清分单', 9);

    if (!capturedInit || !capturedInit.headers) throw new Error('no headers captured');
    const auth = capturedInit.headers['Authorization'] || capturedInit.headers['authorization'];
    if (auth !== `Bearer ${USER_TOKEN}`) {
      throw new Error(`expected "Bearer ${USER_TOKEN}", got "${auth}"`);
    }
  });

  // ── Test 2: searchDocs parses docs_entities into contract structure ────────
  await check('searchDocs 解析 docs_entities 成契约结构', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          has_more: false,
          total: 3,
          docs_entities: [
            { docs_token: 'tok1', docs_type: 'docx',    title: 'Doc A',  owner_id: 'u1' },
            { docs_token: 'tok2', docs_type: 'sheet',   title: 'Sheet B', owner_id: 'u2' },
            { docs_token: 'tok3', docs_type: 'bitable', title: 'Base C',  owner_id: 'u3' },
          ],
        },
      }),
    });

    const results = await searchDocs(USER_TOKEN, 'test', 9);

    if (results.length !== 3) throw new Error(`expected 3 items, got ${results.length}`);

    // index starts at 1
    if (results[0].index !== 1) throw new Error(`index[0] should be 1, got ${results[0].index}`);
    if (results[1].index !== 2) throw new Error(`index[1] should be 2, got ${results[1].index}`);
    if (results[2].index !== 3) throw new Error(`index[2] should be 3, got ${results[2].index}`);

    // title / type / token / owner
    if (results[0].title !== 'Doc A') throw new Error(`title mismatch: ${results[0].title}`);
    if (results[0].type  !== 'docx')  throw new Error(`type mismatch: ${results[0].type}`);
    if (results[0].token !== 'tok1')  throw new Error(`token mismatch: ${results[0].token}`);
    if (results[0].owner !== 'u1')    throw new Error(`owner mismatch: ${results[0].owner}`);

    // editTime should be empty string
    if (results[0].editTime !== '') throw new Error(`editTime should be '', got "${results[0].editTime}"`);

    // url mapping
    const expectedUrls = {
      'tok1': 'https://feishu.cn/docx/tok1',
      'tok2': 'https://feishu.cn/sheets/tok2',
      'tok3': 'https://feishu.cn/base/tok3',
    };
    for (const r of results) {
      if (r.url !== expectedUrls[r.token]) {
        throw new Error(`url for ${r.token}: expected "${expectedUrls[r.token]}", got "${r.url}"`);
      }
    }
  });

  // ── Test 3: url mapping for more types ────────────────────────────────────
  await check('searchDocs URL 映射覆盖各 type', async () => {
    const entities = [
      { docs_token: 'ta', docs_type: 'doc',       title: 'a', owner_id: 'u' },
      { docs_token: 'tb', docs_type: 'mindnote',  title: 'b', owner_id: 'u' },
      { docs_token: 'tc', docs_type: 'file',      title: 'c', owner_id: 'u' },
      { docs_token: 'td', docs_type: 'wiki',      title: 'd', owner_id: 'u' },
      { docs_token: 'te', docs_type: 'slides',    title: 'e', owner_id: 'u' },
      { docs_token: 'tf', docs_type: 'unknown_x', title: 'f', owner_id: 'u' },
    ];
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { has_more: false, total: entities.length, docs_entities: entities } }),
    });

    const results = await searchDocs(USER_TOKEN, 'x', 9);
    const urlMap = Object.fromEntries(results.map(r => [r.type, r.url]));

    const expected = {
      doc:       'https://feishu.cn/docs/ta',
      mindnote:  'https://feishu.cn/mindnotes/tb',
      file:      'https://feishu.cn/file/tc',
      wiki:      'https://feishu.cn/wiki/td',
      slides:    'https://feishu.cn/slides/te',
      unknown_x: 'https://feishu.cn/docs/tf',
    };
    for (const [type, url] of Object.entries(expected)) {
      if (urlMap[type] !== url) throw new Error(`type=${type}: expected "${url}", got "${urlMap[type]}"`);
    }
  });

  // ── Test 4: fetchDoc type='docx' returns content ──────────────────────────
  await check("fetchDoc type='docx' 返回 raw_content 文本", async () => {
    global.fetch = async (url) => {
      if (url.includes('/raw_content')) {
        return { ok: true, json: async () => ({ code: 0, data: { content: '文档正文内容' } }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = { index: 1, title: '清分单', type: 'docx', token: 'tokDOCX', url: 'https://feishu.cn/docx/tokDOCX', owner: 'u1', editTime: '' };
    const result = await fetchDoc(USER_TOKEN, item);

    if (result.title !== '清分单') throw new Error(`title: ${result.title}`);
    if (result.content !== '文档正文内容') throw new Error(`content: "${result.content}"`);
  });

  // ── Test 5: fetchDoc type='sheet' returns content='' ─────────────────────
  await check("fetchDoc type='sheet' 返回 content=''", async () => {
    global.fetch = async () => { throw new Error('should not call fetch for sheet'); };

    const item = { index: 1, title: '表格', type: 'sheet', token: 'tokSHEET', url: 'https://feishu.cn/sheets/tokSHEET', owner: 'u1', editTime: '' };
    const result = await fetchDoc(USER_TOKEN, item);

    if (result.title !== '表格') throw new Error(`title: ${result.title}`);
    if (result.content !== '') throw new Error(`expected content='', got "${result.content}"`);
  });

  // ── Test 6: fetchDoc type='wiki' resolves via get_node then raw_content ───
  await check("fetchDoc type='wiki' 走 get_node → raw_content", async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      if (url.includes('/wiki/v2/spaces/get_node')) {
        return { ok: true, json: async () => ({ code: 0, data: { node: { obj_token: 'objTOK', obj_type: 'docx' } } }) };
      }
      if (url.includes('/raw_content')) {
        return { ok: true, json: async () => ({ code: 0, data: { content: 'wiki 正文' } }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = { index: 1, title: 'Wiki 页面', type: 'wiki', token: 'tokWIKI', url: 'https://feishu.cn/wiki/tokWIKI', owner: 'u1', editTime: '' };
    const result = await fetchDoc(USER_TOKEN, item);

    if (result.content !== 'wiki 正文') throw new Error(`content: "${result.content}"`);
    if (callCount !== 2) throw new Error(`expected 2 fetch calls, got ${callCount}`);
  });

  // ── Test 7: fetchDoc type='wiki' obj_type!='docx' returns content='' ──────
  await check("fetchDoc type='wiki' obj_type!=docx 返回 content=''", async () => {
    global.fetch = async (url) => {
      if (url.includes('/wiki/v2/spaces/get_node')) {
        return { ok: true, json: async () => ({ code: 0, data: { node: { obj_token: 'objTOK', obj_type: 'sheet' } } }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const item = { index: 1, title: 'Wiki Sheet', type: 'wiki', token: 'tokWIKI2', url: 'https://feishu.cn/wiki/tokWIKI2', owner: 'u1', editTime: '' };
    const result = await fetchDoc(USER_TOKEN, item);
    if (result.content !== '') throw new Error(`expected '', got "${result.content}"`);
  });

  // ── Test 8: fetchDoc 内部抛错被 catch 成 content='' ───────────────────────
  await check('fetchDoc 内部 fetch reject 被 catch 成 content=""', async () => {
    global.fetch = async () => { throw new Error('network error'); };

    const item = { index: 1, title: '出错文档', type: 'docx', token: 'tokERR', url: 'https://feishu.cn/docx/tokERR', owner: 'u1', editTime: '' };
    const result = await fetchDoc(USER_TOKEN, item);

    if (result.title !== '出错文档') throw new Error(`title: ${result.title}`);
    if (result.content !== '') throw new Error(`expected content='', got "${result.content}"`);
  });

  // ── Test 9: 会话候选保留结构化“命中消息 + 后续回复” ────────────────────────
  await check('searchMessages 结构化保留命中问句与后续回答', async () => {
    const matchMs = 1_700_000_000_000;
    global.fetch = async (url) => {
      if (url.includes('/search/v2/message')) {
        return { ok: true, json: async () => ({ code: 0, data: { items: ['m1'] } }) };
      }
      if (url.includes('/im/v1/messages/m1')) {
        return { ok: true, json: async () => ({ code: 0, data: { items: [{
          message_id: 'm1', chat_id: 'c1', msg_type: 'text', create_time: String(matchMs), message_position: 7,
          sender: { sender_type: 'user', id: 'u1' }, body: { content: JSON.stringify({ text: '最近澳储油需求吗？' }) },
        }] } }) };
      }
      if (url.includes('container_id=c1')) {
        return { ok: true, json: async () => ({ code: 0, data: { items: [
          { message_id: 'm1', msg_type: 'text', create_time: String(matchMs), sender: { sender_type: 'user', id: 'u1' }, body: { content: JSON.stringify({ text: '最近澳储油需求吗？' }) } },
          { message_id: 'm2', msg_type: 'text', create_time: String(matchMs + 30_000), sender: { sender_type: 'user', id: 'u2' }, body: { content: JSON.stringify({ text: '有，最近需求上涨约两成。' }) } },
          { message_id: 'm3', msg_type: 'text', create_time: String(matchMs + 11 * 60_000), sender: { sender_type: 'user', id: 'u3' }, body: { content: JSON.stringify({ text: '午饭吃什么？' }) } },
        ] } }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const [msg] = await searchMessages(USER_TOKEN, '澳储油需求', 3, { after: 3 });
    if (!msg) throw new Error('expected one message result');
    if (msg.matchText !== '最近澳储油需求吗？') throw new Error(`bad matchText: ${msg.matchText}`);
    if (JSON.stringify(msg.afterTexts) !== JSON.stringify(['有，最近需求上涨约两成。'])) throw new Error(`bad afterTexts: ${JSON.stringify(msg.afterTexts)}`);
    if (!msg.content.includes('[命中消息]') || !msg.content.includes('[后续回复1]')) throw new Error(`missing chat labels: ${msg.content}`);
    if (msg.content.includes('午饭')) throw new Error('超出上下文时间窗的新话题不应混入');
    if (msg.title !== '有，最近需求上涨约两成。') throw new Error(`展示标题没有使用实际回答: ${msg.title}`);
  });

  // ── Restore ────────────────────────────────────────────────────────────────
  global.fetch = originalFetch;

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log('feishu ok');
}

run().catch((err) => { console.error(err); process.exit(1); });
