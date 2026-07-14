const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

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
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    larkCliPath: process.env.LARK_CLI_PATH || 'lark-cli',
    larkIdentity: process.env.LARK_IDENTITY || 'user',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    llmProvider: process.env.LLM_PROVIDER || 'openai',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    topK: 3,
    pageSize: 10,
  };
}

let configCache = null;
let conversationsCache = null;

function getConfig() {
  if (configCache) return configCache;
  const fileConfig = readJSON(CONFIG_FILE, {});
  configCache = { ...getDefaultConfig(), ...fileConfig };
  return configCache;
}

function updateConfig(newConfig) {
  configCache = { ...getConfig(), ...newConfig };
  writeJSON(CONFIG_FILE, configCache);
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
};
