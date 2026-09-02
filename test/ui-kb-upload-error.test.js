'use strict';

const assert = require('assert/strict');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const css = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');

const start = app.indexOf('async function uploadKbFiles');
const upload = app.slice(start, app.indexOf('async function savePastedDoc', start));

assert.match(upload, /errors\.push\(files\[i\]\.name \+ '：' \+ \(j\.error/, '上传失败必须显示文件名和服务端原因');
assert.match(upload, /j\.needOcr/, '扫描件必须与普通解析失败分流');
assert.match(css, /\.toastx\s*\{[^}]*max-width:[^}]*calc\(100vw - 32px\)/s, '长错误提示不得超出视口');
assert.match(css, /\.toastx-msg\s*\{[^}]*overflow-wrap:\s*anywhere/s, '长文件名必须可换行');

console.log('✓ 知识库上传失败会展示文件名、具体原因并保持视口内换行');
