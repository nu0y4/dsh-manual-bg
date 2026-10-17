// host 半边单测：服务注册、两条 HTTP 路由、promote 命中/未命中、坏请求。
// 运行：node test/host-service.test.mjs
import { apply } from '../lib/index.js';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';

const routes = new Map();
const provided = {};
const ctx = {
  provide(name, value) {
    provided[name] = value;
  },
  effect(cb) {
    return cb();
  },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  logger: { warn() {}, error() {}, info() {} },
};

apply(ctx);

const manual = provided.manualBackground;
assert.ok(manual, 'manualBackground 服务应已 provide');
assert.ok(routes.has('/manual-bg/promote'), 'promote 路由应已注册');
assert.ok(routes.has('/manual-bg/ping'), 'ping 路由应已注册');

function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.setEncoding = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', body);
    req.emit('end');
  });
  return req;
}
function makeRes() {
  return {
    writableEnded: false,
    status: null,
    payload: null,
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.writableEnded = true;
      this.payload = b;
    },
  };
}
async function callRoute(pathName, method, body) {
  const route = routes.get(pathName);
  const req = makeReq(method, body);
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.status, json: JSON.parse(res.payload ?? '{}') };
}

// ping
let r = await callRoute('/manual-bg/ping', 'GET');
assert.equal(r.status, 200);
assert.equal(r.json.ok, true);

// 登记一个等待器，未知 callId 不命中
const wait = manual.begin('call-1');
let resolved = false;
wait.promise.then(() => {
  resolved = true;
});
r = await callRoute('/manual-bg/promote', 'POST', JSON.stringify({ callId: 'nope' }));
assert.equal(r.status, 200);
assert.equal(r.json.promoted, false, '未知 callId 不应命中');
assert.equal(resolved, false);

r = await callRoute('/manual-bg/ping', 'GET');
assert.equal(r.json.pending, 1, '应有 1 个待转等待器');

// 命中并唤醒
r = await callRoute('/manual-bg/promote', 'POST', JSON.stringify({ callId: 'call-1' }));
assert.equal(r.json.promoted, true, '已知 callId 应命中');
await new Promise((res2) => setTimeout(res2, 20));
assert.equal(resolved, true, '等待器 promise 应被 resolve');
r = await callRoute('/manual-bg/ping', 'GET');
assert.equal(r.json.pending, 0, '命中后 pending 应清零');

// dispose 幂等
wait.dispose();
wait.dispose();

// 坏请求
r = await callRoute('/manual-bg/promote', 'POST', '{not json');
assert.equal(r.status, 400);
r = await callRoute('/manual-bg/promote', 'GET');
assert.equal(r.status, 405);

console.log('host-service.test: all assertions passed ✅');
