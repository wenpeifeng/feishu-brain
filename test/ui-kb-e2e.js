'use strict';

// 上传知识库增量索引管理页：桌面/移动真实 DOM 几何回归。
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const sessions = Object.values(JSON.parse(fs.readFileSync('data/sessions.json', 'utf8')));
  const conversationsRaw = JSON.parse(fs.readFileSync('data/conversations.json', 'utf8'));
  const conversations = Array.isArray(conversationsRaw) ? conversationsRaw : Object.values(conversationsRaw);
  const target = conversations.find(x => /[奥澳]储还有需求吗/.test(String(x.title || '')));
  const session = sessions
    .filter(x => !target || x.openId === target.ownerOpenId)
    .sort((a, b) => b.expireAt - a.expireAt)[0];
  if (!session) throw new Error('没有本地会话');
  const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = pages.find(x => x.type === 'page');
  if (!page) throw new Error('没有可用的 Chrome page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'browser evaluation failed');
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:3000/login.html' }); await wait(500);
  await evaluate(`localStorage.setItem('kb_token', ${JSON.stringify(session.token)})`);
  await send('Page.navigate', { url: 'http://localhost:3000/' }); await wait(1600);
  await evaluate(`document.getElementById('knowledgeBaseBtn').click()`); await wait(400);
  await evaluate(`renderKbList([{
    id:'ui-fixture', title:'企业知识库增量索引与权限校验规范_最终商用版本.docx',
    uploadedAt:'2026-07-20T00:00:00.000Z', updatedAt:'2026-07-23T00:00:00.000Z',
    revision:7, size:12888, embedded:true, chunkCount:31, vectorCount:31
  }])`);

  const rows = [];
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 600 });
    await wait(160);
    const row = await evaluate(`(() => {
      const page=document.querySelector('.kb-page'), item=document.querySelector('.kb-item');
      const title=document.querySelector('.kb-item-title'), actions=document.querySelector('.kb-item-actions');
      const dropText=document.querySelector('.kb-drop-txt');
      const buttons=[...document.querySelectorAll('.kb-item-action,.kb-item-del,.kb-reindex-btn')];
      const itemButtons=[...document.querySelectorAll('.kb-item-action,.kb-item-del')];
      const rect=e=>e&&e.getBoundingClientRect();
      const pr=rect(page), ir=rect(item), ar=rect(actions);
      return {
        width:innerWidth, page:pr&&{left:pr.left,right:pr.right,width:pr.width},
        item:ir&&{left:ir.left,right:ir.right,width:ir.width},
        actions:ar&&{left:ar.left,right:ar.right,width:ar.width},
        dropText:dropText&&{width:dropText.getBoundingClientRect().width,height:dropText.getBoundingClientRect().height},
        docOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        itemOverflow:item.scrollWidth>item.clientWidth,
        titleEllipsis:getComputedStyle(title).textOverflow,
        meta:document.querySelector('.kb-item-meta').innerText,
        labels:buttons.map(x=>x.getAttribute('title')||x.textContent.trim()),
        allContained:itemButtons.every(x=>{const r=x.getBoundingClientRect();return r.left>=ir.left-1&&r.right<=ir.right+1;})
      };
    })()`);
    rows.push(row);
    if (row.docOverflow || row.itemOverflow || row.titleEllipsis !== 'ellipsis' || !row.allContained) {
      throw new Error('知识库布局失败：' + JSON.stringify(row));
    }
    if (width === 390 && (!row.dropText || row.dropText.width < 280 || row.dropText.height > 90)) {
      throw new Error('移动端上传说明不可读：' + JSON.stringify(row.dropText));
    }
    if (!/v7/.test(row.meta) || !/31 块/.test(row.meta)) throw new Error('版本/块数未展示：' + JSON.stringify(row));
    if (!row.labels.some(x => /编辑文字/.test(x)) || !row.labels.some(x => /替换/.test(x)) || !row.labels.some(x => /重新建立/.test(x))) {
      throw new Error('增量索引操作入口不完整：' + JSON.stringify(row.labels));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`/tmp/feishu-kb-index-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const readonly = await evaluate(`(() => {
    kbScope='organization'; kbCanManage=false; updateKbScopeUi();
    renderKbList([{id:'org-fixture',title:'组织统一制度.docx',revision:2,updatedAt:'2026-07-23',size:800,chunkCount:3}],false);
    return {
      tabs:[...document.querySelectorAll('[data-kb-scope]')].map(x=>x.textContent.trim()),
      dropHidden:document.getElementById('kbDrop').hidden,
      rebuildHidden:document.getElementById('kbReindexBtn').hidden,
      readonly:!!document.querySelector('.kb-readonly'),
      mutationButtons:document.querySelectorAll('.kb-item-edit,.kb-item-replace,.kb-item-del').length,
      hint:document.getElementById('kbScopeHint').textContent
    };
  })()`);
  if (readonly.tabs.length !== 2 || !readonly.dropHidden || !readonly.rebuildHidden || !readonly.readonly || readonly.mutationButtons !== 0 || !/仅管理员/.test(readonly.hint)) {
    throw new Error('组织知识库只读态失败：' + JSON.stringify(readonly));
  }
  rows.push({ organizationReadonly: readonly });
  await evaluate(`(() => {
    chatTitle.textContent='组织管理';
    chatContainer.innerHTML='<div class="org-page"><div class="org-page-head"><div><h2>组织管理</h2><p>成员首次登录后自动加入当前飞书组织。个人知识库、模型配置和开发者设置始终只属于本人。</p></div></div><div id="orgBody"></div></div>';
    currentUser={openId:'owner-ui',name:'Owner',isAdmin:true};
    renderOrganization({organization:{name:'示例企业',memberCount:3},role:'owner',isAdmin:true,isOwner:true,members:[
      {openId:'owner-ui',name:'Owner',role:'owner',lastSeenAt:'2026-07-23'},
      {openId:'admin-ui',name:'知识库管理员',role:'admin',lastSeenAt:'2026-07-22'},
      {openId:'member-ui',name:'普通成员',role:'member',lastSeenAt:'2026-07-21'}
    ]});
  })()`);
  const orgLayouts = [];
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 600 });
    await wait(120);
    const layout = await evaluate(`(() => {
      const page=document.querySelector('.org-page'), members=document.querySelector('.org-members');
      const pr=page.getBoundingClientRect(), mr=members.getBoundingClientRect();
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        page:{left:pr.left,right:pr.right},members:{left:mr.left,right:mr.right},
        summaryCols:getComputedStyle(document.querySelector('.org-summary')).gridTemplateColumns,
        rows:document.querySelectorAll('.org-member').length,selects:document.querySelectorAll('.org-role-select').length,
        contained:mr.left>=pr.left-1&&mr.right<=pr.right+1};
    })()`);
    orgLayouts.push(layout);
    if (layout.overflow || !layout.contained || layout.rows !== 3 || layout.selects !== 2) throw new Error('组织管理布局失败：'+JSON.stringify(layout));
  }
  rows.push({ organizationLayouts: orgLayouts });
  ws.close();
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error('ui-kb-e2e FAILED:', e.message); process.exit(1); });
