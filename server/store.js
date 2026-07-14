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
    pageSize: 9,
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

function getConversations() {
  if (conversationsCache) return conversationsCache;
  conversationsCache = readJSON(CONVERSATIONS_FILE, []);
  return conversationsCache;
}

function saveConversations(conversations) {
  conversationsCache = conversations;
  writeJSON(CONVERSATIONS_FILE, conversations);
}

function createConversation(title = '新对话') {
  const conversations = getConversations();
  const conversation = {
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  conversations.unshift(conversation);
  saveConversations(conversations);
  return conversation;
}

function getConversation(id) {
  return getConversations().find(c => c.id === id);
}

function deleteConversation(id) {
  const conversations = getConversations().filter(c => c.id !== id);
  saveConversations(conversations);
}

function addMessage(conversationId, message) {
  const conversations = getConversations();
  const conversation = conversations.find(c => c.id === conversationId);
  if (!conversation) return null;
  conversation.messages.push(message);
  conversation.updatedAt = new Date().toISOString();
  saveConversations(conversations);
  return conversation;
}

function updateConversationTitle(conversationId, title) {
  const conversations = getConversations();
  const conversation = conversations.find(c => c.id === conversationId);
  if (conversation) {
    conversation.title = title;
    conversation.updatedAt = new Date().toISOString();
    saveConversations(conversations);
  }
  return conversation;
}

module.exports = {
  getConfig,
  updateConfig,
  getConversations,
  createConversation,
  getConversation,
  deleteConversation,
  addMessage,
  updateConversationTitle,
};
