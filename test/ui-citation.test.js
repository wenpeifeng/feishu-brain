'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0, opened = false;
  for (let i = start; i < appSource.length; i++) {
    if (appSource[i] === '{') { depth++; opened = true; }
    if (appSource[i] === '}') {
      depth--;
      if (opened && depth === 0) return appSource.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 不完整`);
}

const context = {};
vm.runInNewContext([
  extractFunction('escapeHtml'),
  extractFunction('safeUrl'),
  extractFunction('linkifyCitations'),
  'this.linkifyCitations = linkifyCitations;',
].join('\n'), context);

const references = Array.from({ length: 5 }, (_, i) => ({
  index: i + 1,
  title: `来源${i + 1}`,
  url: `https://example.com/${i + 1}`,
  snippet: `第${i + 1}条原文`,
}));
const html = context.linkifyCitations('<p>当前状态[1]，历史计划[2][5]。</p>', references);
assert.equal((html.match(/<sup class="citation"/g) || []).length, 3, '每个有效编号都必须转成引用角标');
assert.equal((html.match(/\[(?:1|2|5)\]/g) || []).length, 0, '链接化后不得残留原始 [n] 文本');
assert.ok(html.includes('href="https://example.com/5"'), '角标必须链接到对应参考来源');

// 回归流式竞态：最终渲染必须先取消 token 草稿定时器，且旧回调发现 finalized 后不得覆盖角标。
assert.match(appSource, /var stopDraftRendering = function \(\) \{[\s\S]*clearTimeout\(renderTimer\)/);
assert.match(appSource, /if \(streamFinalized\) return;[\s\S]*bubbleEl\.innerHTML = renderMarkdown\(fullText\)/);
const doneBranch = appSource.slice(appSource.indexOf("eventType === 'done'"), appSource.indexOf("eventType === 'error'"));
assert.ok(doneBranch.indexOf('stopDraftRendering();') < doneBranch.indexOf('linkifyCitations('), 'done 必须先终止草稿渲染再生成角标');

console.log('✓ 引用角标链接化、连续编号与流式渲染竞态防护通过');
