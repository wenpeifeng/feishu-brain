const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONFIG_KEYS = new Set([
  'topK', 'adaptiveEvidence', 'evidenceMin', 'evidenceMax', 'evidenceScoreGap',
  'retrievalPreset', 'pageSize', 'readPool', 'minScore', 'judgeMin', 'adversarial',
  'chatSearch', 'chatSize', 'chatAfter', 'chatBefore',
]);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJSON(filePath, defaultValue = {}) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getDefaultConfig() {
  return {
    topK: 3,          // 关闭自适应时使用的固定证据数
    adaptiveEvidence: true,
    evidenceMin: 2,  // 自适应证据集最少保留数（有足够通过项时）
    evidenceMax: 5,  // 自适应证据集上限，避免固定 3 条截断同档证据
    evidenceScoreGap: 0.15, // 同一法官档内，相对最佳向量分的允许落差
    retrievalPreset: 'baseline-v1', // 初始安全基线；积累人工金标后由离线评测升级版本
    pageSize: 10,      // 召回数量：飞书搜索返回多少篇候选
    readPool: 12,      // 读取上限：读正文参与向量打分的候选数（安全上限，非质量闸；谁入选由 minScore 阈值决定）
    minScore: 0.40,    // 相关度阈值：向量余弦低于此值的段落丢弃（0~1，越高越严）
    judgeMin: 2,       // 法官入选阈值：LLM 判官打分（0~3）≥此值才入选（越高越严）
    adversarial: false, // 实验性复核：现有弱金标显示会伤召回且增加尾延迟，默认关闭，保留开关供评测
    chatSearch: true,  // 会话检索开关：是否检索聊天记录
    chatSize: 6,       // 会话召回数：搜索命中多少条消息
    chatAfter: 3,      // 会话向后拉取：命中消息后补几条回复（聊天是一问一答，答常在后面）
    chatBefore: 0,     // 会话向前拉取：命中消息前补几条（应对"命中的是答案、问题在前面"）
  };
}

function sanitizePersistentConfig(value) {
  const clean = {};
  for (const [key, item] of Object.entries(value || {})) if (CONFIG_KEYS.has(key)) clean[key] = item;
  return clean;
}

let configCache = null;
let conversationsCache = null;

function getConfig() {
  if (configCache) return configCache;
  const raw = readJSON(CONFIG_FILE, {});
  const fileConfig = sanitizePersistentConfig(raw);
  // 一次性迁移旧配置：历史版本曾把应用密钥/模型密钥写入这里。只保留公开的检索默认值。
  if (Object.keys(raw).some(key => !CONFIG_KEYS.has(key))) writeJSON(CONFIG_FILE, fileConfig);
  configCache = { ...getDefaultConfig(), ...fileConfig };
  return configCache;
}

function updateConfig(newConfig) {
  configCache = { ...getConfig(), ...sanitizePersistentConfig(newConfig) };
  writeJSON(CONFIG_FILE, sanitizePersistentConfig(configCache));
  return configCache;
}

// 内部：获取所有对话（已过滤无 ownerOpenId 的旧 mock 数据）
function getConversations() {
  if (conversationsCache) return conversationsCache;
  const raw = readJSON(CONVERSATIONS_FILE, []);
  // 迁移：过滤掉无 ownerOpenId 的旧 mock 数据
  conversationsCache = raw.filter(c => c.ownerOpenId);
  return conversationsCache;
}

function saveConversations(conversations) {
  conversationsCache = conversations;
  writeJSON(CONVERSATIONS_FILE, conversations);
}

// ── 公开接口（全部按 ownerOpenId 隔离） ──────────────────────────

/**
 * 创建对话，含 ownerOpenId 字段
 */
function createConversation(ownerOpenId, title = '新对话') {
  if (!ownerOpenId) throw new Error('ownerOpenId required');
  const conversations = getConversations();
  const conversation = {
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerOpenId,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  conversations.unshift(conversation);
  saveConversations(conversations);
  return conversation;
}

/**
 * 返回属于该 owner 的对话数组（倒序，即创建时间从新到旧）
 */
function getConversationsFor(ownerOpenId) {
  return getConversations().filter(c => c.ownerOpenId === ownerOpenId);
}

/**
 * 按 id + ownerOpenId 获取对话；id 不存在或 owner 不匹配返回 null（防 IDOR）
 */
function getConversationOwned(id, ownerOpenId) {
  const conv = getConversations().find(c => c.id === id);
  if (!conv || conv.ownerOpenId !== ownerOpenId) return null;
  return conv;
}

/**
 * 只删属于该 owner 的对话；不属于则返回 false
 */
function deleteConversationOwned(id, ownerOpenId) {
  const conversations = getConversations();
  const idx = conversations.findIndex(c => c.id === id);
  if (idx === -1) return false;
  if (conversations[idx].ownerOpenId !== ownerOpenId) return false;
  conversations.splice(idx, 1);
  saveConversations(conversations);
  return true;
}

/**
 * 追加消息前校验 owner；不匹配返回 null 且不写入
 */
function addMessage(conversationId, ownerOpenId, message) {
  if (!ownerOpenId) return null;
  const conversations = getConversations();
  const conversation = conversations.find(c => c.id === conversationId);
  if (!conversation) return null;
  if (conversation.ownerOpenId !== ownerOpenId) return null;
  conversation.messages.push(message);
  conversation.updatedAt = new Date().toISOString();
  saveConversations(conversations);
  return conversation;
}

/**
 * 更新标题，校验 owner；不匹配返回 null
 */
function updateConversationTitleOwned(id, ownerOpenId, title) {
  const conversations = getConversations();
  const conversation = conversations.find(c => c.id === id);
  if (!conversation || conversation.ownerOpenId !== ownerOpenId) return null;
  conversation.title = title;
  conversation.updatedAt = new Date().toISOString();
  saveConversations(conversations);
  return conversation;
}

module.exports = {
  getConfig,
  updateConfig,
  createConversation,
  getConversationsFor,
  getConversationOwned,
  deleteConversationOwned,
  addMessage,
  updateConversationTitleOwned,
  sanitizePersistentConfig,
};
