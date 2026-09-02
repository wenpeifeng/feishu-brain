'use strict';

const assert = require('assert/strict');
const fs = require('fs');

const css = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');
const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

const relatedRule = css.match(/\.related-evidence\s*\{([^}]+)\}/);
assert.ok(relatedRule, '缺少更多相关结果容器样式');
assert.ok(!/overflow\s*:\s*hidden/.test(relatedRule[1]), '外层容器不得裁切展开内容');
assert.ok(!/grid-template-rows/.test(css.slice(css.indexOf('.re-clip'), css.indexOf('.re-item'))), '不得恢复不稳定的 0fr/1fr 隐式高度动画');
assert.match(css, /\.re-clip\s*\{[^}]*height\s*:\s*0[^}]*overflow\s*:\s*hidden/s);
assert.match(css, /\.chat-container\s*\{\s*scrollbar-gutter\s*:\s*stable both-edges/, '桌面对话区必须稳定预留滚动条槽位，禁止横向抖动');
assert.match(css, /@supports not \(scrollbar-gutter:\s*stable\)[\s\S]*?\.chat-container\s*\{\s*overflow-y\s*:\s*scroll/, '不支持 scrollbar-gutter 的浏览器必须保留滚动条宽度');
assert.match(css, /\.re-clip\s*\{[^}]*transition\s*:[^}]*height[^}]*opacity/s, '真实高度和淡入必须作为一个连续动画');
assert.match(css, /\.re-list\s*\{[^}]*padding\s*:\s*7px 8px 8px[^}]*border\s*:\s*1px/s, '列表几何不得在展开瞬间跳变');
assert.match(app, /clip\.style\.height = 'auto'/);
assert.match(app, /clip\.style\.height = \(targetOpen \? list\.scrollHeight : 0\) \+ 'px'/);
assert.match(app, /settleResize = function \(\)[\s\S]*clip\.style\.height = box\.classList\.contains\('open'\) \? 'auto' : '0px'/);
assert.match(app, /event\.propertyName === 'height'\) settleResize\(\)/, '动画完成后必须恢复自然高度');
assert.match(app, /setTimeout\(settleResize,\s*480\)/, '无动画或标签切后台时必须有状态收尾');
const relatedStart = app.indexOf('function buildRelatedEvidence');
const relatedBuilder = app.slice(relatedStart, app.indexOf('// 相关文件', relatedStart));
assert.doesNotMatch(relatedBuilder, /chatContainer\.scrollTop\s*=/, '展开更多结果时不得强制滚动，标题位置必须保持稳定');

console.log('✓ 更多相关结果使用真实内容高度，展开态不会被外层裁切');
