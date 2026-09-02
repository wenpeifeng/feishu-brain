// server/feishubot.js — 飞书机器人：接收 im.message.receive_v1 事件，按发消息人的登录态
// 用「他自己的权限」检索作答（防越权），机器人以应用身份回复。
//
// 安全模型：机器人不持有任何人的权限；它按发消息人的 open_id 找其**网页登录态**，
// 用该用户的 user_access_token 检索（和网页问答完全一致的隔离）。没登录过 → 提示先登录。
'use strict';

const crypto = require('crypto');
const { getAppAccessToken } = require('./auth');
const { getSessionByOpenId } = require('./session');
const { getConfig } = require('./store');
const { runRAGStream } = require('./rag');

const FEISHU = 'https://open.feishu.cn';

// ── 事件解密（飞书 AES-256-CBC；设了 Encrypt Key 时事件体被加密）─────────────
function decrypt(encrypt, encryptKey) {
  const key = crypto.createHash('sha256').update(String(encryptKey)).digest();
  const data = Buffer.from(encrypt, 'base64');
  const iv = data.slice(0, 16);
  const ct = data.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * 解析飞书推来的请求体（原始字符串）。返回：
 *   { type:'challenge', challenge }        — URL 验证
 *   { type:'event', header, event, raw }   — 事件回调
 *   { type:'ignore' }                      — 其它
 * @param {string} rawBody
 * @param {string} encryptKey  可空
 */
function parseInbound(rawBody, encryptKey) {
  let obj;
  try { obj = JSON.parse(rawBody); } catch (_e) { return { type: 'ignore' }; }
  // 加密事件：先解密再解析
  if (obj && obj.encrypt) {
    if (!encryptKey) return { type: 'ignore' };
    try { obj = JSON.parse(decrypt(obj.encrypt, encryptKey)); } catch (_e) { return { type: 'ignore' }; }
  }
  if (obj && obj.type === 'url_verification' && obj.challenge) {
    return { type: 'challenge', challenge: obj.challenge, token: obj.token };
  }
  if (obj && obj.header && obj.event) {
    return { type: 'event', header: obj.header, event: obj.event };
  }
  return { type: 'ignore' };
}

/** 从 im.message.receive_v1 的 event 里提取问题与上下文；非文本或不该回则返回 null。 */
function extractQuestion(event) {
  const msg = event && event.message;
  if (!msg) return null;
  const chatType = msg.chat_type;                       // 'p2p' | 'group'
  const mentioned = Array.isArray(msg.mentions) && msg.mentions.length > 0;
  // 群里只在被 @ 时回；单聊都回
  if (chatType === 'group' && !mentioned) return null;
  if (msg.message_type !== 'text') return null;
  let text = '';
  try { text = JSON.parse(msg.content || '{}').text || ''; } catch (_e) { text = ''; }
  text = text.replace(/@_user_\d+/g, ' ').replace(/@_all/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const senderOpenId = event.sender && event.sender.sender_id && event.sender.sender_id.open_id;
  return { question: text, chatId: msg.chat_id, chatType, senderOpenId, messageId: msg.message_id };
}

// ── 发消息（以应用身份，send_as_bot）───────────────────────────────────────────
async function replyText(messageId, text) {
  const appTok = await getAppAccessToken();
  const res = await fetch(`${FEISHU}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + appTok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  return res.json().catch(() => ({}));
}

// ── 主动推送一条文本给某用户（open_id，send_as_bot）。用于定时追踪等主动通知。────
// 以机器人身份把文本发给指定接收方：idType = open_id(用户) | chat_id(群/会话)。
async function pushTo(idType, id, text) {
  const appTok = await getAppAccessToken();
  const res = await fetch(`${FEISHU}/open-apis/im/v1/messages?receive_id_type=${idType}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + appTok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: id, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  return res.json().catch(() => ({}));
}
function pushText(openId, text) { return pushTo('open_id', openId, text); }

// ── 组装该用户的 RAG config（会话里的 LLM + 全局检索参数）────────────────────
function userConfig(ctx) {
  const llm = (ctx && ctx.llm) || {};
  const g = { ...getConfig(), ...((ctx && ctx.rag) || {}) };
  return {
    providerId: llm.providerId || 'glm', apiKey: llm.apiKey || '',
    baseUrl: llm.baseUrl || '', model: llm.model || '',
    topK: g.topK, pageSize: g.pageSize, readPool: g.readPool, minScore: g.minScore,
  };
}

/** 把 RAG 结果整理成适合聊天的文本（正文 + 参考编号列表）。 */
function formatAnswer(answer, refs) {
  let out = (answer || '').trim() || '抱歉，没能找到相关内容。';
  if (refs && refs.length) {
    out += '\n\n参考资料：\n' + refs.map(r => `[${r.index}] ${r.title}${r.url ? ' ' + r.url : ''}`).join('\n');
  }
  return out;
}

// 事件去重（飞书可能重推）
const _seen = new Set();
function dedupe(eventId) {
  if (!eventId) return false;
  if (_seen.has(eventId)) return true;
  _seen.add(eventId);
  if (_seen.size > 2000) _seen.clear();
  return false;
}

// 机器人多轮对话记忆：按 (会话 + 发消息人) 隔离，保留最近 3 轮、30 分钟 TTL。
// 群里不同人各自独立上下文，不会串味。
const _history = new Map();
function histKey(chatId, openId) { return chatId + '|' + openId; }
function getHistory(chatId, openId) {
  const h = _history.get(histKey(chatId, openId));
  if (!h) return [];
  if (Date.now() - h.ts > 30 * 60 * 1000) { _history.delete(histKey(chatId, openId)); return []; }
  return h.msgs.slice();
}
function pushHistory(chatId, openId, role, content) {
  const key = histKey(chatId, openId);
  let h = _history.get(key);
  if (!h) { h = { msgs: [], ts: 0 }; _history.set(key, h); }
  h.msgs.push({ role, content });
  if (h.msgs.length > 6) h.msgs = h.msgs.slice(-6);   // 最近 3 轮（user+assistant）
  h.ts = Date.now();
  if (_history.size > 500) { for (const k of _history.keys()) { _history.delete(k); if (_history.size <= 400) break; } }
}

/**
 * 处理一条消息事件：找登录态→按其权限跑 RAG→回复。全程 catch，绝不抛。
 * @param {{header, event}} parsed
 * @param {{appBaseUrl?:string}} opts
 */
async function handleMessage(parsed, opts = {}) {
  try {
    if (dedupe(parsed.header && parsed.header.event_id)) return;
    if (!parsed.header || parsed.header.event_type !== 'im.message.receive_v1') return;
    const q = extractQuestion(parsed.event);
    if (!q || !q.messageId) return;

    const ctx = getSessionByOpenId(q.senderOpenId);
    if (!ctx) {
      const url = opts.appBaseUrl || process.env.APP_BASE_URL || '';
      await replyText(q.messageId, `你还没在「知识问答」登录授权。请先打开 ${url} 用飞书登录（这样我才能按你自己的权限、只搜你能看的文档），之后再来问我～`);
      return;
    }

    const history = getHistory(q.chatId, q.senderOpenId);   // 多轮上下文
    let answer = '', refs = [];
    for await (const ev of runRAGStream(ctx, q.question, history, false, userConfig(ctx))) {
      if (ev.type === 'token') answer += ev.delta || '';
      else if (ev.type === 'answerFinal') answer = ev.text || '';
      else if (ev.type === 'references') refs = ev.references || [];
    }
    await replyText(q.messageId, formatAnswer(answer, refs));
    // 存入多轮记忆（下一次同一人同一会话提问会带上）
    pushHistory(q.chatId, q.senderOpenId, 'user', q.question);
    pushHistory(q.chatId, q.senderOpenId, 'assistant', answer);
  } catch (_e) {
    // 静默失败，不影响服务
  }
}

module.exports = { decrypt, parseInbound, extractQuestion, formatAnswer, handleMessage, replyText, pushText, pushTo, userConfig, getHistory, pushHistory };
