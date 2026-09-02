// server/feishu.js — 直连飞书 OpenAPI，按用户权限搜索/读文档
// 安全约束：所有请求只用 userAccessToken，绝不使用 app/tenant token。

'use strict';

const BASE = 'https://open.feishu.cn/open-apis';

/** type → URL path segment 映射 */
const TYPE_PATH = {
  docx:     'docx',
  doc:      'docs',
  sheet:    'sheets',
  bitable:  'base',
  mindnote: 'mindnotes',
  file:     'file',
  wiki:     'wiki',
  slides:   'slides',
};

function buildUrl(type, token) {
  const path = TYPE_PATH[type] || 'docs';
  return `https://feishu.cn/${path}/${token}`;
}

/**
 * 搜索飞书云文档（以用户身份）
 * @param {string} userAccessToken
 * @param {string} query
 * @param {number} pageSize
 * @returns {Promise<Array<{index,title,type,token,url,owner,editTime}>>}
 */
/** wiki nodes/search 的 obj_type(数字) → 我们的 type 字符串 */
const OBJ_TYPE = { 1: 'doc', 2: 'sheet', 3: 'bitable', 4: 'mindnote', 5: 'file', 7: 'wiki', 8: 'docx', 11: 'slides' };

/** 搜索云盘文档（docs-api/search/object，不含 wiki） */
async function searchDrive(userAccessToken, query, pageSize) {
  const res = await fetch(`${BASE}/suite/docs-api/search/object`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ search_key: query, count: pageSize, offset: 0 }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`drive search error: code=${j.code} msg=${j.msg}`);
  return (j.data?.docs_entities || []).map(item => ({
    title: item.title,
    type:  item.docs_type,
    token: item.docs_token,
    url:   buildUrl(item.docs_type, item.docs_token),
    owner: item.owner_id || '',
    editTime: '',
    source: 'drive',
  }));
}

/** 搜索知识库 wiki 节点（wiki/v2/nodes/search，覆盖所有有权限的知识空间） */
async function searchWiki(userAccessToken, query, pageSize) {
  const size = Math.min(pageSize, 50);
  const res = await fetch(`${BASE}/wiki/v2/nodes/search?page_size=${size}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`wiki search error: code=${j.code} msg=${j.msg}`);
  return (j.data?.items || []).map(item => ({
    title: item.title,
    type:  OBJ_TYPE[item.obj_type] || 'docx',  // 用于内容读取（8→docx）
    token: item.obj_token,                       // 内容 token
    url:   item.url || buildUrl('wiki', item.node_id),
    owner: '',                                    // wiki 搜索不返回 owner，enrich 时从 metadata 补
    editTime: '',
    source: 'wiki',
  }));
}

/**
 * 搜索飞书全部有权限文档：**并行**云盘 + 知识库 wiki，合并去重。
 * 任一路失败不影响另一路（wiki scope 未开时仍能返回云盘结果）。
 */
// ── 评测夹具（recall snapshot）───────────────────────────────────────────────
// 设 FEISHU_FIXTURE=文件路径 时，searchDocs/fetchDoc 结果落盘复用，让评测确定性可复现、省配额。
// 生产环境不设该变量 → 全为 no-op，无任何影响。
const _FIXTURE_PATH = process.env.FEISHU_FIXTURE || '';
let _fixtureCache = null;
function _fixture() {
  if (!_FIXTURE_PATH) return null;
  if (_fixtureCache) return _fixtureCache;
  try { _fixtureCache = JSON.parse(require('fs').readFileSync(_FIXTURE_PATH, 'utf8')); } catch (_e) { _fixtureCache = {}; }
  return _fixtureCache;
}
function fixtureGet(key) { const f = _fixture(); return f && f[key] ? f[key] : null; }
function fixtureSet(key, val) { const f = _fixture(); if (f) f[key] = val; }
function fixtureFlush() {
  if (_FIXTURE_PATH && _fixtureCache) {
    try { require('fs').writeFileSync(_FIXTURE_PATH, JSON.stringify(_fixtureCache)); } catch (_e) { /* ignore */ }
  }
}

async function searchDocs(userAccessToken, query, pageSize = 9) {
  const _fxKey = 'S:' + query + ':' + pageSize;
  const _cached = fixtureGet(_fxKey);
  if (_cached) return _cached;
  const [driveR, wikiR] = await Promise.allSettled([
    searchDrive(userAccessToken, query, pageSize),
    searchWiki(userAccessToken, query, pageSize),
  ]);
  const drive = driveR.status === 'fulfilled' ? driveR.value : [];
  const wiki  = wikiR.status  === 'fulfilled' ? wikiR.value  : [];
  // 两路都失败才抛错（否则至少返回能拿到的那部分）
  if (driveR.status === 'rejected' && wikiR.status === 'rejected') {
    throw new Error(driveR.reason?.message || wikiR.reason?.message || 'feishu search failed');
  }
  // wiki 优先（工作文档多在知识库），再拼云盘，按 token + 标题双重去重
  const seenToken = new Set();
  const seenTitle = new Set();
  const merged = [];
  for (const r of [...wiki, ...drive]) {
    if (!r.token || seenToken.has(r.token)) continue;
    const titleKey = (r.title || '').trim();
    if (titleKey && seenTitle.has(titleKey)) continue;  // 同名文档只保留一份
    seenToken.add(r.token);
    if (titleKey) seenTitle.add(titleKey);
    merged.push(r);
  }

  // 相关性重排：标题命中的关键词越多越靠前（"澳洲 迁移" 里两个词都在标题 > 只命中一个）。
  // 这样最相关的文档排前面，也正是喂给 AI 读全文的那几篇。
  // 不再按标题关键词硬过滤——飞书搜索本身已按"内容相关性"排序，标题不含关键词但正文
  // 命中的文档（如《电力交易常用Q&A》里有答案）也要保留。直接信任飞书排序，取前 pageSize。
  const _out = merged.slice(0, pageSize).map((r, i) => ({ ...r, index: i + 1 }));
  fixtureSet(_fxKey, _out);
  return _out;
}

/** unix 秒(字符串/数字) → YYYY-MM-DD；无效返回 '' */
function fmtDate(sec) {
  const n = parseInt(sec, 10);
  if (!n) return '';
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 丰富参考资料：补上「作者姓名」和「修改日期」，对齐飞书知识问答的参考资料展示。
 * - 日期：drive metadata batch_query（scope drive:drive.metadata:readonly，已授予）
 * - 姓名：contact users batch（scope contact:user.base:readonly，若未授予则优雅跳过）
 * 任何子调用失败都不影响主流程，只是少一部分信息。
 * @returns 同结构，额外带 ownerName、editTime(YYYY-MM-DD)
 */
async function enrichReferences(userAccessToken, results) {
  if (!results || results.length === 0) return results;
  const auth = { 'Authorization': `Bearer ${userAccessToken}` };

  // 1) 日期 + 作者 open_id via drive metadata（metas 同时返回 latest_modify_time 与 owner_id；
  //    搜索结果常缺 owner_id，这里用 metas 补齐，作者才能查得到）
  const dateByToken = new Map();
  const ownerByToken = new Map();
  try {
    const request_docs = results
      .filter(r => r.token && r.type && r.source !== 'kb' && r.source !== 'message')   // 本地KB/会话消息不查云盘元数据
      .map(r => ({ doc_token: r.token, doc_type: r.type }));
    if (request_docs.length) {
      const res = await fetch(`${BASE}/drive/v1/metas/batch_query`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_docs }),
      });
      const j = await res.json();
      if (j.code === 0) {
        for (const m of (j.data?.metas || [])) {
          dateByToken.set(m.doc_token, fmtDate(m.latest_modify_time));
          if (m.owner_id) ownerByToken.set(m.doc_token, m.owner_id);
        }
      }
    }
  } catch (_e) { /* 日期/作者可选 */ }

  // 2) 作者姓名 + 头像 via contact batch（需 contact:contact.base:readonly；未授予返回 99991679 → 静默跳过，不显示作者）
  const nameById = new Map();
  const avatarById = new Map();
  const ownerIds = [...new Set([...results.map(r => r.owner).filter(Boolean), ...ownerByToken.values()])];
  if (ownerIds.length) {
    try {
      const qs = ownerIds.map(id => 'user_ids=' + encodeURIComponent(id)).join('&');
      const res = await fetch(`${BASE}/contact/v3/users/batch?user_id_type=open_id&${qs}`, { headers: auth });
      const j = await res.json();
      if (j.code === 0) {
        for (const u of (j.data?.items || [])) {
          nameById.set(u.open_id, u.name);
          const av = u.avatar && (u.avatar.avatar_72 || u.avatar.avatar_240 || u.avatar.avatar_origin);
          if (av) avatarById.set(u.open_id, av);
        }
      }
    } catch (_e) { /* 姓名/头像可选 */ }
  }

  return results.map(r => {
    const oid = r.owner || ownerByToken.get(r.token) || '';
    return {
      ...r,
      editTime:  dateByToken.get(r.token) || r.editTime || '',
      ownerName: nameById.get(oid) || '',
      ownerAvatar: avatarById.get(oid) || '',
    };
  });
}

/** 列号 → 字母（1→A, 26→Z, 27→AA）。用于拼 sheet 读值范围。 */
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s || 'A';
}

/**
 * 读取电子表格正文（以用户身份）。v3 列出工作表 → v2 批量读值 → 拼成文本。
 * 需 sheets:spreadsheet:read。为控成本/延迟：最多前 3 个工作表、每表前 200 行 × 26 列。
 */
async function fetchSheetContent(userAccessToken, sheetToken) {
  const auth = { 'Authorization': `Bearer ${userAccessToken}` };
  const metaRes = await fetch(`${BASE}/sheets/v3/spreadsheets/${encodeURIComponent(sheetToken)}/sheets/query`, { headers: auth });
  const metaJ = await metaRes.json();
  if (metaJ.code !== 0) throw new Error(`sheets query error: code=${metaJ.code} msg=${metaJ.msg}`);
  const sheets = (metaJ.data?.sheets || []).slice(0, 3);
  const parts = [];
  for (const sh of sheets) {
    const rows = Math.min(sh.grid_properties?.row_count || 0, 200);
    const cols = Math.min(sh.grid_properties?.column_count || 0, 26);
    if (!rows || !cols) continue;
    const range = `${sh.sheet_id}!A1:${colLetter(cols)}${rows}`;
    const vRes = await fetch(
      `${BASE}/sheets/v2/spreadsheets/${encodeURIComponent(sheetToken)}/values/${range}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`,
      { headers: auth });
    const vJ = await vRes.json();
    if (vJ.code !== 0) continue;
    const values = vJ.data?.valueRange?.values || [];
    const lines = values
      .map(row => (row || []).map(c => (c == null ? '' : String(c))).join(' | '))
      .filter(line => line.replace(/[|\s]/g, '') !== '');   // 跳过空行
    if (lines.length) parts.push(`【${sh.title || '工作表'}】\n` + lines.join('\n'));
  }
  return parts.join('\n\n').slice(0, 8000);
}

/**
 * 读取单篇文档内容（以用户身份）
 * @param {string} userAccessToken
 * @param {{ title, type, token }} item  — searchDocs 返回的一项
 * @returns {Promise<{ title: string, content: string }>}
 */
async function fetchDoc(userAccessToken, item) {
  const { type, token } = item;
  const _fxKey = 'D:' + type + ':' + token;
  const _cached = fixtureGet(_fxKey);
  if (_cached) return _cached;
  const _r = await _fetchDocImpl(userAccessToken, item);
  fixtureSet(_fxKey, _r);
  return _r;
}

async function _fetchDocImpl(userAccessToken, item) {
  const { title, type, token } = item;

  // 支持读取正文的类型：docx / wiki / sheet；其余返回空
  if (type !== 'docx' && type !== 'wiki' && type !== 'sheet') {
    return { title, content: '' };
  }

  try {
    if (type === 'docx') {
      // docId = docx document_id（= token），供后续深链定位到具体块
      return { title, content: await fetchDocxContent(userAccessToken, token), docId: token };
    }
    if (type === 'sheet') {
      // 表格无块级深链，只回正文
      return { title, content: await fetchSheetContent(userAccessToken, token) };
    }

    // type === 'wiki'：先拿 obj_token / obj_type
    const nodeRes = await fetch(
      `${BASE}/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
      { headers: { 'Authorization': `Bearer ${userAccessToken}` } },
    );
    const nodeJ = await nodeRes.json();
    if (nodeJ.code !== 0) {
      throw new Error(`wiki get_node error: code=${nodeJ.code} msg=${nodeJ.msg}`);
    }
    const { obj_token, obj_type } = nodeJ.data?.node || {};
    if (obj_type === 'docx') {
      return { title, content: await fetchDocxContent(userAccessToken, obj_token), docId: obj_token };
    }
    if (obj_type === 'sheet') {
      return { title, content: await fetchSheetContent(userAccessToken, obj_token) };
    }
    return { title, content: '' };

  } catch (_err) {
    // 任何读取失败都降级为空内容，不让整个流程崩溃
    return { title, content: '' };
  }
}

/** 提取一个 block 的纯文本（text/heading/bullet/ordered 等都在 elements[].text_run.content） */
function blockText(b) {
  const fields = ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'quote', 'todo', 'code'];
  for (const f of fields) {
    const el = b[f] && b[f].elements;
    if (Array.isArray(el)) {
      return el.map(e => (e.text_run && e.text_run.content) || '').join('');
    }
  }
  return '';
}

/**
 * 在 docx 文档块里找到与关键词最匹配的块，返回其 block_id（用于深链定位）。
 * 找不到返回 ''。任何失败都静默降级。
 */
async function findAnchorBlock(userAccessToken, docId, keywords) {
  const kws = String(keywords || '').split(/\s+/).filter(Boolean);
  if (!docId || !kws.length) return '';
  try {
    const res = await fetch(`${BASE}/docx/v1/documents/${encodeURIComponent(docId)}/blocks?page_size=500`, {
      headers: { 'Authorization': `Bearer ${userAccessToken}` },
    });
    const j = await res.json();
    if (j.code !== 0) return '';
    let best = '', bestScore = 0;
    for (const b of (j.data?.items || [])) {
      const t = blockText(b);
      if (!t) continue;
      const score = kws.reduce((s, k) => s + (t.includes(k) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = b.block_id; }
    }
    return bestScore > 0 ? best : '';
  } catch (_e) {
    return '';
  }
}

/** 内部：读 docx raw_content */
async function fetchDocxContent(userAccessToken, docxToken) {
  const url = `${BASE}/docx/v1/documents/${encodeURIComponent(docxToken)}/raw_content`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${userAccessToken}` },
  });
  const j = await res.json();
  if (j.code !== 0) {
    throw new Error(`docx raw_content error: code=${j.code} msg=${j.msg}`);
  }
  return j.data?.content || '';
}

/** 从文本里解析飞书文档链接 → [{type,token,url,...}]，用于"总结这篇文档"场景 */
const URL_TYPE = { docx: 'docx', docs: 'doc', wiki: 'wiki', sheets: 'sheet', base: 'bitable', file: 'file', slides: 'slides', mindnotes: 'mindnote', wik: 'wiki' };
function parseFeishuDocUrls(text) {
  const re = /https?:\/\/[\w.-]*feishu\.(?:cn|com)\/(docx|docs|wiki|sheets|base|file|slides|mindnotes)\/([A-Za-z0-9]+)/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text || ''))) {
    const type = URL_TYPE[m[1].toLowerCase()] || 'docx';
    const token = m[2];
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ index: out.length + 1, title: '', type, token, url: m[0], owner: '', editTime: '', source: 'url' });
  }
  return out;
}

// docx 块构造：type→字段名（已连通性验证：2 文本 / 3 H1 / 4 H2 / 12 无序 / 13 有序）
const BLOCK_KEY = { 2: 'text', 3: 'heading1', 4: 'heading2', 12: 'bullet', 13: 'ordered' };
function docBlock(type, elements) {
  const b = { block_type: type };
  b[BLOCK_KEY[type]] = { elements };
  return b;
}
function textEl(content, url) {
  const el = { text_run: { content: content || '' } };
  if (url) el.text_run.text_element_style = { link: { url: encodeURIComponent(url) } };
  return el;
}
// 把答案 markdown 粗解析成飞书块，保留有序/无序列表与小标题
function answerToBlocks(answer) {
  const clean = String(answer || '').replace(/\[\d+\]/g, '').trim();
  const out = [];
  for (const raw of clean.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push(docBlock(4, [textEl(m[1])]));
    else if ((m = line.match(/^\d+[.、)]\s*(.*)$/))) out.push(docBlock(13, [textEl(m[1])]));
    else if ((m = line.match(/^[-*•]\s+(.*)$/))) out.push(docBlock(12, [textEl(m[1])]));
    else out.push(docBlock(2, [textEl(line.replace(/\*\*/g, ''))]));
  }
  return out;
}

/**
 * 导出问答到飞书「我的空间」新建 docx 文档（用户身份）。
 * 结构：H1 问题 → 正文(保留列表) → H2 参考资料(带链接) → 来源脚注
 * 需要用户 scope：docx:document / docx:document:create
 * @param {{question, answer, references?: Array<{title,url}>}} payload
 * @returns {Promise<{documentId, url, title}>}
 */
async function exportToDoc(userAccessToken, { question, answer, references, sharer, dateStr }) {
  const auth = { 'Authorization': `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' };
  const q = (question || '知识问答').trim();
  const title = q.length > 40 ? q.slice(0, 40) : q;

  // 1) 创建文档（文档标题即问题，飞书链接预览卡会把它当大标题展示）
  const cr = await fetch(`${BASE}/docx/v1/documents`, { method: 'POST', headers: auth, body: JSON.stringify({ title }) });
  const cj = await cr.json();
  if (cj.code !== 0) throw new Error(`创建文档失败：${cj.msg || cr.status}（code=${cj.code}）`);
  const documentId = cj.data.document.document_id;

  // 2) 组装块：首行用一条"知识问答 · 分享于 · AI 生成"副标题（对标飞书知识问答分享卡的样式），
  //    不再重复问题大标题（标题已是文档名，链接预览卡会展示）。
  const subtitle = `知识问答 · ${sharer ? sharer + '分享' : ''}${dateStr ? '于' + dateStr : ''} · AI 基于相关知识生成`.replace(/ ·  · /, ' · ');
  const children = [docBlock(2, [textEl(subtitle)]), ...answerToBlocks(answer)];
  if (Array.isArray(references) && references.length) {
    children.push(docBlock(4, [textEl('参考资料')]));
    references.forEach((r, i) => {
      const label = (r.title || r.url || ('资料 ' + (i + 1))).trim();
      children.push(docBlock(13, [textEl(label, r.url || '')]));
    });
  }
  children.push(docBlock(2, [textEl('— 来自飞书知识问答，AI 基于你有权限的资料生成')]));

  // 3) 分批插入到根块下（每批 ≤45，规避单次块数上限），index 递增追加
  for (let i = 0; i < children.length; i += 45) {
    const batch = children.slice(i, i + 45);
    const ir = await fetch(`${BASE}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      method: 'POST', headers: auth, body: JSON.stringify({ index: i, children: batch }),
    });
    const ij = await ir.json();
    if (ij.code !== 0) throw new Error(`写入内容失败：${ij.msg || ir.status}（code=${ij.code}）`);
  }

  return { documentId, url: `https://feishu.cn/docx/${documentId}`, title };
}

/**
 * 检索飞书会话/聊天记录（用户身份）：搜索消息 → 读取正文 → 组装成候选（content 预填）。
 * 需要用户 scope：search:message + im:message.p2p_msg:get_as_user
 * 失败（无权限等）静默返回 []，不阻断文档主检索。
 * @returns {Promise<Array<{index,type:'message',token,source:'message',title,content,chatId,url,owner,editTime}>>}
 */
// 清洗单条消息文本；是垃圾（机器人输出 / 思考泄漏 / SSE 流 / 本系统推送）或空 → 返回 ''。
function cleanMsgText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/```+\s*thinking/i.test(text) || /用户(询问|提问)["“].{0,20}["”]/.test(text)) return '';
  if (/来自「飞书知识问答」/.test(text) || /^📌/.test(text) || /^⏰\s*定时追踪/.test(text)) return '';
  if (/\bevent:\s*\w+\s+data:/i.test(text) || /"(label|delta|references|token)"\s*:/.test(text)) return '';
  if (/正在(生成回答|搜索知识库|阅读相关文档|精排相关内容|甄别相关性)|已完成检索|深度思考中/.test(text)) return '';
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // markdown 链接 [文字](url) → 只留文字，避免留下残缺的 [..]( 干扰判官
    .replace(/```+\s*[a-zA-Z]*/g, ' ').replace(/```+/g, ' ')
    .replace(/\\[nrt]/g, ' ').replace(/^\s*thinking[:：\s]*/i, '')
    .replace(/@_all/g, '').replace(/@_user_\d+/g, '')
    .replace(/\s+/g, ' ').trim();
}

// 搜索经常命中问句或“这份材料没提到”的局部判断，真正答案在后续回复。
// 当命中标题本身不确定时，优先用窗口里含明确业务状态的回复作为展示标题；
// 检索正文仍完整保留命中消息与上下文，不改变判官看到的证据。
function messageWindowTitle(matchText, afterTexts) {
  const match = String(matchText || '').trim();
  const uncertain = /[？?吗呢么]\s*$|好像|可能|不确定|不涉及|未涉及|没涉及|没有提到|未提到|不包含|未包含/.test(match);
  if (!uncertain || !afterTexts || !afterTexts.length) return match;
  const ranked = afterTexts.map((text, index) => {
    const value = String(text || '').trim();
    let score = 0;
    if (/(需求|项目|任务|版本|排期|开发|上线|迁移|验收)/.test(value)) score += 3;
    if (/(已经|已|正在|目前|暂时|计划|预计|启动|完成|暂停|取消|下一|下周|本周)/.test(value)) score += 2;
    if (value.length >= 8) score += 1;
    return { value, index, score };
  }).filter(x => x.value && x.score >= 3)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.length ? ranked[0].value : match;
}

// 拉匹配消息前后的真人文本消息作上下文。聊天是一问一答——检索匹配到的常是"问"，答在后一两条。
// 返回结构化 turn，而不是提前压平成无角色文本：后续向量只匹配命中消息，法官则同时审查后续回复，
// 避免“问题本身很像但没有答案”与“问题后紧跟有效回答”被当成同一种候选。
async function fetchContext(auth, chatId, matchId, matchMs, before, after, maxGapMs = 10 * 60 * 1000) {
  before = before || 0; after = after == null ? 3 : after;
  if (!chatId || !matchMs || (before <= 0 && after <= 0)) return { pre: [], post: [] };
  try {
    // 飞书 start_time 精确到秒；回退 1 秒，避免同秒多条消息时匹配项恰好落在分页边界外。
    const startMs = before > 0 ? matchMs - 30 * 60 * 1000 : matchMs - 1000;
    const pageSize = before > 0 ? 50 : Math.min(50, Math.max(8, after + 5));
    const r = await fetch(`${BASE}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&start_time=${Math.floor(startMs / 1000)}&page_size=${pageSize}&sort_type=ByCreateTimeAsc`, { headers: auth });
    const j = await r.json();
    if (j.code !== 0) return { pre: [], post: [] };
    const items = (j.data && j.data.items) || [];
    const idx = items.findIndex(m => m.message_id === matchId);
    const grab = (arr, n) => {
      const out = [];
      for (const m of arr) {
        if (out.length >= n) break;
        if (!m.sender || m.sender.sender_type !== 'user' || m.msg_type !== 'text') continue;
        let t = ''; try { t = JSON.parse(m.body.content).text || ''; } catch (_e) { t = ''; }
        t = cleanMsgText(t);
        // 上下文里的纯链接消息去掉（对判相关性是噪音，还会稀释问答）
        if (t) t = t.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
        const createdAt = Number(m.create_time) || 0;
        if (t) out.push({
          text: t,
          senderId: (m.sender && m.sender.id) || '',
          createTime: createdAt,
          messageId: m.message_id || '',
        });
      }
      return out;
    };
    const pre = (before > 0 && idx > 0) ? grab(items.slice(0, idx).reverse(), before).reverse() : [];
    // 找不到 matchId 时不能武断地把第一条当命中项再跳过；按时间过滤才能避免漏掉真实第一条回复。
    const afterItems = idx >= 0
      ? items.slice(idx + 1)
      : items.filter(m => m.message_id !== matchId && Number(m.create_time) >= matchMs);
    const post = after > 0
      ? grab(afterItems.filter(m => !Number(m.create_time) || Number(m.create_time) - matchMs <= maxGapMs), after)
      : [];
    return { pre, post };
  } catch (_e) { return { pre: [], post: [] }; }
}

async function searchMessages(userAccessToken, query, size = 8, opts = {}) {
  const auth = { 'Authorization': `Bearer ${userAccessToken}`, 'Content-Type': 'application/json; charset=utf-8' };
  const ctxAfter = opts.after == null ? 3 : opts.after;   // 向后补几条（答案）
  const ctxBefore = opts.before || 0;                     // 向前补几条（问题）
  const maxGapMs = opts.maxGapMs == null ? 10 * 60 * 1000 : Math.max(0, Number(opts.maxGapMs));
  let ids = [];
  try {
    const sr = await fetch(`${BASE}/search/v2/message`, { method: 'POST', headers: auth, body: JSON.stringify({ query, page_size: size }) });
    const sj = await sr.json();
    if (sj.code !== 0) return [];
    ids = (sj.data && sj.data.items) || [];
  } catch (_e) { return []; }

  const msgs = await Promise.all(ids.slice(0, size).map(async (id) => {
    try {
      const mr = await fetch(`${BASE}/im/v1/messages/${id}`, { headers: auth });
      const mj = await mr.json();
      if (mj.code !== 0) return null;
      const it = mj.data && mj.data.items && mj.data.items[0];
      if (!it || it.msg_type !== 'text') return null;
      // 根本过滤：只保留**真人**发的消息。sender_type==='app'/'anonymous'/'system' 一律丢弃
      // ——机器人/应用发的（含本系统推送的分享、定时追踪、卡片、其它 bot）都是噪音，绝不进检索。
      if (!it.sender || it.sender.sender_type !== 'user') return null;
      let raw = '';
      try { raw = JSON.parse(it.body.content).text || ''; } catch (_e) { raw = ''; }
      const text = cleanMsgText(raw);                 // 清洗 + 垃圾过滤（机器人/思考/SSE/推送）
      if (!text || text.length < 4) return null;      // 匹配消息本身太短/是垃圾就跳过
      const chatId = it.chat_id || '';
      const date = it.create_time ? new Date(Number(it.create_time)).toISOString().slice(0, 10) : '';
      // 补会话上下文：匹配到的常是"问"，答在后一两条——拼成一小段问答给法官/模型，答案才看得到
      const { pre, post } = await fetchContext(auth, chatId, id, Number(it.create_time), ctxBefore, ctxAfter, maxGapMs);
      const beforeTexts = pre.map(x => x.text);
      const afterTexts = post.map(x => x.text);
      const displayTitle = messageWindowTitle(text, afterTexts);
      const content = [
        ...beforeTexts.map((t, i) => `[前文${i + 1}] ${t}`),
        `[命中消息] ${text}`,
        ...afterTexts.map((t, i) => `[后续回复${i + 1}] ${t}`),
      ].join('\n');
      return {
        type: 'message', token: id, source: 'message',
        title: displayTitle.length > 36 ? displayTitle.slice(0, 36) + '…' : displayTitle,
        content, chatId,
        matchText: text,
        beforeTexts,
        afterTexts,
        contextMessageIds: [...pre.map(x => x.messageId), id, ...post.map(x => x.messageId)].filter(Boolean),
        createTimeMs: Number(it.create_time) || 0,
        // 消息定位：applink 的 `position`（消息在会话中的序号，未文档化但实测有效）能跳转并高亮到该条消息，
        // 不只是打开会话。message_position 来自消息读取接口。缺 position 时退化为只打开会话。
        url: chatId
          ? `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}` + (it.message_position != null ? `&position=${it.message_position}` : '')
          : '',
        owner: (it.sender && it.sender.id) || '',   // 发件人 open_id → enrichReferences 解析头像+姓名（sender_type 已限定 user）
        editTime: date,
      };
    } catch (_e) { return null; }
  }));
  return msgs.filter(Boolean).map((m, i) => ({ index: i + 1, ...m }));
}

// 列出用户所在的会话（群 + 单聊），用于"分享至会话"的选择器。需 im:chat:readonly。
async function listChats(userAccessToken) {
  const res = await fetch(`${BASE}/im/v1/chats?user_id_type=open_id&page_size=50&sort_type=ByActiveTimeDesc`, {
    headers: { 'Authorization': `Bearer ${userAccessToken}` },
  });
  const j = await res.json();
  if (j.code !== 0) { const e = new Error(j.msg || 'list chats failed'); e.code = j.code; throw e; }
  return ((j.data && j.data.items) || []).map(c => ({
    chatId: c.chat_id, name: c.name || '(未命名会话)', avatar: c.avatar || '', description: c.description || '',
  }));
}

// 从"用户所在的群"聚合同事名单（open_id + 姓名），供"转发给指定同事"选人。用现有 im:chat:readonly + im:message 权限即可。
// 取最活跃的若干个群、并发拉成员、去重、排除自己。成本有限时全量；这里取前 maxGroups 个群兜住耗时。
async function listGroupContacts(userAccessToken, selfOpenId, maxGroups = 20) {
  const chats = await listChats(userAccessToken);
  const groups = chats.slice(0, maxGroups);
  const seen = new Map();
  await Promise.all(groups.map(async (c) => {
    try {
      const r = await fetch(`${BASE}/im/v1/chats/${c.chatId}/members?member_id_type=open_id&page_size=100`, {
        headers: { 'Authorization': `Bearer ${userAccessToken}` },
      });
      const j = await r.json();
      ((j.data && j.data.items) || []).forEach((m) => {
        if (m.member_id && m.member_id !== selfOpenId && !seen.has(m.member_id)) {
          seen.set(m.member_id, { openId: m.member_id, name: m.name || '' });
        }
      });
    } catch (_e) { /* 单个群失败忽略 */ }
  }));
  return [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
}

// 以「本人身份」发一条消息（user_access_token → 发出者就是用户本人，不是机器人；实测 sender_type=user）。
// 需用户 scope im:message + im:message.send_as_user。msgType: 'text' | 'interactive'(卡片)。
// content 为对象（text: {text} / interactive: 卡片 JSON），函数内部 JSON.stringify。
// receiveIdType: open_id(某人) | chat_id(群/会话)。返回飞书原始 json。
async function sendMessageAsUser(userAccessToken, receiveIdType, receiveId, msgType, content) {
  const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
  });
  return res.json().catch(() => ({}));
}

// 构造"知识问答分享卡片"（对标飞书原生转发：蓝色标题栏 + AI 副标题 + 答案摘要 + 整卡点击跳文档）。
// title=问题，answer=答案正文（会截断成摘要），url=云文档链接，sharer=分享人姓名，dateStr=分享日期。
function buildShareCard({ title, answer, url, sharer, dateStr }) {
  const clean = String(answer || '').replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
  const preview = clean.length > 140 ? clean.slice(0, 140) + '…' : clean;
  const sub = `知识问答 · ${sharer || ''}分享${dateStr ? '于' + dateStr : ''} · AI 基于相关知识生成`;
  return {
    config: { wide_screen_mode: true },
    card_link: { url },                                   // 点整张卡片 → 打开云文档
    header: { template: 'blue', title: { tag: 'plain_text', content: String(title || '知识问答').slice(0, 60) } },
    elements: [
      { tag: 'note', elements: [{ tag: 'plain_text', content: sub }] },
      { tag: 'div', text: { tag: 'lark_md', content: preview || '（点击查看完整文档）' } },
      { tag: 'hr' },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整文档' }, type: 'primary', url }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '来自飞书知识问答 · AI 基于你有权限的资料生成' }] },
    ],
  };
}

module.exports = { searchDocs, fetchDoc, enrichReferences, parseFeishuDocUrls, findAnchorBlock, fixtureFlush, exportToDoc, searchMessages, listChats, listGroupContacts, sendMessageAsUser, buildShareCard };
