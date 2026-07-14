// State
let currentConversationId = null;
let conversations = [];
let config = {};
let isLoading = false;
let webSearch = false;
let historySearch = '';
let advancedVisible = false;

// DOM refs
const chatContainer = document.getElementById('chatContainer');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const historyList = document.getElementById('historyList');
const newChatBtn = document.getElementById('newChatBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');
const settingsForm = document.getElementById('settingsForm');
const chatTitle = document.getElementById('chatTitle');
const historySearchInput = document.getElementById('historySearch');
const webSearchBtn = document.getElementById('webSearchBtn');
const shareBtn = document.getElementById('shareBtn');
const feedbackBtn = document.getElementById('feedbackBtn');
const knowledgeBaseBtn = document.getElementById('knowledgeBaseBtn');
const advancedToggle = document.getElementById('advancedToggle');
const advancedFields = document.getElementById('advancedFields');
const addFileBtn = document.getElementById('addFileBtn');
const apiKeyNote = document.getElementById('apiKeyNote');

// Init
async function init() {
  await Promise.all([loadConfig(), loadConversations()]);
  renderHistory();
  setupEventListeners();
  setupInput();
  if (!currentConversationId) {
    await createNewConversation();
  }
}

// API
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.error || 'API error');
    err.larkError = data.larkError;
    err.hint = data.hint;
    throw err;
  }
  return data;
}

async function loadConfig() {
  try {
    const data = await api('/api/config');
    config = data.config;
  } catch (e) {
    console.error('Load config failed:', e);
  }
}

async function loadConversations() {
  try {
    const data = await api('/api/conversations');
    conversations = data.conversations || [];
    if (conversations.length > 0 && !currentConversationId) {
      currentConversationId = conversations[0].id;
      await loadConversation(currentConversationId);
    }
  } catch (e) {
    console.error('Load conversations failed:', e);
  }
}

async function loadConversation(id) {
  try {
    const data = await api(`/api/conversations/${id}`);
    renderConversation(data.conversation);
    currentConversationId = id;
    renderHistory();
  } catch (e) {
    console.error('Load conversation failed:', e);
  }
}

async function createNewConversation() {
  try {
    const data = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: '新对话' }),
    });
    const conversation = data.conversation;
    conversations.unshift({ ...conversation, messageCount: 0 });
    currentConversationId = conversation.id;
    renderHistory();
    renderEmptyChat();
    chatTitle.textContent = '飞书知识问答';
    questionInput.focus();
  } catch (e) {
    console.error('Create conversation failed:', e);
  }
}

async function deleteConversation(id, event) {
  event.stopPropagation();
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    conversations = conversations.filter(c => c.id !== id);
    if (currentConversationId === id) {
      currentConversationId = null;
      renderEmptyChat();
      chatTitle.textContent = '飞书知识问答';
    }
    renderHistory();
  } catch (e) {
    console.error('Delete conversation failed:', e);
  }
}

async function askQuestion() {
  if (isLoading) return;
  const question = questionInput.value.trim();
  if (!question || !currentConversationId) return;

  questionInput.value = '';
  questionInput.style.height = 'auto';
  sendBtn.disabled = true;

  isLoading = true;
  appendUserMessage(question);
  appendLoading();

  try {
    const data = await api(`/api/conversations/${currentConversationId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question, webSearch }),
    });
    removeLoading();
    appendAssistantMessage(data.answer, data.references, data.sources, data.mock);
    updateConversationTitleFromCurrent(question);
  } catch (err) {
    removeLoading();
    console.error('Ask failed:', err);
    appendError(err.message, err.hint);
  } finally {
    isLoading = false;
    sendBtn.disabled = questionInput.value.trim().length === 0;
  }
}

function updateConversationTitleFromCurrent(question) {
  const conv = conversations.find(c => c.id === currentConversationId);
  if (conv && conv.title === '新对话') {
    conv.title = question.slice(0, 30);
    renderHistory();
  }
  chatTitle.textContent = conv ? conv.title : '飞书知识问答';
}

// Rendering
function renderHistory() {
  const filtered = conversations.filter(c =>
    !historySearch || c.title.toLowerCase().includes(historySearch.toLowerCase())
  );
  historyList.innerHTML = '';
  if (filtered.length === 0) {
    historyList.innerHTML = '<div class="empty-state">暂无历史对话</div>';
    return;
  }
  filtered.forEach(conv => {
    const item = document.createElement('div');
    item.className = `history-item ${conv.id === currentConversationId ? 'active' : ''}`;
    item.innerHTML = `
      <span class="history-title">${escapeHtml(conv.title)}</span>
      <button class="history-delete" title="删除">×</button>
    `;
    item.addEventListener('click', () => loadConversation(conv.id));
    item.querySelector('.history-delete').addEventListener('click', (e) => deleteConversation(conv.id, e));
    historyList.appendChild(item);
  });
}

function renderEmptyChat() {
  chatContainer.innerHTML = `
    <div class="welcome">
      <h2>基于飞书知识库的问答助手</h2>
      <p>输入问题，我将搜索你的飞书知识库并给出总结回答。</p>
    </div>
  `;
  chatTitle.textContent = '飞书知识问答';
}

function renderConversation(conversation) {
  chatTitle.textContent = conversation.title;
  chatContainer.innerHTML = '';
  if (conversation.messages.length === 0) {
    renderEmptyChat();
    return;
  }
  conversation.messages.forEach(msg => {
    if (msg.role === 'user') {
      appendUserMessage(msg.content, false);
    } else {
      appendAssistantMessage(msg.content, msg.references, msg.sources, msg.mock, false);
    }
  });
  scrollToBottom();
}

function appendUserMessage(content, scroll = true) {
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = `
    <div class="avatar">我</div>
    <div class="message-content">
      <div class="message-bubble">${escapeHtml(content)}</div>
    </div>
  `;
  chatContainer.appendChild(msg);
  if (scroll) scrollToBottom();
}

function appendAssistantMessage(content, references, sources, mock, scroll = true) {
  const msg = document.createElement('div');
  msg.className = 'message';
  let html = '<div class="avatar">AI</div><div class="message-content">';
  if (mock) {
    html += '<div class="mock-badge">示例数据</div>';
  }
  html += `<div class="message-bubble markdown-body">${renderMarkdown(content)}</div></div>`;
  msg.innerHTML = html;
  chatContainer.appendChild(msg);

  if (references && references.length > 0) {
    appendReferences(references);
  }
  if (sources && sources.length > 0) {
    appendSources(sources);
  }

  if (scroll) scrollToBottom();
}

function appendReferences(references) {
  const section = document.createElement('div');
  section.className = 'references';
  section.innerHTML = `<div class="references-title">为你找到 ${references.length} 篇参考资料</div>`;
  const list = document.createElement('div');
  list.className = 'references-list';
  references.forEach(ref => {
    const item = document.createElement('div');
    item.className = 'reference-item';
    item.addEventListener('click', () => { if (ref.url) window.open(ref.url, '_blank'); });
    item.innerHTML = `
      <div class="reference-icon">${getFileIcon(ref)}</div>
      <div class="reference-info">
        <div class="reference-title">${escapeHtml(ref.title)}</div>
        <div class="reference-meta">${escapeHtml(ref.owner || '')} · ${formatDate(ref.date || ref.editTime)}</div>
      </div>
    `;
    list.appendChild(item);
  });
  section.appendChild(list);
  chatContainer.appendChild(section);
}

function appendSources(sources) {
  const section = document.createElement('div');
  section.className = 'sources';
  section.innerHTML = '<div class="sources-title">来源文档</div>';
  const list = document.createElement('ul');
  list.className = 'sources-list';
  sources.forEach(src => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${src.url || '#'}" target="_blank">${escapeHtml(src.title)}</a>`;
    list.appendChild(li);
  });
  section.appendChild(list);
  chatContainer.appendChild(section);
}

function appendError(message, hint) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div class="avatar">AI</div>
    <div class="message-content">
      <div class="message-bubble error">
        <div>出错了：${escapeHtml(message)}</div>
        ${hint ? `<div style="margin-top:8px;color:#646a73;">${escapeHtml(hint)}</div>` : ''}
      </div>
    </div>
  `;
  chatContainer.appendChild(div);
  scrollToBottom();
}

function appendLoading() {
  const div = document.createElement('div');
  div.className = 'message';
  div.id = 'loadingMessage';
  div.innerHTML = `
    <div class="avatar">AI</div>
    <div class="message-content">
      <div class="message-bubble loading">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <span>正在搜索并总结...</span>
      </div>
    </div>
  `;
  chatContainer.appendChild(div);
  scrollToBottom();
}

function removeLoading() {
  const el = document.getElementById('loadingMessage');
  if (el) el.remove();
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function getFileIcon(ref) {
  const title = (ref.title || '').toLowerCase();
  const type = (ref.type || '').toLowerCase();
  if (type.includes('sheet') || title.endsWith('.xlsx') || title.endsWith('.xls')) return '表格';
  if (type.includes('doc') || title.endsWith('.doc') || title.endsWith('.docx') || title.endsWith('.pdf') || title.endsWith('.ppt') || title.endsWith('.pptx')) return '文档';
  if (type.includes('wiki')) return 'Wiki';
  return '文档';
}

// Markdown renderer
function renderMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let inCode = false;
  let codeContent = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeContent.trim())}</code></pre>`;
        codeContent = '';
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeContent += line + '\n';
      continue;
    }
    if (line.trim().startsWith('|')) {
      if (inList !== 'table') {
        if (inList) {
          html += inList === 'ul' ? '</ul>' : '</ol>';
          inList = false;
        }
        html += '<table>';
        inList = 'table';
      }
      const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
      const isHeader = cells.some(c => c.match(/^-+$/));
      const row = cells.map(c => {
        if (c.match(/^-+$/)) return '';
        const tag = isHeader ? 'th' : 'td';
        return `<${tag}>${inlineMarkdown(c)}</${tag}>`;
      }).filter(c => c !== '').join('');
      if (row) html += `<tr>${row}</tr>`;
      continue;
    } else if (inList === 'table') {
      html += '</table>';
      inList = false;
    }
    const hMatch = line.match(/^(#{1,3}) (.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      html += `<h${level}>${inlineMarkdown(hMatch[2])}</h${level}>`;
      continue;
    }
    const ulMatch = line.match(/^[-*] (.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        if (inList) html += inList === 'ol' ? '</ol>' : '';
        html += '<ul>';
        inList = 'ul';
      }
      html += `<li>${inlineMarkdown(ulMatch[1])}</li>`;
      continue;
    }
    const olMatch = line.match(/^(\d+)\. (.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        if (inList) html += inList === 'ul' ? '</ul>' : '';
        html += '<ol>';
        inList = 'ol';
      }
      html += `<li>${inlineMarkdown(olMatch[2])}</li>`;
      continue;
    }
    if (inList) {
      html += inList === 'ul' ? '</ul>' : inList === 'ol' ? '</ol>' : '';
      inList = false;
    }
    if (line.trim() === '') {
      html += '<br>';
      continue;
    }
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  if (inCode) {
    html += `<pre><code>${escapeHtml(codeContent.trim())}</code></pre>`;
  }
  if (inList === 'table') {
    html += '</table>';
  } else if (inList) {
    html += inList === 'ul' ? '</ul>' : '</ol>';
  }
  return html;
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date)) return isoString;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const providerDefaults = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  custom: { baseUrl: '', model: '' },
};

function applyProviderDefaults() {
  const provider = settingsForm.llmProvider.value;
  const defaults = providerDefaults[provider] || { baseUrl: '', model: '' };
  if (!settingsForm.openaiBaseUrl.value) {
    settingsForm.openaiBaseUrl.value = defaults.baseUrl;
  }
  if (!settingsForm.llmModel.value) {
    settingsForm.llmModel.value = defaults.model;
  }
}

// Settings
function openSettings() {
  settingsForm.larkCliPath.value = config.larkCliPath || '';
  settingsForm.larkIdentity.value = config.larkIdentity || 'user';
  settingsForm.appId.value = config.appId || '';
  settingsForm.appSecret.value = '';
  settingsForm.llmProvider.value = config.llmProvider || 'openai';
  applyProviderDefaults();
  apiKeyNote.textContent = config.openaiApiKey === '***' ? 'API Key 已保存，留空不修改' : '首次使用需要填写';
  settingsForm.openaiApiKey.value = '';
  settingsForm.openaiBaseUrl.value = config.openaiBaseUrl || '';
  settingsForm.llmModel.value = config.llmModel || '';
  settingsForm.pageSize.value = config.pageSize || 9;
  settingsForm.topK.value = config.topK || 3;
  advancedVisible = false;
  advancedFields.classList.remove('show');
  advancedToggle.textContent = '高级设置 ▼';
  settingsModal.classList.add('show');
}

function closeSettingsModal() {
  settingsModal.classList.remove('show');
}

function toggleAdvanced() {
  advancedVisible = !advancedVisible;
  if (advancedVisible) {
    advancedFields.classList.add('show');
    advancedToggle.textContent = '高级设置 ▲';
  } else {
    advancedFields.classList.remove('show');
    advancedToggle.textContent = '高级设置 ▼';
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const formData = new FormData(settingsForm);
  const newConfig = {
    larkCliPath: formData.get('larkCliPath'),
    larkIdentity: formData.get('larkIdentity'),
    appId: formData.get('appId'),
    llmProvider: formData.get('llmProvider'),
    openaiBaseUrl: formData.get('openaiBaseUrl'),
    llmModel: formData.get('llmModel'),
    pageSize: parseInt(formData.get('pageSize'), 10),
    topK: parseInt(formData.get('topK'), 10),
  };
  const appSecret = formData.get('appSecret');
  if (appSecret) newConfig.appSecret = appSecret;
  const apiKey = formData.get('openaiApiKey');
  if (apiKey) newConfig.openaiApiKey = apiKey;

  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(newConfig),
    });
    await loadConfig();
    closeSettingsModal();
    showToast('配置已保存');
  } catch (err) {
    alert('保存失败：' + err.message);
  }
}

// Interactions
function toggleWebSearch() {
  webSearch = !webSearch;
  webSearchBtn.classList.toggle('active', webSearch);
}

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

async function shareChat() {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    showToast('链接已复制');
  } catch (e) {
    showToast(url);
  }
}

function setupEventListeners() {
  newChatBtn.addEventListener('click', createNewConversation);
  settingsBtn.addEventListener('click', openSettings);
  knowledgeBaseBtn.addEventListener('click', openSettings);
  closeSettings.addEventListener('click', closeSettingsModal);
  settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettingsModal);
  settingsForm.addEventListener('submit', saveSettings);
  settingsForm.llmProvider.addEventListener('change', applyProviderDefaults);
  advancedToggle.addEventListener('click', toggleAdvanced);
  sendBtn.addEventListener('click', askQuestion);
  webSearchBtn.addEventListener('click', toggleWebSearch);
  shareBtn.addEventListener('click', shareChat);
  feedbackBtn.addEventListener('click', () => showToast('反馈功能开发中'));
  addFileBtn.addEventListener('click', () => showToast('附件功能开发中'));
  historySearchInput.addEventListener('input', (e) => {
    historySearch = e.target.value.trim();
    renderHistory();
  });
}

function setupInput() {
  questionInput.addEventListener('input', () => {
    questionInput.style.height = 'auto';
    questionInput.style.height = Math.min(questionInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = questionInput.value.trim().length === 0 || isLoading;
  });

  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) askQuestion();
    }
  });
}

// Start
init();