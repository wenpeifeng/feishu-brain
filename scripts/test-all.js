'use strict';

// 在临时副本执行全部离线测试，避免测试用例读写开发者真实的 data/。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-brain-test-'));
const excludedTopLevel = new Set(['.git', '.run', 'data', 'logs', 'node_modules', '.env']);

function copyFilter(source) {
  if (source === projectDir) return true;
  const relative = path.relative(projectDir, source);
  const top = relative.split(path.sep)[0];
  return !excludedTopLevel.has(top);
}

let failed = 0;
try {
  fs.cpSync(projectDir, tempDir, { recursive: true, filter: copyFilter });
  fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(tempDir, 'node_modules'), 'junction');
  const tests = fs.readdirSync(path.join(tempDir, 'test'))
    .filter(name => name.endsWith('.test.js'))
    .sort();

  for (const test of tests) {
    process.stdout.write(`\n=== ${test} ===\n`);
    const result = spawnSync(process.execPath, [path.join('test', test)], {
      cwd: tempDir,
      env: { ...process.env, FEISHU_BRAIN_ENV_FILE: path.join(tempDir, '.env') },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      failed = result.status || 1;
      break;
    }
  }

  if (!failed) process.stdout.write(`\n全部 ${tests.length} 个离线测试文件通过。\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed);
