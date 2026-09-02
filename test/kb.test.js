require('../server/env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kb = require('../server/kb');
const { resolveEmbed } = require('../server/providers');

// ── BM25 纯单测（确定性，无网络）─────────────────────────────────────────────
{
  const s = kb.bm25Scores('辅助服务 调频', [
    '辅助服务市场是以调频、备用为交易标的物的市场',
    '今天食堂午饭有红烧肉和青菜',
  ]);
  assert.ok(s[0] > s[1], 'BM25 相关块分更高');
  assert.equal(s[1], 0, '无关块 0 分');
  assert.equal(kb.bm25Scores('', ['x'])[0], 0, '空 query → 0');
}

// ── hybrid 端到端（建临时库→检索→清理）──────────────────────────────────────
function kbFile(openId) {
  return path.join(__dirname, '..', 'data', 'kb', crypto.createHash('md5').update(openId).digest('hex') + '.json');
}

(async () => {
  const ec = process.env.GLM_API_KEY ? resolveEmbed({ providerId: 'glm', apiKey: process.env.GLM_API_KEY }) : null;
  const openId = 'test-kb-fixture-openid';
  try {
    fs.rmSync(kbFile(openId), { force: true });
    const leaveContent = '员工带薪休假的申请流程：登录OA系统，在休假模块提交申请，主管审批通过后生效，可查看剩余额度。'.repeat(36);
    const m = await kb.addDoc(openId, { title: '请假制度', content: leaveContent }, ec);
    assert.ok(m.id, '返回文档 id');
    assert.equal(m.embedded, !!ec, 'embedded 标记与是否有 embedConfig 一致');
    const updated = await kb.updateDoc(
      openId,
      m.id,
      { content: leaveContent.slice(0, -40) + '新增规则：连续休假超过五天需要部门负责人复核。' },
      ec,
      { expectedRevision: 1 },
    );
    assert.equal(updated.revision, 2, '更新后 revision 递增');
    if (ec) {
      assert.ok(updated.reusedVectorCount > 0, '真实 embedding 更新应复用未变化块');
      assert.ok(updated.embeddedVectorCount > 0, '真实 embedding 更新应只重建变化块');
      assert.ok(updated.embeddedVectorCount < updated.chunkCount, '真实增量更新不能重算全部块');
      console.log(`  增量索引实测：${updated.chunkCount} 块中复用 ${updated.reusedVectorCount}、真实重建 ${updated.embeddedVectorCount}`);
    }
    await kb.addDoc(openId, { title: '报销规定', content: '费用报销需在发生后 30 天内提交发票至财务部门。' }, ec);
    await kb.addDoc(openId, { title: '食堂通知', content: '公司食堂每周一更新菜单，本周有红烧肉。' }, ec);

    // 列表 + 隔离
    assert.equal(kb.listDocs(openId).length, 3, '3 篇');

    // hybrid 检索
    const r = await kb.searchKbHybrid(openId, '怎么申请休假', ec, { topDocs: 2 });
    assert.ok(r.length >= 1, '有结果');
    assert.equal(r[0].title, '请假制度', '命中请假制度');
    assert.equal(r[0].source, 'kb');
    assert.ok(r[0].content.includes('休假'), '带正文');

    // 删除
    assert.ok(await kb.deleteDoc(openId, m.id), '删除成功');
    assert.equal(kb.listDocs(openId).length, 2, '删后剩 2');

    console.log('✅ kb.test.js 通过' + (ec ? '（BM25+向量 hybrid）' : '（仅 BM25，无 GLM）'));
  } finally {
    fs.rmSync(kbFile(openId), { force: true });
  }
})().catch(e => { console.error('❌', e); process.exit(1); });
