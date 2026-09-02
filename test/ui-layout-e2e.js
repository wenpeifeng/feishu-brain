'use strict';

// 六断点真实 DOM 回归：不靠截图肉眼判断，直接校验所有回答/证据/输入区域的几何边界。
const fs = require('fs');
const VIEWPORTS = [1920, 1440, 1280, 1024, 768, 390];
const wait = ms => new Promise(r => setTimeout(r, ms));

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
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'browser evaluation failed');
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:3000/login.html' }); await wait(500);
  await evalJs(`localStorage.setItem('kb_token', ${JSON.stringify(session.token)})`);
  await send('Page.navigate', { url: 'http://localhost:3000/' }); await wait(1800);
  const clicked = await evalJs(`(() => { const rows=[...document.querySelectorAll('.history-item')]; const row=rows.find(x=>/[奥澳]储还有需求吗/.test(x.textContent)); if(!row)return false; row.click(); return true; })()`);
  if (!clicked) throw new Error('没有找到澳储历史会话');
  await wait(1200);

  const results = [];
  for (const width of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 768 });
    await wait(180);
    const row = await evalJs(`(() => {
      const main=document.querySelector('.main').getBoundingClientRect();
      const sidebar=document.querySelector('.sidebar');
      const visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
      const sels=['.message','.references','.related-evidence','.retrieval-debug','.ai-disclaimer','.answer-toolbar','.input-card'];
      const nodes=sels.flatMap(s=>[...document.querySelectorAll(s)]).filter(visible);
      const bad=nodes.filter(e=>{const r=e.getBoundingClientRect();return r.left<main.left-1||r.right>main.right+1||r.left<-1||r.right>innerWidth+1;}).map(e=>({cls:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}));
      const refTitles=[...document.querySelectorAll('.ref-title')];
      const related=[...document.querySelectorAll('.re-item')];
      const answer=document.querySelector('.message:not(.user) .message-bubble');
      const shareLabel=document.querySelector('.answer-toolbar .tb-share span');
      const toolbar=document.querySelector('.answer-toolbar');
      return {width:${'innerWidth'},docOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        main:{left:main.left,right:main.right,width:main.width},sidebar:getComputedStyle(sidebar).display,
        bad,relatedContained:related.every(e=>e.scrollWidth<=e.clientWidth),
        refEllipsis:refTitles.every(e=>getComputedStyle(e).textOverflow==='ellipsis'),
        answerWidth:answer?Math.round(answer.getBoundingClientRect().width):0,
        firstRefWidth:refTitles[0]?Math.round(refTitles[0].getBoundingClientRect().width):0,
        shareLabelDisplay:shareLabel?getComputedStyle(shareLabel).display:'missing',
        toolbarContained:toolbar?toolbar.scrollWidth<=toolbar.clientWidth:true,
        inputRight:Math.round(document.querySelector('.input-card').getBoundingClientRect().right)};
    })()`);
    results.push(row);
    if (row.docOverflow || row.bad.length || !row.relatedContained || !row.refEllipsis) throw new Error('断点布局失败：' + JSON.stringify(row));
    if ((width <= 768) !== (row.sidebar === 'none')) throw new Error('侧栏断点失败：' + JSON.stringify(row));
    if (width === 390 && (row.answerWidth < 300 || row.firstRefWidth < 100 || row.shareLabelDisplay !== 'none' || !row.toolbarContained)) throw new Error('移动端阅读排版失败：' + JSON.stringify(row));
    if (width === 1440 || width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`/tmp/feishu-kb-layout-${width}.png`, Buffer.from(shot.data, 'base64'));
    }
  }
  ws.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('ui-layout-e2e FAILED:', e.message); process.exit(1); });
