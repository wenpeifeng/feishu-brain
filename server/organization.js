'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = process.env.ORGANIZATIONS_FILE || path.join(__dirname, '..', 'data', 'organizations.json');

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_e) { return {}; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function bootstrapIds() {
  return String(process.env.ADMIN_OPEN_IDS || '')
    .split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * tenantKey is the authoritative boundary. FEISHU_TENANT_KEY is a deployment
 * fallback for an existing single-tenant self-built app. The app-id fallback
 * keeps local/mock installs usable without merging different app deployments.
 */
function tenantIdOf(user) {
  return String(
    (user && (user.tenantKey || user.tenantId)) ||
    process.env.FEISHU_TENANT_KEY ||
    (process.env.FEISHU_APP_ID ? `app:${process.env.FEISHU_APP_ID}` : 'app:local')
  );
}

function orgStoreKey(tenantId) {
  return `__organization__:${String(tenantId || '')}`;
}

function registerMember(user) {
  if (!user || !user.openId) return null;
  const tenantId = tenantIdOf(user);
  const state = readState();
  const now = new Date().toISOString();
  const bootstrap = bootstrapIds();
  let org = state[tenantId];
  let bootstrapChanged = false;
  if (!org) {
    const ownerOpenId = bootstrap[0] || user.openId;
    org = {
      id: tenantId,
      name: String(user.tenantName || '当前飞书组织').slice(0, 100),
      ownerOpenId,
      bootstrapAppliedAt: bootstrap.length ? now : '',
      createdAt: now,
      updatedAt: now,
      members: {},
    };
    for (const openId of bootstrap) {
      org.members[openId] = {
        openId, name: openId === user.openId ? String(user.name || '') : '',
        avatar: openId === user.openId ? String(user.avatar || '') : '',
        role: openId === ownerOpenId ? 'owner' : 'admin',
        joinedAt: now, lastSeenAt: openId === user.openId ? now : '',
      };
    }
  } else if (bootstrap.length && !org.bootstrapAppliedAt) {
    // 已运行部署的单次恢复入口：配置在首次组织创建之后补上时也能生效；
    // 成功应用后落标记，之后 UI 中的升降级不会再被环境变量覆盖。
    const previousOwner = org.members && org.members[org.ownerOpenId];
    if (previousOwner) previousOwner.role = 'admin';
    org.ownerOpenId = bootstrap[0];
    for (const openId of bootstrap) {
      const old = (org.members && org.members[openId]) || {};
      org.members[openId] = {
        ...old, openId, name: old.name || '', avatar: old.avatar || '',
        role: openId === org.ownerOpenId ? 'owner' : 'admin',
        joinedAt: old.joinedAt || now, lastSeenAt: old.lastSeenAt || '',
      };
    }
    org.bootstrapAppliedAt = now;
    bootstrapChanged = true;
  }
  const existing = org.members[user.openId] || {};
  const previousSeen = existing.lastSeenAt ? Date.parse(existing.lastSeenAt) : 0;
  const role = user.openId === org.ownerOpenId
    ? 'owner'
    : (existing.role === 'admin' ? 'admin' : 'member');
  const nextMember = {
    ...existing,
    openId: user.openId,
    name: String(user.name || existing.name || '').slice(0, 80),
    avatar: String(user.avatar || existing.avatar || ''),
    role,
    joinedAt: existing.joinedAt || now,
    lastSeenAt: Date.now() - previousSeen > 5 * 60 * 1000 ? now : (existing.lastSeenAt || now),
  };
  const unchanged = existing.openId &&
    existing.name === nextMember.name &&
    existing.avatar === nextMember.avatar &&
    existing.role === nextMember.role &&
    existing.lastSeenAt === nextMember.lastSeenAt;
  org.members[user.openId] = nextMember;
  if (unchanged && !bootstrapChanged) return publicMembership(org, user.openId);
  org.updatedAt = now;
  state[tenantId] = org;
  writeState(state);
  return publicMembership(org, user.openId);
}

function publicMembership(org, openId) {
  if (!org) return null;
  const member = org.members && org.members[openId];
  const role = openId === org.ownerOpenId ? 'owner' : (member && member.role) || 'member';
  return {
    organization: {
      name: org.name || '当前飞书组织',
      memberCount: Object.keys(org.members || {}).length,
    },
    role,
    isOwner: role === 'owner',
    isAdmin: role === 'owner' || role === 'admin',
  };
}

function getMembership(user) {
  if (!user || !user.openId) return null;
  const tenantId = tenantIdOf(user);
  const org = readState()[tenantId];
  return org && org.members && org.members[user.openId]
    ? publicMembership(org, user.openId)
    : registerMember(user);
}

function isAdmin(user) {
  const m = getMembership(user);
  return !!(m && m.isAdmin);
}

function listMembers(user) {
  const tenantId = tenantIdOf(user);
  const org = readState()[tenantId];
  if (!org) return null;
  const membership = publicMembership(org, user.openId);
  if (!membership.isAdmin) return null;
  const order = { owner: 0, admin: 1, member: 2 };
  return {
    ...membership,
    members: Object.values(org.members || {})
      .map(x => ({ openId: x.openId, name: x.name || '未命名成员', avatar: x.avatar || '', role: x.openId === org.ownerOpenId ? 'owner' : x.role, joinedAt: x.joinedAt, lastSeenAt: x.lastSeenAt }))
      .sort((a, b) => (order[a.role] - order[b.role]) || String(a.name).localeCompare(String(b.name), 'zh-CN')),
  };
}

function setMemberRole(actor, targetOpenId, role) {
  if (!['owner', 'admin', 'member'].includes(role)) {
    const e = new Error('不支持的角色'); e.code = 'INVALID_ROLE'; throw e;
  }
  const tenantId = tenantIdOf(actor);
  const state = readState();
  const org = state[tenantId];
  if (!org) return null;
  if (org.ownerOpenId !== actor.openId) {
    const e = new Error('只有组织 Owner 可以更改管理员'); e.code = 'FORBIDDEN'; throw e;
  }
  const target = org.members && org.members[targetOpenId];
  if (!target) {
    const e = new Error('该用户尚未登录过本系统，无法分配角色'); e.code = 'NOT_FOUND'; throw e;
  }
  if (targetOpenId === org.ownerOpenId && role !== 'owner') {
    const e = new Error('请先把 Owner 转移给其他成员'); e.code = 'LAST_OWNER'; throw e;
  }
  if (role === 'owner') {
    const oldOwner = org.members[org.ownerOpenId];
    if (oldOwner) oldOwner.role = 'admin';
    org.ownerOpenId = targetOpenId;
  }
  target.role = role;
  org.updatedAt = new Date().toISOString();
  state[tenantId] = org;
  writeState(state);
  return listMembers({ ...actor, openId: role === 'owner' ? targetOpenId : actor.openId });
}

function memberOpenIds(user) {
  const org = readState()[tenantIdOf(user)];
  return org ? Object.keys(org.members || {}) : [user.openId].filter(Boolean);
}

module.exports = {
  tenantIdOf, orgStoreKey, registerMember, getMembership, isAdmin,
  listMembers, setMemberRole, memberOpenIds,
};
