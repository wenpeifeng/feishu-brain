'use strict';

/**
 * 内网 MinerU 适配器。
 *
 * 安全边界：
 *   - 默认只允许 http://127.0.0.1 / localhost / ::1，不把知识库文件发到公网。
 *   - 地址只来自服务端环境变量，浏览器不能覆盖。
 *   - 使用 MinerU 官方 /file_parse multipart 接口，直接取得 Markdown，不保留原文件副本。
 *
 * MinerU 是较重的独立推理服务；本模块只负责调用，不把 Python/模型加载进 Node 进程。
 */

const path = require('path');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

class MinerUError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'MinerUError';
    this.code = code || 'MINERU_ERROR';
    if (cause) this.cause = cause;
  }
}

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MINERU_ENABLED || ''));
}

function normalizeBaseUrl(value) {
  const raw = String(value || 'http://127.0.0.1:18000').trim();
  let url;
  try {
    url = new URL(raw);
  } catch (_e) {
    throw new MinerUError('MinerU 地址格式无效', 'MINERU_CONFIG');
  }
  if (url.protocol !== 'http:') {
    throw new MinerUError('本地 MinerU 仅允许使用 http 地址', 'MINERU_CONFIG');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new MinerUError('MinerU 默认只允许连接本机 127.0.0.1，禁止文件意外出网', 'MINERU_CONFIG');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function config() {
  const timeout = Number(process.env.MINERU_TIMEOUT_MS);
  const maxChars = Number(process.env.MINERU_MAX_MD_CHARS);
  const backend = String(process.env.MINERU_BACKEND || 'hybrid-engine').trim();
  const effort = String(process.env.MINERU_EFFORT || 'medium').trim();
  if (!['pipeline', 'vlm-engine', 'hybrid-engine'].includes(backend)) {
    throw new MinerUError('MINERU_BACKEND 仅支持 pipeline、vlm-engine 或 hybrid-engine', 'MINERU_CONFIG');
  }
  if (!['medium', 'high'].includes(effort)) {
    throw new MinerUError('MINERU_EFFORT 仅支持 medium 或 high', 'MINERU_CONFIG');
  }
  return {
    enabled: enabled(),
    baseUrl: normalizeBaseUrl(process.env.MINERU_API_URL),
    backend,
    effort,
    timeoutMs: Number.isFinite(timeout) && timeout >= 10_000 ? timeout : 300_000,
    maxMarkdownChars: Number.isFinite(maxChars) && maxChars >= 10_000 ? maxChars : 5_000_000,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new MinerUError(`MinerU 解析超过 ${Math.ceil(timeoutMs / 1000)} 秒`, 'MINERU_TIMEOUT', e);
    }
    throw new MinerUError('无法连接本机 MinerU 服务', 'MINERU_UNAVAILABLE', e);
  } finally {
    clearTimeout(timer);
  }
}

function firstMarkdown(payload) {
  const results = payload && payload.results;
  if (!results || typeof results !== 'object') return '';
  for (const result of Object.values(results)) {
    if (result && typeof result.md_content === 'string' && result.md_content.trim()) {
      return result.md_content.trim();
    }
  }
  return '';
}

async function parseToMarkdown(filename, buf) {
  const cfg = config();
  if (!cfg.enabled) throw new MinerUError('MinerU 未启用', 'MINERU_DISABLED');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new MinerUError('上传文件为空', 'MINERU_INPUT');

  const form = new FormData();
  const safeName = path.basename(String(filename || 'document.pdf')).slice(0, 200) || 'document.pdf';
  form.append('files', new Blob([buf], { type: 'application/pdf' }), safeName);
  form.append('backend', cfg.backend);
  form.append('effort', cfg.effort);
  form.append('parse_method', 'auto');
  form.append('lang_list', 'ch');
  form.append('formula_enable', 'true');
  form.append('table_enable', 'true');
  form.append('image_analysis', cfg.effort === 'high' ? 'true' : 'false');
  form.append('return_md', 'true');
  form.append('return_middle_json', 'false');
  form.append('return_model_output', 'false');
  form.append('return_content_list', 'false');
  form.append('return_images', 'false');
  form.append('response_format_zip', 'false');
  form.append('return_original_file', 'false');

  const response = await fetchWithTimeout(
    `${cfg.baseUrl}/file_parse`,
    { method: 'POST', body: form },
    cfg.timeoutMs,
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && (payload.detail || payload.error || payload.message);
    throw new MinerUError(
      `MinerU 解析失败（HTTP ${response.status}）${detail ? `：${String(detail).slice(0, 300)}` : ''}`,
      'MINERU_RESPONSE',
    );
  }
  const markdown = firstMarkdown(payload);
  if (!markdown) throw new MinerUError('MinerU 未返回 Markdown 内容', 'MINERU_EMPTY');
  if (markdown.length > cfg.maxMarkdownChars) {
    throw new MinerUError(`MinerU 返回内容超过 ${cfg.maxMarkdownChars} 字符上限`, 'MINERU_OUTPUT_TOO_LARGE');
  }
  return {
    text: markdown,
    kind: 'mineru-md',
    parser: `mineru-${String(payload.version || 'unknown')}`,
    backend: String(payload.backend || cfg.backend),
  };
}

async function health() {
  const cfg = config();
  if (!cfg.enabled) return { ok: false, enabled: false, error: 'MinerU 未启用' };
  try {
    const response = await fetchWithTimeout(`${cfg.baseUrl}/health`, { method: 'GET' }, Math.min(cfg.timeoutMs, 5000));
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok && payload.status !== 'unhealthy',
      enabled: true,
      version: payload.version || '',
      backend: cfg.backend,
      effort: cfg.effort,
      error: response.ok ? '' : `HTTP ${response.status}`,
    };
  } catch (e) {
    return { ok: false, enabled: true, backend: cfg.backend, effort: cfg.effort, error: e.message };
  }
}

module.exports = {
  MinerUError,
  config,
  enabled,
  parseToMarkdown,
  health,
  _internals: { normalizeBaseUrl, firstMarkdown, fetchWithTimeout },
};
