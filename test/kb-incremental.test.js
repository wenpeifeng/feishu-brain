'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const semanticPath = require.resolve('../server/semantic');
const realSemantic = require(semanticPath);
let embedCalls = [];
let failEmbed = false;
require.cache[semanticPath] = {
  id: semanticPath,
  filename: semanticPath,
  loaded: true,
  exports: {
    ...realSemantic,
    embed: async texts => {
      embedCalls.push(texts.slice());
      if (failEmbed) throw new Error('mock embedding outage');
      return texts.map(text => [String(text).length, String(text).charCodeAt(0) || 0, 1]);
    },
    batchEmbed: async texts => {
      embedCalls.push(texts.slice());
      if (failEmbed) throw new Error('mock embedding outage');
      return texts.map(text => [String(text).length, String(text).charCodeAt(0) || 0, 1]);
    },
  },
};
delete require.cache[require.resolve('../server/kb')];
const kb = require('../server/kb');

function kbFile(openId) {
  return path.join(__dirname, '..', 'data', 'kb', crypto.createHash('md5').update(openId).digest('hex') + '.json');
}

const embedA = { apiKey: 'test-only', baseUrl: 'https://embed-a.test/v1', model: 'embed-a' };
const embedB = { apiKey: 'test-only', baseUrl: 'https://embed-b.test/v1', model: 'embed-b' };

(async () => {
  const owner = `kb-incremental-owner-${process.pid}`;
  const other = `kb-incremental-other-${process.pid}`;
  try {
    fs.rmSync(kbFile(owner), { force: true });
    fs.rmSync(kbFile(other), { force: true });

    const original = '甲'.repeat(520) + '乙'.repeat(520) + '丙'.repeat(520);
    embedCalls = [];
    const created = await kb.addDoc(owner, { title: '增量索引规范', content: original }, embedA);
    assert.equal(created.revision, 1);
    assert.equal(created.indexMode, 'vector');
    assert.ok(created.chunkCount >= 3);
    assert.equal(created.embeddedVectorCount, created.chunkCount, '首次上传应向量化全部块');

    embedCalls = [];
    const updatedContent = original.slice(0, -80) + '丁'.repeat(80);
    const updated = await kb.updateDoc(owner, created.id, { content: updatedContent }, embedA, { expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    assert.ok(updated.reusedVectorCount > 0, '未变化块必须复用原向量');
    assert.ok(updated.embeddedVectorCount > 0, '变化块必须重新向量化');
    assert.ok(updated.embeddedVectorCount < updated.chunkCount, '增量更新不能重算全部块');
    assert.equal(embedCalls.reduce((n, x) => n + x.length, 0), updated.embeddedVectorCount);

    await assert.rejects(
      () => kb.updateDoc(owner, created.id, { content: '过期客户端覆盖' }, embedA, { expectedRevision: 1 }),
      e => e && e.code === 'REVISION_CONFLICT',
    );
    assert.equal(kb.getDoc(owner, created.id).content, updatedContent, '版本冲突不能修改当前内容');

    failEmbed = true;
    await assert.rejects(
      () => kb.updateDoc(owner, created.id, { content: updatedContent + '失败更新' }, embedA, { expectedRevision: 2 }),
      e => e && e.code === 'INDEX_BUILD_FAILED',
    );
    failEmbed = false;
    assert.equal(kb.getDoc(owner, created.id).revision, 2, '索引失败必须保留旧版本');
    assert.equal(kb.getDoc(owner, created.id).content, updatedContent);

    embedCalls = [];
    const rebuilt = await kb.updateDoc(owner, created.id, {}, embedB, { expectedRevision: 2 });
    assert.equal(rebuilt.revision, 3);
    assert.equal(rebuilt.reusedVectorCount, 0, 'embedding 端点/模型变化不得复用旧向量');
    assert.equal(rebuilt.embeddedVectorCount, rebuilt.chunkCount);

    assert.equal(kb.getDoc(other, created.id), null, '其他用户不得读取文档');
    assert.deepEqual(kb.listDocs(other), [], '其他用户列表不得看到文档');
    assert.equal(await kb.updateDoc(other, created.id, { title: '越权修改' }, embedA), null);
    assert.equal(await kb.deleteDoc(other, created.id), false);
    assert.deepEqual(await kb.searchKbHybrid(other, '增量索引', embedA), []);

    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      kb.addDoc(owner, { title: `并发文档${i}`, content: `并发内容${i}` }, null)
    ));
    assert.equal(kb.listDocs(owner).length, 6, '同一用户并发上传不得发生最后写覆盖');

    await assert.rejects(
      () => kb.deleteDoc(owner, created.id, 2),
      e => e && e.code === 'REVISION_CONFLICT',
    );
    assert.ok(await kb.deleteDoc(owner, created.id, 3));
    assert.equal(kb.getDoc(owner, created.id), null);

    console.log(`✅ kb-incremental.test.js 通过：${updated.chunkCount} 块中复用 ${updated.reusedVectorCount}、重建 ${updated.embeddedVectorCount}；模型失效、回滚、并发与权限隔离通过`);
  } finally {
    failEmbed = false;
    fs.rmSync(kbFile(owner), { force: true });
    fs.rmSync(kbFile(other), { force: true });
    require.cache[semanticPath] = { id: semanticPath, filename: semanticPath, loaded: true, exports: realSemantic };
  }
})().catch(e => { console.error('❌', e); process.exit(1); });
