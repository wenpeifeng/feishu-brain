// State
let currentConversationId = null;
let conversations = [];
let config = {};
let isLoading = false;
let webSearch = false;
let historySearch = '';

// DOM refs (populated after DOMContentLoaded / auth guard calls init)
let chatContainer;
let questionInput;
let sendBtn;
let historyList;
let newChatBtn;
let settingsBtn;
let settingsModal;
let closeSettings;
let settingsForm;
let chatTitle;
let historySearchInput;
let webSearchBtn;
let shareBtn;
let feedbackBtn;
let knowledgeBaseBtn;
let addFileBtn;

// ─── Auth helpers ────────────────────────────────────────────────────────────

async function authFetch(url, opts) {
  if (opts === undefined) opts = {};
  const token = localStorage.getItem('kb_token');
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, Object.assign({}, opts, { headers: headers }));
  if (res.status === 401) {
    localStorage.removeItem('kb_token');
    location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  return res;
}

function renderUser(user) {
  const avatarEl = document.getElementById('userAvatar');
  if (!avatarEl) return;
  if (user && user.avatar) {
    avatarEl.innerHTML = '<img src="' + user.avatar + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">';
  } else {
    avatarEl.textContent = (user && user.name ? user.name : 'U').charAt(0);
  }
  avatarEl.title = (user && user.name) ? user.name : '';
  avatarEl.style.cursor = 'pointer';
  avatarEl.addEventListener('click', function() {
    if (confirm('确定要退出登录吗？')) {
      authFetch('/api/auth/logout', { method: 'POST' }).catch(function() {});
      localStorage.removeItem('kb_token');
      location.href = '/login.html';
    }
  });
}

// ─── Core API ────────────────────────────────────────────────────────────────

async function api(url, options) {
  if (options === undefined) options = {};
  const res = await authFetch(url, options);
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.error || 'API error');
    err.larkError = data.larkError;
    err.hint = data.hint;
    throw err;
  }
  return data;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Wire up DOM refs now that we know auth passed
  chatContainer = document.getElementById('chatContainer');
  questionInput = document.getElementById('questionInput');
  sendBtn = document.getElementById('sendBtn');
  historyList = document.getElementById('historyList');
  newChatBtn = document.getElementById('newChatBtn');
  settingsBtn = document.getElementById('settingsBtn');
  settingsModal = document.getElementById('settingsModal');
  closeSettings = document.getElementById('closeSettings');
  settingsForm = document.getElementById('settingsForm');
  chatTitle = document.getElementById('chatTitle');
  historySearchInput = document.getElementById('historySearch');
  webSearchBtn = document.getElementById('webSearchBtn');
  shareBtn = document.getElementById('shareBtn');
  feedbackBtn = document.getElementById('feedbackBtn');
  knowledgeBaseBtn = document.getElementById('knowledgeBaseBtn');
  addFileBtn = document.getElementById('addFileBtn');

  await Promise.all([loadConfig(), loadConversations()]);
  renderHistory();
  setupEventListeners();
  setupInput();
  if (!currentConversationId) {
    await createNewConversation();
  }
}

// ─── Config & conversations ───────────────────────────────────────────────────

async function loadConfig() {
  try {
    const data = await api('/api/config');
    config = data.config || {};
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
    const data = await api('/api/conversations/' + id);
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
    conversations.unshift(Object.assign({}, conversation, { messageCount: 0 }));
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
    await api('/api/conversations/' + id, { method: 'DELETE' });
    conversations = conversations.filter(function(c) { return c.id !== id; });
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

// ─── Ask / SSE streaming ──────────────────────────────────────────────────────

async function askQuestion() {
  if (isLoading) return;
  const question = questionInput.value.trim();
  if (!question || !currentConversationId) return;

  questionInput.value = '';
  questionInput.style.height = 'auto';
  sendBtn.disabled = true;
  isLoading = true;

  appendUserMessage(question);

  // Create AI bubble with streaming support
  var streamResult = appendStreamingBubble();
  var bubbleEl = streamResult.bubbleEl;
  var msgEl = streamResult.msgEl;
  var thinkBox = streamResult.thinkBox;
  var thinkBody = streamResult.thinkBody;
  var reasoningText = '';

  try {
    const res = await authFetch('/api/conversations/' + currentConversationId + '/ask', {
      method: 'POST',
      body: JSON.stringify({ question: question, webSearch: webSearch }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(function() { return {}; });
      const err = new Error(errData.error || 'Request failed');
      err.hint = errData.hint;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Parse SSE events separated by \n\n
      const events = buffer.split('\n\n');
      buffer = events.pop(); // keep incomplete last chunk

      for (let ei = 0; ei < events.length; ei++) {
        const eventBlock = events[ei];
        if (!eventBlock.trim()) continue;
        const lines = eventBlock.split('\n');
        let eventType = '';
        let dataStr = '';
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataStr = line.slice(6);
          }
        }
        if (!dataStr) continue;

        let payload;
        try { payload = JSON.parse(dataStr); } catch (e) { continue; }

        if (eventType === 'references' && payload.references) {
          appendReferencesAfterBubble(msgEl, payload.references);
        } else if (eventType === 'reasoning' && payload.delta) {
          // 深度思考过程：实时显示，让用户看到进度而不是干等
          reasoningText += payload.delta;
          thinkBox.style.display = 'block';
          thinkBody.textContent = reasoningText;
          scrollToBottom();
        } else if (eventType === 'token' && payload.delta) {
          // 首个正文 token 到达：思考结束，自动收起思考框
          if (fullText === '' && reasoningText) {
            thinkBox.classList.add('collapsed');
            msgEl.querySelector('.think-label').textContent = '已深度思考';
            msgEl.querySelector('.think-toggle').textContent = '展开';
            var sp = msgEl.querySelector('.think-spinner'); if (sp) sp.remove();
          }
          fullText += payload.delta;
          bubbleEl.classList.remove('streaming');
          bubbleEl.innerHTML = renderMarkdown(fullText);
          scrollToBottom();
        } else if (eventType === 'done') {
          appendDoneNote(msgEl);
          updateConversationTitleFromCurrent(question);
        } else if (eventType === 'error') {
          bubbleEl.innerHTML = '<div class="error">出错了：' + escapeHtml(payload.error || '') + (payload.hint ? '<div style="margin-top:8px;color:#646a73;">' + escapeHtml(payload.hint) + '</div>' : '') + '</div>';
          scrollToBottom();
        }
      }
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      bubbleEl.innerHTML = '<div class="error">出错了：' + escapeHtml(err.message) + (err.hint ? '<div style="margin-top:8px;color:#646a73;">' + escapeHtml(err.hint) + '</div>' : '') + '</div>';
      scrollToBottom();
    }
  } finally {
    isLoading = false;
    sendBtn.disabled = questionInput.value.trim().length === 0;
  }
}

function appendStreamingBubble() {
  hideWelcome();
  const msgEl = document.createElement('div');
  msgEl.className = 'message';
  msgEl.innerHTML =
    '<div class="avatar">AI</div><div class="message-content">' +
      '<div class="think-box" style="display:none;">' +
        '<div class="think-head"><span class="think-spinner"></span><span class="think-label">正在深度思考…</span><span class="think-toggle">收起</span></div>' +
        '<div class="think-body"></div>' +
      '</div>' +
      '<div class="message-bubble markdown-body streaming"><div class="loading-dots"><span></span><span></span><span></span></div></div>' +
    '</div>';
  chatContainer.appendChild(msgEl);
  scrollToBottom();
  const thinkBox = msgEl.querySelector('.think-box');
  const thinkBody = msgEl.querySelector('.think-body');
  // 点击标题展开/收起思考过程
  msgEl.querySelector('.think-head').addEventListener('click', function () {
    const collapsed = thinkBox.classList.toggle('collapsed');
    msgEl.querySelector('.think-toggle').textContent = collapsed ? '展开' : '收起';
  });
  return { bubbleEl: msgEl.querySelector('.message-bubble'), msgEl: msgEl, thinkBox: thinkBox, thinkBody: thinkBody };
}

// 统一的参考资料区块构建（飞书紧凑编号列表）。流式与历史加载共用，样式一致。
function buildReferencesSection(references) {
  const section = document.createElement('div');
  section.className = 'references';
  const titleEl = document.createElement('div');
  titleEl.className = 'references-title';
  titleEl.textContent = '为你找到 ' + references.length + ' 篇参考资料';
  section.appendChild(titleEl);
  const list = document.createElement('div');
  list.className = 'references-list';
  references.forEach(function(ref, i) {
    const item = document.createElement('div');
    item.className = 'reference-item';
    // 作者：仅当有真实姓名（ownerName）时显示，绝不显示 open_id
    const author = ref.ownerName
      ? '<span class="ref-author"><span class="ref-avatar">' + escapeHtml(ref.ownerName.slice(0, 1)) + '</span>' + escapeHtml(ref.ownerName) + '</span>'
      : '';
    const date = ref.editTime ? '<span class="ref-date">' + escapeHtml(ref.editTime) + '</span>' : '';
    item.innerHTML =
      '<span class="ref-num">' + (i + 1) + '</span>' +
      '<span class="ref-icon">' + getFileIcon(ref) + '</span>' +
      '<a class="ref-title" href="' + safeUrl(ref.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(ref.title || '') + '</a>' +
      author + date;
    list.appendChild(item);
  });
  section.appendChild(list);
  return section;
}

function appendReferencesAfterBubble(msgEl, references) {
  msgEl.after(buildReferencesSection(references));
  scrollToBottom();
}

// 有真实消息时移除欢迎语占位，避免欢迎语与对话内容重叠
function hideWelcome() {
  const w = chatContainer.querySelector('.welcome');
  if (w) w.remove();
}

function appendDoneNote(msgEl) {
  const note = document.createElement('div');
  note.className = 'ai-disclaimer';
  note.textContent = 'AI 基于你有权限的资料生成，数据保密仅你可见';
  // 插到该 AI 消息其参考资料区块之后
  let lastSib = msgEl;
  while (lastSib.nextElementSibling && lastSib.nextElementSibling.classList.contains('references')) {
    lastSib = lastSib.nextElementSibling;
  }
  lastSib.after(note);
  scrollToBottom();
}

function updateConversationTitleFromCurrent(question) {
  const conv = conversations.find(function(c) { return c.id === currentConversationId; });
  if (conv && conv.title === '新对话') {
    conv.title = question.slice(0, 30);
    renderHistory();
  }
  chatTitle.textContent = conv ? conv.title : '飞书知识问答';
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderHistory() {
  const filtered = conversations.filter(function(c) {
    return !historySearch || c.title.toLowerCase().includes(historySearch.toLowerCase());
  });
  historyList.innerHTML = '';
  if (filtered.length === 0) {
    historyList.innerHTML = '<div class="empty-state">暂无历史对话</div>';
    return;
  }
  filtered.forEach(function(conv) {
    const item = document.createElement('div');
    item.className = 'history-item' + (conv.id === currentConversationId ? ' active' : '');
    item.innerHTML = '<span class="history-title">' + escapeHtml(conv.title) + '</span><button class="history-delete" title="删除">\xd7</button>';
    item.addEventListener('click', function() { loadConversation(conv.id); });
    item.querySelector('.history-delete').addEventListener('click', function(e) { deleteConversation(conv.id, e); });
    historyList.appendChild(item);
  });
}

function renderEmptyChat() {
  chatContainer.innerHTML = '<div class="welcome"><h2>基于飞书知识库的问答助手</h2><p>输入问题，我将搜索你的飞书知识库并给出总结回答。</p></div>';
  chatTitle.textContent = '飞书知识问答';
}

function renderConversation(conversation) {
  chatTitle.textContent = conversation.title;
  chatContainer.innerHTML = '';
  if (!conversation.messages || conversation.messages.length === 0) {
    renderEmptyChat();
    return;
  }
  conversation.messages.forEach(function(msg) {
    if (msg.role === 'user') {
      appendUserMessage(msg.content, false);
    } else {
      appendAssistantMessage(msg.content, msg.references, msg.sources, msg.mock, false);
    }
  });
  scrollToBottom();
}

function appendUserMessage(content, scroll) {
  if (scroll === undefined) scroll = true;
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = '<div class="avatar">我</div><div class="message-content"><div class="message-bubble">' + escapeHtml(content) + '</div></div>';
  chatContainer.appendChild(msg);
  if (scroll) forceScrollToBottom();  // 发新问题时总是滚到底并重置粘底
}

function appendAssistantMessage(content, references, sources, mock, scroll) {
  if (scroll === undefined) scroll = true;
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'message';
  let html = '<div class="avatar">AI</div><div class="message-content">';
  if (mock) {
    html += '<div class="mock-badge">示例数据</div>';
  }
  html += '<div class="message-bubble markdown-body">' + renderMarkdown(content) + '</div></div>';
  msg.innerHTML = html;
  chatContainer.appendChild(msg);

  // 参考资料紧跟在该 AI 消息之后（不再有单独的"来源文档"区块）
  if (references && references.length > 0) {
    msg.after(buildReferencesSection(references));
  }
  if (scroll) scrollToBottom();
}

// 仅当用户"贴着底部"时才自动滚动；用户往上滚看内容时不再强制拉回
let stickToBottom = true;
function isNearBottom() {
  return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
}
function scrollToBottom() {
  if (stickToBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
}
function forceScrollToBottom() {
  stickToBottom = true;
  chatContainer.scrollTop = chatContainer.scrollHeight;
}
function initScrollTracking() {
  chatContainer.addEventListener('scroll', function () {
    stickToBottom = isNearBottom();
  }, { passive: true });
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function openSettings() {
  settingsModal.classList.add('show');
  try {
    const res = await authFetch('/api/config');
    const data = await res.json();
    if (data.ok) {
      renderProviderDropdown(data.providers || [], data.config || {});
    }
  } catch (e) {
    console.error('Load config failed:', e);
  }
}

function renderProviderDropdown(providers, cfg) {
  const providerSelect = document.getElementById('providerSelect');
  const customFields = document.getElementById('customFields');
  if (!providerSelect) return;

  providerSelect.innerHTML = '';
  providers.forEach(function(p) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.model ? ' (' + p.model + ')' : '');
    providerSelect.appendChild(opt);
  });

  providerSelect.value = cfg.providerId || (providers[0] && providers[0].id) || '';

  // Show/hide custom fields
  const showCustom = providerSelect.value === 'custom';
  if (customFields) customFields.style.display = showCustom ? 'block' : 'none';

  // Fill custom fields if custom
  if (cfg.custom) {
    const customBaseUrl = document.getElementById('customBaseUrl');
    const customModel = document.getElementById('customModel');
    if (customBaseUrl) customBaseUrl.value = cfg.custom.baseUrl || '';
    if (customModel) customModel.value = cfg.custom.model || '';
  }

  // Fill topK and pageSize
  const topKInput = document.getElementById('topKInput');
  const pageSizeInput = document.getElementById('pageSizeInput');
  if (topKInput) topKInput.value = cfg.topK || 3;
  if (pageSizeInput) pageSizeInput.value = cfg.pageSize || 9;

  // Wire up provider change
  providerSelect.onchange = function() {
    if (customFields) customFields.style.display = providerSelect.value === 'custom' ? 'block' : 'none';
  };
}

function closeSettingsModal() {
  settingsModal.classList.remove('show');
}

async function saveSettings(e) {
  e.preventDefault();
  const providerSelect = document.getElementById('providerSelect');
  const providerId = providerSelect ? providerSelect.value : '';
  const newConfig = { providerId: providerId };

  if (providerId === 'custom') {
    const customBaseUrl = document.getElementById('customBaseUrl');
    const customModel = document.getElementById('customModel');
    const customApiKey = document.getElementById('customApiKey');
    newConfig.custom = {
      baseUrl: customBaseUrl ? customBaseUrl.value : '',
      model: customModel ? customModel.value : '',
    };
    if (customApiKey && customApiKey.value) {
      newConfig.custom.apiKey = customApiKey.value;
    }
  }

  const topKInput = document.getElementById('topKInput');
  const pageSizeInput = document.getElementById('pageSizeInput');
  if (topKInput) newConfig.topK = parseInt(topKInput.value, 10);
  if (pageSizeInput) newConfig.pageSize = parseInt(pageSizeInput.value, 10);

  try {
    const res = await authFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(newConfig),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');
    closeSettingsModal();
    showToast('配置已保存');
  } catch (err) {
    alert('保存失败：' + err.message);
  }
}

// ─── Interactions ─────────────────────────────────────────────────────────────

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
  setTimeout(function() { toast.classList.remove('show'); }, 2000);
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
  // v1 暂无独立知识库管理页（上传/管理为 v2）；此按钮仅作「搜索覆盖全部有权限文档」的状态提示
  knowledgeBaseBtn.addEventListener('click', function () {
    alert('搜索已覆盖你飞书内有权限的全部文档。\n（知识库上传 / 管理为后续版本功能）');
  });
  closeSettings.addEventListener('click', closeSettingsModal);
  settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettingsModal);
  settingsForm.addEventListener('submit', saveSettings);
  sendBtn.addEventListener('click', askQuestion);
  webSearchBtn.addEventListener('click', toggleWebSearch);
  shareBtn.addEventListener('click', shareChat);
  feedbackBtn.addEventListener('click', function() { showToast('反馈功能开发中'); });
  addFileBtn.addEventListener('click', function() { showToast('附件功能开发中'); });
  historySearchInput.addEventListener('input', function(e) {
    historySearch = e.target.value.trim();
    renderHistory();
  });
}

function setupInput() {
  questionInput.addEventListener('input', function() {
    questionInput.style.height = 'auto';
    questionInput.style.height = Math.min(questionInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = questionInput.value.trim().length === 0 || isLoading;
  });

  questionInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) askQuestion();
    }
  });
}

// ─── Utility functions ────────────────────────────────────────────────────────

function getFileIcon(ref) {
  const title = (ref.title || '').toLowerCase();
  const type = (ref.type || '').toLowerCase();
  var color = '#3370ff';       // 文档蓝
  var body = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="' + color + '" opacity="0.12"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" fill="none" stroke="' + color + '" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="' + color + '" stroke-width="1.6"/>';
  if (type.includes('sheet') || type.includes('bitable') || title.endsWith('.xlsx') || title.endsWith('.xls')) {
    color = '#34c724';         // 表格绿
    body = '<rect x="4" y="4" width="16" height="16" rx="2" fill="' + color + '" opacity="0.12"/><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="' + color + '" stroke-width="1.6"/><path d="M4 10h16M4 15h16M10 4v16" stroke="' + color + '" stroke-width="1.4"/>';
  } else if (type.includes('chat') || type.includes('message') || title.includes('会话')) {
    color = '#3370ff';         // 会话蓝
    body = '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2z" fill="' + color + '" opacity="0.12"/><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4a2 2 0 0 1-1-2z" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
  }
  return '<svg width="16" height="16" viewBox="0 0 24 24">' + body + '</svg>';
}

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
        html += '<pre><code>' + escapeHtml(codeContent.trim()) + '</code></pre>';
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
      const cells = line.split('|').map(function(c) { return c.trim(); }).filter(function(c) { return c !== ''; });
      const isHeader = cells.some(function(c) { return c.match(/^-+$/); });
      const row = cells.map(function(c) {
        if (c.match(/^-+$/)) return '';
        const tag = isHeader ? 'th' : 'td';
        return '<' + tag + '>' + inlineMarkdown(c) + '</' + tag + '>';
      }).filter(function(c) { return c !== ''; }).join('');
      if (row) html += '<tr>' + row + '</tr>';
      continue;
    } else if (inList === 'table') {
      html += '</table>';
      inList = false;
    }
    const hMatch = line.match(/^(#{1,3}) (.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      html += '<h' + level + '>' + inlineMarkdown(hMatch[2]) + '</h' + level + '>';
      continue;
    }
    const ulMatch = line.match(/^[-*] (.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        if (inList) html += inList === 'ol' ? '</ol>' : '';
        html += '<ul>';
        inList = 'ul';
      }
      html += '<li>' + inlineMarkdown(ulMatch[1]) + '</li>';
      continue;
    }
    const olMatch = line.match(/^(\d+)\. (.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        if (inList) html += inList === 'ul' ? '</ul>' : '';
        html += '<ol>';
        inList = 'ol';
      }
      html += '<li>' + inlineMarkdown(olMatch[2]) + '</li>';
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
    html += '<p>' + inlineMarkdown(line) + '</p>';
  }
  if (inCode) {
    html += '<pre><code>' + escapeHtml(codeContent.trim()) + '</code></pre>';
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
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, text, url) { return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'; });
  return html;
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date)) return isoString;
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// ─── Auth Guard (runs immediately, calls init() after auth passes) ─────────────

(async function authGuard() {
  // 1. Check URL for ?token= param
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    localStorage.setItem('kb_token', params.get('token'));
    // clean URL, respect state redirect (only allow site-internal relative paths)
    let state = params.get('state') || '/';
    if (!/^\/[^/]/.test(state) && state !== '/') state = '/';
    history.replaceState(null, '', state);
  }

  // 2. Check localStorage for token
  const token = localStorage.getItem('kb_token');
  if (!token) {
    location.href = '/login.html';
    return;
  }

  // 3. Verify token with /api/auth/me
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401) {
      localStorage.removeItem('kb_token');
      location.href = '/login.html';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      localStorage.removeItem('kb_token');
      location.href = '/login.html';
      return;
    }
    // Render user info in header
    renderUser(data.user);
  } catch (e) {
    // Network error - allow to proceed (offline tolerance)
    console.warn('Auth check failed:', e);
  }

  // 4. Start app
  init();
})();
