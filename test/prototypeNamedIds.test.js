'use strict';

/**
 * 回归测试：成员 ID 与 JavaScript 对象原型属性同名时的家谱故障。
 *
 * 成员 ID 允许是任意非空字符串——包括 "__proto__"、"constructor"、"toString"
 * 等与 Object.prototype 成员同名的值。旧实现用普通对象字面量 {} 当
 * 「成员 ID → 父母列表」索引：
 *   - 读：键不存在时沿原型链取到继承值（constructor / toString 函数），
 *     被误当作父母列表继续 push / 展开，备份恢复预览直接抛异常（HTTP 500）；
 *   - 写："__proto__" 会改写对象原型而不是新增条目，该成员的关系对
 *     Object.entries 不可见，遍历与落盘都会静默丢失。
 * 现在所有以成员 ID 为键的索引统一是 null 原型对象（createIdIndex），
 * 任意合法 ID 都能安全读写。
 *
 * 本文件覆盖：备份预览校验、恢复提交、重启加载、撤销，以及依赖假设图的
 * 关系分析（批量预检、合并预演、变更影响预览、删除成员影响预览、辈分矛盾、
 * 后代支系、共同祖先、桥梁分析、整谱布局）；恢复后成员与关系原样保留，
 * 环路与重复关系仍按原规则拒绝。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createIdIndex,
  createState,
  validateEdge,
  validateEdgeBatch,
  validateBackup,
  previewMergeMembers,
  previewEdgeImpact,
  previewMemberDeletion,
  findGenerationConflicts,
  findCommonAncestors,
  descendantBranches,
} = require('../server/familyGraph');
const { findCriticalLinks } = require('../server/criticalLinks');
const { layoutFamilyChart } = require('../server/familyChart');
const { createStore } = require('../server/store');

const PROTO_IDS = ['__proto__', 'constructor', 'toString'];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-proto-id-'));
  return path.join(dir, 'family.json');
}

/** 测试辅助：批量建成员（id 与姓名相同）并建立已有关系 */
function makeState(names, existing = []) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  for (const [p, c] of existing) {
    const r = validateEdge(state, p, c);
    assert.equal(r.error, null, `准备数据失败 ${p} -> ${c}: ${r.error}`);
    state.parentsOf[c].push(p);
  }
  return state;
}

/** 边表 → 有序端点对列表（排序便于比较） */
const edgePairs = (edges) =>
  edges.map((e) => [e.parentId, e.childId]).sort((x, y) => {
    if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
    return x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });

/** 合法备份：三名原型属性同名成员 + 一名普通成员，链式加双亲关系（无环） */
function protoBackup() {
  return {
    members: [
      { id: '__proto__', name: '甲' },
      { id: 'constructor', name: '乙' },
      { id: 'toString', name: '丙' },
      { id: 'hasOwnProperty', name: '丁' },
    ],
    edges: [
      { parentId: 'toString', childId: 'constructor' },
      { parentId: 'hasOwnProperty', childId: 'constructor' },
      { parentId: 'constructor', childId: '__proto__' },
    ],
  };
}

/* ---------------- null 原型索引本身 ---------------- */

test('ID 索引：null 原型对象对原型属性同名 ID 读写安全', () => {
  const index = createIdIndex();
  for (const id of PROTO_IDS) {
    assert.equal(index[id], undefined, `缺失键 ${id} 不得取到原型继承值`);
    index[id] = ['p'];
    assert.deepEqual(index[id], ['p']);
  }
  assert.deepEqual(Object.keys(index).sort(), [...PROTO_IDS].sort());

  // createState 的父母索引就是 null 原型：特殊 ID 成员直接读写不抛异常、不污染原型
  const state = createState();
  state.parentsOf['__proto__'] = [];
  state.parentsOf['__proto__'].push('constructor');
  assert.deepEqual(state.parentsOf['__proto__'], ['constructor']);
  assert.deepEqual(Object.keys(state.parentsOf), ['__proto__']);
  assert.equal(state.parentsOf['toString'], undefined);
});

/* ---------------- 备份预览校验 ---------------- */

test('备份校验：原型属性同名成员及其亲子关系合法通过，不再抛异常', () => {
  for (const id of PROTO_IDS) {
    const r = validateBackup({
      members: [
        { id, name: '甲' },
        { id: 'b', name: '乙' },
      ],
      edges: [{ parentId: 'b', childId: id }],
    });
    assert.equal(r.valid, true, `成员 ID "${id}" 的合法备份应通过校验`);
    assert.equal(r.memberCount, 2);
    assert.deepEqual(r.edges, [{ parentId: 'b', childId: id }]);
  }

  // 三名特殊 ID 成员同谱：链式 + 双亲关系全部保留
  const r = validateBackup(protoBackup());
  assert.equal(r.valid, true);
  assert.equal(r.memberCount, 4);
  assert.equal(r.edgeCount, 3);
  assert.deepEqual(edgePairs(r.edges), [
    ['constructor', '__proto__'],
    ['hasOwnProperty', 'constructor'],
    ['toString', 'constructor'],
  ]);
});

test('备份校验：特殊 ID 成员的环路、重复关系、超两位父母仍按原规则拒绝', () => {
  // 祖先环路：__proto__ → constructor → __proto__
  const cyc = validateBackup({
    members: [
      { id: '__proto__', name: '甲' },
      { id: 'constructor', name: '乙' },
    ],
    edges: [
      { parentId: '__proto__', childId: 'constructor' },
      { parentId: 'constructor', childId: '__proto__' },
    ],
  });
  assert.equal(cyc.valid, false);
  assert.equal(cyc.errors.filter((e) => /环路/.test(e.message)).length, 2);

  // 重复关系：每个副本都报错
  const dup = validateBackup({
    members: [
      { id: 'toString', name: '甲' },
      { id: 'b', name: '乙' },
    ],
    edges: [
      { parentId: 'toString', childId: 'b' },
      { parentId: 'toString', childId: 'b' },
    ],
  });
  assert.equal(dup.valid, false);
  assert.ok(dup.errors.some((e) => /重复/.test(e.message)));

  // 超过两位父母：三位特殊 ID 父母指向同一子女
  const many = validateBackup({
    members: [
      { id: '__proto__', name: '甲' },
      { id: 'constructor', name: '乙' },
      { id: 'toString', name: '丙' },
      { id: 'kid', name: '子' },
    ],
    edges: [
      { parentId: '__proto__', childId: 'kid' },
      { parentId: 'constructor', childId: 'kid' },
      { parentId: 'toString', childId: 'kid' },
    ],
  });
  assert.equal(many.valid, false);
  assert.ok(many.errors.some((e) => /3 位父母/.test(e.message)));

  // 自指
  const self = validateBackup({
    members: [{ id: 'constructor', name: '甲' }],
    edges: [{ parentId: 'constructor', childId: 'constructor' }],
  });
  assert.equal(self.valid, false);
  assert.ok(self.errors.some((e) => /自指/.test(e.message)));
});

/* ---------------- 恢复提交 / 重启加载 / 撤销 ---------------- */

test('恢复特殊 ID 备份：成员与关系原样保留，重启加载与撤销均不丢失', () => {
  const file = tmpFile();
  const content = JSON.stringify(protoBackup());

  const store = createStore(file);
  store.addMember('旧成员');
  const v = store.getVersion();

  // 预览：合法、只读
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true);
  assert.equal(preview.memberCount, 4);
  assert.equal(preview.edgeCount, 3);
  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members.length, 1);

  // 恢复提交：成员 ID 与关系原样保留
  assert.equal(store.restoreBackup(content, preview.fingerprint, v).error, null);
  const data = store.list();
  assert.deepEqual(
    data.members.map((m) => [m.id, m.name]).sort(),
    protoBackup().members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(edgePairs(data.edges), [
    ['constructor', '__proto__'],
    ['hasOwnProperty', 'constructor'],
    ['toString', 'constructor'],
  ]);

  // 重启加载：成员与关系原样保留（旧实现在此静默丢边甚至抛异常）
  const reloaded = createStore(file);
  assert.deepEqual(
    reloaded.list().members.map((m) => m.id).sort(),
    data.members.map((m) => m.id).sort(),
  );
  assert.deepEqual(edgePairs(reloaded.list().edges), edgePairs(data.edges));

  // 撤销恢复：回到恢复前的「旧成员」，撤销结果同样落盘
  assert.equal(reloaded.undoLast(reloaded.getVersion()).error, null);
  assert.equal(reloaded.list().members.length, 1);
  assert.equal(reloaded.list().edges.length, 0);
  const again = createStore(file);
  assert.equal(again.list().members.length, 1);
  assert.equal(again.list().edges.length, 0);
});

test('重启加载：旧版 parentsOf 邻接表磁盘格式中的特殊 ID 关系同样保留', () => {
  const file = tmpFile();
  // 直接写 JSON 文本（对象字面量的 "__proto__" 键会被当作原型设置，无法用于构造数据）
  fs.writeFileSync(
    file,
    '{' +
      '"version":3,"maxMembers":30,' +
      '"members":[{"id":"__proto__","name":"甲"},{"id":"constructor","name":"乙"}],' +
      '"parentsOf":{"__proto__":["constructor"]}' +
      '}',
  );
  const store = createStore(file);
  assert.equal(store.list().members.length, 2);
  assert.deepEqual(edgePairs(store.list().edges), [['constructor', '__proto__']]);
});

/* ---------------- 依赖假设图的关系分析 ---------------- */

test('批量预检与提交：特殊 ID 成员的草稿合法写入，环路草稿仍拒绝', () => {
  const file = tmpFile();
  const store = createStore(file);
  const content = JSON.stringify(protoBackup());
  const preview = store.previewRestore(content);
  assert.equal(store.restoreBackup(content, preview.fingerprint, 0).error, null);

  // 合法草稿：__proto__ 作为父母指向新成员
  const kid = store.addMember('新成员').member;
  const v = store.getVersion();
  const batch = store.validateEdgeBatch([{ parentId: '__proto__', childId: kid.id }]);
  assert.equal(batch.valid, true);
  assert.equal(store.commitEdges([{ parentId: '__proto__', childId: kid.id }], v).error, null);
  assert.ok(
    store.list().edges.some((e) => e.parentId === '__proto__' && e.childId === kid.id),
    '特殊 ID 父母的关系应写入',
  );

  // 环路草稿仍拒绝：让 toString 成为自己的后代
  const cyc = validateEdgeBatch(store.getState(), [
    { parentId: '__proto__', childId: 'toString' },
  ]);
  assert.equal(cyc.valid, false);
  assert.ok(cyc.items[0].errors.some((m) => /环路/.test(m)));
});

test('合并预演：特殊 ID 成员被合并时关系替换与去重正确', () => {
  const state = makeState(
    ['__proto__', 'constructor', 'toString', 'keep'],
    [
      ['toString', 'constructor'],
      ['constructor', '__proto__'],
    ],
  );
  // 把 toString 并入 keep：toString→constructor 变为 keep→constructor
  const r = previewMergeMembers(state, 'keep', 'toString');
  assert.equal(r.valid, true);
  assert.deepEqual(edgePairs(r.edges), [
    ['constructor', '__proto__'],
    ['keep', 'constructor'],
  ]);

  // 把 __proto__ 并入 constructor：constructor→__proto__ 替换后成为自指，仍被拒绝
  const self = previewMergeMembers(state, 'constructor', '__proto__');
  assert.equal(self.valid, false);
  assert.ok(self.conflicts.some((c) => c.type === 'self'));

  // 合并后成环仍被拒绝：__proto__ → x → constructor，把 __proto__ 并入 constructor
  const cycState = makeState(
    ['__proto__', 'x', 'constructor'],
    [
      ['__proto__', 'x'],
      ['x', 'constructor'],
    ],
  );
  const cyc = previewMergeMembers(cycState, 'constructor', '__proto__');
  assert.equal(cyc.valid, false);
  assert.ok(cyc.conflicts.some((c) => c.type === 'cycle'));
});

test('变更影响预览：特殊 ID 成员参与的假设图新增/移除不抛异常', () => {
  const state = makeState(
    ['__proto__', 'constructor', 'toString', 'x'],
    [
      ['toString', 'constructor'],
      ['constructor', '__proto__'],
    ],
  );
  const removed = previewEdgeImpact(state, {
    action: 'remove',
    parentId: 'constructor',
    childId: '__proto__',
  });
  assert.equal(removed.error, undefined);
  assert.equal(removed.action, 'remove');

  const added = previewEdgeImpact(state, {
    action: 'add',
    parentId: '__proto__',
    childId: 'x',
  });
  assert.equal(added.error, undefined);
  assert.equal(added.action, 'add');

  // 假设图校验规则不变：特殊 ID 的环路新增仍被拒绝
  const cyc = previewEdgeImpact(state, {
    action: 'add',
    parentId: '__proto__',
    childId: 'toString',
  });
  assert.match(cyc.error, /环路/);
});

test('删除成员影响预览：特殊 ID 成员的假设删除图正常计算', () => {
  const state = makeState(
    ['__proto__', 'constructor', 'toString'],
    [
      ['toString', 'constructor'],
      ['constructor', '__proto__'],
    ],
  );
  const r = previewMemberDeletion(state, 'constructor');
  assert.equal(r.error, undefined);
  assert.equal(r.removedEdgeCount, 2);
  // toString 与 __proto__ 之间唯一通路经过 constructor：删除后断联
  assert.equal(r.disconnectedCount, 1);
  assert.deepEqual(
    [r.disconnected[0].ancestorId, r.disconnected[0].descendantId],
    ['toString', '__proto__'],
  );
});

test('只读关系分析：特殊 ID 成员参与的各视图不抛异常且结果正确', () => {
  const state = makeState(
    ['__proto__', 'constructor', 'toString'],
    [
      ['toString', 'constructor'],
      ['constructor', '__proto__'],
    ],
  );

  // 辈分矛盾核查（链式无矛盾，但不抛异常）
  assert.equal(findGenerationConflicts(state).total, 0);

  // 共同祖先：链 toString → constructor → __proto__ 顶端是 toString（2 代）
  const common = findCommonAncestors(state, '__proto__', 'toString');
  assert.deepEqual(common.ancestors.map((a) => a.id), ['toString']);

  // 后代支系视图：从 toString 向下两代齐全
  const branches = descendantBranches(state, 'toString', 5);
  assert.deepEqual(
    branches.members.map((m) => m.id),
    ['toString', 'constructor', '__proto__'],
  );
  assert.equal(branches.edges.length, 2);

  // 桥梁分析：链式两条边都是关键连接
  const links = findCriticalLinks(state);
  assert.equal(links.bridgeCount, 2);
  assert.deepEqual(
    edgePairs(links.bridges),
    [
      ['constructor', '__proto__'],
      ['toString', 'constructor'],
    ],
  );

  // 整谱布局：三个节点分层、两条连线
  const chart = layoutFamilyChart(state, 1);
  assert.equal(chart.nodes.length, 3);
  assert.equal(chart.edges.length, 2);
  assert.deepEqual(
    edgePairs(chart.edges),
    [
      ['constructor', '__proto__'],
      ['toString', 'constructor'],
    ],
  );
});

/* ---------------- HTTP 全链路 ---------------- */

test('HTTP：特殊 ID 备份的恢复预览返回 200（不再 500），恢复后状态原样可见', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-proto-id-http-'));
  process.env.DATA_FILE = path.join(dir, 'family.json');
  const app = require('../server/index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    const content = JSON.stringify(protoBackup());

    // 恢复预览：200 且校验通过（旧实现抛异常返回 500）
    let res = await post('/api/backup/restore/preview', { content });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.valid, true);
    assert.equal(body.memberCount, 4);
    assert.equal(body.edgeCount, 3);
    assert.equal(body.version, 0);
    assert.ok(body.fingerprint);

    // 恢复确认：成功替换整个家谱
    res = await post('/api/backup/restore', {
      content,
      fingerprint: body.fingerprint,
      version: body.version,
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.members.length, 4);
    assert.equal(body.edges.length, 3);

    // 状态接口：成员 ID 与关系原样保留
    res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.deepEqual(
      state.members.map((m) => m.id).sort(),
      ['__proto__', 'constructor', 'hasOwnProperty', 'toString'].sort(),
    );
    assert.deepEqual(edgePairs(state.edges), [
      ['constructor', '__proto__'],
      ['hasOwnProperty', 'constructor'],
      ['toString', 'constructor'],
    ]);

    // 只读分析接口同样不再受特殊 ID 影响
    res = await fetch(`${base}/api/critical-links`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bridgeCount, 3);
    res = await fetch(`${base}/api/family-chart`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).nodes.length, 4);
  } finally {
    server.close();
  }
});
