// State
let currentUser = null;
let activeView = 'chat';   // 'chat' | 'kb' | 'dash' | 'quality' — 决定侧栏哪个高亮
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
let kbScope = 'personal';
let kbCanManage = true;

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
  currentUser = user || null;
  const avatarEl = document.getElementById('userAvatar');
  if (!avatarEl) return;
  if (user && user.avatar) {
    avatarEl.innerHTML = '<img src="' + user.avatar + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">';
  } else {
    avatarEl.textContent = (user && user.name ? user.name : 'U').charAt(0);
  }
  avatarEl.title = (user && user.name) ? user.name : '';
  avatarEl.style.cursor = 'pointer';
  avatarEl.tabIndex = 0;
  avatarEl.setAttribute('role', 'button');
  avatarEl.setAttribute('aria-haspopup', 'menu');
  avatarEl.setAttribute('aria-expanded', 'false');
  avatarEl.setAttribute('aria-label', '打开个人菜单');
  var toggleUserMenu = function (e, focusFirst) {
    if (e) e.stopPropagation();
    var open = avatarEl.querySelector('.user-menu');
    if (open) {
      open.remove();
      avatarEl.setAttribute('aria-expanded', 'false');
      return;
    }
    var name = (user && user.name) || '用户';
    var avHtml = (user && user.avatar) ? '<img src="' + user.avatar + '">' : escapeHtml(name.charAt(0));
    var menu = document.createElement('div');
    menu.className = 'user-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '个人与组织设置');
    menu.innerHTML =
      '<div class="um-head"><div class="um-av">' + avHtml + '</div>' +
      '<div class="um-meta"><div class="um-name">' + escapeHtml(name) + '</div>' +
      '<div class="um-sub">飞书账号 · 已登录</div></div></div>' +
      '<button class="user-menu-item" data-act="tasks">' + TB_ICON.clock + '<span>定时追踪</span></button>' +
      '<button class="user-menu-item" data-act="settings">' + SETTINGS_SVG + '<span>模型配置</span></button>' +
      '<button class="user-menu-item" data-act="dev">' + DEV_SVG + '<span>开发者设置</span></button>' +
      (user && user.isAdmin ? '<button class="user-menu-item" data-act="organization">' + ORG_SVG + '<span>组织管理</span></button>' : '') +
      '<button class="user-menu-item danger" data-act="logout">' + LOGOUT_SVG + '<span>退出登录</span></button>';
    avatarEl.appendChild(menu);
    avatarEl.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll('.user-menu-item').forEach(function (item) { item.setAttribute('role', 'menuitem'); });
    var close = function (restoreFocus) {
      menu.remove();
      avatarEl.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDoc);
      if (restoreFocus) avatarEl.focus();
    };
    var onDoc = function (ev) { if (!avatarEl.contains(ev.target)) close(); };
    setTimeout(function () { document.addEventListener('click', onDoc); }, 0);
    menu.addEventListener('keydown', function (ev) {
      var items = Array.from(menu.querySelectorAll('.user-menu-item'));
      var current = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { ev.preventDefault(); close(true); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var delta = ev.key === 'ArrowDown' ? 1 : -1;
        items[(current + delta + items.length) % items.length].focus();
      }
    });
    menu.querySelector('[data-act="tasks"]').addEventListener('click', function (ev) { ev.stopPropagation(); close(); openTasks(); });
    menu.querySelector('[data-act="settings"]').addEventListener('click', function (ev) { ev.stopPropagation(); close(); openSettings(); });
    menu.querySelector('[data-act="dev"]').addEventListener('click', function (ev) { ev.stopPropagation(); close(); openDevSettings(); });
    var orgBtn = menu.querySelector('[data-act="organization"]');
    if (orgBtn) orgBtn.addEventListener('click', function (ev) { ev.stopPropagation(); close(); openOrganization(); });
    menu.querySelector('[data-act="logout"]').addEventListener('click', function (ev) {
      ev.stopPropagation();
      authFetch('/api/auth/logout', { method: 'POST' }).catch(function () {});
      localStorage.removeItem('kb_token');
      location.href = '/login.html';
    });
    if (focusFirst) menu.querySelector('.user-menu-item').focus();
  };
  // 使用属性处理器避免用户信息重绘时重复绑定、一次点击出现“打开又关闭”。
  avatarEl.onclick = function (e) { toggleUserMenu(e, false); };
  avatarEl.onkeydown = function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUserMenu(e, true); }
    else if (e.key === 'ArrowDown' && !avatarEl.querySelector('.user-menu')) { e.preventDefault(); toggleUserMenu(e, true); }
  };
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
  setupCitationPreview();
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
    // 登录后不自动进入最近一条对话——默认落到"新对话"空页（见 init → createNewConversation）
  } catch (e) {
    console.error('Load conversations failed:', e);
  }
}

async function loadConversation(id) {
  try {
    const data = await api('/api/conversations/' + id);
    activeView = 'chat';
    renderConversation(data.conversation);
    currentConversationId = id;
    renderHistory();
  } catch (e) {
    console.error('Load conversation failed:', e);
  }
}

// 新对话＝纯前端进入空页，先不建后端记录；发出第一条消息时才真正创建（见 askQuestion），
// 避免左侧堆一堆没发过消息的空"新对话"。
function createNewConversation() {
  activeView = 'chat';
  currentConversationId = null;
  renderHistory();
  renderEmptyChat();
  chatTitle.textContent = '飞书知识问答';
  questionInput.focus();
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

async function askQuestion(forcedQuestion, opts) {
  if (isLoading) return;
  opts = opts || {};
  // 只有传入字符串才当作"指定问题"（重新生成用）；事件对象等一律走输入框，避免 [object PointerEvent] 之类
  const question = (typeof forcedQuestion === 'string' ? forcedQuestion : questionInput.value).trim();
  if (!question) return;
  // 首次提问才创建对话记录（左侧此刻才出现这条对话），避免空"新对话"堆积
  if (!currentConversationId) {
    try {
      const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '新对话' }) });
      conversations.unshift(Object.assign({}, created.conversation, { messageCount: 0 }));
      currentConversationId = created.conversation.id;
      renderHistory();
    } catch (e) { console.error('Create conversation failed:', e); return; }
  }

  // 发送给后端的问题：若开启了深入研究/帮我写作模式则增强 prompt；气泡仍显示用户原文
  var sendQuestion = (forcedQuestion == null) ? applyInputMode(question) : question;

  if (forcedQuestion == null) {
    questionInput.value = '';
    questionInput.style.height = 'auto';
    clearInputMode();
  }
  sendBtn.disabled = true;
  isLoading = true;

  appendUserMessage(question);

  // Create AI bubble with streaming support
  var streamResult = appendStreamingBubble();
  var bubbleEl = streamResult.bubbleEl;
  var msgEl = streamResult.msgEl;
  var thinkPanel = streamResult.thinkPanel;
  var thinkText = streamResult.thinkText;
  var thinkTime = streamResult.thinkTime;
  var thinkSteps = streamResult.thinkSteps;
  var thinkToggle = streamResult.thinkToggle;
  var pendingReferences = null;
  var pendingDebug = null;
  var pendingRelatedFiles = null;
  var pendingRelatedEvidence = null;
  var sawNoResult = false;   // 后端判定"答不了"（无召回/无相关）→ 回答后追加"联系作者"兜底卡
  var sawAbout = false;      // 身份/作者类问题 → 回答后追加"关于弧光团队/关注公众号"卡
  var pendingConfidence = null;   // 置信度（high/medium + 佐证篇数）→ 参考区显示徽标
  var pendingConflict = null;     // 多来源冲突提示 → 参考区上方黄条
  var thinkStart = 0;
  var thinkTimer = null;
  var sawReasoning = false;
  var lastThinkStep = '';
  // 显示思考面板并计时（检索/推理都算"深度思考"）
  var startThinking = function () {
    thinkPanel.style.display = 'block';
    if (!thinkStart) {
      thinkStart = Date.now();
      thinkTimer = setInterval(function () { thinkTime.textContent = ' · ' + Math.round((Date.now() - thinkStart) / 1000) + 's'; }, 200);
    }
  };
  // 累积一步过程（去重连续重复），点开可回看
  var pushThinkStep = function (text) {
    if (!text || text === lastThinkStep) return;
    lastThinkStep = text;
    var d = document.createElement('div');
    d.className = 'think-step';
    d.textContent = text;
    thinkSteps.appendChild(d);
  };
  var lastRenderTs = 0, renderQueued = false;
  var renderTimer = null, streamFinalized = false;
  // 最终引用渲染前必须取消尚未执行的 token 草稿渲染；否则旧定时器会把 <sup> 角标
  // 覆盖回普通的 “[n]” 文本。这是所有流式回答共用的生命周期约束。
  var stopDraftRendering = function () {
    streamFinalized = true;
    renderQueued = false;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  };

  try {
    const res = await authFetch('/api/conversations/' + currentConversationId + '/ask', {
      method: 'POST',
      body: JSON.stringify({ question: sendQuestion, webSearch: webSearch }),
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

        if (eventType === 'status' && payload.text) {
          // 即时进度反馈：正在搜索 / 正在阅读（让用户看到系统在动，不是卡住）
          startThinking();
          thinkText.textContent = payload.text;
          pushThinkStep(payload.text);
        } else if (eventType === 'conflict' && payload.text) {
          pendingConflict = payload.text;   // 多来源矛盾 → 回答后在参考区上方黄条提示
        } else if (eventType === 'confidence' && payload.confidence) {
          pendingConfidence = payload.confidence;   // 缓存，回答后随参考区显示置信度徽标
        } else if (eventType === 'about') {
          sawAbout = true;      // 身份/作者问题 → 回答后追加"关于/关注公众号"卡
        } else if (eventType === 'noresult') {
          sawNoResult = true;   // 回答生成完后追加"联系作者/关注公众号"兜底卡
        } else if (eventType === 'references' && payload.references) {
          // 先缓存，等回答生成完再渲染（参考资料出现在答案之后，像飞书）
          pendingReferences = payload.references;
        } else if (eventType === 'answerFinal' && typeof payload.text === 'string') {
          // 服务端完成引用完整性校验后的最终正文；替换流式草稿，避免出现无对应来源的空角标。
          stopDraftRendering();
          fullText = payload.text;
          bubbleEl.innerHTML = linkifyCitations(renderMarkdown(fullText), pendingReferences);
        } else if (eventType === 'debug' && payload.debug) {
          // 检索调试信息（召回/分数/阈值/入选），回答完渲染成可展开面板
          pendingDebug = payload.debug;
        } else if (eventType === 'relatedFiles' && payload.files) {
          // 飞书搜到但读不了正文的相关文件（PDF等），回答完列出让用户可点击查阅
          pendingRelatedFiles = payload.files;
        } else if (eventType === 'relatedEvidence' && payload.evidence) {
          pendingRelatedEvidence = payload.evidence;
        } else if (eventType === 'reasoning' && payload.delta) {
          // 只显示"深度思考中 · 用时"，不暴露原始思考内容（含 prompt 规则/草稿，很丑）
          if (!sawReasoning) {
            sawReasoning = true;
            startThinking();
            thinkText.textContent = '深度思考中';
            pushThinkStep('深度思考中…');
          }
        } else if (eventType === 'token' && payload.delta) {
          // 首个正文 token：把思考面板收成可点开的"已深度思考"pill（保留过程，不是空白间隙）
          if (fullText === '') {
            if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
            if (thinkStart) {
              var secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
              thinkPanel.classList.add('done');
              var sp = thinkPanel.querySelector('.think-spinner'); if (sp) sp.remove();
              thinkText.textContent = sawReasoning ? '已深度思考' : '已完成检索';
              thinkTime.textContent = ' · 用时 ' + secs + 's';
              thinkToggle.addEventListener('click', function () { thinkPanel.classList.toggle('open'); });
            } else {
              thinkPanel.style.display = 'none';   // 无任何过程 → 不显示，头像与首行答案对齐
            }
          }
          fullText += payload.delta;
          bubbleEl.classList.remove('streaming');
          // 节流渲染：每次 token 都全量 renderMarkdown(fullText) 是 O(n²)，长答案会越渲越卡、卡住流式。
          // 改成最多每 60ms 渲染一次；两次渲染间用 rAF 兜个尾，done 时再做最终渲染。
          var _now = Date.now();
          if (_now - lastRenderTs > 60) {
            lastRenderTs = _now;
            bubbleEl.innerHTML = renderMarkdown(fullText);
            scrollToBottom();
          } else if (!renderQueued) {
            renderQueued = true;
            renderTimer = setTimeout(function () {
              renderQueued = false;
              renderTimer = null;
              if (streamFinalized) return;
              lastRenderTs = Date.now();
              bubbleEl.innerHTML = renderMarkdown(fullText);
              scrollToBottom();
            }, 60);
          }
        } else if (eventType === 'done') {
          stopDraftRendering();
          if ((!pendingRelatedEvidence || !pendingRelatedEvidence.length) && payload.relatedEvidence) pendingRelatedEvidence = payload.relatedEvidence;
          // 回答生成完：把正文里的 [n] 渲染成可点击上标（对应下方参考资料），再渲染参考区
          bubbleEl.innerHTML = linkifyCitations(renderMarkdown(fullText), pendingReferences);
          // 顺序：检索详情 → 参考资料 → 相关文件 →（免责）→ 工具栏
          var afterEl = msgEl;
          if (pendingDebug) {
            var dbgEl = buildDebugPanel(pendingDebug);
            afterEl.after(dbgEl); afterEl = dbgEl;
          }
          if (pendingConflict) {   // 多来源矛盾提示（在参考区上方）
            afterEl = insertAlignedCard(afterEl, buildConflictNote(pendingConflict));
          }
          if (pendingReferences && pendingReferences.length) {
            var refEl = buildReferencesSection(pendingReferences, pendingConfidence);
            afterEl.after(refEl); afterEl = refEl;
          }
          if (pendingRelatedEvidence && pendingRelatedEvidence.length) {
            var reEl = buildRelatedEvidence(pendingRelatedEvidence);
            afterEl.after(reEl); afterEl = reEl;
          }
          if (pendingRelatedFiles && pendingRelatedFiles.length) {
            var rfEl = buildRelatedFiles(pendingRelatedFiles);
            afterEl.after(rfEl); afterEl = rfEl;
          }
          if (sawAbout) {      // 身份/作者问题 → 追加"关于弧光团队/关注公众号"卡
            afterEl = insertAlignedCard(afterEl, buildAboutCard());
          }
          if (sawNoResult) {   // 答不了 → 追加"联系作者/关注公众号"兜底卡
            afterEl = insertAlignedCard(afterEl, buildNoResultFallback(question));
          }
          appendDoneNote(msgEl);   // 免责说明放在相关文件之后、工具栏之前（飞书样式）
          appendAnswerToolbar(msgEl, payload.qid, question, fullText, pendingReferences);
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
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    isLoading = false;
    sendBtn.disabled = questionInput.value.trim().length === 0;
  }
}

// AI 卡通头像（豆包风：友好机器人小子，白脸+琥珀天线，衬在蓝色渐变底上）
var AI_AVATAR = '<svg viewBox="0 0 32 32" width="26" height="26" fill="none"><rect x="6.5" y="9.5" width="19" height="14.5" rx="6.5" fill="#fff"/><circle cx="12" cy="16.6" r="1.9" fill="#6a49f2"/><circle cx="20" cy="16.6" r="1.9" fill="#6a49f2"/><path d="M12.4 20.4c1.9 1.7 5.3 1.7 7.2 0" stroke="#6a49f2" stroke-width="1.6" stroke-linecap="round" fill="none"/><line x1="16" y1="9.5" x2="16" y2="6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="5" r="1.8" fill="#f5a623"/></svg>';

// 桂冠装饰：弧茎 + 尖形叶片（非圆叶）；右侧用 CSS 镜像。currentColor 上色。
var _LEAF = 'M0 0 C 3.3 -3.1 6.9 -2.7 9.2 0 C 6.9 2.7 3.3 3.1 0 0 Z';
var _LEAFS = 'M0 0 C 2.9 -2.6 5.9 -2.3 7.8 0 C 5.9 2.3 2.9 2.6 0 0 Z';
var LAUREL_SVG = '<svg width="26" height="40" viewBox="0 0 24 40" fill="none" aria-hidden="true">' +
  '<path d="M15.5 37 C 8 32 6.5 20 11 7" stroke="currentColor" stroke-width="1.6" opacity=".3" stroke-linecap="round"/>' +
  '<g fill="currentColor">' +
  '<path d="' + _LEAF + '" transform="translate(15 35) rotate(205)"/>' +
  '<path d="' + _LEAF + '" transform="translate(11 28) rotate(219)"/>' +
  '<path d="' + _LEAF + '" transform="translate(9 21) rotate(234)"/>' +
  '<path d="' + _LEAF + '" transform="translate(9.5 14) rotate(250)"/>' +
  '<path d="' + _LEAFS + '" transform="translate(12 8) rotate(264)"/>' +
  '</g></svg>';
var SPARK_SVG = '<svg width="13" height="13" viewBox="-8 -8 16 16" fill="currentColor" aria-hidden="true"><path d="M0 -7 C .8 -2 2 -.8 7 0 C 2 .8 .8 2 0 7 C -.8 2 -2 .8 -7 0 C -2 -.8 -.8 -2 0 -7 Z"/></svg>';
// 眼睛（明/暗）——替代 👁/🙈 廉价 emoji
var EYE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_OFF_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a15.4 15.4 0 0 1-3 3.6"/><path d="M6.3 6.3A15.5 15.5 0 0 0 2 12s3.5 7 10 7a9.3 9.3 0 0 0 3-.5"/></svg>';
var LOGOUT_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';
var UPLOAD_SVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
var DEV_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/></svg>';
var ORG_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21h16"/><path d="M6.5 21V5.5A1.5 1.5 0 0 1 8 4h8a1.5 1.5 0 0 1 1.5 1.5V21"/><path d="M9.5 8h1M13.5 8h1M9.5 12h1M13.5 12h1M10 21v-5h4v5"/></svg>';
var HELP_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.3 9a2.7 2.7 0 0 1 5.2 1c0 1.8-2.5 2-2.5 3.6"/><path d="M12 17h.01"/></svg>';
var TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';
var KBEMPTY_SVG = '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
function kbFileIcon(title) {
  var ext = (String(title).split('.').pop() || '').toLowerCase();
  var color = '#7c5cff', label = 'TXT';
  if (ext === 'md' || ext === 'markdown') { color = '#3370ff'; label = 'MD'; }
  else if (ext === 'csv') { color = '#34c724'; label = 'CSV'; }
  else if (ext === 'json') { color = '#f5a623'; label = 'JSON'; }
  else if (ext === 'log') { color = '#8f959e'; label = 'LOG'; }
  return '<span class="kb-ext" style="background:' + color + '18;color:' + color + '">' + label + '</span>';
}
var SETTINGS_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function appendStreamingBubble() {
  hideWelcome();
  const msgEl = document.createElement('div');
  msgEl.className = 'message';
  msgEl.innerHTML =
    '<div class="avatar ai-avatar">' + AI_AVATAR + '</div><div class="message-content">' +
      '<div class="think-panel" style="display:none;">' +
        '<button type="button" class="think-toggle"><span class="think-spinner"></span>' +
        '<span class="think-text">深度思考中</span><span class="think-time"></span>' +
        '<svg class="think-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>' +
        '<div class="think-steps"></div>' +
      '</div>' +
      '<div class="message-bubble markdown-body streaming"><div class="loading-dots"><span></span><span></span><span></span></div></div>' +
    '</div>';
  chatContainer.appendChild(msgEl);
  scrollToBottom();
  return {
    bubbleEl: msgEl.querySelector('.message-bubble'),
    msgEl: msgEl,
    thinkPanel: msgEl.querySelector('.think-panel'),
    thinkText: msgEl.querySelector('.think-text'),
    thinkTime: msgEl.querySelector('.think-time'),
    thinkSteps: msgEl.querySelector('.think-steps'),
    thinkToggle: msgEl.querySelector('.think-toggle'),
  };
}

// 统一的参考资料区块构建（飞书紧凑编号列表）。流式与历史加载共用，样式一致。
// 来源新鲜度：YYYY-MM-DD → 相对时间 + 是否可能过期（>半年）
function relFresh(dateStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (!m) return null;
  var days = Math.floor((Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) / 86400000);
  var label;
  if (days <= 0) label = '今天';
  else if (days === 1) label = '昨天';
  else if (days < 7) label = days + ' 天前';
  else if (days < 30) label = Math.floor(days / 7) + ' 周前';
  else if (days < 365) label = Math.floor(days / 30) + ' 个月前';
  else label = Math.floor(days / 365) + ' 年前';
  return { label: label, stale: days > 180 };
}

// 空结果兜底卡：答不了时引导关注公众号「弧光团队」留言 + 一键把问题提交给作者。
// 二维码图片放 public/assets/gzh-qr.png；缺图自动隐藏、只留文字引导。
function buildNoResultFallback(question) {
  var el = document.createElement('div');
  el.className = 'noresult-card';
  el.innerHTML =
    '<div class="nr-head">' +
      '<span class="nr-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></span>' +
      '<div><div class="nr-title">没找到相关内容</div>' +
      '<div class="nr-sub">可能它不在你有权限的文档里，或者换个说法再问一次。本产品专注「文档知识问答」，通用问题建议回到文档里搜。</div></div>' +
    '</div>' +
    '<div class="nr-contact">' +
      '<img class="nr-qr" src="assets/gzh-qr.png" alt="弧光团队公众号" onerror="this.style.display=\'none\'">' +
      '<div class="nr-contact-tx">' +
        '<div class="nr-contact-t">还是没解决？关注公众号「弧光团队」留言</div>' +
        '<div class="nr-contact-d">作者会看到你的问题，推动补充资料或修复检索。</div>' +
        '<button type="button" class="nr-submit">把这个问题提交给作者</button>' +
      '</div>' +
    '</div>';
  var btn = el.querySelector('.nr-submit');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    authFetch('/api/wish', { method: 'POST', body: JSON.stringify({ type: 'unanswered', content: question }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (j && j.ok) { btn.textContent = '已提交给作者 ✓'; btn.classList.add('done'); showToast('已提交，作者会看到', 'success'); }
        else { btn.disabled = false; showToast(j && j.error ? j.error : '提交失败，请稍后再试', 'error'); }
      })
      .catch(function () { btn.disabled = false; showToast('提交失败，请稍后再试', 'error'); });
  });
  return el;
}

// 把带边框的卡(关于/兜底/冲突)插到 afterEl 之后，并用对齐容器让左边缘与 AI 正文对齐（缩进 68px）。
function insertAlignedCard(afterEl, el) {
  var row = document.createElement('div');
  row.className = 'msg-row';
  row.appendChild(el);
  afterEl.after(row);
  return row;
}

// 多来源冲突提示条（实时与重载复用）
function buildConflictNote(text) {
  var el = document.createElement('div');
  el.className = 'conflict-note';
  el.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>' +
    '<span><b>来源存在不一致：</b>' + escapeHtml(text) + '</span>';
  return el;
}

// 身份/作者卡：介绍「弧光团队」+ 引导关注公众号（用户问"你是谁/谁开发的"时出现）。
function buildAboutCard() {
  var el = document.createElement('div');
  el.className = 'noresult-card';
  el.innerHTML =
    '<div class="nr-head">' +
      '<span class="nr-ic"><svg width="20" height="20" viewBox="-8 -8 16 16" fill="currentColor"><path d="M0 -7 C .8 -2 2 -.8 7 0 C 2 .8 .8 2 0 7 C -.8 2 -2 .8 -7 0 C -2 -.8 -.8 -2 0 -7 Z"/></svg></span>' +
      '<div><div class="nr-title">关于「弧光团队」</div>' +
      '<div class="nr-sub">这个飞书知识问答助手由「弧光团队」打造，专注帮你从飞书文档、知识库、会话里检索带来源、可溯源的答案。</div></div>' +
    '</div>' +
    '<div class="nr-contact">' +
      '<img class="nr-qr" src="assets/gzh-qr.png" alt="弧光团队公众号" onerror="this.style.display=\'none\'">' +
      '<div class="nr-contact-tx">' +
        '<div class="nr-contact-t">关注公众号「弧光团队」了解更多</div>' +
        '<div class="nr-contact-d">最新进展、使用技巧，或想与作者交流，都在这里。</div>' +
      '</div>' +
    '</div>';
  return el;
}

function buildReferencesSection(references, confidence) {
  const section = document.createElement('div');
  section.className = 'references';
  const titleEl = document.createElement('div');
  titleEl.className = 'references-title';
  titleEl.textContent = '为你找到 ' + references.length + ' 篇参考资料';
  // 置信度徽标：高=判官很确定 / 中=压线通过（提醒用户自行核对来源），带佐证篇数
  if (confidence && confidence.level) {
    var isHigh = confidence.level === 'high';
    var badge = document.createElement('span');
    badge.className = 'conf-badge ' + (isHigh ? 'conf-high' : 'conf-mid');
    badge.title = isHigh ? '判官判定高度相关，答案有可靠来源支撑' : '来源为压线通过，建议点开参考核对';
    badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
      (isHigh ? '高置信' : '中置信') + '<span class="conf-src">· ' + confidence.sources + ' 篇佐证</span>';
    titleEl.appendChild(badge);
  }
  section.appendChild(titleEl);
  const list = document.createElement('div');
  list.className = 'references-list';
  references.forEach(function(ref, i) {
    const item = document.createElement('div');
    item.className = 'reference-item';
    // 作者：仅当有真实姓名（ownerName）时显示，绝不显示 open_id。有头像用真实头像，否则用姓名首字
    const avatarInner = ref.ownerAvatar
      ? '<img src="' + safeUrl(ref.ownerAvatar) + '" alt="">'
      : escapeHtml((ref.ownerName || '').slice(0, 1));
    const author = ref.ownerName
      ? '<span class="ref-author"><span class="ref-avatar">' + avatarInner + '</span>' + escapeHtml(ref.ownerName) + '</span>'
      : '';
    const fr = relFresh(ref.editTime);
    const date = ref.editTime
      ? '<span class="ref-date' + (fr && fr.stale ? ' ref-stale' : '') + '" title="更新于 ' + escapeHtml(ref.editTime) + '">' +
        (fr ? fr.label : escapeHtml(ref.editTime)) + (fr && fr.stale ? ' · 可能过期' : '') + '</span>'
      : '';
    item.innerHTML =
      '<span class="ref-num">' + (ref.index || (i + 1)) + '</span>' +
      '<span class="ref-icon">' + getFileIcon(ref) + '</span>' +
      '<a class="ref-title" href="' + safeUrl(ref.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(ref.title || '') + '</a>' +
      author + date;
    list.appendChild(item);
  });
  section.appendChild(list);
  return section;
}

// 法官通过但未进入最终生成上下文的证据：完整可查，但不冒充正文编号引用。
function buildRelatedEvidence(evidence) {
  var box = document.createElement('div');
  box.className = 'related-evidence open';
  box.innerHTML = '<button type="button" class="re-toggle" aria-expanded="true"><span>更多相关结果</span><b>' + evidence.length + '</b><small>相关但未参与本次回答</small><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>' +
    '<div class="re-clip"><div class="re-list">' + evidence.map(function (x) {
      return '<a class="re-item" href="' + safeUrl(x.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="re-source">' + escapeHtml(x.source === 'message' ? '聊天' : '文档') + '</span>' +
        '<span class="re-main"><strong>' + escapeHtml(x.title || '相关资料') + '</strong>' +
        (x.snippet ? '<span>' + escapeHtml(x.snippet) + '</span>' : '') + '</span></a>';
    }).join('') + '</div></div>';
  var toggle = box.querySelector('.re-toggle');
  var clip = box.querySelector('.re-clip');
  var list = box.querySelector('.re-list');
  var resizeFrame = 0;
  var resizeTimer = 0;
  var settleResize = function () {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
    clip.style.height = box.classList.contains('open') ? 'auto' : '0px';
    if (chatContainer) chatContainer.classList.remove('related-resizing');
  };
  // 默认展开直接使用自然高度，不播放挂载动画，避免首屏内容先折叠再弹开。
  clip.style.height = 'auto';
  toggle.addEventListener('click', function () {
    var open = box.classList.contains('open');
    var targetOpen = !open;
    var currentHeight = clip.getBoundingClientRect().height;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (resizeTimer) clearTimeout(resizeTimer);

    // 从当前像素高度开始，快速反向点击时也不会跳到起点。
    clip.style.height = currentHeight + 'px';
    void clip.offsetHeight;
    box.classList.toggle('open', targetOpen);
    toggle.setAttribute('aria-expanded', targetOpen ? 'true' : 'false');
    if (chatContainer) chatContainer.classList.add('related-resizing');

    resizeFrame = requestAnimationFrame(function () {
      resizeFrame = 0;
      clip.style.height = (targetOpen ? list.scrollHeight : 0) + 'px';
    });
    // reduced-motion 没有 transitionend；计时兜底也避免标签切后台时遗留中间高度。
    resizeTimer = setTimeout(settleResize, 480);
  });
  clip.addEventListener('transitionend', function (event) {
    if (event.propertyName === 'height') settleResize();
  });
  return box;
}

// 相关文件（飞书搜到但读不了正文，如 PDF）：不参与作答，单独列出让用户可点击查阅
function fileBadge(f) {
  var t = (f.title || '').toLowerCase();
  if (/\.pdf$/.test(t) || f.type === 'pdf') return 'PDF';
  if (/\.xlsx?$/.test(t)) return 'Excel';
  if (/\.pptx?$/.test(t)) return 'PPT';
  if (/\.docx?$/.test(t)) return 'Word';
  if (/\.(mp4|mov|avi)$/.test(t)) return '视频';
  return '文件';
}
function buildRelatedFiles(files) {
  var box = document.createElement('div');
  box.className = 'related-files';
  var head = '<div class="rf-head">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>' +
    '相关文件 · AI 未能读取正文，可点击查阅</div>';
  var items = files.map(function (f) {
    var badge = fileBadge(f);
    return '<a class="rf-item" href="' + safeUrl(f.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="rf-ic">' + getFileIcon({ type: f.type, title: f.title }) + '</span>' +
      '<span class="rf-title">' + escapeHtml(f.title || '文件') + '</span>' +
      (badge ? '<span class="rf-badge">' + badge + '</span>' : '') + '</a>';
  }).join('');
  box.innerHTML = head + '<div class="rf-list">' + items + '</div>';
  return box;
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
  // 免责说明只保留在"最后一条"AI 回答后：先清掉之前的，再加到当前这条
  chatContainer.querySelectorAll('.ai-disclaimer').forEach(function (n) { n.remove(); });
  var probe = msgEl;
  while (probe.nextElementSibling &&
    (probe.nextElementSibling.classList.contains('references') ||
     probe.nextElementSibling.classList.contains('retrieval-debug') ||
     probe.nextElementSibling.classList.contains('related-evidence') ||
     probe.nextElementSibling.classList.contains('related-files'))) {
    probe = probe.nextElementSibling;
  }
  const note = document.createElement('div');
  note.className = 'ai-disclaimer';
  note.innerHTML = '<svg class="disc-shield" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 22.3 5 18.4 5 14V6z"/><path d="M9 12l2 2 4-4"/></svg>' +
    '<span>AI 基于你有权限的资料生成，数据保密仅你可见</span>';
  probe.after(note);
  scrollToBottom();
}

// 图标集（飞书风格：细线、currentColor）
var TB_ICON = {
  share:  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18.5C4.7 12 9 8.7 15 8.6"/><path d="M12.5 4 19.5 9l-7 5"/></svg>',
  copy:   '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  export: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  like:   '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V11"/><path d="M7 11l3.5-6.5a2 2 0 0 1 2.7-.8 2 2 0 0 1 1 2.4L13 11h5.5a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17.3 21H7"/></svg>',
  dislike:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3v10"/><path d="M17 13l-3.5 6.5a2 2 0 0 1-2.7.8 2 2 0 0 1-1-2.4L11 13H5.5a2 2 0 0 1-2-2.4l1.2-6A2 2 0 0 1 6.7 3H17"/></svg>',
  regen:  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
  link:   '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/></svg>',
  img:    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  dl:     '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>',
  chat:   '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l-3 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/><path d="M14 8l3 3-3 3"/><path d="M17 11H9"/></svg>',
  clock:  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
};

// 答案工具条（对标飞书）：分享 | 复制 | 导出到文档 | 不喜欢 | 重新生成
// 反馈投票本地持久化（按 qid）：切会话/刷新后仍能还原选中态。'up' | 'down' | ''
function getVote(qid) { try { return localStorage.getItem('kb_vote_' + qid) || ''; } catch (e) { return ''; } }
function setVote(qid, v) { try { if (v) localStorage.setItem('kb_vote_' + qid, v); else localStorage.removeItem('kb_vote_' + qid); } catch (e) { /* ignore */ } }

function appendAnswerToolbar(msgEl, qid, question, answerText, references) {
  const bar = document.createElement('div');
  bar.className = 'answer-toolbar';
  // 写入飞书「我的空间」文档（问题+答案+参考资料链接），返回 {ok,url,error}
  const doExport = function () {
    var refs = (references || []).map(function (r) { return { title: r.title, url: r.url }; });
    return authFetch('/api/export/doc', { method: 'POST', body: JSON.stringify({ question: question, answer: answerText, references: refs }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  };
  bar.innerHTML =
    '<button class="tb-btn tb-share" data-act="share">' + TB_ICON.share + '<span>分享</span></button>' +
    '<span class="tb-sep"></span>' +
    '<button class="tb-btn" data-act="copy" data-tip="复制">' + TB_ICON.copy + '</button>' +
    '<button class="tb-btn" data-act="export" data-tip="导出到文档">' + TB_ICON.export + '</button>' +
    '<button class="tb-btn" data-act="track" data-tip="定时追踪">' + TB_ICON.clock + '</button>' +
    (qid ? '<button class="tb-btn tb-like" data-act="like" data-tip="有帮助">' + TB_ICON.like + '</button>' +
           '<button class="tb-btn tb-dislike" data-act="dislike" data-tip="不喜欢">' + TB_ICON.dislike + '</button>' : '') +
    '<button class="tb-btn" data-act="regen" data-tip="重新生成">' + TB_ICON.regen + '</button>';

  const cleanText = function () { return (answerText || '').replace(/\[\d+\]/g, '').trim(); };
  const flash = function (btn, tip) { var o = btn.getAttribute('data-tip'); btn.setAttribute('data-tip', tip); btn.classList.add('tb-flash'); setTimeout(function () { btn.setAttribute('data-tip', o); btn.classList.remove('tb-flash'); }, 1400); };

  // 复制（复制成功给页面级提示）
  bar.querySelector('[data-act="copy"]').addEventListener('click', function () {
    const txt = cleanText(); const self = this;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { flash(self, '已复制'); showToast('已复制到剪贴板', 'success'); }).catch(function () { showToast('复制失败', 'error'); });
    else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); flash(self, '已复制'); showToast('已复制到剪贴板', 'success'); } catch (e) { showToast('复制失败', 'error'); } document.body.removeChild(ta); }
  });
  // 重新生成
  bar.querySelector('[data-act="regen"]').addEventListener('click', function () { if (!isLoading) askQuestion(question, { fresh: true }); });
  // 导出到飞书文档：写入「我的空间」新建文档并打开
  bar.querySelector('[data-act="export"]').addEventListener('click', function () {
    const self = this; if (self.classList.contains('tb-busy')) return; self.classList.add('tb-busy'); flash(self, '导出中…');
    doExport()
      .then(function (j) {
        self.classList.remove('tb-busy');
        if (j && j.ok && j.url) { showToast('已导出到飞书「我的空间」'); window.open(j.url, '_blank'); }
        else showToast(j && j.error ? j.error : '导出失败');
      })
      .catch(function () { self.classList.remove('tb-busy'); showToast('导出失败，请稍后重试'); });
  });
  // 有帮助 / 不喜欢：互斥、可取消、填充选中态；用 localStorage 按 qid 持久化，切会话再切回来仍在
  const likeBtn = bar.querySelector('[data-act="like"]');
  const disBtn = bar.querySelector('[data-act="dislike"]');
  if (qid && likeBtn && disBtn) {
    const cur0 = getVote(qid);
    likeBtn.classList.toggle('active', cur0 === 'up');
    disBtn.classList.toggle('active', cur0 === 'down');
    const vote = function (v) {
      const next = getVote(qid) === v ? '' : v;   // 再点一次取消
      setVote(qid, next);
      likeBtn.classList.toggle('active', next === 'up');
      disBtn.classList.toggle('active', next === 'down');
      if (next) authFetch('/api/feedback', { method: 'POST', body: JSON.stringify({ qid: qid, vote: v }) }).catch(function () {});
      var existing = bar.parentNode && bar.parentNode.querySelector('.dv-reason');
      if (existing) existing.remove();
      if (next === 'up') showToast('感谢反馈 · 已标记有帮助', 'success');
      else if (next === 'down') showDislikeReason(bar, qid);   // 点踩 → 追问"哪里不对"，进 bad-case
    };
    likeBtn.addEventListener('click', function () { vote('up'); });
    disBtn.addEventListener('click', function () { vote('down'); });
  }
  // 定时追踪：用这个问题打开定时任务页（预填），每天定点让机器人主动推最新答案到飞书
  bar.querySelector('[data-act="track"]').addEventListener('click', function () { openTasks(question); });
  // 分享弹窗
  bar.querySelector('[data-act="share"]').addEventListener('click', function (e) { e.stopPropagation(); openSharePopover(bar, question, doExport, cleanText(), references); });

  let lastSib = msgEl;
  while (lastSib.nextElementSibling &&
    (lastSib.nextElementSibling.classList.contains('references') ||
     lastSib.nextElementSibling.classList.contains('retrieval-debug') ||
     lastSib.nextElementSibling.classList.contains('related-evidence') ||
     lastSib.nextElementSibling.classList.contains('related-files') ||
     lastSib.nextElementSibling.classList.contains('ai-disclaimer'))) {
    lastSib = lastSib.nextElementSibling;
  }
  lastSib.after(bar);
}

// 点踩闭环：追问"哪里不对"（选原因 + 可补充）→ 提交进 bad-case，供作者定向补资料/修检索。
var DV_REASONS = ['答非所问', '信息过时/不准确', '来源不相关', '不够详细', '答错了'];
function showDislikeReason(bar, qid) {
  if (bar.parentNode && bar.parentNode.querySelector('.dv-reason')) return;
  var box = document.createElement('div');
  box.className = 'dv-reason';
  box.innerHTML =
    '<div class="dv-card">' +
    '<div class="dv-head"><span class="dv-q">哪里不对？帮我们改进</span><button type="button" class="dv-close" title="关闭">&times;</button></div>' +
    '<div class="dv-chips">' + DV_REASONS.map(function (r) {
      return '<button type="button" class="dv-chip" data-r="' + escapeHtml(r) + '">' + escapeHtml(r) + '</button>';
    }).join('') + '</div>' +
    '<textarea class="dv-note" rows="2" placeholder="补充一下具体问题（选填）"></textarea>' +
    '<div class="dv-actions"><button type="button" class="dv-skip">跳过</button><button type="button" class="dv-submit">提交</button></div>' +
    '</div>';
  bar.after(box);
  box.querySelector('.dv-close').addEventListener('click', function () { box.remove(); });
  var picked = '';
  box.querySelectorAll('.dv-chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var r = c.getAttribute('data-r');
      if (picked === r) { picked = ''; c.classList.remove('active'); }
      else { picked = r; box.querySelectorAll('.dv-chip').forEach(function (x) { x.classList.remove('active'); }); c.classList.add('active'); }
    });
  });
  box.querySelector('.dv-skip').addEventListener('click', function () { box.remove(); });
  box.querySelector('.dv-submit').addEventListener('click', function () {
    var note = (box.querySelector('.dv-note').value || '').trim();
    var reason = (picked ? picked : '') + (note ? (picked ? '：' : '') + note : '');
    if (!reason) { box.remove(); return; }   // 什么都没填也算数（down 已记录），直接收起
    authFetch('/api/feedback', { method: 'POST', body: JSON.stringify({ qid: qid, vote: 'down', reason: reason }) }).catch(function () {});
    box.innerHTML = '<div class="dv-thanks">收到，谢谢反馈 · 已进入改进清单</div>';
    setTimeout(function () { box.remove(); }, 1600);
  });
}

// 分享弹窗（对标飞书）：全选 · 复制图片 · 下载图片 · 复制链接 · 分享至会话
function openSharePopover(bar, question, doExport, answerText, references) {
  var exist = bar.querySelector('.share-pop');
  if (exist) { exist.remove(); return; }
  var pop = document.createElement('div');
  pop.className = 'share-pop';
  pop.innerHTML =
    '<label class="sp-all"><input type="checkbox" checked><span>全选</span></label>' +
    '<button class="sp-tile" data-s="copyimg"><i class="sp-ic sp-orange">' + TB_ICON.img + '</i><span>复制图片</span></button>' +
    '<button class="sp-tile" data-s="dlimg"><i class="sp-ic sp-green">' + TB_ICON.dl + '</i><span>下载图片</span></button>' +
    '<button class="sp-tile" data-s="link"><i class="sp-ic sp-blue">' + TB_ICON.link + '</i><span>复制链接</span></button>' +
    '<button class="sp-tile" data-s="chat"><i class="sp-ic sp-indigo">' + TB_ICON.chat + '</i><span>分享至会话</span></button>' +
    '<button class="sp-close" title="关闭">&times;</button>';
  bar.appendChild(pop);
  var close = function () { pop.remove(); document.removeEventListener('click', onDoc); };
  var onDoc = function (e) { if (!pop.contains(e.target)) close(); };
  setTimeout(function () { document.addEventListener('click', onDoc); }, 0);
  pop.querySelector('.sp-close').addEventListener('click', close);
  pop.querySelectorAll('.sp-tile').forEach(function (t) {
    t.addEventListener('click', function (e) {
      e.stopPropagation();
      var s = t.getAttribute('data-s');
      if (s === 'link') {
        // 复制链接 = 写入飞书「我的空间」文档，再复制该文档链接（对标飞书）。带加载态 → 成功提示
        if (t.classList.contains('busy')) return;
        t.classList.add('busy');
        var tip = showToast('正在生成链接…', 'loading');
        doExport().then(function (j) {
          t.classList.remove('busy');
          if (j && j.ok && j.url) {
            var ok = function () { tip.update('链接已复制到剪贴板', 'success'); };
            if (navigator.clipboard) navigator.clipboard.writeText(j.url).then(ok).catch(function () { tip.update('已写入文档：' + j.url, 'success'); });
            else ok();
          } else tip.update(j && j.error ? j.error : '生成失败', 'error');
        }).catch(function () { t.classList.remove('busy'); tip.update('生成失败，请稍后重试', 'error'); });
        close();
      } else if (s === 'copyimg' || s === 'dlimg') {
        showToast('图片导出即将上线', 'info');
      } else if (s === 'chat') {
        // 分享至会话 = 一键转发：选中群/自己 → 后端「导出成你名下文档 + 以你本人身份把链接发过去」，一个动作。
        openChatPicker(question, answerText, references);
        close();
      }
    });
  });
}

// 检索调试面板（可折叠）：显示召回数、阈值、每篇候选的向量分与是否入选。
// 用 div + max-height 过渡实现平滑下滑展开（对齐深度思考面板，不用生硬的原生 <details>）。
function buildDebugPanel(dbg) {
  const box = document.createElement('div');
  box.className = 'retrieval-debug';
  const kept = (dbg.candidates || []).filter(function(c) { return c.kept; }).length;
  const selected = dbg.selected != null ? dbg.selected : (dbg.candidates || []).filter(function(c) { return c.selected; }).length;
  const sum = document.createElement('button');
  sum.type = 'button';
  sum.className = 'debug-toggle';
  var panelId = 'retrieval-debug-' + Math.random().toString(36).slice(2, 9);
  sum.setAttribute('aria-expanded', 'false');
  sum.setAttribute('aria-controls', panelId);
  sum.innerHTML = '<svg class="dbg-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' +
    '<span>检索详情 · ' + (dbg.method === 'vector' ? '向量+LLM法官' : '词法+LLM法官') +
    ' · 召回' + (dbg.recalled || 0) + ' 读' + (dbg.read || 0) + ' 通过' + kept + (selected ? ' 主证据' + selected : '') + '</span>';
  sum.addEventListener('click', function () {
    var keepBottom = !!chatContainer &&
      chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 140;
    var open = box.classList.toggle('open');
    sum.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) wrap.scrollTop = 0;
    // 用户原本位于答案底部时，展开期间跟随新增高度，确保参考与更多相关结果仍然可达可见。
    if (keepBottom) {
      var started = performance.now();
      var followExpansion = function (now) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
        if (now - started < 380) requestAnimationFrame(followExpansion);
      };
      requestAnimationFrame(followExpansion);
    }
  });
  box.appendChild(sum);
  const wrap = document.createElement('div');
  wrap.className = 'debug-wrap';
  wrap.id = panelId;
  const head = document.createElement('div');
  head.className = 'debug-row debug-head';
  head.innerHTML = '<span class="debug-score">向量</span><span class="debug-jscore">法官</span><span class="debug-rank">质量</span><span class="debug-flag">结果</span><span class="debug-title">文档</span>';
  const list = document.createElement('div');
  list.className = 'debug-list';
  list.appendChild(head);
  (dbg.candidates || []).forEach(function(c) {
    const row = document.createElement('div');
    row.className = 'debug-row' + (c.kept ? ' kept' : '') + (c.selected ? ' selected' : '');
    var vs = (c.vscore != null) ? c.vscore.toFixed(3) : (c.score != null ? c.score.toFixed(3) : '-');
    var js = (c.jscore != null) ? String(c.jscore) : '-';
    var rank = (c.rank != null) ? String(c.rank) : '-';
    row.innerHTML =
      '<span class="debug-score">' + vs + '</span>' +
      '<span class="debug-jscore">' + js + '</span>' +
      '<span class="debug-rank">' + rank + '</span>' +
      '<span class="debug-flag">' + (c.selected ? '★主证据' : c.kept ? '✓相关' : '✗丢弃') + '</span>' +
      '<span class="debug-title" title="' + escapeHtml(c.calibration || '') + '">' + escapeHtml(c.title || '') + (c.calibration ? '<small class="debug-cal"> · ' + escapeHtml(c.calibration) + '</small>' : '') + '</span>';
    list.appendChild(row);
  });
  wrap.appendChild(list);
  box.appendChild(wrap);
  return box;
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
    item.className = 'history-item' + (activeView === 'chat' && conv.id === currentConversationId ? ' active' : '');
    item.innerHTML = '<span class="history-title">' + escapeHtml(conv.title) + '</span><button class="history-delete" title="删除">\xd7</button>';
    item.addEventListener('click', function() { loadConversation(conv.id); });
    item.querySelector('.history-delete').addEventListener('click', function(e) { deleteConversation(conv.id, e); });
    historyList.appendChild(item);
  });
  syncNavActive();
}

// 侧栏"全部知识库 / 提问看板"高亮跟随当前视图
function syncNavActive() {
  var kb = document.getElementById('knowledgeBaseBtn');
  var dash = document.getElementById('dashboardBtn');
  var quality = document.getElementById('qualityBtn');
  if (kb) kb.classList.toggle('active', activeView === 'kb');
  if (dash) dash.classList.toggle('active', activeView === 'dash');
  if (quality) quality.classList.toggle('active', activeView === 'quality');
}

function renderEmptyChat() {
  document.body.classList.remove('dash-mode');
  var _now = new Date();
  var _md = (_now.getMonth() + 1) + '月' + _now.getDate() + '日';
  chatContainer.innerHTML =
    '<div class="welcome">' +
      '<div class="hero-ring"></div>' +
      '<h2>飞书知识问答 <span class="free-badge">内部专享</span></h2>' +
      '<p>整合你有权限的飞书文档 + 上传知识库，<span class="hero-num">检索 · 甄别 · 带来源</span>地回答你</p>' +
      '<div class="hero-clock"><span class="hc-dot"></span><span id="heroClock" class="hc-time">--:--:--</span><span class="hc-sep">·</span><span id="heroDate" class="hc-date"></span></div>' +
      '<div class="hero-cards">' +
        '<div class="hero-card"><div class="hero-card-title">截至' + _md + ' · AI 已为你解答</div>' +
          '<div class="hero-stat-row">' +
            '<span class="laurel laurel-l">' + LAUREL_SVG + '</span>' +
            '<span class="hero-card-stat"><span id="heroCount">0</span><span class="hero-unit">次</span></span>' +
            '<span class="laurel laurel-r">' + LAUREL_SVG + '<span class="laurel-spark">' + SPARK_SVG + '</span></span>' +
          '</div>' +
          '<div class="hero-card-sub">问一句，答案就在你的飞书里</div></div>' +
        '<div class="hero-card"><div class="hero-card-title">你可能感兴趣</div>' +
          '<div id="heroSuggest">' +
            '<div class="hero-suggest" data-act="paste"><span class="hs-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></span>粘贴飞书文档链接，我来总结 <span class="arr">→</span></div>' +
            '<div class="hero-suggest" data-act="web"><span class="hs-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9z"/></svg></span>联网搜索一个实时问题 <span class="arr">→</span></div>' +
            '<div class="hero-suggest" data-act="kb"><span class="hs-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M8 8l4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span>上传文档，扩充知识库 <span class="arr">→</span></div>' +
          '</div></div>' +
      '</div>' +
    '</div>';
  chatTitle.textContent = '飞书知识问答';
  fillHeroStats();
  startHeroClock();
}

// 首页实时时钟：秒级走动，等宽数字；元素消失（离开首页）自动停止，不泄漏定时器
function startHeroClock() {
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var tick = function () {
    var el = document.getElementById('heroClock');
    if (!el) { clearInterval(window.__heroClockTimer); window.__heroClockTimer = null; return; }
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    var dateEl = document.getElementById('heroDate');
    if (dateEl) dateEl.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
  };
  if (window.__heroClockTimer) clearInterval(window.__heroClockTimer);
  tick();
  window.__heroClockTimer = setInterval(tick, 1000);
}

async function fillHeroStats() {
  try {
    const res = await authFetch('/api/analytics');
    const s = (await res.json()).summary || {};
    const cEl = document.getElementById('heroCount');
    if (cEl) { cEl.setAttribute('data-suffix', ' 次'); animateCount(cEl, s.total || 0); }
    const top = (s.topQuestions && s.topQuestions.length) ? s.topQuestions : (s.recent || []);
    if (top && top.length) {
      const html = top.slice(0, 3).map(function (x) {
        const q = x.q || x;
        return '<div class="hero-suggest" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + ' <span class="arr">→</span></div>';
      }).join('');
      const sEl = document.getElementById('heroSuggest');
      if (sEl && html) sEl.innerHTML = html;
    }
  } catch (e) { /* 无统计不影响 */ }
}

function renderConversation(conversation) {
  document.body.classList.remove('dash-mode');
  chatTitle.textContent = conversation.title;
  chatContainer.innerHTML = '';
  if (!conversation.messages || conversation.messages.length === 0) {
    renderEmptyChat();
    return;
  }
  var lastUserQ = '';
  conversation.messages.forEach(function(msg) {
    if (msg.role === 'user') {
      lastUserQ = msg.content;
      appendUserMessage(msg.content, false);
    } else {
      appendAssistantMessage(msg.content, msg.references, msg.sources, msg.mock, false, lastUserQ, msg.qid, msg.debug, msg.reasoning, msg.relatedFiles,
        { noResult: msg.noResult, about: msg.about, conflict: msg.conflict, confidence: msg.confidence, relatedEvidence: msg.relatedEvidence });
    }
  });
  scrollToBottom();
}

function appendUserMessage(content, scroll) {
  if (scroll === undefined) scroll = true;
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'message user';
  var uav = (currentUser && currentUser.avatar)
    ? '<img src="' + currentUser.avatar + '" alt="">'
    : escapeHtml((currentUser && currentUser.name ? currentUser.name : '我').charAt(0));
  msg.innerHTML = '<div class="avatar">' + uav + '</div><div class="message-content"><div class="message-bubble">' + escapeHtml(content) + '</div></div>';
  chatContainer.appendChild(msg);
  if (scroll) forceScrollToBottom();  // 发新问题时总是滚到底并重置粘底
}

// 从存储的 debug 重建"已深度思考/已完成检索"折叠面板（切换会话后仍在）
function buildThinkPanelDone(debug, reasoning) {
  var kept = (debug.candidates || []).filter(function (c) { return c.kept; }).length;
  var selected = debug.selected != null ? debug.selected : (debug.candidates || []).filter(function (c) { return c.selected; }).length;
  var steps = [
    '提取关键词，检索云盘 / 知识库 / 会话',
    '召回 ' + (debug.recalled || 0) + ' 篇候选，读取 ' + (debug.read || 0) + ' 篇正文',
    '模型判断相关 ' + kept + ' 篇，最终使用 ' + (selected || kept) + ' 篇回答',
  ];
  var el = document.createElement('div');
  el.className = 'think-panel done';
  el.style.display = 'block';
  el.innerHTML =
    '<button type="button" class="think-toggle"><span class="think-text">' + (reasoning ? '已深度思考' : '已完成检索') + '</span>' +
    '<svg class="think-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>' +
    '<div class="think-steps">' + steps.map(function (s) { return '<div class="think-step">' + escapeHtml(s) + '</div>'; }).join('') + '</div>';
  el.querySelector('.think-toggle').addEventListener('click', function () { el.classList.toggle('open'); });
  return el;
}

function appendAssistantMessage(content, references, sources, mock, scroll, question, qid, debug, reasoning, relatedFiles, extra) {
  extra = extra || {};
  content = sanitizeAnswerCitationText(content, references ? references.length : 0);
  if (scroll === undefined) scroll = true;
  hideWelcome();
  const msg = document.createElement('div');
  msg.className = 'message';
  let html = '<div class="avatar ai-avatar">' + AI_AVATAR + '</div><div class="message-content">';
  if (mock) {
    html += '<div class="mock-badge">示例数据</div>';
  }
  html += '<div class="message-bubble markdown-body">' + linkifyCitations(renderMarkdown(content), references) + '</div></div>';
  msg.innerHTML = html;
  chatContainer.appendChild(msg);

  // 切换会话后重建"深度思考"面板（放在正文上方，与实时一致）
  if (!mock && debug) {
    var mc = msg.querySelector('.message-content');
    mc.insertBefore(buildThinkPanelDone(debug, reasoning), mc.firstChild);
  }
  // 顺序：检索详情 → 参考资料 → 相关文件 →（免责）→ 工具栏
  var afterEl = msg;
  if (!mock && debug) {
    var dbgEl = buildDebugPanel(debug);
    msg.after(dbgEl); afterEl = dbgEl;
  }
  if (extra.conflict) {   // 多来源冲突条（重建）
    afterEl = insertAlignedCard(afterEl, buildConflictNote(extra.conflict));
  }
  if (references && references.length > 0) {
    var refEl = buildReferencesSection(references, extra.confidence);
    afterEl.after(refEl); afterEl = refEl;
  }
  if (!mock && extra.relatedEvidence && extra.relatedEvidence.length) {
    var reEl = buildRelatedEvidence(extra.relatedEvidence);
    afterEl.after(reEl); afterEl = reEl;
  }
  if (!mock && relatedFiles && relatedFiles.length) {
    var rfEl = buildRelatedFiles(relatedFiles);
    afterEl.after(rfEl); afterEl = rfEl;
  }
  if (extra.about) {   // 身份/作者卡（重建）
    afterEl = insertAlignedCard(afterEl, buildAboutCard());
  }
  if (extra.noResult) {   // 空结果兜底卡（重建）
    afterEl = insertAlignedCard(afterEl, buildNoResultFallback(question || content));
  }
  if (!mock) {
    appendDoneNote(msg);   // 免责说明（只保留最后一条）
    appendAnswerToolbar(msg, qid || null, question || content, content, references);  // 历史消息也带工具栏
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
    // 名称 · 速度标注（响应快 / 深度思考·慢）
    opt.textContent = p.name + (p.hint ? ' · ' + p.hint : '');
    providerSelect.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = '自定义（手填 Base URL / 模型）';
  providerSelect.appendChild(customOpt);

  providerSelect.value = cfg.providerId || 'qwen';
  if (customFields) customFields.style.display = providerSelect.value === 'custom' ? 'block' : 'none';

  const customBaseUrl = document.getElementById('customBaseUrl');
  const customModel = document.getElementById('customModel');
  if (customBaseUrl) customBaseUrl.value = (cfg.custom && cfg.custom.baseUrl) || '';
  if (customModel) customModel.value = (cfg.custom && cfg.custom.model) || '';

  // API Key 永不从服务端回显；留空表示保持当前会话中的原值。
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput) { apiKeyInput.value = ''; apiKeyInput.type = 'password'; apiKeyInput.placeholder = cfg.hasKey ? '已设置，留空表示不修改' : '填写你自己的 API Key'; }
  const keyEye = document.getElementById('keyEye');
  if (keyEye) keyEye.innerHTML = EYE_SVG;
  const keyStatus = document.getElementById('keyStatus');
  if (keyStatus) {
    keyStatus.textContent = cfg.hasKey ? '· 已设置' : '· 未设置，请填写';
    keyStatus.className = 'key-status ' + (cfg.hasKey ? 'ok' : 'warn');
  }

  // 检索调参：显示当前默认值，供测试调优
  var ps = document.getElementById('pageSizeInput');
  var rp = document.getElementById('readPoolInput');
  var ms = document.getElementById('minScoreInput');
  if (ps && cfg.pageSize != null) ps.value = cfg.pageSize;
  if (rp && cfg.readPool != null) rp.value = cfg.readPool;
  if (ms && cfg.minScore != null) ms.value = cfg.minScore;

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
  const providerId = providerSelect ? providerSelect.value : 'qwen';
  const newConfig = { providerId: providerId };

  // 用户自己的 API Key（留空表示不修改）
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput && apiKeyInput.value) newConfig.apiKey = apiKeyInput.value;

  if (providerId === 'custom') {
    const customBaseUrl = document.getElementById('customBaseUrl');
    const customModel = document.getElementById('customModel');
    newConfig.baseUrl = customBaseUrl ? customBaseUrl.value : '';
    newConfig.model = customModel ? customModel.value : '';
  }

  // 检索调参（界面可调）
  var ps = document.getElementById('pageSizeInput');
  var rp = document.getElementById('readPoolInput');
  var ms = document.getElementById('minScoreInput');
  if (ps && ps.value !== '') newConfig.pageSize = parseInt(ps.value, 10);
  if (rp && rp.value !== '') newConfig.readPool = parseInt(rp.value, 10);
  if (ms && ms.value !== '') newConfig.minScore = parseFloat(ms.value);

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

// ─── 知识库（用户上传的补充文档，检索时与飞书文档一起命中）──────────────────
function setupKb() {
  const kbModal = document.getElementById('kbModal');
  if (!kbModal) return;
  const close = function () { kbModal.classList.remove('show'); };
  document.getElementById('closeKb').addEventListener('click', close);
  kbModal.querySelector('.modal-backdrop').addEventListener('click', close);
  const fileInput = document.getElementById('kbFileInput');
  document.getElementById('kbUploadBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { uploadKbFiles(fileInput.files); fileInput.value = ''; });
  const pasteArea = document.getElementById('kbPasteArea');
  document.getElementById('kbPasteBtn').addEventListener('click', function () {
    pasteArea.style.display = pasteArea.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('kbPasteSave').addEventListener('click', savePastedDoc);

  // 拖拽上传：拖文本文件到弹窗即上传
  const body = kbModal.querySelector('.modal-body') || kbModal;
  ['dragenter', 'dragover'].forEach(function (ev) {
    body.addEventListener(ev, function (e) { e.preventDefault(); body.classList.add('kb-dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    body.addEventListener(ev, function (e) { e.preventDefault(); if (ev !== 'drop') body.classList.remove('kb-dragover'); });
  });
  body.addEventListener('drop', function (e) {
    body.classList.remove('kb-dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadKbFiles(e.dataTransfer.files);
  });
}

function openKb() {
  var m = document.getElementById('kbModal'); if (m) m.classList.remove('show');
  document.body.classList.add('dash-mode');
  hideWelcome();
  activeView = 'kb'; renderHistory();
  kbScope = 'personal';
  kbCanManage = true;
  chatTitle.textContent = '知识库';
  chatContainer.innerHTML =
    '<div class="kb-page">' +
      '<div class="kb-scope-row"><div class="kb-scope-tabs"><button type="button" class="active" data-kb-scope="personal">个人知识库</button><button type="button" data-kb-scope="organization">组织知识库</button></div><span id="kbScopeHint">仅你可见，设置只影响你自己</span></div>' +
      '<p class="kb-lead" id="kbLead">你上传的补充资料。提问时会连同你有权限的飞书文档、聊天和组织知识库一起实时检索。</p>' +
      '<div class="kb-drop" id="kbDrop">' +
        '<div class="kb-drop-ic">' + UPLOAD_SVG + '</div>' +
        '<div class="kb-drop-txt">' +
          '<div class="kb-drop-t">把文件拖到这里，或 <span class="kb-drop-link">点击上传</span></div>' +
          '<div class="kb-drop-s">支持 Word/Excel/PPT · PDF · txt/md/csv/json · 图片(需配 OCR) · 可多选</div>' +
        '</div>' +
        '<div class="kb-drop-btns">' +
          '<button type="button" class="btn-primary" id="kbUploadBtn2">＋ 上传文档</button>' +
          '<button type="button" class="btn-ghost" id="kbPasteBtn2">粘贴文本</button>' +
        '</div>' +
        '<input type="file" id="kbFileInput2" accept=".txt,.md,.markdown,.csv,.json,.log,.text,.tsv,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.bmp" multiple hidden>' +
      '</div>' +
      '<div id="kbPasteArea2" class="kb-paste" style="display:none">' +
        '<input type="text" id="kbPasteTitle2" placeholder="文档标题" class="kb-input">' +
        '<textarea id="kbPasteContent2" placeholder="粘贴文档内容…" class="kb-textarea"></textarea>' +
        '<div class="kb-paste-actions"><button type="button" class="btn-ghost" id="kbPasteCancel2">取消</button><button type="button" class="btn-primary" id="kbPasteSave2">保存到知识库</button></div>' +
      '</div>' +
      '<div class="kb-records-head"><span class="kb-records-title">上传记录</span><span class="kb-records-count" id="kbCount"></span><button type="button" class="kb-reindex-btn" id="kbReindexBtn" title="模型切换或索引异常时，重新建立本人全部文档索引">重建索引</button></div>' +
      '<div id="kbList" class="kb-list"></div>' +
    '</div>';
  var drop = document.getElementById('kbDrop');
  var fileInput = document.getElementById('kbFileInput2');
  drop.addEventListener('click', function () { fileInput.click(); });
  document.getElementById('kbUploadBtn2').onclick = function (e) { e.stopPropagation(); fileInput.click(); };
  fileInput.onchange = function () { uploadKbFiles(this.files); this.value = ''; };
  ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
  ['dragleave'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer && e.dataTransfer.files) uploadKbFiles(e.dataTransfer.files); });
  document.getElementById('kbPasteBtn2').onclick = function (e) { e.stopPropagation(); var a = document.getElementById('kbPasteArea2'); a.style.display = a.style.display === 'none' ? 'flex' : 'none'; };
  document.getElementById('kbPasteCancel2').onclick = function (e) {
    e.stopPropagation();
    var c = document.getElementById('kbPasteContent2');
    delete c.dataset.editId; delete c.dataset.revision;
    document.getElementById('kbPasteArea2').style.display = 'none';
  };
  document.getElementById('kbPasteSave2').onclick = savePastedDoc2;
  document.getElementById('kbReindexBtn').onclick = function () { reindexKb(this); };
  document.querySelectorAll('[data-kb-scope]').forEach(function (button) {
    button.onclick = function () {
      kbScope = button.getAttribute('data-kb-scope') || 'personal';
      document.querySelectorAll('[data-kb-scope]').forEach(function (x) { x.classList.toggle('active', x === button); });
      loadKbList();
    };
  });
  loadKbList();
}

async function savePastedDoc2() {
  var titleEl = document.getElementById('kbPasteTitle2');
  var contentEl = document.getElementById('kbPasteContent2');
  var title = (titleEl.value || '').trim() || '粘贴文档';
  var content = (contentEl.value || '').trim();
  if (!content) { showToast('内容为空'); return; }
  try {
    var editingId = contentEl.dataset.editId || '';
    var payload = { title: title, content: content };
    if (editingId) payload.expectedRevision = Number(contentEl.dataset.revision || 0);
    var res = await authFetch(withKbScope(editingId ? '/api/kb/' + encodeURIComponent(editingId) : '/api/kb'), {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    var data = await res.json().catch(function () { return { ok: false }; });
    if (data.ok) {
      showToast(editingId ? '已更新，仅变化内容重新建索引' : '已保存到知识库，已建索引');
      titleEl.value = ''; contentEl.value = '';
      delete contentEl.dataset.editId; delete contentEl.dataset.revision;
      document.getElementById('kbPasteArea2').style.display = 'none';
      loadKbList();
    } else {
      showToast(data.error || '保存失败', 'error');
      if (res.status === 409) loadKbList();
    }
  } catch (e) { showToast('保存失败'); }
}

// ─── 检索质量工作台：自动案例 → 人工金标 ─────────────────────────────────────
var qualityCases = [];
var qualityCurrentId = '';

function setupQualityWorkbench() {
  var btn = document.getElementById('qualityBtn');
  if (btn) btn.addEventListener('click', openQualityWorkbench);
}

function openQualityWorkbench() {
  document.body.classList.add('dash-mode');
  hideWelcome(); activeView = 'quality'; renderHistory();
  chatTitle.textContent = '质量评测';
  chatContainer.innerHTML = '<div class="quality-page"><div class="quality-head"><div><span class="quality-kicker">RETRIEVAL QA</span><h2>把真实问题变成可复用金标</h2><p>系统自动采集每次检索轨迹；管理员确认答案与证据相关性后，才进入人工金标。</p></div><div class="quality-baseline"><b>baseline-v1</b><span>初始安全基线 · 待金标升级</span></div></div><div id="qualityBody" class="quality-loading">加载案例…</div></div>';
  loadQualityCases('pending');
}

async function loadQualityCases(status) {
  var body = document.getElementById('qualityBody'); if (!body) return;
  try {
    var res = await authFetch('/api/quality/cases?status=' + encodeURIComponent(status || 'pending') + '&limit=150');
    if (res.status === 403) { document.getElementById('qualityBtn').hidden = true; openDashboard(); return; }
    var data = await res.json(); qualityCases = data.cases || [];
    if (!qualityCases.some(function (x) { return x.id === qualityCurrentId; })) qualityCurrentId = qualityCases[0] ? qualityCases[0].id : '';
    renderQualityWorkbench(data.summary || {}, status || 'pending', data.metrics || {}, data.scope || 'personal');
  } catch (_e) { body.innerHTML = '<div class="quality-empty">质量案例加载失败</div>'; }
}

function renderQualityWorkbench(summary, status, metrics, scope) {
  var body = document.getElementById('qualityBody'); if (!body) return;
  body.className = 'quality-body';
  body.innerHTML = '<div class="quality-stats">' +
    '<div><strong>' + (summary.pending || 0) + '</strong><span>待标注</span></div><div><strong>' + (summary.labeled || 0) + '</strong><span>已成金标</span></div><div><strong>' + (summary.high || 0) + '</strong><span>高优先级</span></div><div><strong>' + (summary.total || 0) + '</strong><span>累计采集</span></div></div>' + qualityMetricBanner(metrics || {}) +
    '<div class="quality-toolbar"><div class="quality-tabs"><button data-status="pending" class="' + (status === 'pending' ? 'active' : '') + '">待标注</button><button data-status="labeled" class="' + (status === 'labeled' ? 'active' : '') + '">已标注</button><button data-status="all" class="' + (status === 'all' ? 'active' : '') + '">全部</button></div><span>' + (scope === 'organization' ? '本组织案例 · 仅 Owner / 管理员可见' : '仅显示你自己的案例') + ' · 不保存密钥或访问令牌</span></div>' +
    '<div class="quality-work"><aside class="quality-queue">' + (qualityCases.length ? qualityCases.map(qualityCaseRow).join('') : '<div class="quality-empty">暂无案例</div>') + '</aside><section id="qualityDetail" class="quality-detail"></section></div>';
  body.querySelectorAll('[data-status]').forEach(function (b) { b.onclick = function () { loadQualityCases(b.getAttribute('data-status')); }; });
  body.querySelectorAll('.quality-case').forEach(function (b) { b.onclick = function () { qualityCurrentId = b.getAttribute('data-id'); renderQualityDetail(); }; });
  renderQualityDetail();
}

function qualityMetricBanner(m) {
  var cases = m.labeledCases || 0, candidates = m.labeledCandidates || 0;
  if (!m.ready) return '<div class="quality-gate"><b>参数推荐尚未解锁</b><span>已标 ' + cases + '/30 个案例、' + candidates + '/100 条候选。达到门槛后，系统才会用精确率、召回率和平均证据数给出参数建议，避免小样本拍脑袋。</span></div>';
  var r = m.recommendation || {};
  return '<div class="quality-gate ready"><b>离线评测建议</b><span>证据下限 ' + r.min + '、上限 ' + r.max + '、同档分差 ' + r.scoreGap + '；F1 ' + Math.round((r.f1 || 0) * 1000) / 10 + '%，平均 ' + Math.round((r.avgEvidence || 0) * 10) / 10 + ' 条证据。建议先 A/B 验证，再人工发布为新基线。</span></div>';
}

function qualityCaseRow(x) {
  var p = x.priority === 'high' ? '高' : x.priority === 'medium' ? '中' : '常规';
  return '<button class="quality-case' + (x.id === qualityCurrentId ? ' active' : '') + '" data-id="' + escapeHtml(x.id) + '"><span class="qc-top"><i class="qp-' + x.priority + '">' + p + '</i><time>' + escapeHtml(String(x.createdAt || '').slice(0, 10)) + '</time></span><strong>' + escapeHtml(x.question) + '</strong><small>' + escapeHtml((x.provider && (x.provider.model || x.provider.id)) || '未知模型') + ' · ' + (x.trace ? x.trace.recalled : 0) + ' 召回 / ' + (x.trace ? x.trace.selected : 0) + ' 证据</small></button>';
}

function renderQualityDetail() {
  var el = document.getElementById('qualityDetail'); if (!el) return;
  var x = qualityCases.find(function (c) { return c.id === qualityCurrentId; });
  if (!x) { el.innerHTML = '<div class="quality-empty">选择左侧案例开始标注</div>'; return; }
  document.querySelectorAll('.quality-case').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-id') === x.id); });
  var trace = x.trace || {};
  var candidates = x.candidates || [];
  el.innerHTML = '<div class="qd-head"><span>问题</span><h3>' + escapeHtml(x.question) + '</h3><div class="trace-line"><b>' + (trace.recalled || 0) + '<small>召回</small></b><i>→</i><b>' + (trace.read || 0) + '<small>读取</small></b><i>→</i><b>' + (trace.eligible || 0) + '<small>法官通过</small></b><i>→</i><b class="trace-final">' + (trace.selected || 0) + '<small>最终证据</small></b></div></div>' +
    '<div class="qd-answer"><span>系统回答</span><p>' + escapeHtml(x.answer || '未生成回答') + '</p></div>' +
    '<div class="qd-label"><span>答案金标</span><div class="answer-labels">' + qualityAnswerOptions((x.label || {}).answer) + '</div></div>' +
    '<div class="qd-candidates"><div class="qd-section-title"><span>候选证据逐条标注</span><small>“最终”参与回答；“相关”仅折叠展示；淘汰项用于定位漏召回/误杀</small></div>' +
    (candidates.length ? candidates.map(function (c) { return qualityCandidate(c, ((x.label || {}).evidence || {})[c.key]); }).join('') : '<div class="quality-empty">本次没有候选轨迹</div>') + '</div>' +
    '<textarea id="qualityNote" class="quality-note" placeholder="标注说明：答案缺了什么、聊天答案位于后几条、误召原因…">' + escapeHtml((x.label || {}).note || '') + '</textarea>' +
    '<div class="quality-actions"><button class="btn-ghost" id="qualityIgnore">忽略案例</button><button class="btn-primary" id="qualitySave">保存为人工金标</button></div>';
  document.getElementById('qualitySave').onclick = function () { saveQualityLabel(x.id, 'labeled'); };
  document.getElementById('qualityIgnore').onclick = function () { saveQualityLabel(x.id, 'ignored'); };
}

function qualityAnswerOptions(value) {
  return [['correct','正确'],['partial','部分正确'],['wrong','错误'],['unanswerable','资料不足']].map(function (o) { return '<label><input type="radio" name="answerGold" value="' + o[0] + '"' + (value === o[0] ? ' checked' : '') + '><span>' + o[1] + '</span></label>'; }).join('');
}

function qualityCandidate(c, value) {
  return '<article class="quality-candidate"><div class="qce-main"><div><span class="qce-source">' + escapeHtml(c.source === 'message' ? '聊天' : '文档') + '</span>' + (c.selected ? '<span class="qce-final">最终</span>' : c.eligible ? '<span class="qce-related">相关</span>' : '<span class="qce-drop">淘汰</span>') + '</div><strong>' + escapeHtml(c.title) + '</strong><p>' + escapeHtml(c.snippet || '无片段') + '</p><small>向量 ' + (c.vectorScore == null ? '—' : c.vectorScore) + ' · 法官 ' + (c.judgeScore == null ? '—' : c.judgeScore) + ' · 质量 ' + (c.evidenceRank == null ? '—' : c.evidenceRank) + (c.recheck ? ' · ' + escapeHtml(c.recheck) : '') + '</small></div><div class="qce-label" data-key="' + escapeHtml(c.key) + '">' + [['relevant','相关'],['irrelevant','无关'],['unsure','不确定']].map(function (o) { return '<label><input type="radio" name="ev-' + escapeHtml(c.key) + '" value="' + o[0] + '"' + (value === o[0] ? ' checked' : '') + '><span>' + o[1] + '</span></label>'; }).join('') + '</div></article>';
}

async function saveQualityLabel(id, status) {
  var answer = document.querySelector('input[name="answerGold"]:checked');
  if (status === 'labeled' && !answer) { showToast('请先标注答案是否正确', 'error'); return; }
  var evidence = {};
  document.querySelectorAll('.qce-label[data-key]').forEach(function (g) { var r = g.querySelector('input:checked'); if (r) evidence[g.getAttribute('data-key')] = r.value; });
  var payload = { status: status, label: { answer: answer ? answer.value : '', note: (document.getElementById('qualityNote').value || '').trim(), evidence: evidence } };
  var res = await authFetch('/api/quality/cases/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(payload) });
  var data = await res.json();
  if (data.ok) { showToast(status === 'labeled' ? '已保存为人工金标' : '已忽略', 'success'); qualityCurrentId = ''; loadQualityCases('pending'); }
  else showToast(data.error || '保存失败', 'error');
}

// ─── 提问看板 ────────────────────────────────────────────────────────────────
function setupDashboard() {
  const modal = document.getElementById('dashModal');
  if (!modal) return;
  const close = function () { modal.classList.remove('show'); };
  document.getElementById('closeDash').addEventListener('click', close);
  modal.querySelector('.modal-backdrop').addEventListener('click', close);
  const btn = document.getElementById('dashboardBtn');
  if (btn) btn.addEventListener('click', openDashboard);
}

function openDashboard() {
  // 全页面渲染（不再是居中弹窗），并隐藏底部输入区
  var m = document.getElementById('dashModal'); if (m) m.classList.remove('show');
  document.body.classList.add('dash-mode');
  hideWelcome();
  activeView = 'dash'; renderHistory();
  chatTitle.textContent = '提问看板';
  chatContainer.innerHTML =
    '<div class="dash-page">' +
      '<div class="dash-head-row">' +
        '<div class="dash-page-head"><h2>提问看板</h2>' +
        '<p>你的提问统计与知识盲区分析，帮助沉淀 FAQ、发现库里缺什么。仅你可见。</p></div>' +
        '<div class="dash-head-actions">' +
          '<div class="dash-toggle" id="dashToggle" hidden><button type="button" data-v="me" class="active">个人</button><button type="button" data-v="org">全公司</button></div>' +
          '<button type="button" class="btn-ghost dash-export" id="dashExport">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>' +
            '<span>导出周报</span></button>' +
        '</div>' +
      '</div>' +
      '<div id="dashBody"><div class="kb-empty">加载中…</div></div>' +
    '</div>';
  loadAnalytics();
}

var DASH_ICON = {
  chat:  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12 7.7L3 21l1.8-6A8.5 8.5 0 1 1 21 11.5z"/></svg>',
  today: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>',
  up:    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v10"/><path d="M7 11l3.5-6.5a2 2 0 0 1 2.7-.8 2 2 0 0 1 1 2.4L13 11h5.5a2 2 0 0 1 2 2.4l-1.2 6A2 2 0 0 1 17.3 21H7"/></svg>',
  gap:   '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  fire:  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-1.5.7-2.8 1.5-3.7C9 9 9.5 10.5 11 11c0-2 1-4 1-9z"/></svg>',
  warn:  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  target:'<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></svg>',
  trend: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/></svg>',
  down:  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V3"/><path d="M17 13l-3.5 6.5a2 2 0 0 1-2.7.8 2 2 0 0 1-1-2.4L11 13H5.5a2 2 0 0 1-2-2.4l1.2-6A2 2 0 0 1 6.7 3H17"/></svg>'
};

// 数字滚动动画（大屏动效）
function animateCount(el, target) {
  target = target || 0;
  if (target <= 0 || !window.requestAnimationFrame) { el.textContent = String(target); return; }
  var startT = null, dur = 850;
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function frame(ts) {
    if (startT === null) startT = ts;
    var p = Math.min((ts - startT) / dur, 1);
    el.textContent = String(Math.round(ease(p) * target));
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// 看板渲染小工具（个人/组织视图共用）
function dStat(icon, cls, num, lbl, suffix, target) {
  return '<div class="dstat' + (target ? ' dstat-click' : '') + '"' + (target ? ' data-target="' + target + '"' : '') + '><div class="dstat-ic ' + cls + '">' + icon + '</div>' +
    '<div class="dstat-body"><div class="dstat-numwrap"><span class="dstat-num" data-count="' + num + '">0</span>' +
    (suffix ? '<span class="dstat-unit">' + suffix + '</span>' : '') + '</div>' +
    '<div class="dstat-lbl">' + lbl + '</div></div></div>';
}
function dCard(icon, cls, title, body, hl) {
  return '<div class="dcard"' + (hl ? ' data-hl="' + hl + '"' : '') + '><div class="dcard-head"><span class="dcard-ic ' + cls + '">' + icon + '</span>' +
    '<span class="dcard-title">' + title + '</span></div>' + body + '</div>';
}
function dRows(arr, empty, fmt) {
  if (!arr || !arr.length) return '<div class="dcard-empty">' + empty + '</div>';
  return '<div class="drows">' + arr.map(fmt).join('') + '</div>';
}
function dTrendChart(trend) {
  trend = trend || [];
  var maxC = Math.max.apply(null, trend.map(function (t) { return t.count; }).concat([1]));
  // Y 轴刻度：向上取整到 4 的倍数 → 4 等分，刻度值恒为整数（0,2,4,6,8… 一目了然）
  var niceMax = Math.max(4, Math.ceil(maxC / 4) * 4);
  var step = niceMax / 4;
  var ticks = [];
  for (var v = niceMax; v >= 0; v -= step) ticks.push('<span class="trend-yt">' + v + '</span>');
  var bars = trend.map(function (t) {
    var h = t.count ? Math.max(Math.round((t.count / niceMax) * 100), 3) : 0;
    return '<div class="trend-bar"><div class="trend-col' + (t.count ? '' : ' trend-col-zero') + '" data-h="' + h + '" style="height:0">' +
      '<span class="trend-val">' + (t.count || '') + '</span><span class="trend-tip">' + t.label + ' · ' + t.count + ' 次</span></div></div>';
  }).join('');
  var labels = trend.map(function (t) { return '<span class="trend-lbl">' + t.label + '</span>'; }).join('');
  return '<div class="trend-chart">' +
    '<div class="trend-plot"><div class="trend-yaxis">' + ticks.join('') + '</div>' +
    '<div class="trend-bars">' + bars + '</div></div>' +
    '<div class="trend-axis">' + labels + '</div></div>';
}
function animateDash(el) {
  el.querySelectorAll('.dstat-num[data-count]').forEach(function (n) { animateCount(n, parseInt(n.getAttribute('data-count'), 10) || 0); });
  if (window.requestAnimationFrame) requestAnimationFrame(function () {
    el.querySelectorAll('.trend-col[data-h]').forEach(function (c) { c.style.height = c.getAttribute('data-h') + '%'; });
  });
}

async function loadAnalytics() {
  const el = document.getElementById('dashBody');
  el.innerHTML = '<div class="kb-empty">加载中…</div>';
  try {
    const res = await authFetch('/api/analytics');
    const data = await res.json();
    const s = data.summary || {};
    const fb = s.feedback || { up: 0, down: 0 };
    const gaps = s.gaps || [];
    const stat = dStat, card = dCard, rows = dRows;
    // 管理员：显示"个人/全公司"切换
    var toggle = document.getElementById('dashToggle');
    if (toggle) { toggle.hidden = !data.isAdmin; toggle.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-v') === 'me'); }); }
    // 可点击再问：最近提问 / 高频问题
    const recent = rows(s.recent, '还没有提问记录', function (x) {
      return '<div class="drow drow-click" data-q="' + escapeHtml(x.q) + '"><span class="drow-q" title="' + escapeHtml(x.q) + '">' + escapeHtml(x.q) + '</span><span class="drow-cnt">' + (x.refs ? x.refs + ' 篇' : '0 篇') + '</span></div>';
    });
    const top = rows(s.topQuestions, '暂无重复提问', function (x, i) {
      return '<div class="drow drow-click" data-q="' + escapeHtml(x.q) + '"><span class="drow-rank">' + (i + 1) + '</span><span class="drow-q" title="' + escapeHtml(x.q) + '">' + escapeHtml(x.q) + '</span><span class="drow-cnt">' + x.count + ' 次</span></div>';
    });
    // 盲区一键沉淀：每条带"补充资料"按钮 → 跳知识库上传
    const gap = rows(gaps, '暂无盲区，覆盖很好', function (q) {
      return '<div class="drow drow-gap"><span class="drow-dot"></span><span class="drow-q" title="' + escapeHtml(q) + '">' + escapeHtml(q) + '</span>' +
        '<button type="button" class="drow-act" data-act="supplement" data-q="' + escapeHtml(q) + '">补充资料</button></div>';
    });
    // 待改进（bad-case）：点踩+原因，作者据此定向补资料/修检索
    const bad = rows(s.badcases, '暂无点踩，回答质量不错', function (x) {
      return '<div class="drow drow-gap"><span class="drow-dot dot-bad"></span><span class="drow-q" title="' + escapeHtml(x.q) + '">' + escapeHtml(x.q) +
        (x.reason ? '<span class="drow-reason">' + escapeHtml(x.reason) + '</span>' : '') + '</span>' +
        '<button type="button" class="drow-act" data-act="supplement" data-q="' + escapeHtml(x.q) + '">补充资料</button></div>';
    });
    const trendChart = dTrendChart(s.trend);

    el.innerHTML =
      '<div class="dstats">' +
        stat(DASH_ICON.chat, 'v', s.total || 0, '累计提问', '', 'recent') +
        stat(DASH_ICON.today, 'b', s.today || 0, '今日提问', '', 'recent') +
        stat(DASH_ICON.target, 'g', s.coverage || 0, '知识覆盖率', '%', 'trend') +
        stat(DASH_ICON.up, 'v', fb.up || 0, '有帮助反馈') +
        stat(DASH_ICON.gap, 'o', gaps.length, '知识盲区', '', 'gap') +
      '</div>' +
      card(DASH_ICON.trend, 'v', '提问趋势 · 近 7 天', trendChart, 'trend') +
      '<div class="dgrid">' +
        '<div class="dcol-main">' + card(DASH_ICON.clock, 'v', '最近提问 <span class="dcard-hint">点击可再问一次</span>', recent, 'recent') + '</div>' +
        '<div class="dcol-side">' +
          card(DASH_ICON.fire, 'o', '高频问题 · FAQ 候选', top) +
          card(DASH_ICON.warn, 'r', '知识盲区 <span class="dcard-hint">补充资料即可覆盖</span>', gap, 'gap') +
          card(DASH_ICON.down, 'r', '待改进 · 点踩反馈 <span class="dcard-hint">定向补资料/修检索</span>', bad) +
        '</div>' +
      '</div>';
    animateDash(el);
    // 交互：点问题再问一次 / 盲区补充资料 / 统计卡下钻到对应明细
    el.addEventListener('click', function (e) {
      var supp = e.target.closest('[data-act="supplement"]');
      if (supp) { e.stopPropagation(); openKb(); return; }
      var scard = e.target.closest('.dstat-click[data-target]');
      if (scard) {
        var tgt = el.querySelector('.dcard[data-hl="' + scard.getAttribute('data-target') + '"]');
        if (tgt) {
          tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tgt.classList.remove('dcard-pulse'); void tgt.offsetWidth; tgt.classList.add('dcard-pulse');
        }
        return;
      }
      var row = e.target.closest('.drow-click[data-q]');
      if (row) askFromDashboard(row.getAttribute('data-q'));
    });
    // 导出周报
    var exp = document.getElementById('dashExport');
    if (exp) exp.onclick = function () { exportWeeklyReport(s, this); };
    wireDashToggle();
  } catch (e) { el.innerHTML = '<div class="kb-empty">加载失败</div>'; }
}

// 组织级看板（管理员）：全公司聚合
async function loadOrgAnalytics() {
  const el = document.getElementById('dashBody');
  el.innerHTML = '<div class="kb-empty">加载中…</div>';
  try {
    const res = await authFetch('/api/analytics/org');
    if (res.status === 403) { el.innerHTML = '<div class="kb-empty">仅管理员可见组织看板</div>'; return; }
    const s = (await res.json()).summary || {};
    const fb = s.feedback || { up: 0, down: 0 };
    var toggle = document.getElementById('dashToggle');
    if (toggle) toggle.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-v') === 'org'); });
    const top = dRows(s.topQuestions, '暂无重复提问', function (x, i) {
      return '<div class="drow"><span class="drow-rank">' + (i + 1) + '</span><span class="drow-q" title="' + escapeHtml(x.q) + '">' + escapeHtml(x.q) + '</span><span class="drow-cnt">' + x.count + ' 次 · ' + (x.users || 1) + ' 人</span></div>';
    });
    const gap = dRows(s.gaps, '暂无盲区，覆盖很好', function (q) {
      return '<div class="drow drow-gap"><span class="drow-dot"></span><span class="drow-q" title="' + escapeHtml(q) + '">' + escapeHtml(q) + '</span>' +
        '<button type="button" class="drow-act" data-act="supplement">补充资料</button></div>';
    });
    el.innerHTML =
      '<div class="dstats">' +
        dStat(DASH_ICON.chat, 'v', s.total || 0, '全公司提问') +
        dStat(DASH_ICON.up, 'b', s.users || 0, '活跃用户') +
        dStat(DASH_ICON.today, 'o', s.today || 0, '今日提问') +
        dStat(DASH_ICON.target, 'g', s.coverage || 0, '知识覆盖率', '%') +
        dStat(DASH_ICON.gap, 'r', (s.gaps || []).length, '知识盲区') +
      '</div>' +
      dCard(DASH_ICON.trend, 'v', '全公司提问趋势 · 近 7 天', dTrendChart(s.trend)) +
      '<div class="dgrid">' +
        '<div class="dcol-main">' + dCard(DASH_ICON.fire, 'o', '全公司高频问题 <span class="dcard-hint">该沉淀成 FAQ</span>', top) + '</div>' +
        '<div class="dcol-side">' + dCard(DASH_ICON.warn, 'r', '全公司知识盲区 <span class="dcard-hint">库里可能缺内容</span>', gap) + '</div>' +
      '</div>';
    animateDash(el);
    el.addEventListener('click', function (e) {
      var supp = e.target.closest('[data-act="supplement"]');
      if (supp) { e.stopPropagation(); openKb(); }
    });
    wireDashToggle();
  } catch (e) { el.innerHTML = '<div class="kb-empty">加载失败</div>'; }
}

function wireDashToggle() {
  var toggle = document.getElementById('dashToggle');
  if (!toggle) return;
  toggle.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { if (b.getAttribute('data-v') === 'org') loadOrgAnalytics(); else loadAnalytics(); };
  });
}

// 从看板点问题 → 新开对话并再问一次
async function askFromDashboard(q) {
  if (!q) return;
  await createNewConversation();
  questionInput.value = q;
  askQuestion(q);
}

// 一键导出提问周报到飞书文档（复用导出能力）
function exportWeeklyReport(s, btn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  var fb = s.feedback || { up: 0, down: 0 };
  var lines = [];
  lines.push('# 提问看板周报');
  lines.push('累计提问 ' + (s.total || 0) + ' 次，今日 ' + (s.today || 0) + ' 次，知识覆盖率 ' + (s.coverage || 0) + '%，有帮助/没帮助 ' + (fb.up || 0) + '/' + (fb.down || 0) + '。');
  lines.push('## 近 7 天提问趋势');
  (s.trend || []).forEach(function (t) { lines.push('- ' + t.label + '：' + t.count + ' 次'); });
  lines.push('## 高频问题（FAQ 候选）');
  if ((s.topQuestions || []).length) (s.topQuestions).forEach(function (x, i) { lines.push((i + 1) + '. ' + x.q + '（' + x.count + ' 次）'); });
  else lines.push('- 暂无重复提问');
  lines.push('## 知识盲区（可能库里缺内容）');
  if ((s.gaps || []).length) (s.gaps).forEach(function (q) { lines.push('- ' + q); });
  else lines.push('- 暂无盲区');
  var answer = lines.join('\n');
  authFetch('/api/export/doc', { method: 'POST', body: JSON.stringify({ question: '提问看板周报', answer: answer, references: [] }) })
    .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (j) { if (btn) btn.disabled = false; if (j && j.ok && j.url) { showToast('周报已导出到飞书'); window.open(j.url, '_blank'); } else showToast(j && j.error ? j.error : '导出失败'); })
    .catch(function () { if (btn) btn.disabled = false; showToast('导出失败，请稍后重试'); });
}

async function loadKbList() {
  const listEl = document.getElementById('kbList');
  listEl.innerHTML = '<div class="kb-empty">加载中…</div>';
  try {
    const res = await authFetch(withKbScope('/api/kb'));
    const data = await res.json();
    kbCanManage = data.canManage !== false;
    updateKbScopeUi();
    renderKbList(data.docs || [], kbCanManage);
  } catch (e) { listEl.innerHTML = '<div class="kb-empty">加载失败</div>'; }
}

function renderKbList(docs, canManage) {
  if (canManage === undefined) canManage = true;
  const listEl = document.getElementById('kbList');
  const countEl = document.getElementById('kbCount');
  if (countEl) countEl.textContent = docs.length ? ('共 ' + docs.length + ' 篇') : '';
  if (!docs.length) {
    listEl.innerHTML = '<div class="kb-empty"><div class="kb-empty-ic">' + KBEMPTY_SVG + '</div>' +
      '<div class="kb-empty-t">还没有上传文档</div>' +
      '<div class="kb-empty-s">上传后，提问时会自动带上这些资料一起检索</div></div>';
    return;
  }
  listEl.innerHTML = '';
  docs.forEach(function (d) {
    const item = document.createElement('div');
    item.className = 'kb-item';
    const idxBadge = d.embedded
      ? '<span class="kb-badge kb-badge-vec" title="已建向量索引，支持语义检索"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>向量索引</span>'
      : d.indexMode === 'legacy_vector'
        ? '<span class="kb-badge kb-badge-warn" title="旧索引缺少模型身份，为避免向量空间不兼容，需点击重建索引">待重建</span>'
        : '<span class="kb-badge kb-badge-bm" title="仅关键词索引（未用向量厂商）">关键词</span>';
    const changedAt = (d.updatedAt || d.uploadedAt || '').slice(0, 10);
    item.innerHTML =
      '<span class="kb-file-ic">' + kbFileIcon(d.title) + '</span>' +
      '<div class="kb-item-info"><div class="kb-item-title" title="' + escapeHtml(d.title) + '">' + escapeHtml(d.title) + '</div>' +
      '<div class="kb-item-meta">v' + (d.revision || 1) + ' · ' + changedAt + ' · ' + (d.size || 0) + ' 字 · ' + (d.chunkCount || 0) + ' 块 ' + idxBadge + '</div></div>' +
      (canManage ? '<div class="kb-item-actions">' +
        '<button class="kb-item-action kb-item-edit" type="button" title="编辑文字内容">编辑</button>' +
        '<button class="kb-item-action kb-item-replace" type="button" title="用新文件替换，只重建变化部分">替换文件</button>' +
        '<button class="kb-item-del" type="button" title="删除">' + TRASH_SVG + '</button>' +
      '</div>' : '<span class="kb-readonly">只读</span>');
    var edit = item.querySelector('.kb-item-edit'), replace = item.querySelector('.kb-item-replace'), del = item.querySelector('.kb-item-del');
    if (edit) edit.addEventListener('click', function (e) { e.stopPropagation(); editKbDoc(d); });
    if (replace) replace.addEventListener('click', function (e) { e.stopPropagation(); replaceKbDoc(d); });
    if (del) del.addEventListener('click', function (e) { e.stopPropagation(); deleteKbDoc(d.id, d.revision); });
    listEl.appendChild(item);
  });
}

function withKbScope(path) {
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'scope=' + encodeURIComponent(kbScope);
}

function updateKbScopeUi() {
  var org = kbScope === 'organization';
  var hint = document.getElementById('kbScopeHint');
  var lead = document.getElementById('kbLead');
  var drop = document.getElementById('kbDrop');
  var paste = document.getElementById('kbPasteArea2');
  var rebuild = document.getElementById('kbReindexBtn');
  if (hint) hint.textContent = org
    ? (kbCanManage ? '同一飞书组织成员可用 · 你可以维护' : '同一飞书组织成员可用 · 仅管理员可维护')
    : '仅你可见，设置只影响你自己';
  if (lead) lead.textContent = org
    ? '组织统一资料会参与同租户所有成员的检索；个人知识库和个人设置不会被管理员读取或修改。'
    : '你上传的补充资料。提问时会连同你有权限的飞书文档、聊天和组织知识库一起实时检索。';
  if (drop) drop.hidden = !kbCanManage;
  if (paste && !kbCanManage) paste.style.display = 'none';
  if (rebuild) rebuild.hidden = !kbCanManage;
}

function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { var s = String(r.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// 传文件 → 服务端解析(docx/xlsx/pptx/pdf/txt…) → 入库。图片/扫描件需 OCR：没配 key 时单独提示、不影响其它文件。
async function uploadKbFiles(files) {
  if (!files || !files.length) return;
  const listEl = document.getElementById('kbList');
  let ok = 0, needOcr = 0, failed = 0, degraded = 0;
  const errors = [];
  const warnings = [];
  for (let i = 0; i < files.length; i++) {
    try {
      if (listEl) listEl.innerHTML = '<div class="kb-empty">正在解析并建立索引… (' + (i + 1) + '/' + files.length + ') ' + escapeHtml(files[i].name) + '</div>';
      const b64 = await fileToBase64(files[i]);
      const res = await authFetch(withKbScope('/api/kb/upload'), { method: 'POST', body: JSON.stringify({ filename: files[i].name, dataBase64: b64 }) });
      const j = await res.json().catch(function () { return { ok: false }; });
      if (j.ok) {
        ok++;
        if (j.warning) {
          degraded++;
          warnings.push(files[i].name + '：' + j.warning);
        }
      }
      else if (j.needOcr) {
        needOcr++;
        errors.push(files[i].name + '：' + (j.error || '需要 OCR 才能识别'));
      } else {
        failed++;
        errors.push(files[i].name + '：' + (j.error || ('上传失败（HTTP ' + res.status + '）')));
      }
    } catch (e) {
      failed++;
      errors.push(files[i].name + '：' + (e && e.message ? e.message : '网络或服务异常'));
    }
  }
  var msg = ok ? ('已上传 ' + ok + ' 篇，已建索引') : '';
  if (needOcr) msg += (msg ? '；' : '') + needOcr + ' 个图片/扫描件需配置 OCR 才能识别';
  if (failed) msg += (msg ? '；' : '') + failed + ' 个解析失败';
  if (errors.length) msg += ' · ' + errors.slice(0, 2).join('；') + (errors.length > 2 ? '；另有 ' + (errors.length - 2) + ' 个失败' : '');
  if (degraded) msg += ' · ' + warnings.slice(0, 2).join('；') + (warnings.length > 2 ? '；另有 ' + (warnings.length - 2) + ' 个降级' : '');
  showToast(msg || '未成功上传', (needOcr || failed) ? 'error' : degraded ? 'info' : 'success');
  loadKbList();
}

async function savePastedDoc() {
  const titleEl = document.getElementById('kbPasteTitle');
  const contentEl = document.getElementById('kbPasteContent');
  const title = (titleEl.value || '').trim() || '粘贴文档';
  const content = (contentEl.value || '').trim();
  if (!content) { showToast('内容为空'); return; }
  try {
    const editingId = contentEl.dataset.editId || '';
    const payload = { title, content };
    if (editingId) payload.expectedRevision = Number(contentEl.dataset.revision || 0);
    const res = await authFetch(withKbScope(editingId ? '/api/kb/' + encodeURIComponent(editingId) : '/api/kb'), {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(function () { return { ok: false }; });
    if (data.ok) {
      showToast(editingId ? '已更新，仅变化内容重新建索引' : '已保存到知识库');
      titleEl.value = '';
      contentEl.value = '';
      delete contentEl.dataset.editId;
      delete contentEl.dataset.revision;
      document.getElementById('kbPasteArea').style.display = 'none';
      loadKbList();
    } else {
      showToast(data.error || '保存失败', 'error');
      if (res.status === 409) loadKbList();
    }
  } catch (e) { showToast('保存失败'); }
}

async function editKbDoc(doc) {
  try {
    const res = await authFetch(withKbScope('/api/kb/' + encodeURIComponent(doc.id)));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    const titleEl = document.getElementById('kbPasteTitle2') || document.getElementById('kbPasteTitle');
    const contentEl = document.getElementById('kbPasteContent2') || document.getElementById('kbPasteContent');
    const area = document.getElementById('kbPasteArea2') || document.getElementById('kbPasteArea');
    if (!titleEl || !contentEl || !area) throw new Error('编辑区域不可用');
    titleEl.value = data.doc.title || '';
    contentEl.value = data.doc.content || '';
    contentEl.dataset.editId = data.doc.id;
    contentEl.dataset.revision = data.doc.revision;
    area.style.display = area.id === 'kbPasteArea2' ? 'flex' : 'block';
    contentEl.focus();
  } catch (e) { showToast(e.message || '读取失败', 'error'); }
}

function replaceKbDoc(doc) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.markdown,.csv,.json,.log,.text,.tsv,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.bmp';
  input.hidden = true;
  input.addEventListener('change', async function () {
    const file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    try {
      showToast('正在解析并增量更新索引…', 'loading');
      const b64 = await fileToBase64(file);
      const res = await authFetch(withKbScope('/api/kb/' + encodeURIComponent(doc.id) + '/upload'), {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, dataBase64: b64, expectedRevision: doc.revision }),
      });
      const data = await res.json().catch(function () { return { ok: false }; });
      if (!data.ok) throw new Error(data.error || '更新失败');
      var updatedMsg = '已更新：复用 ' + (data.doc.reusedVectorCount || 0) + ' 块，重建 ' + (data.doc.embeddedVectorCount || 0) + ' 块';
      if (data.warning) updatedMsg += ' · ' + data.warning;
      showToast(updatedMsg, data.warning ? 'info' : 'success');
      loadKbList();
    } catch (e) {
      showToast(e.message || '更新失败', 'error');
      loadKbList();
    } finally { input.remove(); }
  });
  document.body.appendChild(input);
  input.click();
}

async function reindexKb(btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await authFetch(withKbScope('/api/kb/reindex'), { method: 'POST', body: '{}' });
    const data = await res.json().catch(function () { return { ok: false }; });
    if (data.failed) showToast('已重建 ' + data.succeeded + ' 篇，' + data.failed + ' 篇失败', 'error');
    else showToast('已重建 ' + (data.succeeded || 0) + ' 篇索引', 'success');
    loadKbList();
  } catch (e) { showToast('重建失败', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

async function deleteKbDoc(id, revision) {
  if (!confirm('删除这篇文档？')) return;
  try {
    const suffix = revision ? '?revision=' + encodeURIComponent(revision) : '';
    const res = await authFetch(withKbScope('/api/kb/' + encodeURIComponent(id) + suffix), { method: 'DELETE' });
    const data = await res.json().catch(function () { return { ok: false }; });
    if (!data.ok) showToast(data.error || '删除失败', 'error');
    loadKbList();
  } catch (e) { showToast('删除失败', 'error'); }
}

// ─── 组织管理：同租户成员 + Owner/Admin/Member 角色 ──────────────────────────
async function openOrganization() {
  document.body.classList.add('dash-mode');
  hideWelcome(); activeView = 'organization'; renderHistory();
  chatTitle.textContent = '组织管理';
  chatContainer.innerHTML = '<div class="org-page"><div class="org-page-head"><div><h2>组织管理</h2><p>成员首次登录后自动加入当前飞书组织。个人知识库、模型配置和开发者设置始终只属于本人。</p></div></div><div id="orgBody" class="kb-empty">加载中…</div></div>';
  try {
    var res = await authFetch('/api/organization');
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || '加载失败');
    renderOrganization(data);
  } catch (e) {
    document.getElementById('orgBody').innerHTML = '<div class="quality-empty">' + escapeHtml(e.message || '加载失败') + '</div>';
  }
}

function renderOrganization(data) {
  var body = document.getElementById('orgBody'); if (!body) return;
  var org = data.organization || {};
  var labels = { owner: 'Owner', admin: '管理员', member: '成员' };
  body.className = 'org-body';
  body.innerHTML =
    '<div class="org-summary"><div><span>当前组织</span><strong>' + escapeHtml(org.name || '当前飞书组织') + '</strong></div><div><span>已接入成员</span><strong>' + Number(org.memberCount || (data.members || []).length) + '</strong></div><div><span>你的角色</span><strong>' + escapeHtml(labels[data.role] || '成员') + '</strong></div></div>' +
    '<div class="org-policy"><b>权限边界</b><span>Owner 管理角色；管理员维护组织知识库和组织质量数据；成员只读组织知识库。任何角色都不能查看其他人的个人知识库或个人设置。</span></div>' +
    '<div class="org-members"><div class="org-members-head"><strong>成员与角色</strong><span>只有登录过本系统的同租户用户会出现在这里</span></div>' +
    (data.members || []).map(function (m) {
      var controls = data.isOwner && m.role !== 'owner'
        ? '<select class="org-role-select" data-open-id="' + escapeHtml(m.openId) + '"><option value="member"' + (m.role === 'member' ? ' selected' : '') + '>成员</option><option value="admin"' + (m.role === 'admin' ? ' selected' : '') + '>管理员</option><option value="owner">转为 Owner</option></select>'
        : '<span class="org-role role-' + escapeHtml(m.role) + '">' + escapeHtml(labels[m.role] || '成员') + '</span>';
      return '<div class="org-member"><span class="org-avatar">' + (m.avatar ? '<img src="' + escapeHtml(m.avatar) + '">' : escapeHtml((m.name || 'U').charAt(0))) + '</span><div class="org-member-meta"><strong>' + escapeHtml(m.name || '未命名成员') + (currentUser && m.openId === currentUser.openId ? '（你）' : '') + '</strong><small>最近登录 ' + escapeHtml(String(m.lastSeenAt || '').slice(0, 10) || '—') + '</small></div>' + controls + '</div>';
    }).join('') + '</div>';
  body.querySelectorAll('.org-role-select').forEach(function (select) {
    var old = select.value;
    select.onchange = async function () {
      var role = select.value;
      var text = role === 'owner' ? '确认把组织 Owner 转移给该成员？你将变为管理员。' : '确认修改该成员角色？';
      if (!confirm(text)) { select.value = old; return; }
      select.disabled = true;
      try {
        var res = await authFetch('/api/organization/members/' + encodeURIComponent(select.getAttribute('data-open-id')), { method: 'PATCH', body: JSON.stringify({ role: role }) });
        var out = await res.json();
        if (!out.ok) throw new Error(out.error || '修改失败');
        showToast('组织角色已更新', 'success');
        await openOrganization();
      } catch (e) {
        select.value = old; select.disabled = false;
        showToast(e.message || '修改失败', 'error');
      }
    };
  });
}

// ─── Interactions ─────────────────────────────────────────────────────────────

function toggleWebSearch() {
  webSearch = !webSearch;
  webSearchBtn.classList.toggle('active', webSearch);
}

var TOAST_IC = {
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>',
  error:   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  info:    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>',
  loading: '<svg class="toastx-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" opacity=".9"/></svg>',
};
function toastIcon(type) { return TOAST_IC[type] || TOAST_IC.info; }

// 现代化提示：顶部居中、从上滑入、白底彩色图标；支持 loading→success/error 更新（如复制链接）。
function showToast(message, type) {
  type = type || 'success';
  var wrap = document.getElementById('toastWrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  var el = document.createElement('div');
  el.className = 'toastx toastx-' + type;
  el.innerHTML = '<span class="toastx-ic">' + toastIcon(type) + '</span><span class="toastx-msg"></span>';
  el.querySelector('.toastx-msg').textContent = message;
  wrap.appendChild(el);
  void el.offsetWidth;   // 强制回流：先让浏览器画出"起始态"(在上方/透明)，再加 .in 才能触发下滑过渡
  el.classList.add('in');
  var timer = null;
  function schedule(d) { if (timer) clearTimeout(timer); if (d) timer = setTimeout(dismiss, d); }
  function dismiss() { if (timer) clearTimeout(timer); el.classList.remove('in'); el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.remove(); }, 280); }
  schedule(type === 'loading' ? 0 : 2200);
  return {
    update: function (msg, t) {
      el.className = 'toastx toastx-' + t + ' in';
      el.querySelector('.toastx-ic').innerHTML = toastIcon(t);
      el.querySelector('.toastx-msg').textContent = msg;
      schedule(t === 'loading' ? 0 : 2200);
    },
    close: dismiss,
  };
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

// 输入框 "+" 菜单：添加图片 / 深入研究 / 帮我写作
function setupPlusMenu() {
  var menu = document.getElementById('plusMenu');
  if (!addFileBtn || !menu) return;
  var close = function () { menu.hidden = true; addFileBtn.classList.remove('open'); document.removeEventListener('click', onDoc); };
  var onDoc = function (e) { if (!menu.contains(e.target) && e.target !== addFileBtn && !addFileBtn.contains(e.target)) close(); };
  addFileBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.hidden) { menu.hidden = false; addFileBtn.classList.add('open'); setTimeout(function () { document.addEventListener('click', onDoc); }, 0); }
    else close();
  });
  var picker = document.getElementById('imgPicker');
  if (picker) picker.addEventListener('change', function () {
    if (picker.files && picker.files.length) { showToast('已选择「' + picker.files[0].name + '」，带图提问即将上线'); picker.value = ''; }
  });
  menu.querySelectorAll('.pm-item').forEach(function (it) {
    it.addEventListener('click', function () {
      var p = it.getAttribute('data-p');
      if (p === 'image') { if (picker) picker.click(); }
      else if (p === 'research' || p === 'write') setInputMode(p);
      close();
    });
  });
  var chipX = document.querySelector('#modeChip .mode-chip-x');
  if (chipX) chipX.addEventListener('click', clearInputMode);
}

// 输入模式（深入研究 / 帮我写作）：显示蓝色 chip + 对应占位，发送时增强 prompt（气泡仍显示原文）
var inputMode = null;
var DEFAULT_PLACEHOLDER = '试试输入“/”，支持深入研究、写作、带图提问';
var MODE_CFG = {
  research: { label: '深入研究', placeholder: '思考更久，检索更深，答案更好', prefix: '请对以下问题进行深入研究：多角度检索资料、交叉验证，给出结构化、详尽且有依据的结论。\n问题：' },
  write: { label: '帮我写作', placeholder: '描述你的写作要求（如项目进展、行业或竞品分析）', prefix: '请根据以下要求帮我写作，输出条理清晰、可直接使用的成稿。\n要求：' }
};
function setInputMode(mode) {
  var cfg = MODE_CFG[mode]; if (!cfg) return;
  inputMode = mode;
  var chip = document.getElementById('modeChip');
  chip.querySelector('.mode-chip-text').textContent = cfg.label;
  chip.hidden = false;
  questionInput.placeholder = cfg.placeholder;
  questionInput.focus();
}
function clearInputMode() {
  inputMode = null;
  var chip = document.getElementById('modeChip');
  if (chip) chip.hidden = true;
  if (questionInput) questionInput.placeholder = DEFAULT_PLACEHOLDER;
}
function applyInputMode(q) {
  var cfg = inputMode && MODE_CFG[inputMode];
  return cfg ? cfg.prefix + q : q;
}

// 提交反馈 / 许愿——整页（非弹框），可勾选热门许愿 + 自由留言 + 提交成功动效
var FB_WISHES = [
  { id: 'export', t: '答案导出为 PDF / Word', d: '把回答一键存成规整文档', i: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M9 13h6M9 17h4' },
  { id: 'image', t: '答案生成分享图片', d: '一键长图，方便转发进群', i: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z|M8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z|M5 18l4.5-5 3 3.5L16 12l4 6' },
  { id: 'source', t: '更多数据源：多维表格 / OKR / 审批', d: '让 AI 读到更全的企业资料', i: 'M4 4h16v16H4z|M4 10h16M4 15h16M10 4v16' },
  { id: 'chatshare', t: '分享答案到飞书会话', d: '选个群或同事直接发过去', i: 'M7 17l-3 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z|M14 8l3 3-3 3M17 11H9' },
  { id: 'cron', t: '定时追踪关键问题', d: '每天定点帮你查一次并推送', i: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 8v4l3 2' },
  { id: 'followup', t: '答案支持追问 / 多轮深挖', d: '顺着上一条继续往下问', i: 'M21 11.5a8.5 8.5 0 0 1-12 7.7L3 21l1.8-6A8.5 8.5 0 1 1 21 11.5z' },
  { id: 'mobile', t: '手机 / 飞书内也能用', d: '移动端与飞书侧边栏适配', i: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M11 18h2' },
  { id: 'faster', t: '更快的响应速度', d: '再快一点，等得更少', i: 'M13 2L4.5 13H11l-1 9 8.5-11H12z' },
];
function fbChipSvg(paths) {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    paths.split('|').map(function (p) { return '<path d="' + p + '"/>'; }).join('') + '</svg>';
}
// ─── 开发者设置：检索/法官/会话各参数可视化调参（避免在代码里写死）─────────────
var DEV_PARAMS = [
  { group: '检索召回', items: [
    { key: 'pageSize', label: '召回数量', def: 10, min: 1, max: 30, step: 1, tip: '先从飞书找回多少条候选。调大不容易漏资料，但搜索和后续处理会更慢。' },
    { key: 'readPool', label: '读取上限', def: 12, min: 1, max: 20, step: 1, tip: '最多打开多少篇文档读正文。调大更不容易漏掉答案，但会增加读取时间。聊天内容已带正文，不占这个数量。' },
  ] },
  { group: '相关性精排', items: [
    { key: 'minScore', label: '语义相似门槛', def: 0.4, min: 0, max: 1, step: 0.01, tip: '先过滤明显无关的内容。调高会更干净，但可能把换了一种说法的正确答案也删掉；调低会更全，但交给模型判断的内容更多。' },
    { key: 'judgeMin', label: '模型判断门槛', def: 2, min: 1, max: 3, step: 1, tip: '模型给每条候选打 0～3 分。3 分能直接回答，2 分有有效信息，1 分只是话题相近。默认保留 2 分及以上。' },
    { key: 'adaptiveEvidence', label: '自适应证据集', def: true, type: 'toggle', tip: '开启后，系统会根据相关程度自动决定给答案用几条资料；关闭后固定取前几条。这个开关主要用于对比测试。' },
    { key: 'topK', label: '固定资料数', def: 3, min: 1, max: 8, step: 1, tip: '只在关闭“自适应证据集”时生效。比如填 3，就只让回答使用前 3 条；其他相关内容仍可在下方展开查看。' },
    { key: 'evidenceMin', label: '证据下限', def: 2, min: 1, max: 5, step: 1, tip: '开启自适应时生效。有足够相关结果时，至少给回答模型几条证据。' },
    { key: 'evidenceMax', label: '证据上限', def: 5, min: 1, max: 8, step: 1, tip: '最终参与回答并编号引用的最大条数。其余法官通过项不会丢失，会折叠到“更多相关结果”。' },
    { key: 'evidenceScoreGap', label: '接近最佳的范围', def: 0.15, min: 0, max: 0.5, step: 0.01, tip: '决定“比最佳结果差多少还算值得引用”。调小更精简，调大能带上更多补充资料。请结合质量评测结果调整。' },
    { key: 'adversarial', label: '实验性二次复核', def: false, type: 'toggle', tip: '让当前模型再检查一次刚好及格的候选。可能减少误选，但也可能删掉正确资料，而且会多等一次模型调用。现有测试中召回变差，所以默认关闭，仅用于 A/B 对比。' },
  ] },
  { group: '会话检索', items: [
    { key: 'chatSearch', label: '会话检索', def: true, type: 'toggle', tip: '是否检索飞书聊天记录作为来源。关闭后只用文档与本地知识库。' },
    { key: 'chatSize', label: '聊天候选数', def: 6, min: 1, max: 10, step: 1, tip: '先从聊天中找回多少个可能相关的消息位置。调大不容易漏，但会处理更多聊天片段。' },
    { key: 'chatAfter', label: '向后补条数', def: 3, min: 0, max: 8, step: 1, tip: '对「每条命中的消息」向后补取几条真人回复作上下文。聊天一问一答，命中的常是"问"、答在后面——补上答案，判官才判得出相关。补太多会带进跑题闲聊、反而稀释，建议 2~3。' },
    { key: 'chatBefore', label: '向前补条数', def: 0, min: 0, max: 4, step: 1, tip: '命中聊天后，再带上前面几条消息。适合“搜到的是答案，但问题在前面”的情况。' },
  ] },
];

function openDevSettings() {
  authFetch('/api/config').then(function (r) { return r.json(); }).then(function (d) {
    var cfg = (d && d.config) || {};
    var groups = DEV_PARAMS.map(function (g) {
      var items = g.items.map(function (it) {
        var val = cfg[it.key]; if (val == null) val = it.def;
        var ctrl = it.type === 'toggle'
          ? '<button type="button" class="tk-switch dev-toggle' + (val !== false ? ' on' : '') + '" data-key="' + it.key + '"><span class="tk-knob"></span></button>'
          : '<input type="number" class="dev-input" data-key="' + it.key + '" value="' + val + '" min="' + it.min + '" max="' + it.max + '" step="' + it.step + '">';
        return '<div class="dev-row"><div class="dev-label"><span>' + it.label + '</span>' +
          '<span class="dev-help" data-tip="' + escapeHtml(it.tip) + '">' + HELP_SVG + '</span></div>' +
          '<div class="dev-ctrl">' + ctrl + '</div></div>';
      }).join('');
      return '<div class="dev-group"><div class="dev-group-title">' + g.group + '</div>' + items + '</div>';
    }).join('');
    var overlay = document.createElement('div');
    overlay.className = 'dev-modal';
    overlay.innerHTML =
      '<div class="dev-backdrop"></div>' +
      '<div class="dev-card">' +
        '<div class="dev-head"><h3>' + DEV_SVG + ' 开发者设置</h3><button type="button" class="dev-close" aria-label="关闭">&times;</button></div>' +
        '<div class="dev-sub">检索召回、相关性精排、会话检索参数（仅对你的登录会话生效）。当前为 <b>baseline-v1 安全基线</b>；质量工作台积累人工标注后再按离线指标升级。悬停或点击 <span class="dev-help-inline">' + HELP_SVG + '</span> 查看说明。</div>' +
        '<div class="dev-body">' + groups + '</div>' +
        '<div class="dev-foot"><button type="button" class="btn-ghost dev-reset">恢复系统基线</button><button type="button" class="btn-primary dev-save">保存</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('in'); });
    // 参数说明 tooltip：用 fixed 定位挂到 body，脱离弹框滚动容器（否则会被 overflow 裁切）；上方放不下自动翻到下方
    var tipEl = null;
    var hideTip = function () { if (tipEl) { tipEl.remove(); tipEl = null; } };
    overlay.querySelectorAll('.dev-help').forEach(function (h) {
      h.setAttribute('tabindex', '0');
      var showTip = function () {
        hideTip();
        tipEl = document.createElement('div'); tipEl.className = 'dev-tip-fixed';
        tipEl.textContent = h.getAttribute('data-tip'); document.body.appendChild(tipEl);
        var r = h.getBoundingClientRect(); var tw = 260;
        var left = Math.max(12, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 12));
        tipEl.style.left = left + 'px';
        var top = r.top - tipEl.offsetHeight - 9;
        if (top < 12) top = r.bottom + 9;   // 上方不够 → 翻到下方
        tipEl.style.top = top + 'px';
        requestAnimationFrame(function () { if (tipEl) tipEl.classList.add('in'); });
      };
      h.addEventListener('mouseenter', showTip);
      h.addEventListener('mouseleave', hideTip);
      h.addEventListener('focus', showTip);
      h.addEventListener('blur', hideTip);
      h.addEventListener('click', function (e) { e.stopPropagation(); if (tipEl) hideTip(); else showTip(); });
    });
    var close = function () { hideTip(); overlay.classList.remove('in'); setTimeout(function () { overlay.remove(); }, 200); };
    overlay.querySelector('.dev-backdrop').addEventListener('click', close);
    overlay.querySelector('.dev-close').addEventListener('click', close);
    overlay.querySelectorAll('.dev-toggle').forEach(function (t) {
      t.addEventListener('click', function () { t.classList.toggle('on'); });
    });
    overlay.querySelector('.dev-reset').addEventListener('click', function () {
      DEV_PARAMS.forEach(function (g) { g.items.forEach(function (it) {
        if (it.type === 'toggle') { var t = overlay.querySelector('.dev-toggle[data-key="' + it.key + '"]'); if (t) t.classList.toggle('on', it.def !== false); }
        else { var i = overlay.querySelector('.dev-input[data-key="' + it.key + '"]'); if (i) i.value = it.def; }
      }); });
    });
    overlay.querySelector('.dev-save').addEventListener('click', function () {
      var self = this; self.disabled = true;
      var payload = {};
      overlay.querySelectorAll('.dev-input').forEach(function (i) { var v = parseFloat(i.value); if (!isNaN(v)) payload[i.getAttribute('data-key')] = v; });
      overlay.querySelectorAll('.dev-toggle').forEach(function (t) { payload[t.getAttribute('data-key')] = t.classList.contains('on'); });
      authFetch('/api/config', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .then(function (j) { self.disabled = false; if (j && j.ok) { showToast('设置已保存 · 下次提问生效', 'success'); close(); } else showToast(j && j.error ? j.error : '保存失败', 'error'); })
        .catch(function () { self.disabled = false; showToast('保存失败', 'error'); });
    });
  }).catch(function () { showToast('加载配置失败', 'error'); });
}

// 一键转发选择器：选中群/自己 → 一个动作完成「导出成你名下云文档 + 以你本人身份把链接发过去」。
// 以用户身份发消息（非机器人）需 scope im:message:send；缺了会 needReauth，提示去后台开通+重登。
function openChatPicker(question, answerText, references) {
  var shareRefs = (references || []).map(function (r) { return { title: r.title, url: r.url }; });
  var overlay = document.createElement('div');
  overlay.className = 'dev-modal';
  overlay.innerHTML =
    '<div class="dev-backdrop"></div><div class="dev-card cp-card">' +
      '<div class="dev-head"><h3>' + TB_ICON.chat + ' 转发给…</h3><button type="button" class="dev-close">&times;</button></div>' +
      '<div class="cp-search"><input type="text" id="cpSearch" placeholder="搜索群 / 同事姓名"></div>' +
      '<div class="cp-list" id="cpList"><div class="cp-empty">加载会话…</div></div>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(function () { overlay.classList.add('in'); });
  var close = function () { overlay.classList.remove('in'); setTimeout(function () { overlay.remove(); }, 200); };
  overlay.querySelector('.dev-backdrop').addEventListener('click', close);
  overlay.querySelector('.dev-close').addEventListener('click', close);

  var forward = function (receiveType, receiveId, name) {
    var tip = showToast('正在以你的名义转发给「' + name + '」…', 'loading');
    authFetch('/api/share/forward', { method: 'POST', body: JSON.stringify({ receiveType: receiveType, receiveId: receiveId, question: question, answer: answerText || '', references: shareRefs }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (j && j.ok) { tip.update('已以你的名义转发给「' + name + '」', 'success'); close(); }
        else if (j && j.needReauth) tip.update('需在应用后台开通「以用户身份发送消息」并重新登录', 'error');
        else tip.update(j && j.error ? j.error : '转发失败', 'error');
      })
      .catch(function () { tip.update('转发失败，请稍后重试', 'error'); });
  };
  var groups = [], people = [], hint = '', peopleLoading = true;
  var itemHtml = function (av, name, sub, dataAttr) {
    return '<button type="button" class="cp-item" ' + dataAttr + '><span class="cp-av">' + av + '</span>' +
      '<span class="cp-name">' + escapeHtml(name) + (sub ? '<span class="cp-sub">' + escapeHtml(sub) + '</span>' : '') + '</span></button>';
  };
  var render = function (q) {
    q = (q || '').trim().toLowerCase();
    var el = overlay.querySelector('#cpList');
    var html = hint ? '<div class="cp-hint">' + hint + '</div>' : '';
    // 发给我自己（无搜索或匹配"我/自己"时显示）
    if (!q || '我自己'.indexOf(q) >= 0 || 'self'.indexOf(q) >= 0) {
      html += '<button type="button" class="cp-item" data-self="1"><span class="cp-av cp-av-self">我</span><span class="cp-name">发给我自己<span class="cp-sub">以你本人身份发到「与自己的会话」</span></span></button>';
    }
    var gs = q ? groups.filter(function (c) { return (c.name || '').toLowerCase().indexOf(q) >= 0; }) : groups;
    if (gs.length) {
      html += '<div class="cp-sec">群聊</div>' + gs.map(function (c) {
        var av = c.avatar ? '<img src="' + safeUrl(c.avatar) + '">' : escapeHtml((c.name || '?').charAt(0));
        return itemHtml(av, c.name, '', 'data-chat="' + escapeHtml(c.chatId) + '" data-name="' + escapeHtml(c.name) + '"');
      }).join('');
    }
    var ps = q ? people.filter(function (p) { return (p.name || '').toLowerCase().indexOf(q) >= 0; }) : people.slice(0, 30);
    if (ps.length) {
      html += '<div class="cp-sec">同事' + (!q && people.length > 30 ? '（搜索姓名查看全部 ' + people.length + ' 人）' : '') + '</div>' + ps.map(function (p) {
        return itemHtml(escapeHtml((p.name || '?').charAt(0)), p.name, '', 'data-open="' + escapeHtml(p.openId) + '" data-name="' + escapeHtml(p.name) + '"');
      }).join('');
    } else if (q && peopleLoading) {
      html += '<div class="cp-sec">同事</div><div class="cp-empty">同事名单加载中…</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('.cp-item').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-self')) forward('open_id', '', '我自己');
        else if (b.getAttribute('data-open')) forward('open_id', b.getAttribute('data-open'), b.getAttribute('data-name'));
        else forward('chat_id', b.getAttribute('data-chat'), b.getAttribute('data-name'));
      });
    });
  };
  authFetch('/api/chats').then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok) groups = j.chats || [];
    else if (j && j.needReauth) hint = '重新登录后可选群（需 im:chat:readonly）。现在可先「发给我自己」或搜同事。';
    else hint = escapeHtml((j && j.error) || '会话列表加载失败');
    render(overlay.querySelector('#cpSearch').value);
  }).catch(function () { hint = '会话列表加载失败'; render(''); });
  authFetch('/api/contacts').then(function (r) { return r.json(); }).then(function (j) {
    peopleLoading = false;
    if (j && j.ok) people = j.contacts || [];
    render(overlay.querySelector('#cpSearch').value);
  }).catch(function () { peopleLoading = false; });
  overlay.querySelector('#cpSearch').addEventListener('input', function () { render(this.value); });
}

// ─── 定时追踪 ────────────────────────────────────────────────────────────────
function tkPad(n) { return String(n).padStart(2, '0'); }

function openTasks(prefill) {
  var m = document.getElementById('dashModal'); if (m) m.classList.remove('show');
  document.body.classList.add('dash-mode');
  hideWelcome();
  activeView = 'tasks'; renderHistory();   // 切到定时追踪视图：清掉左侧对话/看板/知识库的选中态
  chatTitle.textContent = '定时追踪';
  chatContainer.innerHTML =
    '<div class="tk-page">' +
      '<div class="dash-page-head"><h2>定时追踪</h2>' +
      '<p>订阅一个问题，每天定点由机器人主动把最新答案推送到你的飞书。适合追踪进度、每日复盘、值班信息——不用再手动问。</p></div>' +
      '<div class="tk-create">' +
        '<textarea id="tkQ" class="tk-q" placeholder="要每天追踪的问题，例如：昨天线上有没有故障复盘？本周澳洲迁移进度如何？">' + escapeHtml(prefill || '') + '</textarea>' +
        '<div class="tk-create-row">' +
          '<label class="tk-time-label">每天 <input type="time" id="tkTime" class="tk-time" value="09:00"></label>' +
          '<span class="tk-hint" id="tkHint"></span>' +
          '<button type="button" class="btn-primary tk-add" id="tkAdd">添加追踪</button>' +
        '</div>' +
      '</div>' +
      '<div class="tk-list-head"><span class="tk-list-title">我的追踪</span><span class="tk-list-count" id="tkCount"></span></div>' +
      '<div id="tkList" class="tk-list"></div>' +
    '</div>';
  document.getElementById('tkAdd').addEventListener('click', addTaskFromForm);
  document.getElementById('tkQ').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addTaskFromForm();
  });
  loadTasksList();
  if (prefill) { var q = document.getElementById('tkQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function addTaskFromForm() {
  var q = (document.getElementById('tkQ').value || '').trim();
  var t = document.getElementById('tkTime').value || '09:00';
  var hint = document.getElementById('tkHint');
  if (!q) { hint.textContent = '先写下要追踪的问题～'; return; }
  var parts = t.split(':'); var hour = parseInt(parts[0], 10) || 0, minute = parseInt(parts[1], 10) || 0;
  var self = document.getElementById('tkAdd'); self.disabled = true; hint.textContent = '';
  authFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ question: q, hour: hour, minute: minute }) })
    .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (j) {
      self.disabled = false;
      if (j && j.ok) { document.getElementById('tkQ').value = ''; showToast('已添加 · 每天 ' + tkPad(hour) + ':' + tkPad(minute) + ' 推送到飞书'); loadTasksList(); }
      else showToast(j && j.error ? j.error : '添加失败');
    })
    .catch(function () { self.disabled = false; showToast('添加失败，请稍后重试'); });
}

function loadTasksList() {
  authFetch('/api/tasks').then(function (r) { return r.json(); }).then(function (j) {
    var list = document.getElementById('tkList'); if (!list) return;
    var tasks = (j && j.tasks) || [];
    var cnt = document.getElementById('tkCount'); if (cnt) cnt.textContent = tasks.length ? tasks.length + ' 个' : '';
    if (!tasks.length) {
      list.innerHTML = '<div class="tk-empty">' + KBEMPTY_SVG + '<p>还没有定时追踪。<br>在上面添加一个，或在任意回答下方点「定时追踪」。</p></div>';
      return;
    }
    list.innerHTML = tasks.map(renderTaskRow).join('');
    list.querySelectorAll('.tk-row').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('.tk-switch').addEventListener('click', function () { toggleTaskUI(id, !this.classList.contains('on'), this, row); });
      row.querySelector('.tk-del').addEventListener('click', function () { deleteTaskUI(id, row); });
    });
  }).catch(function () {});
}

function renderTaskRow(t) {
  var time = tkPad(t.hour) + ':' + tkPad(t.minute);
  return '<div class="tk-row' + (t.enabled ? '' : ' off') + '" data-id="' + t.id + '">' +
    '<div class="tk-row-main">' +
      '<div class="tk-row-q">' + escapeHtml(t.question) + '</div>' +
      '<div class="tk-row-meta"><span class="tk-badge">' + TB_ICON.clock + '每天 ' + time + '</span>' +
        (t.lastRun ? '<span class="tk-last">上次推送 ' + escapeHtml(t.lastRun) + '</span>' : '<span class="tk-last">尚未推送</span>') + '</div>' +
    '</div>' +
    '<div class="tk-row-actions">' +
      '<button class="tk-switch' + (t.enabled ? ' on' : '') + '" title="启用 / 停用"><span class="tk-knob"></span></button>' +
      '<button class="tk-del" title="删除">' + TRASH_SVG + '</button>' +
    '</div>' +
  '</div>';
}

function toggleTaskUI(id, on, btn, row) {
  authFetch('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: on }) })
    .then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { btn.classList.toggle('on', on); row.classList.toggle('off', !on); showToast(on ? '已启用' : '已停用'); }
      else showToast('操作失败');
    }).catch(function () { showToast('操作失败'); });
}

function deleteTaskUI(id, row) {
  authFetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { row.classList.add('tk-removing'); setTimeout(loadTasksList, 200); showToast('已删除'); }
      else showToast('删除失败');
    }).catch(function () { showToast('删除失败'); });
}

function openFeedback() {
  var m = document.getElementById('feedbackModal'); if (m) m.classList.remove('show');
  document.body.classList.add('dash-mode');
  hideWelcome();
  activeView = 'wish'; renderHistory();   // 切到反馈视图：清掉"提问看板/知识库/对话"的选中态
  chatTitle.textContent = '提交反馈';
  var chips = FB_WISHES.map(function (w, i) {
    return '<button type="button" class="wish-chip" data-id="' + w.id + '" style="--d:' + (i * 0.04) + 's">' +
      '<span class="wish-ic">' + fbChipSvg(w.i) + '</span>' +
      '<span class="wish-tx"><span class="wish-t">' + w.t + '</span><span class="wish-d">' + w.d + '</span></span>' +
      '<span class="wish-check"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg></span>' +
      '</button>';
  }).join('');
  chatContainer.innerHTML =
    '<div class="fb-page">' +
      '<div class="dash-page-head"><h2>许个愿，帮我们变更好 ✦</h2>'.replace(' ✦', '') +
      '<p>你在意什么，我们就优先做什么。挑下面你想要的功能投一票，或直接写下想法——每一条都会被认真看到。</p></div>' +
      '<div class="fb-sec">想要的功能 <span class="fb-sec-sub">可多选，帮它们插队</span></div>' +
      '<div class="wish-grid">' + chips + '</div>' +
      '<div class="fb-sec">还想说点别的？</div>' +
      '<textarea id="fbText" class="fb-textarea2" placeholder="功能许愿、问题吐槽、体验建议都行…（例如：希望在手机飞书里也能用）"></textarea>' +
      '<div class="fb-submit-row"><span class="fb-hint2" id="fbHint"></span>' +
        '<button type="button" class="btn-primary fb-submit" id="fbSubmit">提交反馈</button></div>' +
    '</div>';
  var sel = new Set();
  chatContainer.querySelectorAll('.wish-chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var id = c.getAttribute('data-id');
      if (sel.has(id)) { sel.delete(id); c.classList.remove('active'); }
      else { sel.add(id); c.classList.add('active'); }
      var hint = document.getElementById('fbHint'); if (hint) hint.textContent = '';
    });
  });
  document.getElementById('fbSubmit').addEventListener('click', function () {
    var self = this;
    var txt = (document.getElementById('fbText').value || '').trim();
    var picked = FB_WISHES.filter(function (w) { return sel.has(w.id); }).map(function (w) { return w.t; });
    if (!picked.length && !txt) { document.getElementById('fbHint').textContent = '选一个功能或写点内容再提交～'; return; }
    self.disabled = true;
    var content = (picked.length ? '想要：' + picked.join('、') : '') + (txt ? (picked.length ? '\n补充：' : '') + txt : '');
    authFetch('/api/wish', { method: 'POST', body: JSON.stringify({ type: 'wish', content: content }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) { self.disabled = false; if (j && j.ok) showFbThanks(picked.length + (txt ? 1 : 0)); else showToast(j && j.error ? j.error : '提交失败，请稍后再试'); })
      .catch(function () { self.disabled = false; showToast('提交失败，请稍后再试'); });
  });
}
function showFbThanks(n) {
  var page = chatContainer.querySelector('.fb-page');
  if (!page) return;
  page.innerHTML =
    '<div class="fb-thanks">' +
      '<div class="fb-thanks-ring"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg></div>' +
      '<h2>收到，谢谢你 🙌</h2>'.replace(' 🙌', '') +
      '<p>你的' + (n > 1 ? (n + ' 条') : '') + '反馈已记录，会推动我们把它排进计划。</p>' +
      '<button type="button" class="btn-ghost" id="fbAgain">再许一个愿</button>' +
    '</div>';
  var b = document.getElementById('fbAgain'); if (b) b.addEventListener('click', openFeedback);
}

function setupEventListeners() {
  newChatBtn.addEventListener('click', createNewConversation);
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  knowledgeBaseBtn.addEventListener('click', openKb);   // 全部知识库 → 知识库管理
  closeSettings.addEventListener('click', closeSettingsModal);
  settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettingsModal);
  settingsForm.addEventListener('submit', saveSettings);
  var keyEyeBtn = document.getElementById('keyEye');
  if (keyEyeBtn) keyEyeBtn.addEventListener('click', function () {
    var inp = document.getElementById('apiKeyInput');
    if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; keyEyeBtn.innerHTML = inp.type === 'text' ? EYE_OFF_SVG : EYE_SVG; }
  });
  sendBtn.addEventListener('click', function () { askQuestion(); });
  webSearchBtn.addEventListener('click', toggleWebSearch);
  shareBtn.addEventListener('click', shareChat);
  feedbackBtn.addEventListener('click', openFeedback);
  setupPlusMenu();                                       // 输入框"+" → 添加图片/深入研究/帮我写作
  setupKb();
  setupDashboard();
  setupQualityWorkbench();
  // 欢迎页引导（事件委托）：点"感兴趣"的问题直接提问，点能力做对应动作
  chatContainer.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('.wc-chip, .hero-suggest');
    if (!el) return;
    var q = el.getAttribute('data-q');
    if (q) { questionInput.value = q; askQuestion(q); return; }
    var act = el.getAttribute('data-act');
    if (act === 'kb') { openKb(); }
    else if (act === 'web') { if (webSearchBtn && !webSearchBtn.classList.contains('active')) toggleWebSearch(); questionInput.focus(); }
    else { questionInput.focus(); }
  });
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
  text = String(text).replace(/^\s+/, '');   // 去掉开头空行/空白，避免答案与上方"已完成检索"之间留大段空白
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
      continue;   // 段落间空行不再输出 <br>：<p> 自带上下间距，避免多余空白堆叠
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

// 把答案正文里的 [n] 角标替换成可点击上标，跳转到对应参考资料（编号由后端保证与参考列表一致）。
// 只替换是有效编号的 [n]，避免误伤正文里恰好出现的 [1] 之类。
function linkifyCitations(html, references) {
  if (!references || !references.length) return html;
  var byIndex = {};
  references.forEach(function (r, i) { byIndex[r.index || (i + 1)] = r; });
  return html.replace(/\[(\d{1,2})\]/g, function (m, n) {
    var ref = byIndex[parseInt(n, 10)];
    if (!ref) return m;
    return '<sup class="citation" data-title="' + escapeHtml(ref.title || '') + '"' +
      ' data-snippet="' + escapeHtml((ref.snippet || '').slice(0, 240)) + '"' +
      ' data-url="' + escapeHtml(ref.url || '') + '"' +
      ' data-date="' + escapeHtml(ref.editTime || '') + '">' +
      '<a href="' + safeUrl(ref.url) + '" target="_blank" rel="noopener noreferrer">' + n + '</a></sup>';
  });
}

// 兼容历史会话：旧数据里也可能存有超过参考数量的角标。重载时使用与服务端相同的
// fail-closed 规则，避免修复后旧会话仍展示空引用。
function sanitizeAnswerCitationText(answer, referenceCount) {
  var max = Math.max(0, Number(referenceCount) || 0);
  return String(answer || '').split(/(?<=[。！？!?])|(\n+)/).map(function (part) {
    if (!part) return '';
    var nums = [];
    part.replace(/\[(\d+)\]/g, function (_all, n) { nums.push(Number(n)); return _all; });
    if (!nums.length) return part;
    var invalid = nums.some(function (n) { return n < 1 || n > max; });
    if (!invalid) return part;
    var valid = nums.some(function (n) { return n >= 1 && n <= max; });
    if (!valid) return /^\s+$/.test(part) ? part : '';
    return part.replace(/\[(\d+)\]/g, function (all, n) {
      n = Number(n);
      return n >= 1 && n <= max ? all : '';
    });
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
}

// 引用悬浮预览：hover 正文 [n] 角标 → 弹出该来源的标题 + 原文片段 + 新鲜度 + 打开原文
function setupCitationPreview() {
  var pop = document.createElement('div');
  pop.className = 'cite-pop';
  pop.hidden = true;
  document.body.appendChild(pop);
  var hideT = null;
  var show = function (sup) {
    clearTimeout(hideT);
    var title = sup.getAttribute('data-title') || '';
    var snip = sup.getAttribute('data-snippet') || '';
    var url = sup.getAttribute('data-url') || '';
    var fr = relFresh(sup.getAttribute('data-date') || '');
    pop.innerHTML =
      '<div class="cite-pop-t">' + escapeHtml(title) + '</div>' +
      (snip ? '<div class="cite-pop-s">' + escapeHtml(snip) + (snip.length >= 240 ? '…' : '') + '</div>'
            : '<div class="cite-pop-s cite-pop-empty">（该来源无可预览片段）</div>') +
      '<div class="cite-pop-f"><span>' + (fr ? fr.label + (fr.stale ? ' · 可能过期' : '') : '') + '</span>' +
      (url ? '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">打开原文 ›</a>' : '') + '</div>';
    pop.hidden = false;
    var r = sup.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    var top = r.top - ph - 10;
    if (top < 8) top = r.bottom + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };
  var scheduleHide = function () { hideT = setTimeout(function () { pop.hidden = true; }, 140); };
  chatContainer.addEventListener('mouseover', function (e) {
    var sup = e.target.closest && e.target.closest('.citation');
    if (sup) show(sup);
  });
  chatContainer.addEventListener('mouseout', function (e) {
    var sup = e.target.closest && e.target.closest('.citation');
    if (sup) scheduleHide();
  });
  pop.addEventListener('mouseenter', function () { clearTimeout(hideT); });
  pop.addEventListener('mouseleave', function () { pop.hidden = true; });
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
