require('../server/env');
const assert = require('assert');
const crypto = require('crypto');
const bot = require('../server/feishubot');

// 与飞书同方案的加密助手，用来测 decrypt
function encrypt(plain, key) {
  const k = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
}

// decrypt 往返
{
  const key = 'testkey123';
  const plain = JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 't' });
  assert.equal(bot.decrypt(encrypt(plain, key), key), plain, 'decrypt 还原');
}

// parseInbound：明文 challenge
{
  const r = bot.parseInbound(JSON.stringify({ type: 'url_verification', challenge: 'xyz', token: 't' }), '');
  assert.equal(r.type, 'challenge'); assert.equal(r.challenge, 'xyz');
}
// parseInbound：加密 challenge
{
  const key = 'k';
  const enc = encrypt(JSON.stringify({ type: 'url_verification', challenge: 'enc-chal' }), key);
  const r = bot.parseInbound(JSON.stringify({ encrypt: enc }), key);
  assert.equal(r.type, 'challenge'); assert.equal(r.challenge, 'enc-chal');
}
// parseInbound：事件
{
  const body = { header: { event_type: 'im.message.receive_v1', event_id: 'e1', token: 't' }, event: { message: {} } };
  const r = bot.parseInbound(JSON.stringify(body), '');
  assert.equal(r.type, 'event'); assert.equal(r.header.event_id, 'e1');
}
// parseInbound：垃圾输入
assert.equal(bot.parseInbound('not json', '').type, 'ignore');

// extractQuestion：单聊文本
{
  const ev = { sender: { sender_id: { open_id: 'ou_1' } }, message: { chat_type: 'p2p', message_type: 'text', chat_id: 'oc_1', message_id: 'om_1', content: JSON.stringify({ text: '电价是什么' }) } };
  const q = bot.extractQuestion(ev);
  assert.equal(q.question, '电价是什么'); assert.equal(q.senderOpenId, 'ou_1'); assert.equal(q.messageId, 'om_1');
}
// extractQuestion：群里没@ → null
{
  const ev = { sender: { sender_id: { open_id: 'ou_1' } }, message: { chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'hi' }) } };
  assert.equal(bot.extractQuestion(ev), null, '群里没@不回');
}
// extractQuestion：群里@了 → 去掉@mention
{
  const ev = { sender: { sender_id: { open_id: 'ou_1' } }, message: { chat_type: 'group', message_type: 'text', chat_id: 'oc', message_id: 'om', mentions: [{ key: '@_user_1' }], content: JSON.stringify({ text: '@_user_1 负电价是什么' }) } };
  assert.equal(bot.extractQuestion(ev).question, '负电价是什么', '去掉@mention');
}
// extractQuestion：非文本 → null
{
  const ev = { sender: { sender_id: { open_id: 'x' } }, message: { chat_type: 'p2p', message_type: 'image', content: '{}' } };
  assert.equal(bot.extractQuestion(ev), null, '图片消息不处理');
}

// formatAnswer
{
  const f = bot.formatAnswer('答案内容', [{ index: 1, title: '文档A', url: 'http://x' }]);
  assert.ok(f.includes('答案内容') && f.includes('[1] 文档A'), '含答案+参考编号');
  assert.ok(bot.formatAnswer('', []).length > 0, '空答案有兜底');
}

// 多轮对话记忆：按 会话+人 隔离，保留最近3轮
{
  bot.pushHistory('oc_1', 'ou_a', 'user', 'q1');
  bot.pushHistory('oc_1', 'ou_a', 'assistant', 'a1');
  const h = bot.getHistory('oc_1', 'ou_a');
  assert.equal(h.length, 2, '有历史');
  assert.equal(h[0].content, 'q1');
  // 不同人隔离
  assert.equal(bot.getHistory('oc_1', 'ou_b').length, 0, '不同人独立上下文');
  // 只留最近3轮
  for (let i = 0; i < 5; i++) { bot.pushHistory('oc_1', 'ou_a', 'user', 'u' + i); bot.pushHistory('oc_1', 'ou_a', 'assistant', 'a' + i); }
  assert.ok(bot.getHistory('oc_1', 'ou_a').length <= 6, '最多6条(3轮)');
}

console.log('✅ feishubot.test.js 通过');
