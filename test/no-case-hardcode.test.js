'use strict';

// 真实失败 case 可以进入金标和回归脚本，但不得渗入生产 Prompt、检索、排序或 UI 代码。
// 后续若有人为“修一题”把项目名、固定日期或答案片段写入生产目录，本门禁直接失败。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTION_DIRS = ['server', 'public'];
const FORBIDDEN_CASE_LITERALS = [
  '澳储',
  '奥储',
  '澳洲光储',
  '第二期部份需求已经启动',
  '2026/07/22',
  '2026/07/15',
];

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:js|html|css)$/.test(entry.name) ? [full] : [];
  });
}

const violations = [];
for (const dir of PRODUCTION_DIRS) {
  for (const file of sourceFiles(path.join(ROOT, dir))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const literal of FORBIDDEN_CASE_LITERALS) {
      if (source.includes(literal)) violations.push(`${path.relative(ROOT, file)}: ${literal}`);
    }
  }
}

assert.deepEqual(violations, [], `真实 case 被硬编码进生产代码：\n${violations.join('\n')}`);
console.log('✓ 生产代码无真实澳储 case、固定日期或答案片段硬编码');
