'use strict';

/**
 * 回归：成员 ID 与 JavaScript 对象原型属性同名（"__proto__"、"constructor"、
 * "toString" 等）时，父母关系索引必须像 Map 一样按任意合法 ID 安全读写——
 * 备份预览校验、恢复提交、重启加载、撤销与各依赖假设图的关系分析都不得抛异常，
 * 成员与关系原样保留；环路与重复关系仍按原规则拒绝。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const {
  validateBackup,
  validateEdgeBatch,
  previewEdgeImpact,
  previewMemberDeletion,
  previewMergeMembers,
  findGenerationConflicts,
  findCommonAncestors,
  descendantBranches,
} = require('../server/familyGraph');
const { layoutFamilyChart } = require('../server/familyChart');
const { findCriticalLinks } = require('../server/criticalLinks');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-proto-key-'));
  return path.join(dir, 'family.json');
}

/** ID 与对象原型属性同名的合法家谱：__proto__ 与 constructor 同为 x 的父母 */
function protoBackup() {
  return {
    members: [
      { id: '__proto__', name: '原型' },
      { id: 'constructor', name: '构造器' },
      { id: 'toString', name: '字符串' },
      { id: 'x', name: '子女' },
    ],
    edges: [
      { parentId: '__proto__', childId: 'x' },
      { parentId: 'constructor', childId: 'x' },
      { parentId: 'x', childId: 'toString' },
    ],
  };
}

test('原型名 ID：合法备份通过整份校验，不抛异常且关系一条不丢', () => {
  const r = validateBackup(protoBackup());
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.memberCount, 4);
  assert.equal(r.edgeCount, 3);
  assert.deepEqual(
    r.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['__proto__->x', 'constructor->x', 'x->toString'],
  );
});

test('原型名 ID：环路与重复关系仍按原规则拒绝', () => {
  const cycle = validateBackup({
    members: [
      { id: '__proto__', name: '甲' },
      { id: 'constructor', name: '乙' },
    ],
    edges: [
      { parentId: '__proto__', childId: 'constructor' },
      { parentId: 'constructor', childId: '__proto__' },
    ],
  });
  assert.equal(cycle.valid, false);
  assert.ok(cycle.errors.some((e) => /环路/.test(e.message)));

  const duplicate = validateBackup({
    members: [
      { id: '__proto__', name: '甲' },
      { id: 'toString', name: '乙' },
    ],
    edges: [
      { parentId: '__proto__', childId: 'toString' },
      { parentId: '__proto__', childId: 'toString' },
    ],
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((e) => /重复/.test(e.message)));

  // 同名为 constructor 的重复成员 ID 依旧拒绝
  const dupId = validateBackup({
    members: [
      { id: 'constructor', name: '甲' },
      { id: 'constructor', name: '乙' },
    ],
    edges: [],
  });
  assert.equal(dupId.valid, false);
  assert.ok(dupId.errors.some((e) => /重复/.test(e.message)));
});

test('原型名 ID：恢复预览 → 提交 → 重启加载，成员与关系原样保留', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('旧成员');
  const v = store.getVersion();
  const content = JSON.stringify(protoBackup());

  // 修复前预览即抛异常并返回 500
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(preview.memberCount, 4);
  assert.equal(preview.edgeCount, 3);
  assert.equal(store.getVersion(), v); // 预览只读

  const restored = store.restoreBackup(content, preview.fingerprint, v);
  assert.equal(restored.error, null);

  // 关系索引是无原型对象，未被 "__proto__" 污染
  const state = store.getState();
  assert.equal(Object.getPrototypeOf(state.parentsOf), null);
  assert.deepEqual(state.parentsOf.x, ['__proto__', 'constructor']);
  assert.deepEqual(state.parentsOf.__proto__, []);
  assert.deepEqual(state.parentsOf.constructor, []);
  assert.deepEqual(state.parentsOf.toString, ['x']);

  const data = store.list();
  assert.deepEqual(
    data.members.map((m) => m.id).sort(),
    ['__proto__', 'constructor', 'toString', 'x'],
  );
  assert.deepEqual(
    data.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['__proto__->x', 'constructor->x', 'x->toString'],
  );

  // 重启后从磁盘重新加载，成员与关系仍原样保留
  const reloadedStore = createStore(file);
  const reloaded = reloadedStore.list();
  assert.deepEqual(
    reloaded.members.map((m) => m.id).sort(),
    ['__proto__', 'constructor', 'toString', 'x'],
  );
  assert.deepEqual(
    reloaded.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['__proto__->x', 'constructor->x', 'x->toString'],
  );
  assert.equal(Object.getPrototypeOf(reloadedStore.getState().parentsOf), null);
});

test('原型名 ID：撤销快照落盘后，重启仍可整体撤销恢复前家谱', () => {
  const file = tmpFile();
  const store = createStore(file);
  const old = store.addMember('旧成员').member;
  const v = store.getVersion();
  const content = JSON.stringify(protoBackup());

  const preview = store.previewRestore(content);
  assert.equal(store.restoreBackup(content, preview.fingerprint, v).error, null);

  const reloaded = createStore(file);
  assert.equal(reloaded.undoLast(reloaded.getVersion()).error, null);
  const afterUndo = reloaded.list();
  assert.deepEqual(afterUndo.members.map((m) => m.id), [old.id]);
  assert.equal(afterUndo.edges.length, 0);
});

test('原型名 ID：在恢复后的家谱上继续增删关系与环路拦截', () => {
  const file = tmpFile();
  const store = createStore(file);
  const content = JSON.stringify(protoBackup());
  const preview = store.previewRestore(content);
  assert.equal(
    store.restoreBackup(content, preview.fingerprint, store.getVersion()).error,
    null,
  );

  // __proto__ → toString 合法（__proto__ 本就是 toString 的祖先，直达边不形成环）
  const batch = store.commitEdges(
    [{ parentId: '__proto__', childId: 'toString' }],
    store.getVersion(),
  );
  assert.equal(batch.error, null);
  assert.deepEqual(store.getState().parentsOf.toString, ['x', '__proto__']);

  // 反向关系（后代成为祖先的父母）会形成祖先环路，仍被拒绝
  const cyclic = store.addEdge('toString', '__proto__');
  assert.equal(cyclic.error.includes('环路'), true);

  // 删除以原型名 ID 为端点的关系
  assert.equal(store.deleteEdge('__proto__', 'toString').error, null);
  assert.deepEqual(store.getState().parentsOf.toString, ['x']);
  // 不存在的关系仍按原规则报错（不能把 constructor 误读为原型构造器）
  assert.equal(store.deleteEdge('constructor', '__proto__').error, '关系不存在');

  // 批量预检同样在合并图上安全分析
  const check = validateEdgeBatch(store.getState(), [
    { parentId: '__proto__', childId: 'toString' },
    { parentId: '__proto__', childId: 'toString' }, // 批内重复
  ]);
  assert.equal(check.valid, false);
  assert.ok(check.items[0].errors.some((m) => /批内重复/.test(m)));
});

test('原型名 ID：所有依赖父母索引的只读分析均不抛异常', () => {
  const file = tmpFile();
  const store = createStore(file);
  const content = JSON.stringify(protoBackup());
  const preview = store.previewRestore(content);
  store.restoreBackup(content, preview.fingerprint, store.getVersion());
  const state = store.getState();

  assert.equal(layoutFamilyChart(state, 1).edgeCount, 3);
  assert.equal(findCriticalLinks(state).edgeCount, 3);
  assert.equal(typeof findGenerationConflicts(state).total, 'number');
  const ancestors = findCommonAncestors(state, '__proto__', 'constructor');
  assert.ok(!ancestors.error);
  // __proto__ 的后代：x（1 代）、toString（2 代），constructor 不在其支系内
  const branches = descendantBranches(state, '__proto__', 5);
  assert.equal(branches.error, null);
  assert.equal(branches.members.length, 3);

  // 假设图分析（新增 / 移除）
  assert.equal(
    previewEdgeImpact(state, { action: 'remove', parentId: '__proto__', childId: 'x' })
      .error,
    undefined,
  );
  // 新增一条合法的隔代边 __proto__ → toString（不形成环）
  const addImpact = previewEdgeImpact(state, {
    action: 'add',
    parentId: '__proto__',
    childId: 'toString',
  });
  assert.equal(addImpact.error, undefined);
  // 形成环路的新增仍按原规则拒绝
  assert.match(
    previewEdgeImpact(state, { action: 'add', parentId: 'toString', childId: '__proto__' })
      .error,
    /环路/,
  );

  // 删除成员影响预览（被删成员 ID 恰为原型属性名）
  assert.equal(previewMemberDeletion(state, '__proto__').error, undefined);
  assert.equal(previewMemberDeletion(state, 'constructor').error, undefined);

  // 合并预检（该备份中任意合并都会引入自指/环路，只要求不抛异常并按规则给出结论）
  const merge = previewMergeMembers(state, 'x', 'toString');
  assert.equal(typeof merge.valid, 'boolean');
});
