'use strict';

/**
 * server/rag.js — 流式 RAG 编排（Task 6）
 *
 * 导出：
 *   async function* runRAGStream(user, question, history, webSearch, config)
 *
 * 依赖：
 *   feishu.searchDocs(userAccessToken, query, pageSize) → [{index,title,type,token,url,owner,editTime}]
 *   feishu.fetchDoc(userAccessToken, item) → {title, content}
 *   llm.askLLMStream(question, docs, history, provider) → async generator yielding string deltas
 *   llm.askLLMGeneral(question, history, provider, webSearch) → async generator yielding string deltas
 *   providers.resolveProvider(config) → {id,name,model,baseUrl,apiKey}
 *
 * 安全约束：只用 user.userAccessToken，不使用 app/tenant token。
 * 不 log token 或 apiKey。
 */

const { searchDocs, fetchDoc, enrichReferences, parseFeishuDocUrls, findAnchorBlock, searchMessages } = require('./feishu');
const { askLLMStream, askLLMGeneral, planSearchQuery, classifyNeedsDoc, clarifyQuestion, detectConflict, condenseQuery, expandQueries, judgeRelevance, verifyRelevance } = require('./llm');

// 身份/作者类问题（你是谁 / 谁开发的 / 作者是谁 / 开发你的是谁…）→ 固定介绍 + 引导关注公众号。
// 只锚定"自我指涉"，避免误伤"澳洲迁移谁做的"这类真实文档问题。
const IDENTITY_RE = /(你是谁|你是誰|你叫(什么|啥)|你是(什么|啥)(助手|东西|应用|产品|模型|机器人|ai)|(你|你的)(作者|开发者|开发团队|制作者|创造者)|作者是谁|谁是(你的)?作者|谁(开发|研发|创造|创建|制作|做)(了|的)?你|(开发|研发|制作|创造)你的|你(是谁|由谁|是由谁)(开发|研发|做|制作|创造)|你(背后|属于).{0,5}(团队|公司)|who\s+(are|made|created|developed|built)\s+you)/i;

/**
 * 多查询召回 + round-robin 并集：原关键词 + 若干扩展查询各搜一次，然后**轮流取各查询的
 * 第1、第2…名**去重合并。这样"某个查询能把右文档排第1"就一定会被纳入候选池，
 * 不会被其它查询的旁支文档稀释（这正是 naive RRF 累加排序的坑）。精度交给后面的向量+法官。
 */
async function multiSearch(userAccessToken, queries, pageSize) {
  const uniq = [...new Set(queries.filter(Boolean))];
  const settled = await Promise.allSettled(uniq.map(q => searchDocs(userAccessToken, q, pageSize)));
  const lists = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  if (!lists.length) {                                  // 全部查询都失败 → 抛错（如 token 过期），别静默成"未找到"
    const rej = settled.find(s => s.status === 'rejected');
    throw new Error((rej && rej.reason && rej.reason.message) || 'feishu search failed');
  }
  // 多查询越多，固定截成 15 条越容易只保住每路前 2~3 名，时间更新但标题不完全匹配的周报会抖动消失。
  // 搜索请求本来已并行；这里只扩大廉价候选并集，正文读取仍由 readPool 严格控量。
  return mergeRoundRobin(lists, Math.max(pageSize * 2, 24));
}

function mergeRoundRobin(lists, limit, key = 'token') {
  const seen = new Set();
  const out = [];
  const maxLen = Math.max(0, ...lists.map(l => l.length));
  for (let rank = 0; rank < maxLen; rank++) {          // 轮流取每个查询的第 rank 名
    for (const list of lists) {
      const r = list[rank];
      const id = r && r[key];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
  }
  return out.slice(0, limit).map((r, i) => ({ ...r, index: i + 1 }));
}

// 同一个局部问答窗口可能同时命中“问题”和“回答”，甚至被关键词/原问题两路各命中一次。
// 若上下文消息 ID 有交集，只保留召回顺序更靠前的一条，避免同一段聊天重复占用 topK 和引用列表。
function dedupeMessageWindows(items) {
  const kept = [];
  for (const item of items) {
    const ids = new Set((item.contextMessageIds || [item.token]).filter(Boolean));
    const overlaps = kept.some(old => {
      if (!item.chatId || item.chatId !== old.chatId) return false;
      return (old.contextMessageIds || [old.token]).some(id => ids.has(id));
    });
    if (!overlaps) kept.push(item);
  }
  return kept;
}

function itemRecency(item) {
  const title = String((item && item.title) || '');
  const m = title.match(/(20\d{2})[年/_-](\d{1,2})[月/_-](\d{1,2})日?/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const raw = item && (item.editTime || item.updatedAt || item.createdAt);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(raw || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// 状态/进度类问答既要搜索相关度，也要资料新鲜度。保留约 2/3 原始相关序，余量补最新资料，再回填。
function selectRemoteReadables(items, budget) {
  if (items.length <= budget) return items;
  const baseCount = Math.max(1, budget - Math.min(4, Math.floor(budget / 3)));
  const out = items.slice(0, baseCount);
  const seen = new Set(out.map(x => x.token));
  const recent = items.slice().sort((a, b) => itemRecency(b) - itemRecency(a));
  for (const item of [...recent, ...items]) {
    if (out.length >= budget) break;
    if (!item.token || seen.has(item.token)) continue;
    seen.add(item.token); out.push(item);
  }
  return out;
}

function toRelatedEvidence(d) {
  return {
    token: d.token,
    title: d.title || '相关资料',
    source: d.source || d.type || '',
    url: d.url || '',
    score: d._score != null ? Number(d._score.toFixed(3)) : null,
    judgeScore: d._judgeScore || null,
    evidenceRank: d._judgeRank != null ? d._judgeRank : null,
    snippet: String(d._anchorText || d.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    reason: d._evidenceReason || 'not_selected',
  };
}

// 同一个 LLM 在不同候选批次里可能把“某份材料没提到 X”误当成“X 整体没有”的强证据。
// 对“是否还有/进展如何”类状态问题做一层可解释的范围校准：局部材料缺失降权，明确状态更新升权。
// 只在法官已判相关的同档排序中使用，不绕过 judgeMin，也不按聊天/文档来源硬编码优先级。
function calibrateEvidenceRank(question, doc, rank) {
  let value = rank == null ? null : Number(rank);
  const q = String(question || '');
  // 聊天证据的实体常在命中问句、状态在后续回复；检查限定窗口全文，避免拆散问答。
  const text = `${doc._anchorText || ''} ${doc.content || ''}`.replace(/\s+/g, ' ');
  if (!/(最新|最近|目前|当前|现在|正在|还在|在做|做的|还有|是否|有没有|有无|进展|情况|状态|何时|什么时候)/.test(q)) return { value, reason: '' };
  const localAbsence = /(这份|该份|某份|昨天的|本次|当前这份|需求说明|说明书|文档|会议纪要).{0,18}(不涉及|未涉及|没涉及|没有提到|未提到|不包含|未包含)/.test(text);
  if (localAbsence) return { value: value == null ? 35 : Math.min(value, 35), reason: '局部材料缺失≠整体状态' };
  const directState = /(已经|已|正在|目前|暂时|计划|预计).{0,16}(启动|开发|排期|上线|完成|暂停|停止|取消|需求)|(?:需求|项目|任务|版本|二期|第二期).{0,16}(已经|已|正在|启动|开发|排期|上线|完成|暂停|停止|取消|计划|预计)/.test(text);
  if (directState) {
    let floor = 80;
    const titleDate = String(doc.title || '').match(/(20\d{2})[年/_-](\d{1,2})[月/_-](\d{1,2})日?/);
    if (titleDate) {
      const at = Date.UTC(Number(titleDate[1]), Number(titleDate[2]) - 1, Number(titleDate[3]));
      const now = new Date();
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const ageDays = Math.floor((today - at) / 86400000);
      if (ageDays >= 0 && ageDays <= 14) floor = 92;
      else if (ageDays >= 0 && ageDays <= 30) floor = 86;
    }
    return { value: value == null ? floor : Math.max(value, floor), reason: floor > 80 ? '包含明确且较新的状态更新' : '包含明确状态更新' };
  }
  return { value, reason: '' };
}

// 对“某项目还有需求吗/进展如何”这类状态题，原文若同时命中项目实体和明确状态动词，
// 就属于可直接核验的结构化事实。法官偶发把它从 2 判成 1 时做一次确定性保护；0 分仍不提升，
// 避免把完全无关材料硬抬进来。该规则只使用证据原文，不猜测、不调用额外模型。
function protectDirectStateEvidence(question, doc, score, rank) {
  const q = String(question || '');
  const text = `${doc._anchorText || ''} ${doc.content || ''}`.replace(/\s+/g, ' ');
  if (!/(最新|最近|目前|当前|现在|正在|还在|在做|做的|还有|是否|有没有|有无|进展|情况|状态|何时|什么时候)/.test(q)) return { score, rank, reason: '' };
  const topic = q.replace(/(最新|最近|目前|当前|现在|正在|还在|在做的|在做|做的|还有|是否|有没有|有无|需求|进展|情况|状态|何时|什么时候|有吗|吗|呢|的|[？?，。\s])/g, '');
  if (topic.length < 2 || !text.includes(topic)) return { score, rank, reason: '' };
  // “不过是另一个项目”这类后文纠正不能被前半句的高相关词误保护。
  if (/(?:不过|但是|但).{0,12}(?:不是|是)/.test(text)) return { score, rank, reason: '' };
  const direct = /(?:需求|prd).{0,20}(?:已经|已|正在|启动|开发|排期|评审|计划|预计|筹备|跟进|暂停|停止|取消|终止|延期)|(?:已经|已|正在|下周|计划|预计).{0,20}(?:需求|prd|开发|评审)/i.test(text);
  if (!direct || Number(score) !== 1) return { score, rank, reason: '' };
  return { score: 2, rank: Math.max(Number(rank) || 0, 80), reason: '原文含明确项目状态' };
}

function shouldClarifyQuestion(question) {
  const q = String(question || '').replace(/[？?！!，。\s]/g, '');
  return q.length <= 8 && /^(有问题吗|进度呢|怎么样|怎么办|这个|那个|它呢|他呢|还有吗|现在呢)$/.test(q);
}

// 模型偶发输出超过参考列表范围的 [n]。不能把空角标交给用户，也不能把无来源事实
// 留在正文里：若一个句子只有越界引用，整句移除；若同时含有效引用，只移除越界角标。
function sanitizeAnswerCitations(answer, referenceCount) {
  const max = Math.max(0, Number(referenceCount) || 0);
  return String(answer || '')
    .split(/(?<=[。！？!?])|(\n+)/)
    .map(part => {
      if (!part) return '';
      const citations = [...part.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
      if (!citations.length) return part;
      const hasInvalid = citations.some(n => n < 1 || n > max);
      if (!hasInvalid) return part;
      const hasValid = citations.some(n => n >= 1 && n <= max);
      if (!hasValid) return /^\s+$/.test(part) ? part : '';
      return part.replace(/\[(\d+)\]/g, (all, raw) => {
        const n = Number(raw);
        return n >= 1 && n <= max ? all : '';
      });
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const { resolveProvider, resolveEmbed } = require('./providers');
const { searchKbHybrid } = require('./kb');
const { tenantIdOf, orgStoreKey } = require('./organization');
const { rankDocs } = require('./semantic');
const { selectEvidence } = require('./evidence');
const { discoverCorpusQueries, applyCorpusCorrection, deriveStatusCoreQuery } = require('./query-planner');

/**
 * RAG 流式编排生成器。
 *
 * yield 事件类型：
 *   { type: 'references', references: [...] }  — 参考资料列表（尽早 yield）
 *   { type: 'token', delta: '...' }             — 正文 delta（多次）
 *   { type: 'sources', sources: [{title,url}] } — 结尾
 *
 * @param {{ openId, userAccessToken }} user
 * @param {string} question
 * @param {Array}  history   — [{role,content}]
 * @param {boolean} webSearch
 * @param {object}  config   — { pageSize, topK, providerId, custom, ... }
 */
async function* runRAGStream(user, question, history = [], webSearch = false, config = {}) {
  const userAccessToken = user.userAccessToken;
  const pageSize = config.pageSize || 10;   // 召回数量（界面可调）
  const topK     = config.topK     || 3;
  const evidenceMin = config.evidenceMin != null ? config.evidenceMin : Math.min(2, topK);
  const evidenceMax = config.evidenceMax != null ? config.evidenceMax : topK;
  const readPool = config.readPool || 6;    // 读取候选数（界面可调）
  const minScore = config.minScore != null ? config.minScore : 0.35;  // 相关度阈值（界面可调）
  const judgeMin = config.judgeMin != null ? config.judgeMin : 2;      // 法官入选阈值（界面可调）
  const provider = resolveProvider(config);
  const _t0 = Date.now();
  const T = process.env.RAG_TIMING ? (l) => console.error('[rag]', (Date.now() - _t0) + 'ms', l) : () => {};

  // 身份/作者类问题 → 固定介绍 + 引导关注公众号（不走检索、不需 key）
  if (IDENTITY_RE.test(question)) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '我是「弧光团队」打造的飞书知识问答助手——专门帮你从飞书文档、知识库、聊天记录里检索**带来源、可溯源**的答案，尽量不编造。\n\n想了解更多进展、或与作者交流，欢迎关注下方的公众号「弧光团队」。' };
    yield { type: 'about' };
    return;
  }

  // 没填 API Key 就直接提示，不做无谓检索（每人必须填自己的 key）
  if (!provider.apiKey) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '⚠️ 还没设置 API Key。点右上角头像旁的「设置」，选模型厂商并填入你自己的 API Key（仅本次登录有效）。' };
    return;
  }

  // 知识库问答（联网与否都走同一套：搜索→读→重排→法官→只留相关文档做参考；
  // webSearch=true 时额外给 LLM 开 web_search 工具。不再有"联网就把原始搜索结果全塞成参考"的旧分支）。
  // Step 0: 若消息里粘了飞书文档链接，直接定位这几篇（"帮我总结这篇文档"场景）
  const urlItems = parseFeishuDocUrls(question);
  // 多轮追问：把含指代/省略的追问改写成"脱离上下文也能独立检索"的问题（仅检索用；展示/生成仍用原话）
  let retrievalQ = question;
  if (history && history.length && !urlItems.length) {
    try { retrievalQ = await condenseQuery(question, history, provider); } catch (_e) { retrievalQ = question; }
  }
  const cleanQ = retrievalQ.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();

  // 澄清反问：仅对"首轮、较短、可能太笼统"的问题触发（省 token、避免打扰）。太含糊 → 反问补全，不硬检索。
  if (!urlItems.length && (!history || !history.length) && shouldClarifyQuestion(question)) {
    let clarify = '';
    try { clarify = await clarifyQuestion(question, provider); } catch (_e) { clarify = ''; }
    if (clarify) {
      yield { type: 'references', references: [] };
      yield { type: 'token', delta: clarify };
      return;
    }
  }

  // Step 1: 搜索（立刻给"搜索中"反馈）
  yield { type: 'status', text: urlItems.length ? '正在打开你发的文档…' : '正在搜索知识库…' };

  let searchResults = [];
  let kbResults = [];
  let msgResults = [];
  let searchErr = null;
  let keywords = '';   // 供搜索 + 后续深链定位块用
  let queryPlan = { keywords: cleanQ, correctedQuestion: '', expansions: [], confidence: 0 };
  // 粘了文档链接就只总结那篇（不再关键词搜索，避免搜出一堆不相干的）
  T('after condenseQuery (history=' + (history && history.length || 0) + ')');
  if (!urlItems.length) {
    try { queryPlan = await planSearchQuery(retrievalQ, provider); } catch (_e) { /* 使用原问题兜底 */ }
    keywords = queryPlan.keywords || retrievalQ;
    T('after planSearchQuery');
    // 双路召回（默认开启）：用「LLM关键词」+「清洗后的原问题」各搜一次，round-robin 并集。
    // 原因：关键词提取会犯错——如"做策略需要考虑的因素有哪些"被抽成"策略 制定"(丢了"因素"、
    // 还凭空加了"制定")，导致真正含该问答的《电力交易常用Q&A》0 召回；而用原问题该文档排第 1。
    // 关键词负责聚焦、原问题负责兜底，谁都不会独自漏召；精度仍交给后面的向量+法官。
    // config.multiQuery=true 时再叠加 LLM 同义扩展（默认不开，实测同义扩展在飞书语料上噪音大）。
    // 三路检索并行：飞书文档 / 本地知识库 / 会话记录，彼此无依赖，一起发起省掉串行往返。
    const statusCoreQuery = deriveStatusCoreQuery(cleanQ, keywords);
    if (statusCoreQuery) queryPlan = { ...queryPlan, statusCoreQuery };
    const docsP = (async () => {
      if (!keywords) return [];
      let queries = [keywords, statusCoreQuery, cleanQ, queryPlan.correctedQuestion, ...(queryPlan.expansions || [])];
      if (config.multiQuery) {
        try { const ex = await expandQueries(question, provider, 3); if (ex.length) queries.push(...ex); } catch (_e) { /* 扩展失败 */ }
      }
      queries = [...new Set(queries.filter(Boolean))].slice(0, 6);
      return queries.length > 1 ? multiSearch(userAccessToken, queries, pageSize) : searchDocs(userAccessToken, keywords, pageSize);
    })().catch(err => { searchErr = err; return []; });
    // 本地知识库（用户上传的补充文档）：hybrid 检索（BM25 + 向量 RRF）。用完整问题效果更好。
    // 用 async IIFE 包一层：即使依赖同步抛错（如测试未 mock）也转成可被 .catch 兜住的 rejection。
    const kbP = (async () => {
      const q = cleanQ || question;
      const embedConfig = resolveEmbed(config);
      const [personal, organization] = await Promise.all([
        searchKbHybrid(user.openId, q, embedConfig, { topDocs: 5, scope: 'personal' }).catch(() => []),
        searchKbHybrid(orgStoreKey(tenantIdOf(user)), q, embedConfig, { topDocs: 5, scope: 'organization' }).catch(() => []),
      ]);
      // 两个权限域独立检索后合并，后续仍经过同一内容读取、法官和证据选择链路。
      return [...personal, ...organization];
    })().catch(() => []);
    // 飞书会话/聊天记录检索（默认开启，可 config.chatSearch=false 关闭）。失败静默降级。
    const msgP = (async () => {
      if (config.chatSearch === false || !keywords) return [];
      const chatSize = config.chatSize || 6;
      // 消息搜索也用“关键词 + 原问题”双路召回：关键词覆盖同义表达，原问题保住一问一答里的原始问句。
      // 两路并行后 round-robin 去重，避免任一路偶发排序波动把另一条路的首名挤掉。
      const msgQueries = [...new Set([keywords, statusCoreQuery, cleanQ, queryPlan.correctedQuestion, ...(queryPlan.expansions || [])].filter(Boolean))].slice(0, 6);
      const lists = await Promise.all(msgQueries.map(q => searchMessages(userAccessToken, q, chatSize, {
        after: config.chatAfter,
        before: config.chatBefore,
        maxGapMs: config.chatMaxGapMs,
      }).catch(() => [])));
      // chatSize 是每条搜索的返回量；多查询并集不能再截回 chatSize，否则新增的别名查询会互相挤掉
      // 各自的高质量候选。上限仍为 2×chatSize，控制后续向量/法官成本。
      return dedupeMessageWindows(mergeRoundRobin(lists, chatSize * 2)).slice(0, chatSize * 2);
    })().catch(() => []);
    [searchResults, kbResults, msgResults] = await Promise.all([docsP, kbP, msgP]);
    // 模型低置信时，用用户本次真实可见的标题/聊天发现近似实体，再补一次文档查询。
    // 这是语料驱动纠错，不维护项目专名表；原查询始终保留，补查失败也不影响首轮结果。
    const corpusQueries = discoverCorpusQueries(queryPlan, cleanQ, [...msgResults, ...searchResults], 3);
    if (corpusQueries.length) {
      try {
        const refinedQueries = [...new Set([
          ...corpusQueries,
          queryPlan.keywords,
          queryPlan.correctedQuestion,
          ...(queryPlan.expansions || []),
        ].filter(Boolean))].slice(0, 6);
        const [extraDocs, extraMessageLists] = await Promise.all([
          multiSearch(userAccessToken, refinedQueries, Math.max(pageSize, 20)),
          Promise.all(refinedQueries.map(q => searchMessages(userAccessToken, q, config.chatSize || 6, {
            after: config.chatAfter, before: config.chatBefore, maxGapMs: config.chatMaxGapMs,
          }).catch(() => []))),
        ]);
        searchResults = mergeRoundRobin([searchResults, extraDocs], Math.max(pageSize * 3, 40));
        msgResults = dedupeMessageWindows(mergeRoundRobin([msgResults, ...extraMessageLists], Math.max((config.chatSize || 6) * 2, 12))).slice(0, Math.max((config.chatSize || 6) * 2, 12));
        queryPlan = { ...queryPlan, corpusExpansions: corpusQueries };
      } catch (_e) { /* 首轮召回仍可继续 */ }
    }
    T('after searches (parallel: docs ' + searchResults.length + ' / kb ' + kbResults.length + ' / msg ' + msgResults.length + ')');

    if (searchErr && !kbResults.length && !msgResults.length) {
      yield { type: 'references', references: [] };
      yield { type: 'token', delta: '搜索文档失败：' + (searchErr.message || String(searchErr)) };
      return;
    }
  }

  // 合并：链接文档最前（用户明确指定）→ 本地知识库 → 飞书搜索，按 token 去重
  const seen = new Set();
  const results = [];
  for (const r of [...urlItems, ...kbResults, ...msgResults, ...searchResults]) {
    if (!r.token || seen.has(r.token)) continue;
    seen.add(r.token);
    results.push(r);
  }
  if (results.length === 0) {
    yield { type: 'references', references: [] };
    // 一条都没召回：常识/通用问题(今天周几、天气、问候、算术…)直接答、不弹兜底；
    // 只有"需要公司内部资料却没找到"才发 noresult → 引导关注公众号。
    let needsDoc = true;
    try { needsDoc = await classifyNeedsDoc(cleanQ || question, provider); } catch (_e) { needsDoc = true; }
    if (needsDoc) yield { type: 'noresult' };
    try {
      for await (const chunk of askLLMGeneral(question, history, provider, webSearch)) {
        if (chunk.type === 'reasoning') yield { type: 'reasoning', delta: chunk.text };
        else yield { type: 'token', delta: chunk.text };
      }
    } catch (_e) {
      yield { type: 'token', delta: '未找到相关文档。' };
    }
    return;
  }

  // Step 2: 读取正文（给"阅读中"反馈）。readPool 只限制需要额外调用飞书读取正文的远程文档；
  // 本地 KB 和会话候选在召回时已经带正文，必须全部进入精排。否则 6 条聊天会占满默认 readPool，
  // 造成文档候选尚未打分就被来源顺序静默淘汰，反之亦然。
  yield { type: 'status', text: '正在阅读相关文档…' };
  const READABLE = new Set(['docx', 'wiki', 'doc']);
  const preloaded = results.filter(r => r.content || r.source === 'kb' || r.source === 'message');
  const remoteReadable = results.filter(r => !preloaded.includes(r) && READABLE.has(r.type));
  const remoteBudget = Math.max(readPool, urlItems.length);
  const topItems = [...preloaded, ...selectRemoteReadables(remoteReadable, remoteBudget)];
  let docs = await Promise.all(
    topItems.map(item => {
      // 本地知识库文档已带正文，无需再拉取
      if (item.source === 'kb' || item.content) {
        return Promise.resolve({ ...item, content: item.content || '' });
      }
      return fetchDoc(userAccessToken, item)
        .then(d => ({ ...item, title: d.title || item.title, content: d.content || '', docId: d.docId || '' }))
        .catch(() => ({ ...item, content: '' }));
    })
  );
  // 标题只能发现正式实体；正文常同时出现正式名与内部简称。低置信时从已授权正文中发现
  // 一字差的规范词形，形成有语料证据的纠错，再补搜聊天，解决“命中问句但答案在后续回复”。
  if (!queryPlan.correctedQuestion && config.chatSearch !== false) {
    const contentQueries = discoverCorpusQueries(
      queryPlan,
      cleanQ,
      docs.filter(d => d.content).map(d => ({ text: `${d.title || ''} ${d.content || ''}` })),
      4
    );
    const corpusCorrection = applyCorpusCorrection(retrievalQ, queryPlan, [...contentQueries, ...(queryPlan.corpusExpansions || [])]);
    if (corpusCorrection) {
      try {
        const correctedKeywords = applyCorpusCorrection(queryPlan.keywords, queryPlan, [...contentQueries, ...(queryPlan.corpusExpansions || [])]);
        const correctionQueries = [...new Set([corpusCorrection, correctedKeywords, ...contentQueries].filter(Boolean))].slice(0, 6);
        const lists = await Promise.all(correctionQueries.map(q => searchMessages(userAccessToken, q, config.chatSize || 6, {
          after: config.chatAfter, before: config.chatBefore, maxGapMs: config.chatMaxGapMs,
        }).catch(() => [])));
        const existing = new Set(docs.map(d => d.token));
        const extraMessages = dedupeMessageWindows(mergeRoundRobin(lists, Math.max((config.chatSize || 6) * 2, 12)))
          .filter(x => !existing.has(x.token));
        docs = [...docs, ...extraMessages];
        queryPlan = { ...queryPlan, corpusCorrection, contentExpansions: contentQueries };
      } catch (_e) { /* 正文纠错补查失败时保留已有候选 */ }
    }
  }
  T('after fetchDoc (read ' + docs.length + ')');

  // 语义重排（P1 检索准确率地基）：把读到的正文切块，按与问题的相似度只保留最相关段落
  // 喂给 LLM（少噪音、更准；向量法命中字面不匹配但语义相关的内容）。
  // 「总结这篇文档」(urlItems) 场景要看全文，不重排。向量失败自动降级词法。
  let llmDocs = docs.filter(d => d.content);
  let judgeInfo = null;   // 调试用：LLM 法官打分
  let ragDebug = null;
  let confidence = null;  // 置信度：high=有判3的高置信档 / medium=只有压线2分档；带佐证篇数
  if (!urlItems.length && llmDocs.length) {
    yield { type: 'status', text: '正在精排相关内容…' };
    let ranked = null;
    try {
      // 第一层：向量把候选切块、按语义排序（负责"排序 + 取每篇最相关段落"）
      const embedConfig = resolveEmbed(config);
      // 向量排序：topChunks 取足够大(覆盖每篇候选)，保证每篇都能拿到"它与问题最相关的块"。
      // 向量与法官统一使用经语料验证的查询词形，避免简称或错别字导致分数漂移。
      // 展示与最终回答仍保留用户原始问题。
      const scoringQ = queryPlan.correctedQuestion || queryPlan.corpusCorrection || cleanQ || question;
      ranked = await rankDocs(scoringQ, llmDocs, {
        embedConfig,
        topChunks: Math.max(24, topItems.length * 2),
        vectorFloor: minScore,
        // 第一层只做宽松粗筛，最终精度由来源感知的法官控制；相对最高分比例会让某个超高分候选
        // 抬高全局门槛，导致另一来源中本来已过绝对阈值的有效证据被误杀。
        keepRatio: config.keepRatio != null ? config.keepRatio : 0,
      });
      T('after rankDocs (embed)');
      // ranked.docs=[] 表示所有段落都没过粗筛，必须尊重这个结论；回退到 llmDocs 会绕过 minScore，
      // 让本应被向量阈值淘汰的原始召回全部重新进入法官。
      const candDocs = Array.isArray(ranked.docs) ? ranked.docs : [];

      // 第二层：LLM 相关性法官（reranker）——**每篇候选取"与问题最相关的那个块"(_anchorText)** 交给法官判(0~3)。
      // doc级判定保证"每篇候选都被判到"，不会因候选变多而被别篇的块挤出判定集（这是块级全局Top-N的坑）。
      // 配合"一问一答独立成块"，每篇的最佳块就是它最相关的内容，法官判得准。
      yield { type: 'status', text: '正在甄别相关性…' };
      const toJudgeItem = d => ({
        text: d._anchorText || d.content,
        source: d.source,
        matchText: d.matchText,
        afterTexts: d.afterTexts,
      });
      const judgeItems = candDocs.map(toJudgeItem);
      const scores = await judgeRelevance(scoringQ, judgeItems, provider);
      const fineRanks = scores.ranks || [];
      T('after judgeRelevance (LLM)');
      const scored = candDocs.map((d, i) => {
        const calibrated = calibrateEvidenceRank(scoringQ, d, fineRanks[i]);
        const protectedState = protectDirectStateEvidence(scoringQ, d, scores[i], calibrated.value);
        return {
          d, score: protectedState.score, orig: scores[i], rank: protectedState.rank,
          rawRank: fineRanks[i],
          calibration: [calibrated.reason, protectedState.reason].filter(Boolean).join('；'),
        };
      });
      // 实验性对抗复核（默认关）：只对"刚好压线(score==judgeMin，通常是2)"的边界档，再用一个怀疑者严判一遍——
      // 扛不住的降到阈值下丢掉。法官判 3 的高置信档直接信任、不复核（省一次调用）。这是把"沾边但没真答上"
      // 现有弱金标中它降低召回且增加尾延迟，仅在 config.adversarial=true 时用于 A/B。
      if (config.adversarial === true) {
        const borderline = scored.filter(x => x.score === judgeMin);
        if (borderline.length) {
          try {
            const verdicts = await verifyRelevance(scoringQ, borderline.map(x => toJudgeItem(x.d)), provider);
            borderline.forEach((x, i) => { if (verdicts[i] === false) { x.score = judgeMin - 1; x.rechecked = true; } });
            T('after verifyRelevance (LLM)');
          } catch (_e) { /* 复核失败不影响主流程 */ }
        }
      }
      // 只留（复核后）≥阈值的。全部低分 → 留空（不硬塞，答案用通用知识兜底）。
      const kept = scored
        .filter(x => x.score >= judgeMin)
        .sort((a, b) => b.score - a.score || (b.rank == null ? -1 : b.rank) - (a.rank == null ? -1 : a.rank) || (b.d._score || 0) - (a.d._score || 0) || String(a.d.token || '').localeCompare(String(b.d.token || '')));
      llmDocs = kept.map(x => Object.assign(x.d, {
        _judgeScore: x.score,
        _judgeRank: x.rank,
        _judgeRawRank: x.rawRank,
        _judgeCalibration: x.calibration,
        _judgeOriginal: x.orig,
        _judgeRechecked: !!x.rechecked,
      }));
      // 置信度：判官对入选档最高分——3=高置信(判官很确定)，2=中(压线通过)。带佐证篇数。
      if (kept.length) {
        const maxS = Math.max.apply(null, kept.map(x => x.score));
        confidence = { level: maxS >= 3 ? 'high' : 'medium', sources: kept.length };
      }

      judgeInfo = scored.map(x => ({
        title: x.d.title || '',
        source: x.d.source || x.d.type || '',
        vscore: x.d._score != null ? Number(x.d._score.toFixed(3)) : null,
        jscore: x.orig,                    // 展示法官原始分
        rank: x.rank != null ? x.rank : null,
        rawRank: x.rawRank != null ? x.rawRank : null,
        calibration: x.calibration || '',
        kept: x.score >= judgeMin,         // 是否最终入选（含复核）
        recheck: x.rechecked ? '复核未过' : '',
        token: x.d.token || '',
        url: x.d.url || '',
        passage: String(x.d._anchorText || x.d.content || '').replace(/\s+/g, ' ').slice(0, 360),
      }));
      const judgedTokens = new Set(judgeInfo.map(x => x.token));
      for (const x of (ranked.debug || [])) {
        if (judgedTokens.has(x.token)) continue;
        judgeInfo.push({
          title: x.title || '', source: x.source || '', token: x.token || '', url: x.url || '',
          vscore: x.score, jscore: null, kept: false, selected: false,
          recheck: x.kept ? '法官未执行' : '未过语义门槛', passage: x.passage || '',
        });
      }
      ragDebug = { method: ranked.method, threshold: minScore, recalled: results.length, read: docs.length, eligible: llmDocs.length, queryPlan, candidates: judgeInfo };
    } catch (e) {
      // **fail-closed**：精排/法官失败也绝不"把召回的全部原样展示"（那正是反复出现无关文档的隐患）。
      // 退化为"向量/词法排序过阈值"的结果（ranked.docs，已过 vectorFloor），都拿不到就留空、不硬塞。
      const hasDeterministicSignal = ranked && (ranked.method === 'vector' || (ranked.chunks && ranked.chunks.length));
      llmDocs = (hasDeterministicSignal && ranked.docs && ranked.docs.length) ? ranked.docs.slice(0, 5) : [];
      ragDebug = {
        method: ranked ? ranked.method : 'none',
        threshold: minScore,
        recalled: results.length,
        read: docs.length,
        selected: llmDocs.length,
        degraded: true,
        reason: String((e && e.message) || 'rerank failed').slice(0, 120),
        queryPlan,
        candidates: (ranked && ranked.debug) || [],
      };
    }
  }

  // “通过相关性闸门”不等于“全部塞给生成模型”。最终证据集按同档分数断层自适应选取；
  // 其余通过项作为“更多相关结果”完整保留，既不丢证据，也不污染回答上下文。
  let relatedDocs = [];
  let evidenceMeta = null;
  let refDocs;
  if (!urlItems.length && config.adaptiveEvidence !== false) {
    const picked = selectEvidence(llmDocs, {
      min: evidenceMin,
      max: evidenceMax,
      scoreGap: config.evidenceScoreGap != null ? config.evidenceScoreGap : 0.15,
    });
    refDocs = picked.selected;
    relatedDocs = picked.related;
    evidenceMeta = picked.cutoff;
  } else {
    refDocs = llmDocs.slice(0, Math.max(1, topK));
    relatedDocs = llmDocs.slice(refDocs.length);
  }
  if (ragDebug) {
    const selectedTokens = new Set(refDocs.map(d => d.token));
    ragDebug.selected = refDocs.length;
    ragDebug.related = relatedDocs.length;
    ragDebug.evidence = evidenceMeta;
    (ragDebug.candidates || []).forEach(c => { c.selected = selectedTokens.has(c.token); });
    yield { type: 'debug', debug: ragDebug };
  }
  // 召回了候选但法官判定一篇都不相关 → 也算"答不了"，触发兜底卡（summary/urlItems 场景除外）。
  if (!urlItems.length && !refDocs.length) yield { type: 'noresult' };

  // 深链定位 + 作者日期富化：都对 refDocs 并行进行，与下面的答案生成重叠，不加延迟。
  const anchorKw = keywords || question;
  // 评测模式跳过深链锚点/富化的飞书调用（评测只看命中，不需要、省配额、更确定）
  const anchorP = config.retrievalOnly ? Promise.resolve(new Map()) :
    Promise.all(refDocs.filter(d => d.docId && d.content && d.url).map(async d => {
      try {
        const blockId = await findAnchorBlock(userAccessToken, d.docId, anchorKw);
        if (!blockId) return null;
        const origin = new URL(d.url).origin;
        return [d.token, `${origin}/docx/${d.docId}#${blockId}`];
      } catch (_e) { return null; }
    })).then(pairs => new Map(pairs.filter(Boolean)));
  const enrichP = config.retrievalOnly ? Promise.resolve(refDocs) :
    enrichReferences(userAccessToken, refDocs).catch(() => refDocs);
  // 与答案生成并行，避免冲突检测成为完成态的串行尾延迟。
  const conflictP = (!config.retrievalOnly && refDocs.length >= 2)
    ? detectConflict(cleanQ || question, refDocs, provider).catch(() => '')
    : Promise.resolve('');

  // Step 3: 流式生成回答（喂重排后的精准段落 llmDocs）。累积正文以便判断实际引用了哪些资料。
  // 评测模式(retrievalOnly)只测检索质量、不生成答案——省下最大头的 token 消耗。
  let answerText = '';
  if (config.retrievalOnly) {
    const [enrichedRefsE, anchorByTokenE] = await Promise.all([enrichP, anchorP]);
    const titleByTokenE = new Map(docs.map(d => [d.token, d.title || (d.content || '').split('\n')[0].trim().slice(0, 60)]));
    const referencesE = enrichedRefsE.map((r, i) => ({
      ...r, index: i + 1,
      title: r.title || titleByTokenE.get(r.token) || '飞书文档',
      url: anchorByTokenE.get(r.token) || r.url,
    }));
    yield { type: 'references', references: referencesE };
    if (relatedDocs.length) yield { type: 'relatedEvidence', evidence: relatedDocs.map(toRelatedEvidence) };
    return;
  }
  try {
    let _first = true;
    // 生成上下文必须与最终展示的 Top K 参考严格一致。否则模型可能引用 [4]/[5]，
    // 但参考区只展示前三条；同时还会把已通过法官、却未进入 Top K 的较弱证据重新带进回答。
    for await (const chunk of askLLMStream(question, refDocs, history, provider, webSearch)) {
      if (_first) { T('FIRST TOKEN'); _first = false; }
      if (chunk.type === 'reasoning') { yield { type: 'reasoning', delta: chunk.text }; }
      else { answerText += chunk.text; yield { type: 'token', delta: chunk.text }; }
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('未配置 LLM API Key')) {
      yield { type: 'token', delta: '⚠️ 未配置 LLM API Key，请在设置中选择模型厂商' };
    } else {
      yield { type: 'token', delta: '⚠️ 生成回答时出错：' + msg };
    }
  }

  // Step 4: 引用驱动的参考资料（grounded citation）——**只列答案真正引用了 [n] 角标的文档**，
  // 向量/词法预选只负责"喂给模型"，最终展示谁由模型的实际引用决定。这样噪音文档不会出现在参考里。
  const titleByToken = new Map(docs.map(d => [d.token, d.title || (d.content || '').split('\n')[0].trim().slice(0, 60)]));
  const [enrichedRefs, anchorByToken] = await Promise.all([enrichP, anchorP]);
  // 参考资料 = **LLM 法官判定为相关(≥2)的文档**（已在 llmDocs/refDocs 里过滤好），
  // 按相关度排序、编号与正文 [n] 角标对应。不再按"是否被引用"来藏——相关就展示，
  // 正文角标只负责把某句话链到具体来源（Perplexity 式：来源列表 ⊇ 行内引用）。
  const references = enrichedRefs.map((r, i) => ({
    ...r,
    index: i + 1,
    title: r.title || titleByToken.get(r.token) || '飞书文档',
    url: anchorByToken.get(r.token) || r.url,
    // 悬浮预览用：该文档里与问题最相关的一小段原文
    snippet: String(r._anchorText || r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  }));
  // 冲突检测：≥2 篇入选来源时，查是否互相矛盾（有则在参考区上方提示，让用户自行甄别）
  const cflt = await conflictP;
  if (cflt) yield { type: 'conflict', text: cflt };
  if (confidence && references.length) yield { type: 'confidence', confidence: { ...confidence, sources: references.length } };
  yield { type: 'references', references };
  const finalAnswerText = sanitizeAnswerCitations(answerText, references.length);
  if (finalAnswerText !== answerText) {
    answerText = finalAnswerText;
    yield { type: 'answerFinal', text: answerText };
  }
  if (relatedDocs.length) yield { type: 'relatedEvidence', evidence: relatedDocs.map(toRelatedEvidence) };
  yield { type: 'sources', sources: references.map(d => ({ title: d.title, url: d.url })) };

  // 【已移除"相关文件"展示】。原意是把飞书召回但读不了正文的文件（PDF/上传Office）列出让用户查阅，
  // 但多维审计证明：读不了正文就无法验证它是否真的切题，仅凭标题相似度会把"同领域不同主题"的文件
  // （如问"实时电价波动"却出"电力现货市场未来技术需求.pdf"）误判为相关——13条误报里 9 条是它。
  // 原则：**只展示能按正文验证相关性的内容**。要支持 PDF，得先能读其正文（下载权限+解析）再走同一套向量+法官闸。
}

module.exports = {
  runRAGStream,
  _internals: { protectDirectStateEvidence, shouldClarifyQuestion, calibrateEvidenceRank, dedupeMessageWindows, selectRemoteReadables, sanitizeAnswerCitations },
};
