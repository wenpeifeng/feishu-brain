'use strict';

// 企业专名不能靠通用模型猜。低置信时，从当前用户实际召回到的标题中发现“只差一个字”的
// 高频写法与正式标题前缀，用作补充查询；不保存固定业务词表，也不替换用户原查询。
function oneEditOrLess(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

function cleanTitle(value) {
  return String(value || '').replace(/[\s_—–-]+/g, ' ').trim();
}

function titleEntityPrefix(title) {
  const text = cleanTitle(title);
  const cut = text.match(/^(.{2,20}?)(?:组周报|周报|项目|平台|技术方案|需求说明|会议纪要|文字记录)(?:\s|$)/);
  return cut ? cut[1].trim() : '';
}

function titleSeriesStem(title) {
  return cleanTitle(title)
    .replace(/(?:20\d{2})[年/.-]\d{1,2}[月/.-]\d{1,2}日?.*$/, '')
    .replace(/[\s_—–-]+$/g, '')
    .trim();
}

function discoverCorpusQueries(plan, originalQuestion, items, limit = 3) {
  if (plan && Number(plan.confidence) >= 0.8 && plan.correctedQuestion) return [];
  const keywords = String((plan && plan.keywords) || originalQuestion || '');
  const tokens = keywords.split(/\s+/).map(x => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(x => x.length >= 2 && x.length <= 8);
  const titles = (items || []).map(x => cleanTitle(x && (x.text || x.title)).slice(0, 5000)).filter(Boolean);
  const counts = new Map();
  const relatedTitles = new Set();
  for (const token of tokens) {
    // “最新需求 / 当前进展 / 计划安排”描述的是查询意图，不是企业实体。
    // 对它们做一字纠错会把“最新需求”改成“有新需求”之类相近短语，造成宽泛补搜。
    if (/(需求|进展|状态|情况|问题|结果|方案|时间|计划|安排|最新|最近|当前|目前|现在)/.test(token)) continue;
    // 原词已经在当前用户有权限的真实语料中出现时，禁止再做一字替换。
    // 真正的错别字（原词在语料中不存在）仍可走下面的近似发现，不依赖业务专名表。
    if (titles.some(title => title.includes(token))) continue;
    for (const title of titles) {
      for (let i = 0; i <= title.length - token.length; i++) {
        const part = title.slice(i, i + token.length);
        if (part === token || !/^[\p{L}\p{N}]+$/u.test(part) || !oneEditOrLess(token, part)) continue;
        counts.set(part, (counts.get(part) || 0) + 1);
        relatedTitles.add(title);
      }
    }
  }
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(x => x[0]);
  for (const title of relatedTitles) {
    const prefix = titleEntityPrefix(title);
    if (prefix && !out.includes(prefix)) out.push(prefix);
    const stem = titleSeriesStem(title);
    // 只有确实去掉了日期的标题才是“系列标题”；普通文档标题不能抢占扩展名额。
    if (stem !== cleanTitle(title) && stem.length >= 3 && stem.length <= 30 && !out.includes(stem)) out.push(stem);
  }
  return out.filter(x => x && !keywords.includes(x)).slice(0, Math.max(0, limit));
}

// 状态类问法常带“最新 / 目前 / 在做 / 有吗”等搜索不需要的意图词。
// 只移除这些通用修饰词，形成额外的稳定核心查询；原问题和模型关键词仍会保留。
function deriveStatusCoreQuery(question, keywords) {
  const q = String(question || '');
  if (!/(最新|最近|目前|当前|现在|正在|还在|在做|做的|还有|有没有|有无|是否|进展|情况|状态)/.test(q)) return '';
  const modifier = /(最新|最近|目前|当前|现在|正在|还在|在做的|在做|做的|还有|有没有|有无|是否|进展如何|进展|情况|状态)/g;
  const tokens = String(keywords || q)
    .split(/\s+/)
    .map(x => x.replace(/[？?！!，。,.;；：:]/g, '').replace(modifier, '').replace(/^(的|有)+|(吗|呢|么|的|有)+$/g, ''))
    .filter(Boolean);
  const unique = [...new Set(tokens)];
  // 只有“需求”一类泛词会放大噪音，至少还要保留一个实体/主题词。
  return unique.length >= 2 ? unique.join(' ') : '';
}

function applyCorpusCorrection(question, plan, candidates) {
  const text = String(question || '');
  const tokens = String((plan && plan.keywords) || '').split(/\s+/).filter(x => x.length >= 2 && x.length <= 8);
  for (const token of tokens) {
    if (!text.includes(token)) continue;
    const all = (candidates || []).filter(Boolean);
    const formal = all.filter(x => x.length > token.length);
    const replacement = all
      .map((value, index) => ({
        value,
        index,
        score: formal.reduce((score, full) => {
          // 企业简称常保留正式名首字与业务尾字；只排序语料内已有候选，不生成新词。
          if (value[0] === full[0] && value[value.length - 1] === full[full.length - 1]) score += 4;
          let p = 0;
          for (const ch of value) { p = full.indexOf(ch, p); if (p < 0) break; p++; }
          return score + (p >= 0 ? 1 : 0);
        }, 0),
      }))
      .filter(x => x.value.length === token.length && x.value !== token && oneEditOrLess(token, x.value))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.value;
    if (replacement) return text.replace(token, replacement);
  }
  return '';
}

module.exports = { oneEditOrLess, titleEntityPrefix, titleSeriesStem, discoverCorpusQueries, applyCorpusCorrection, deriveStatusCoreQuery };
