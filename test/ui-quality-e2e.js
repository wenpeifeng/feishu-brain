'use strict';

// 质量评测页真实 DOM 几何回归：工作区必须留在视口内，详情末尾操作可滚动到达。
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const sessions = Object.values(JSON.parse(fs.readFileSync('data/sessions.json', 'utf8')));
  const session = sessions.sort((a, b) => b.expireAt - a.expireAt)[0];
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
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:3000/login.html' }); await wait(400);
  await evaluate(`localStorage.setItem('kb_token', ${JSON.stringify(session.token)})`);
  await send('Page.navigate', { url: 'http://localhost:3000/' }); await wait(1300);
  await evaluate(`(() => {
    document.body.classList.add('dash-mode');
    hideWelcome(); activeView='quality'; renderHistory();
    chatTitle.textContent='质量评测';
    chatContainer.innerHTML='<div class="quality-page"><div class="quality-head"><div><span class="quality-kicker">RETRIEVAL QA</span><h2>把真实问题变成可复用金标</h2><p>系统自动采集每次检索轨迹；管理员确认答案与证据相关性后，才进入人工金标。</p></div><div class="quality-baseline"><b>baseline-v1</b><span>初始安全基线 · 待金标升级</span></div></div><div id="qualityBody"></div></div>';
    qualityCases=[{
      id:'layout-case',createdAt:'2026-07-23T00:00:00Z',priority:'medium',
      question:'澳储还有需求吗？',answer:'这是用于验证长内容可滚动到末尾的系统回答。'.repeat(12),
      provider:{model:'glm-4-air'},trace:{recalled:16,read:15,eligible:7,selected:5},
      candidates:Array.from({length:14},(_,i)=>({key:'c'+i,title:'候选证据 '+(i+1),
        source:i%2?'message':'doc',snippet:'候选片段 '.repeat(24),vectorScore:.8-i*.01,
        judgeScore:i%3, evidenceRank:80-i,eligible:i<10,selected:i<5}))
    }];
    qualityCurrentId='layout-case';
    renderQualityWorkbench({pending:1,labeled:0,high:0,total:1},'pending',{ready:false,labeledCases:0,labeledCandidates:0},'organization');
  })()`); await wait(250);

  const rows = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: !!viewport.mobile });
    await wait(180);
    const row = await evaluate(`(() => {
      const chat=document.querySelector('.chat-container'), page=document.querySelector('.quality-page');
      const work=document.querySelector('.quality-work'), detail=document.querySelector('.quality-detail');
      const actions=document.querySelector('.quality-actions');
      detail.scrollTop=detail.scrollHeight;
      if(innerWidth<=700) chat.scrollTop=chat.scrollHeight;
      const cr=chat.getBoundingClientRect(), pr=page.getBoundingClientRect(), wr=work.getBoundingClientRect(), ar=actions.getBoundingClientRect();
      return {
        viewport:{width:innerWidth,height:innerHeight},
        chat:{top:cr.top,bottom:cr.bottom,height:cr.height},
        page:{top:pr.top,bottom:pr.bottom,height:pr.height},
        work:{top:wr.top,bottom:wr.bottom,height:wr.height},
        detail:{clientHeight:detail.clientHeight,scrollHeight:detail.scrollHeight,scrollTop:detail.scrollTop},
        actions:{top:ar.top,bottom:ar.bottom},
        horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        workInViewport:wr.top>=cr.top-1&&wr.bottom<=cr.bottom+1,
        workInWidth:wr.left>=-1&&wr.right<=innerWidth+1,
        actionsVisible:ar.top>=wr.top-1&&ar.bottom<=wr.bottom+1,
        mobileActionsInViewport:innerWidth>700||(ar.top>=cr.top-1&&ar.bottom<=cr.bottom+1)
      };
    })()`);
    rows.push(row);
    const desktopFailure = viewport.width > 700 && !row.workInViewport;
    if (row.horizontalOverflow || desktopFailure || !row.workInWidth || !row.actionsVisible || !row.mobileActionsInViewport || row.detail.scrollTop <= 0 || row.work.height < 220) {
      throw new Error('质量评测布局失败：' + JSON.stringify(row));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`/tmp/feishu-quality-${viewport.width}x${viewport.height}.png`, Buffer.from(shot.data, 'base64'));
  }
  ws.close();
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error('ui-quality-e2e FAILED:', e.message); process.exit(1); });
