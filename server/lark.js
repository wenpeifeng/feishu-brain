const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./store');

const LARK_CLI_HOME = path.join(__dirname, '..', 'data', 'lark-cli-home');

function getLarkConfig() {
  const cfg = getConfig();
  return {
    larkCli: cfg.larkCliPath || 'lark-cli',
    identity: cfg.larkIdentity || 'user',
  };
}

function getLarkCliEnv(extraEnv = {}) {
  const cfg = getConfig();
  if (cfg.appId && cfg.appSecret) {
    fs.mkdirSync(LARK_CLI_HOME, { recursive: true });
  }
  return {
    ...process.env,
    ...(cfg.appId && cfg.appSecret ? { HOME: LARK_CLI_HOME } : {}),
    ...extraEnv,
  };
}

async function initLarkCliConfig(appId, appSecret) {
  fs.mkdirSync(LARK_CLI_HOME, { recursive: true });
  return new Promise((resolve, reject) => {
    const { larkCli } = getLarkConfig();
    const child = spawn(larkCli, [
      'config', 'init',
      '--app-id', appId,
      '--app-secret-stdin',
      '--brand', 'feishu',
      '--lang', 'zh',
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: LARK_CLI_HOME },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`lark-cli config init failed: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(appSecret);
    child.stdin.end();
  });
}

function runLark(args, options = {}) {
  const { larkCli, identity } = getLarkConfig();
  const { input, env: extraEnv, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(larkCli, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getLarkCliEnv(extraEnv),
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const output = stdout || stderr;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        parsed = { raw: output };
      }

      if (code !== 0 && !parsed.error) {
        reject(new Error(`lark-cli exited with code ${code}: ${output.trim()}`));
        return;
      }

      resolve(parsed);
    });

    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function searchDocs(query, pageSize = 10) {
  const { identity } = getLarkConfig();
  const result = await runLark([
    'drive', '+search',
    '--query', query,
    '--page-size', String(pageSize),
    '--as', identity,
    '--format', 'json',
  ]);

  if (!result.ok) {
    const err = new Error(result.error?.message || 'lark search failed');
    err.larkError = result.error;
    throw err;
  }

  return (result.data?.items || []).map((item, index) => ({
    index: index + 1,
    title: item.title,
    type: item.type,
    token: item.token,
    url: item.url,
    owner: item.owner?.name || item.owner?.display_name || item.owner?.en_name || '',
    editTime: item.edit_time,
    openTime: item.open_time,
  }));
}

async function fetchDoc(urlOrToken) {
  const { identity } = getLarkConfig();
  const result = await runLark([
    'docs', '+fetch',
    '--api-version', 'v2',
    '--doc', urlOrToken,
    '--as', identity,
    '--doc-format', 'markdown',
    '--format', 'json',
  ]);

  if (!result.ok) {
    const err = new Error(result.error?.message || 'lark fetch failed');
    err.larkError = result.error;
    throw err;
  }

  return {
    title: result.data?.title,
    content: result.data?.content || '',
  };
}

module.exports = { runLark, searchDocs, fetchDoc, initLarkCliConfig };
