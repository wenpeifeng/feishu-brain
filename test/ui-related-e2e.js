'use strict';

// 真实 Chrome DOM 验收：需先以 --remote-debugging-port=9222 启动隔离 Chrome，且本地服务运行在 3000。
// 不输出 session/token，只验证已有会话的补充证据组件、位置和默认展开状态。
const fs = require('fs');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const sessions = JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
  const conversationsRaw = JSON.parse(fs.readFileSync('data/conversations.json', 'utf8'));
  const conversations = Array.isArray(conversationsRaw) ? conversationsRaw : Object.values(conversationsRaw);
  const target = conversations.find(x => /[奥澳]储还有需求吗/.test(String(x.title || '')));
  const session = Object.values(sessions)
    .filter(x => !target || x.openId === target.ownerOpenId)
    .sort((a, b) => b.expireAt - a.expireAt)[0];
  if (!session) throw new Error('没有有效本地会话');
  const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = pages.find(x => x.type === 'page');
  if (!page) throw new Error('没有可用的 Chrome page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'browser evaluation failed');
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:3000/login.html' }); await wait(700);
  await evaluate(`localStorage.setItem('kb_token', ${JSON.stringify(session.token)})`);
  await send('Page.navigate', { url: 'http://localhost:3000/' }); await wait(2200);
  const clicked = await evaluate(`(() => { const rows=[...document.querySelectorAll('.history-item')]; const row=rows.find(x=>x.textContent.trim().startsWith('奥储还有需求吗')) || rows.find(x=>x.textContent.trim().startsWith('澳储还有需求吗')); if(!row)return false; row.click(); return true; })()`);
  if (!clicked) throw new Error('没有找到澳储历史会话');
  await wait(1600);
  const result = await evaluate(`(() => {
    const box=document.querySelector('.related-evidence');
    const refs=document.querySelector('.references');
    const disclaimer=document.querySelector('.ai-disclaimer');
    if(!box) return {exists:false, bodyText:document.body.innerText.slice(-500)};
    const list=box.querySelector('.re-list');
    const br=box.getBoundingClientRect(), rr=refs&&refs.getBoundingClientRect(), dr=disclaimer&&disclaimer.getBoundingClientRect();
    const clip=box.querySelector('.re-clip'), last=box.querySelector('.re-item:last-child');
    const lr=last&&last.getBoundingClientRect(), cr=clip&&clip.getBoundingClientRect(), lir=list.getBoundingClientRect();
    const clipped=[...box.querySelectorAll('.re-main strong,.re-main span')];
    return {exists:true, open:box.classList.contains('open'), display:getComputedStyle(list).display,
      count:box.querySelectorAll('.re-item').length, titles:[...box.querySelectorAll('.re-main strong')].map(x=>x.textContent.trim()),
      width:Math.round(br.width), aligned:!!rr && Math.abs(br.left-rr.left)<2 && Math.abs(br.width-rr.width)<2,
      ordered:!!rr && !!dr && rr.bottom<=br.top && br.bottom<=dr.top, contained:[...box.querySelectorAll('.re-item')].every(x=>x.scrollWidth<=x.clientWidth),
      contentVisible:!!lr && !!cr && lr.bottom<=cr.bottom+.5 && lr.bottom<=lir.bottom+.5 && list.scrollHeight<=list.clientHeight+1 && clip.scrollHeight<=clip.clientHeight+1,
      followingGap:dr ? Math.round(dr.top-br.bottom) : -1,
      ellipsis:clipped.every(x=>getComputedStyle(x).textOverflow==='ellipsis'), clipped:clipped.some(x=>x.scrollWidth>x.clientWidth),
      transition:getComputedStyle(box.querySelector('.re-clip')).transitionDuration,
      debug:(document.querySelector('.debug-toggle')||{}).textContent||'', overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  })()`);
  if (!result.exists) throw new Error('更多相关结果组件不存在');
  if (!result.open || result.display !== 'grid') throw new Error('更多相关结果没有默认展开');
  if (result.count < 1) throw new Error('更多相关结果内容为空');
  if (!result.aligned || !result.ordered || !result.contained || !result.contentVisible || result.followingGap < 8 || result.overflow || !result.ellipsis || !result.clipped) throw new Error('更多相关结果布局不正确：' + JSON.stringify(result));
  if (!result.transition || result.transition === '0s') throw new Error('展开收缩没有过渡动画');
  const before = await evaluate(`(() => { const answer=document.querySelector('.message:not(.user) .message-content'); const clip=document.querySelector('.re-clip'); const toggle=document.querySelector('.re-toggle'); const chat=document.getElementById('chatContainer'); return {height:clip.getBoundingClientRect().height,x:answer.getBoundingClientRect().left,toggleTop:toggle.getBoundingClientRect().top,scrollTop:chat.scrollTop,gutter:getComputedStyle(chat).scrollbarGutter}; })()`);
  await evaluate(`document.querySelector('.re-toggle').click()`); await wait(100);
  const middle = await evaluate(`(() => ({height:document.querySelector('.re-clip').getBoundingClientRect().height,aria:document.querySelector('.re-toggle').getAttribute('aria-expanded')}))()`);
  await wait(420);
  const closed = await evaluate(`(() => ({height:document.querySelector('.re-clip').getBoundingClientRect().height,x:document.querySelector('.message:not(.user) .message-content').getBoundingClientRect().left,toggleTop:document.querySelector('.re-toggle').getBoundingClientRect().top,scrollTop:document.getElementById('chatContainer').scrollTop}))()`);
  await evaluate(`document.querySelector('.re-toggle').click()`); await wait(500);
  const reopened = await evaluate(`(() => ({height:document.querySelector('.re-clip').getBoundingClientRect().height,x:document.querySelector('.message:not(.user) .message-content').getBoundingClientRect().left,toggleTop:document.querySelector('.re-toggle').getBoundingClientRect().top,scrollTop:document.getElementById('chatContainer').scrollTop}))()`);
  if (middle.aria !== 'false' || !(middle.height < before.height && middle.height > 0) || closed.height > 1 || Math.abs(reopened.height - before.height) > 2 ||
      Math.abs(closed.x - before.x) > .5 || Math.abs(reopened.x - before.x) > .5 || Math.abs(reopened.toggleTop - closed.toggleTop) > .5 ||
      reopened.scrollTop !== closed.scrollTop || !/stable/.test(before.gutter)) {
    throw new Error('展开收缩动画状态不正确：' + JSON.stringify({ before, middle, closed, reopened }));
  }

  const debugResult = await evaluate(`(async () => {
    const chat=document.getElementById('chatContainer');
    const toggles=[...document.querySelectorAll('.debug-toggle')];
    const toggle=toggles.sort((a,b)=>
      b.closest('.retrieval-debug').querySelectorAll('.debug-row').length -
      a.closest('.retrieval-debug').querySelectorAll('.debug-row').length
    )[0];
    if(!toggle) return {exists:false};
    chat.scrollTop=chat.scrollHeight;
    toggle.click();
    await new Promise(r=>setTimeout(r,430));
    const box=toggle.closest('.retrieval-debug');
    const wrap=box.querySelector('.debug-wrap');
    let related=null, cursor=box.nextElementSibling;
    while(cursor && !cursor.classList.contains('message')){
      if(cursor.matches('.related-evidence,.references')) related=cursor;
      cursor=cursor.nextElementSibling;
    }
    const br=box.getBoundingClientRect(), wr=wrap.getBoundingClientRect(), cr=chat.getBoundingClientRect();
    chat.scrollTop=chat.scrollHeight;
    await new Promise(r=>requestAnimationFrame(r));
    const rr=related&&related.getBoundingClientRect();
    let linkedCitationCount=0, rawCitationCount=0;
    const maxCitation=[...document.querySelectorAll('.message-bubble')].reduce((max,b)=>{
      const refs=b.closest('.message');
      let n=refs, count=0;
      while(n && n.nextElementSibling){
        n=n.nextElementSibling;
        if(n.classList.contains('references')) { count=n.querySelectorAll('.reference-item').length; break; }
        if(n.classList.contains('message')) break;
      }
      linkedCitationCount += b.querySelectorAll('sup.citation a').length;
      rawCitationCount += (b.textContent.match(/\\[\\d+\\]/g)||[]).length;
      const invalid=(b.textContent.match(/\\[(\\d+)\\]/g)||[]).map(x=>Number(x.slice(1,-1))).filter(x=>x>count);
      return Math.max(max, invalid.length);
    },0);
    return {exists:true, aria:toggle.getAttribute('aria-expanded'), open:box.classList.contains('open'),
      wrapHeight:Math.round(wr.height), wrapScrollable:wrap.scrollHeight>wrap.clientHeight,
      boxContained:br.width<=cr.width, relatedReachable:!rr || (rr.top<cr.bottom && rr.bottom>cr.top),
      atBottom:Math.round(chat.scrollHeight-chat.scrollTop-chat.clientHeight), invalidCitationCount:maxCitation,
      linkedCitationCount, rawCitationCount,
      pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  })()`);
  ws.close();
  if (!debugResult.exists || debugResult.aria !== 'true' || !debugResult.open || debugResult.wrapHeight > 342 ||
      !debugResult.boxContained || !debugResult.relatedReachable || debugResult.atBottom > 2 ||
      debugResult.invalidCitationCount || !debugResult.linkedCitationCount || debugResult.rawCitationCount || debugResult.pageOverflow) {
    throw new Error('检索详情展开后的可达性/引用完整性不正确：' + JSON.stringify(debugResult));
  }
  console.log(JSON.stringify({ ...result, animation: { before, middle, closed, reopened }, debug: debugResult }, null, 2));
}

main().catch(err => { console.error('ui-related-e2e FAILED:', err.message); process.exit(1); });
