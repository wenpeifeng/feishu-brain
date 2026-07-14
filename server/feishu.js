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
async function searchDocs(userAccessToken, query, pageSize = 9) {
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
    merged.push({ ...r, index: merged.length + 1 });
  }
  // 控制总数，避免一堆低相关文档（wiki 已优先靠前）
  return merged.slice(0, pageSize);
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

  // 1) 日期（+ owner 兜底）via drive metadata
  const dateByToken = new Map();
  try {
    const request_docs = results
      .filter(r => r.token && r.type)
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
        }
      }
    }
  } catch (_e) { /* 日期可选 */ }

  // 2) 作者姓名 via contact batch（需 contact:user.base:readonly，未授予则跳过）
  const nameById = new Map();
  const ownerIds = [...new Set(results.map(r => r.owner).filter(Boolean))];
  if (ownerIds.length) {
    try {
      const qs = ownerIds.map(id => 'user_ids=' + encodeURIComponent(id)).join('&');
      const res = await fetch(`${BASE}/contact/v3/users/batch?user_id_type=open_id&${qs}`, { headers: auth });
      const j = await res.json();
      if (j.code === 0) {
        for (const u of (j.data?.items || [])) nameById.set(u.open_id, u.name);
      }
    } catch (_e) { /* 姓名可选 */ }
  }

  return results.map(r => ({
    ...r,
    editTime:  dateByToken.get(r.token) || r.editTime || '',
    ownerName: nameById.get(r.owner) || '',
  }));
}

/**
 * 读取单篇文档内容（以用户身份）
 * @param {string} userAccessToken
 * @param {{ title, type, token }} item  — searchDocs 返回的一项
 * @returns {Promise<{ title: string, content: string }>}
 */
async function fetchDoc(userAccessToken, item) {
  const { title, type, token } = item;

  // 不支持内容读取的类型，直接返回空
  if (type !== 'docx' && type !== 'wiki') {
    return { title, content: '' };
  }

  try {
    if (type === 'docx') {
      return { title, content: await fetchDocxContent(userAccessToken, token) };
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
    if (obj_type !== 'docx') {
      return { title, content: '' };
    }
    return { title, content: await fetchDocxContent(userAccessToken, obj_token) };

  } catch (_err) {
    // 任何读取失败都降级为空内容，不让整个流程崩溃
    return { title, content: '' };
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

module.exports = { searchDocs, fetchDoc, enrichReferences };
