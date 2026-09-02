'use strict';

// 头像菜单组件回归：所有入口必须使用统一图标槽和行高，新增入口不得撑坏菜单。
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function findAdminSession() {
  const sessions = Object.values(JSON.parse(fs.readFileSync('data/sessions.json', 'utf8')))
    .sort((a, b) => b.expireAt - a.expireAt);
  for (const session of sessions) {
    try {
      const res = await fetch('http://127.0.0.1:3000/api/auth/me', { headers: { Authorization: `Bearer ${session.token}` } });
      const body = await res.json();
      if (body.ok && body.user && body.user.isAdmin) return session;
    } catch (_e) {}
  }
  throw new Error('没有可用于组织管理入口测试的管理员会话');
}

async function main() {
  const session = await findAdminSession();
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
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
    return out.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:3000/login.html' }); await wait(350);
  await evaluate(`localStorage.setItem('kb_token', ${JSON.stringify(session.token)})`);
  await send('Page.navigate', { url: 'http://localhost:3000/' }); await wait(1200);

  const rows = [];
  for (const viewport of [
    { width: 1920, height: 1080 }, { width: 1440, height: 900 },
    { width: 1280, height: 800 }, { width: 1024, height: 768 },
    { width: 768, height: 900 }, { width: 390, height: 844 },
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width <= 480 });
    await wait(120);
    await evaluate(`(() => {
      const avatar=document.getElementById('userAvatar');
      const current=avatar.querySelector('.user-menu');
      if(current) current.remove();
      avatar.click();
    })()`);
    await wait(100);
    const row = await evaluate(`(() => {
      const menu=document.querySelector('.user-menu');
      const items=[...menu.querySelectorAll('.user-menu-item')];
      const rect=e=>e.getBoundingClientRect();
      const mr=rect(menu);
      const metrics=items.map(item=>{
        const ir=rect(item), svg=item.querySelector('svg'), sr=rect(svg), label=rect(item.querySelector('span'));
        return {action:item.dataset.act,height:ir.height,top:ir.top,icon:{left:sr.left,width:sr.width,height:sr.height},label:{left:label.left,height:label.height}};
      });
      const heights=metrics.map(x=>x.height), iconLefts=metrics.map(x=>x.icon.left), labelLefts=metrics.map(x=>x.label.left);
      const orgItem=menu.querySelector('[data-act="organization"]');
      orgItem.focus();
      const focusStyle=getComputedStyle(orgItem);
      return {
        viewport:{width:innerWidth,height:innerHeight},
        menu:{left:mr.left,right:mr.right,top:mr.top,bottom:mr.bottom,width:mr.width,height:mr.height},
        metrics,
        organization:metrics.find(x=>x.action==='organization'),
        uniformRows:Math.max(...heights)-Math.min(...heights)<=1,
        uniformIcons:Math.max(...iconLefts)-Math.min(...iconLefts)<=1&&metrics.every(x=>Math.abs(x.icon.width-18)<.1&&Math.abs(x.icon.height-18)<.1),
        uniformLabels:Math.max(...labelLefts)-Math.min(...labelLefts)<=1,
        contained:mr.left>=8&&mr.right<=innerWidth-8&&mr.bottom<=innerHeight-8,
        horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        semantics:{menuRole:menu.getAttribute('role'),itemRole:orgItem.getAttribute('role'),expanded:document.getElementById('userAvatar').getAttribute('aria-expanded')},
        focus:{action:document.activeElement&&document.activeElement.dataset.act,outlineWidth:focusStyle.outlineWidth}
      };
    })()`);
    rows.push(row);
    if (!row.organization || !row.uniformRows || !row.uniformIcons || !row.uniformLabels || !row.contained || row.horizontalOverflow ||
      Math.abs(row.organization.height - 42) >= .1 || row.semantics.menuRole !== 'menu' || row.semantics.itemRole !== 'menuitem' ||
      row.semantics.expanded !== 'true' || row.focus.action !== 'organization' || parseFloat(row.focus.outlineWidth) < 2) {
      throw new Error('头像菜单布局失败：' + JSON.stringify(row));
    }
    if (viewport.width === 1440 || viewport.width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`/tmp/feishu-user-menu-${viewport.width}.png`, Buffer.from(shot.data, 'base64'));
    }
  }
  const keyboard = await evaluate(`(() => {
    const avatar=document.getElementById('userAvatar');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const escaped=!avatar.querySelector('.user-menu')&&avatar.getAttribute('aria-expanded')==='false'&&document.activeElement===avatar;
    avatar.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const opened=!!avatar.querySelector('.user-menu')&&avatar.getAttribute('aria-expanded')==='true';
    const firstFocused=document.activeElement&&document.activeElement.dataset.act==='tasks';
    return {escaped,opened,firstFocused};
  })()`);
  if (!keyboard.escaped || !keyboard.opened || !keyboard.firstFocused) throw new Error('头像菜单键盘交互失败：'+JSON.stringify(keyboard));
  rows.push({ keyboard });
  ws.close();
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error('ui-user-menu-e2e FAILED:', e.message); process.exit(1); });
