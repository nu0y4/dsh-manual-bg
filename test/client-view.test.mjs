// client 半边单测：在 Node 里 mock ModuleLoader/react，验证
//   1) bundle 导出 apply/inject，注册 tool.call.toolview（key = run）
//   2) 默认折叠：单行 = 命令行 + 仅 SVG 图标的按钮（无文字、无输出块）
//   3) 整行可点击（role=button / aria-expanded / onClick / 键盘 Enter）
//   4) 按钮点击会 stopPropagation 并 POST /manual-bg/promote
//   5) 折叠时不渲染输出；展开时渲染完整命令 + 输出预览
// 运行：node test/client-view.test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const code = fs.readFileSync(clientPath, 'utf8');

const modules = {
  react: { useState: (initial) => [initial, () => {}] },
  'react/jsx-runtime': {
    jsx: (type, props) => ({ type, props: props ?? {} }),
    jsxs: (type, props) => ({ type, props: props ?? {} }),
    Fragment: 'Fragment',
  },
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded = def;
    },
  },
};
const fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, body: opts?.body });
  return { json: async () => ({ ok: true, promoted: true }) };
};

new Function(code)();
assert.ok(loaded, 'ModuleLoader.load 应被调用');
assert.equal(loaded.id, 'dsh-manual-bg');

const exportsObj = loaded.factory((spec) => {
  assert.ok(spec in modules, `unexpected require: ${spec}`);
  return modules[spec];
});
assert.equal(typeof exportsObj.apply, 'function');
assert.deepEqual(exportsObj.inject, ['slots']);

const registered = [];
exportsObj.apply({
  effect: (cb) => cb(),
  slots: {
    inject: (_name, cb) => cb(),
    register: (def, component) => {
      registered.push({ def, component });
      return () => {};
    },
  },
});
assert.equal(registered.length, 1);
assert.deepEqual(registered[0].def, { name: 'tool.call.toolview', key: 'run' });

const RunCard = registered[0].component;
assert.equal(typeof RunCard, 'function');

/** 递归展开函数组件元素，得到可断言的 DOM 树。 */
function expand(node, depth = 0) {
  if (node == null || depth > 40) return node;
  if (typeof node === 'function') return expand(node({}), depth + 1);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props), depth + 1);
  const kids = node.props?.children;
  return {
    ...node,
    props: {
      ...node.props,
      children: Array.isArray(kids) ? kids.map((k) => expand(k, depth + 1)) : expand(kids, depth + 1),
    },
  };
}
function find(node, pred) {
  if (node == null || typeof node !== 'object') return null;
  if (pred(node)) return node;
  const kids = node.props?.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const hit = find(k, pred);
    if (hit) return hit;
  }
  return null;
}
function countType(node, type) {
  if (node == null || typeof node !== 'object') return 0;
  let n = node.type === type ? 1 : 0;
  const kids = node.props?.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) n += countType(k, type);
  return n;
}
const args = JSON.stringify({ command: 'Start-Sleep -Seconds 60' });

// ── running：默认折叠 = 根 div > [行 div, null]，行 = code + button
const running = expand(
  RunCard({ phase: 'start', block: { phase: 'start', name: 'run', argsRaw: args }, callId: 'call_a' })
);
assert.equal(running.type, 'div');
assert.deepEqual(
  running.props.children.map((c) => (c === null ? null : c.type)),
  ['div', null],
  '折叠时根节点应为「行 + 无预览」'
);
const head = running.props.children[0];
assert.deepEqual(head.props.children.map((c) => c.type), ['code', 'button'], '行应为：命令行 + 按钮');
assert.equal(countType(running, 'pre'), 0, '默认折叠不应有预览块');

// 可点击 / 可键盘展开
assert.equal(head.props.role, 'button', '行应可点击（role=button）');
assert.equal(head.props.tabIndex, 0, '行应可聚焦');
assert.equal(head.props['aria-expanded'], false, '默认 aria-expanded=false');
assert.equal(typeof head.props.onClick, 'function', '行应有 onClick 展开');
assert.equal(typeof head.props.onKeyDown, 'function', '行应支持键盘展开');
let prevented = false;
head.props.onKeyDown({ key: 'Enter', preventDefault: () => (prevented = true) });
assert.equal(prevented, true, 'Enter 应 preventDefault');
assert.match(String(head.props.title), /展开/, '行 tooltip 应提示可展开');

// 按钮只含 SVG，点击 stopPropagation + POST promote
const btn = head.props.children.find((c) => c.type === 'button');
assert.deepEqual(btn.props.children.map((c) => c.type), ['svg'], '按钮应只含 SVG 图标');
assert.ok(!btn.props.children.some((c) => typeof c === 'string'), '按钮不应包含可见文本子节点');
let stopped = false;
btn.props.onClick({ stopPropagation: () => (stopped = true) });
assert.equal(stopped, true, '按钮点击应 stopPropagation，避免触发行展开');
await new Promise((r) => setTimeout(r, 20));
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, '/manual-bg/promote');
assert.equal(fetchCalls[0].body, JSON.stringify({ callId: 'call_a' }));

// ── result：折叠时不渲染输出块/输出文本
const result = expand(
  RunCard({
    phase: 'result',
    block: {
      kind: 'tool-result',
      isError: false,
      call: { name: 'run', argsRaw: args },
      content: [{ type: 'text', text: '这段输出不应渲染到折叠卡片里' }],
    },
    callId: 'call_a',
  })
);
assert.equal(countType(result, 'pre'), 0, '折叠时 result 不应有输出块');
assert.ok(!JSON.stringify(result).includes('不应渲染'), '折叠时 result 不应渲染输出文本');

// ── 展开场景：mock useState(false) 返回 true（模拟用户点击后展开）
const modulesOpen = {
  ...modules,
  react: {
    useState: (initial) => (initial === false ? [true, () => {}] : [initial, () => {}]),
  },
};
let loadedOpen = null;
globalThis.window = { __ModuleLoader__: { load: (d) => (loadedOpen = d) } };
new Function(code)();
const expOpen = loadedOpen.factory((s) => modulesOpen[s]);
const regOpen = [];
expOpen.apply({
  effect: (cb) => cb(),
  slots: {
    inject: (_n, cb) => cb(),
    register: (d, c) => {
      regOpen.push(c);
      return () => {};
    },
  },
});
const openTree = expand(
  regOpen[0]({
    phase: 'result',
    block: {
      kind: 'tool-result',
      isError: false,
      call: { name: 'run', argsRaw: args },
      content: [{ type: 'text', text: '展开后可见的输出' }],
    },
    callId: 'call_a',
  })
);
assert.equal(countType(openTree, 'pre'), 1, '展开时应渲染一个 pre 预览块');
assert.ok(JSON.stringify(openTree).includes('展开后可见的输出'), '展开时应显示输出文本');
assert.ok(JSON.stringify(openTree).includes('Start-Sleep -Seconds 60'), '展开时应显示完整命令');
const openHead = openTree.props.children[0];
assert.equal(openHead.props['aria-expanded'], true, '展开时 aria-expanded=true');

console.log('client-view.test: all assertions passed ✅');
