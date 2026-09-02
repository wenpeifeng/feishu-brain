'use strict';

process.env.USE_MOCK = 'true';
process.env.ADMIN_OPEN_IDS = '';
process.env.DEFAULT_LLM_KEY = '';
process.env.ORGANIZATIONS_FILE = `/tmp/feishu-kb-org-test-${process.pid}.json`;

const assert = require('assert');
const fs = require('fs');
const { handleRequest } = require('../server/router');
const { createSession, removeSession } = require('../server/session');

function request(token, method, url, body) {
  return new Promise(resolve => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method, url, headers: { authorization: `Bearer ${token}`, host: 'localhost' },
      on(event, cb) {
        if (event === 'data') chunks.forEach(cb);
        if (event === 'end') cb();
      },
    };
    const res = {
      statusCode: 200, raw: '',
      setHeader() {},
      writeHead(status) { this.statusCode = status; },
      write(x) { this.raw += String(x || ''); },
      end(x) {
        this.raw += String(x || '');
        try { this.json = JSON.parse(this.raw || '{}'); } catch (_e) { this.json = null; }
        resolve(this);
      },
    };
    handleRequest(req, res);
  });
}

async function run() {
  const now = Date.now() + 3600000;
  const owner = createSession({ openId: `owner-${process.pid}`, name: 'Owner', tenantKey: 'tenant-A', userAccessToken: 'a', refreshToken: 'ra', expireAt: now });
  const member = createSession({ openId: `member-${process.pid}`, name: 'Member', tenantKey: 'tenant-A', userAccessToken: 'b', refreshToken: 'rb', expireAt: now });
  const outsider = createSession({ openId: `outsider-${process.pid}`, name: 'Outsider', tenantKey: 'tenant-B', userAccessToken: 'c', refreshToken: 'rc', expireAt: now });
  let docId = '';
  try {
    const ownerMe = await request(owner, 'GET', '/api/auth/me');
    const memberMe = await request(member, 'GET', '/api/auth/me');
    const outsiderMe = await request(outsider, 'GET', '/api/auth/me');
    assert.equal(ownerMe.json.user.role, 'owner');
    assert.equal(memberMe.json.user.role, 'member');
    assert.equal(outsiderMe.json.user.role, 'owner');

    const denied = await request(member, 'POST', '/api/kb?scope=organization', { title: '越权', content: '不能写' });
    assert.equal(denied.statusCode, 403);

    const created = await request(owner, 'POST', '/api/kb?scope=organization', { title: '组织制度', content: '组织成员共同可检索的资料' });
    assert.equal(created.statusCode, 200, created.raw);
    docId = created.json.doc.id;

    const memberList = await request(member, 'GET', '/api/kb?scope=organization');
    assert.equal(memberList.json.canManage, false);
    assert.ok(memberList.json.docs.some(x => x.id === docId));
    const outsiderList = await request(outsider, 'GET', '/api/kb?scope=organization');
    assert.ok(!outsiderList.json.docs.some(x => x.id === docId), '不同 tenant 不得读取组织知识库');

    const promote = await request(owner, 'PATCH', `/api/organization/members/member-${process.pid}`, { role: 'admin' });
    assert.equal(promote.statusCode, 200);
    const adminMe = await request(member, 'GET', '/api/auth/me');
    assert.equal(adminMe.json.user.role, 'admin');

    const demote = await request(owner, 'PATCH', `/api/organization/members/member-${process.pid}`, { role: 'member' });
    assert.equal(demote.statusCode, 200);
    const memberAgain = await request(member, 'GET', '/api/auth/me');
    assert.equal(memberAgain.json.user.role, 'member', '撤销管理员后不得被引导配置重新提升');

    const transfer = await request(owner, 'PATCH', `/api/organization/members/member-${process.pid}`, { role: 'owner' });
    assert.equal(transfer.statusCode, 200);
    const oldOwnerMe = await request(owner, 'GET', '/api/auth/me');
    assert.equal(oldOwnerMe.json.user.role, 'admin');
    console.log('✅ organization-router.test.js 通过：首人 Owner、角色变更、组织库读写与跨租户隔离');
  } finally {
    if (docId) await request(member, 'DELETE', `/api/kb/${docId}?scope=organization`);
    [owner, member, outsider].forEach(removeSession);
    try { fs.unlinkSync(process.env.ORGANIZATIONS_FILE); } catch (_e) {}
  }
}

run().catch(err => { console.error(err); process.exit(1); });
