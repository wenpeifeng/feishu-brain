'use strict';

/**
 * 用户反馈 / 许愿收集（按 openId 记名，落盘 data/wishes.json）。
 * type: 'wish'(功能许愿) | 'bug'(问题反馈) | 'other'
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'wishes.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_e) { return []; }
}
function save(list) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch (_e) { /* 落盘失败不影响主流程 */ }
}

function addWish(openId, name, { type, content }, ts) {
  const text = String(content || '').trim();
  if (!text) throw new Error('反馈内容不能为空');
  const list = load();
  const item = {
    id: 'w' + (ts || 0) + '_' + list.length,
    openId, name: name || '',
    type: ['wish', 'bug', 'other'].indexOf(type) >= 0 ? type : 'wish',
    content: text.slice(0, 2000),
    time: ts || 0,
  };
  list.unshift(item);
  save(list);
  return item;
}

function listWishes(openId) {
  const all = load();
  return openId ? all.filter(w => w.openId === openId) : all;
}

module.exports = { addWish, listWishes };
