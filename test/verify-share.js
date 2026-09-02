// 一次性验证：分享到「用户 / 群聊」到底能不能直接用 ID 发。全走真实飞书接口，只读为主。
'use strict';
const fs = require('fs');

// 载入 .env
for (const line of fs.readFileSync(__dirname + '/../.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const FEISHU = 'https://open.feishu.cn';
const APP_ID = process.env.FEISHU_APP_ID, APP_SECRET = process.env.FEISHU_APP_SECRET;

async function appTok() {
  const r = await fetch(FEISHU + '/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return (await r.json()).app_access_token;
}
async function tenantTok() {
  const r = await fetch(FEISHU + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return (await r.json()).tenant_access_token;
}
async function refresh(refreshToken) {
  const at = await appTok();
  const r = await fetch(FEISHU + '/open-apis/authen/v1/refresh_access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  return r.json();
}
async function listChats(token, label) {
  const r = await fetch(`${FEISHU}/open-apis/im/v1/chats?user_id_type=open_id&page_size=50&sort_type=ByActiveTimeDesc`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  console.log(`\n[列会话:${label}] code=${j.code} msg=${j.msg || 'ok'} 数量=${(j.data && j.data.items || []).length}`);
  return (j.data && j.data.items) || [];
}
async function send(receiveIdType, id, text, token, useTenant) {
  const auth = useTenant ? token : ('Bearer ' + token);
  const r = await fetch(`${FEISHU}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST', headers: { Authorization: auth.startsWith('Bearer') ? auth : ('Bearer ' + token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  return r.json();
}

(async () => {
  // 挑最新 session
  const sessions = JSON.parse(fs.readFileSync(__dirname + '/../data/sessions.json', 'utf8'));
  const arr = Object.values(sessions).filter(s => s && s.userAccessToken && s.refreshToken);
  arr.sort((a, b) => (b.expireAt || 0) - (a.expireAt || 0));
  let sess = arr[0];
  console.log('用最新 session: open_id=', sess.openId, ' expireAt=', new Date(sess.expireAt || 0).toISOString());

  // 先试用户 token 列群；过期就刷新
  let userToken = sess.userAccessToken;
  let userChats = await listChats(userToken, '用户token(=选择器现在用的)');
  if (userChats.length === 0) {
    console.log('→ 可能过期，尝试 refresh...');
    const j = await refresh(sess.refreshToken);
    console.log('   refresh code=', j.code, j.msg || '');
    if (j.code === 0) { userToken = j.data.access_token; userChats = await listChats(userToken, '用户token(刷新后)'); }
  }
  userChats.slice(0, 12).forEach(c => console.log('   [用户群]', c.chat_id, '|', c.name));

  // 机器人(tenant) 能列到的群
  const tt = await tenantTok();
  const botChats = await listChats(tt, '机器人tenant token');
  botChats.slice(0, 12).forEach(c => console.log('   [机器人群]', c.chat_id, '|', c.name));

  // 交集：机器人真正发得进去、且用户也在的群
  const botSet = new Set(botChats.map(c => c.chat_id));
  const shared = userChats.filter(c => botSet.has(c.chat_id));
  console.log('\n★ 交集(机器人+用户都在,发得进去)的群数:', shared.length);
  shared.forEach(c => console.log('   ✓', c.chat_id, '|', c.name));

  // 验证1：给用户本人 open_id 发（无害，落在你与机器人的会话）
  const r1 = await send('open_id', sess.openId, '【验证】直接用 open_id 发给用户本人', tt);
  console.log('\n[发给用户本人 open_id] code=', r1.code, r1.msg || 'ok');

  // 验证2：给一个「用户在、但机器人可能不在」的群发（预期 230002 = 不在群里；不会真的发出去）
  const outsider = userChats.find(c => !botSet.has(c.chat_id));
  if (outsider) {
    const r2 = await send('chat_id', outsider.chat_id, '【验证】机器人是否能发进用户的群', tt);
    console.log(`[发给"用户在/机器人不在"的群 ${outsider.name}] code=`, r2.code, r2.msg || 'ok', r2.code === 230002 ? '(=机器人不在群里)' : '');
  } else {
    console.log('[没有"用户在但机器人不在"的群可测]');
  }
})().catch(e => console.error('ERR', e));
