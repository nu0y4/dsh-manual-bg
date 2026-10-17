// client 半边单测：在 Node 里 mock ModuleLoader/react，验证
//   1) bundle 导出 apply/inject，注册 tool.call.toolview（key = run）
//   2) running 行 = 命令行 + 仅 SVG 图标的按钮（无文字、无输出块）
//   3) result 行 = 单行（无 pre、不渲染输出）
//   4) 点按钮会 POST /manual-bg/promote
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
    props: { ...node.props, children: Array.isArray(kids) ? kids.map((k) => expand(k, depth + 1)) : expand(kids, depth + 1) },
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

// running：单行 = code + button，按钮只有 svg
const running = expand(
  RunCard({ phase: 'start', block: { phase: 'start', name: 'run', argsRaw: args }, callId: 'call_a' })
);
assert.equal(running.type, 'div');
assert.deepEqual(
  running.props.children.map((c) => c.type),
  ['code', 'button'],
  'running 行应为：命令行 + 按钮'
);
assert.equal(countType(running, 'pre'), 0, 'running 不应有输出块');
const btn = running.props.children.find((c) => c.type === 'button');
assert.deepEqual(btn.props.children.map((c) => c.type), ['svg'], '按钮应只含 SVG 图标');
assert.ok(
  !btn.props.children.some((c) => typeof c === 'string'),
  '按钮不应包含可见文本子节点'
);

// 点击 -> POST promote
btn.props.onClick();
await new Promise((r) => setTimeout(r, 20));
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, '/manual-bg/promote');
assert.equal(fetchCalls[0].body, JSON.stringify({ callId: 'call_a' }));

// result：单行、无输出块、无「已转后台」文字
const result = expand(
  RunCard({
    phase: 'result',
    block: {
      kind: 'tool-result',
      isError: false,
      call: { name: 'run', argsRaw: args },
      content: [{ type: 'text', text: '这段输出不应渲染到卡片里' }],
    },
    callId: 'call_a',
  })
);
assert.deepEqual(result.props.children.map((c) => c.type), ['code', 'span']);
assert.equal(countType(result, 'pre'), 0, 'result 不应有输出块');
assert.ok(!JSON.stringify(result).includes('不应渲染'), 'result 不应渲染输出文本');

console.log('client-view.test: all assertions passed ✅');
