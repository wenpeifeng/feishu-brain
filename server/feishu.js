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
async function searchDocs(userAccessToken, query, pageSize = 9) {
  const url = `${BASE}/suite/docs-api/search/object`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ search_key: query, count: pageSize, offset: 0 }),
  });

  const j = await res.json();
  if (j.code !== 0) {
    throw new Error(`feishu search error: code=${j.code} msg=${j.msg}`);
  }

  const entities = j.data?.docs_entities || [];
  return entities.map((item, i) => ({
    index:    i + 1,
    title:    item.title,
    type:     item.docs_type,
    token:    item.docs_token,
    url:      buildUrl(item.docs_type, item.docs_token),
    owner:    item.owner_id,
    editTime: '',
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

module.exports = { searchDocs, fetchDoc };
