'use strict';

// TDD: 先写测试（Step 1），预期失败，等实现后通过
const {
  createConversation,
  getConversationsFor,
  getConversationOwned,
  deleteConversationOwned,
  addMessage,
  updateConversationTitleOwned,
  sanitizePersistentConfig,
} = require('../server/store');

console.assert(JSON.stringify(sanitizePersistentConfig({ topK: 4, appSecret: 'secret', openaiApiKey: 'key' })) === JSON.stringify({ topK: 4 }), '持久化配置必须过滤密钥字段');

let idA;

async function run() {
  // --- 1. A 建对话 ---
  const convA = createConversation('ou_A', '测试对话A');
  idA = convA.id;
  console.assert(convA.ownerOpenId === 'ou_A', 'createConversation 应含 ownerOpenId');
  console.assert(typeof convA.id === 'string', 'conversation 应含 id');
  console.assert(Array.isArray(convA.messages), 'conversation 应含 messages 数组');

  // --- 2. 跨用户 getConversationOwned 应返回 null ---
  const notOwned = getConversationOwned(idA, 'ou_B');
  console.assert(notOwned === null, 'ou_B 不应能访问 ou_A 的对话，应返回 null');

  // --- 3. 正确 owner 可以访问 ---
  const owned = getConversationOwned(idA, 'ou_A');
  console.assert(owned !== null && owned.id === idA, 'ou_A 应能访问自己的对话');

  // --- 4. getConversationsFor 只返回 A 的对话 ---
  // B 也建一个对话
  const convB = createConversation('ou_B', '测试对话B');
  const listA = getConversationsFor('ou_A');
  console.assert(Array.isArray(listA), 'getConversationsFor 应返回数组');
  const allBelongToA = listA.every(c => c.ownerOpenId === 'ou_A');
  console.assert(allBelongToA, 'getConversationsFor(ou_A) 不应含其他用户的对话');
  const hasA = listA.some(c => c.id === idA);
  console.assert(hasA, 'getConversationsFor(ou_A) 应含 A 的对话');
  const hasBinA = listA.some(c => c.id === convB.id);
  console.assert(!hasBinA, 'getConversationsFor(ou_A) 不应含 B 的对话');

  // --- 5. addMessage: 跨用户写 → null 且未写入 ---
  const msg = { role: 'user', content: '越权消息' };
  const badAdd = addMessage(idA, 'ou_B', msg);
  console.assert(badAdd === null, 'addMessage 错误 owner 应返回 null');
  // 验证未写入：重新查，messages 数量不变
  const afterBadAdd = getConversationOwned(idA, 'ou_A');
  console.assert(afterBadAdd.messages.length === 0, '跨用户 addMessage 不应写入消息');

  // --- 6. addMessage: 正确 owner → 成功 ---
  const goodMsg = { role: 'user', content: '合法消息' };
  const goodAdd = addMessage(idA, 'ou_A', goodMsg);
  console.assert(goodAdd !== null, 'addMessage 正确 owner 应返回 conversation');
  const afterGoodAdd = getConversationOwned(idA, 'ou_A');
  console.assert(afterGoodAdd.messages.length === 1, '正确 owner addMessage 应写入消息');

  // --- 7. updateConversationTitleOwned: 跨用户不改 ---
  const badUpdate = updateConversationTitleOwned(idA, 'ou_B', '越权标题');
  console.assert(badUpdate === null, 'updateConversationTitleOwned 错误 owner 应返回 null');
  const afterBadUpdate = getConversationOwned(idA, 'ou_A');
  console.assert(afterBadUpdate.title === '测试对话A', '跨用户 updateTitle 不应修改标题');

  // --- 8. updateConversationTitleOwned: 正确 owner 可更新 ---
  const goodUpdate = updateConversationTitleOwned(idA, 'ou_A', '新标题');
  console.assert(goodUpdate !== null && goodUpdate.title === '新标题', 'updateConversationTitleOwned 正确 owner 应更新标题');

  // --- 9. deleteConversationOwned: 跨用户不删 ---
  const badDel = deleteConversationOwned(idA, 'ou_B');
  console.assert(badDel === false, 'deleteConversationOwned 错误 owner 应返回 false');
  const stillExists = getConversationOwned(idA, 'ou_A');
  console.assert(stillExists !== null, '跨用户 delete 不应删除对话');

  // --- 10. deleteConversationOwned: 正确 owner 可删 ---
  const goodDel = deleteConversationOwned(idA, 'ou_A');
  console.assert(goodDel !== false, 'deleteConversationOwned 正确 owner 应返回 truthy');
  const afterDel = getConversationOwned(idA, 'ou_A');
  console.assert(afterDel === null, '删除后 getConversationOwned 应返回 null');

  // --- 清理 B 的测试对话 ---
  deleteConversationOwned(convB.id, 'ou_B');

  console.log('store ok');
}

run().catch(err => {
  console.error('store test FAILED:', err);
  process.exit(1);
});
