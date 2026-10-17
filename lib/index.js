/**
 * dsh-manual-bg — 手动转后台插件的 host 半边。
 *
 * 职责只有两件：
 *  1. 提供一个进程级服务 `manualBackground`（ctx.provide），让 agent 平面的
 *     `run` 工具在等待前台命令时登记一个「可被唤醒」的等待器（按 tool callId）。
 *  2. 在 web server 上注册 `/manual-bg/promote`，浏览器里命令卡片上的 SVG 按钮
 *     点一下 → POST {callId} → 唤醒对应等待器 → 工具立刻返回 job id，命令继续在
 *     后台跑（进程本来就是 ctx.jobs 里注册的后台 job，只是不再前台等它）。
 *
 * 安全说明：路由只做「把已登记的前台等待转为后台」，不接受任意命令、不读数据；
 * 仅由本机浏览器同源页面调用。服务不可用时工具体感等同官方 pwsh 工具。
 */

export const name = 'dsh-manual-bg';

/** 需要 web server 就绪后注册路由。 */
export const inject = ['webServer'];

/** 浏览器按钮调用的固定路径。 */
const PROMOTE_PATH = '/manual-bg/promote';
/** 调试探活路径。 */
const PING_PATH = '/manual-bg/ping';
/** 请求体上限（只需要一个 callId）。 */
const MAX_BODY_BYTES = 8192;

/**
 * 创建 promote 等待表。
 * @returns {{
 *   begin: (callId: string) => {promise: Promise<void>, dispose: () => void} | undefined,
 *   promote: (callId: string) => boolean,
 *   pendingCount: () => number,
 * }}
 */
function createManualBackground() {
  /** @type {Map<string, {promise: Promise<void>, resolve: () => void}>} */
  const pending = new Map();
  return {
    /**
     * 登记一次前台等待。返回的 promise 在 promote() 命中时 resolve。
     * @param {string} callId 工具调用的 callId
     */
    begin(callId) {
      if (typeof callId !== 'string' || callId.length === 0) return undefined;
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      const entry = { promise, resolve };
      pending.set(callId, entry);
      return {
        promise,
        dispose: () => {
          if (pending.get(callId) === entry) pending.delete(callId);
        },
      };
    },
    /**
     * 唤醒一次等待。
     * @param {string} callId 工具调用的 callId
     * @returns {boolean} 是否命中了在等待的调用
     */
    promote(callId) {
      const entry = pending.get(callId);
      if (entry === undefined) return false;
      pending.delete(callId);
      entry.resolve();
      return true;
    },
    pendingCount: () => pending.size,
  };
}

/** 读取一个 JSON 请求体（带大小上限）。 */
function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        body = '';
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body === '' ? '{}' : body);
        resolveBody(typeof parsed === 'object' && parsed !== null ? parsed : {});
      } catch {
        resolveBody(null);
      }
    });
    req.on('error', () => resolveBody(null));
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const manual = createManualBackground();
  ctx.provide('manualBackground', manual);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROMOTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { ok: false, error: 'invalid json' });
            return;
          }
          const callId = typeof body.callId === 'string' ? body.callId : '';
          const promoted = manual.promote(callId);
          sendJson(res, 200, { ok: true, promoted });
        },
      }),
    'manual-bg: promote route'
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PING_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          sendJson(res, 200, { ok: true, pending: manual.pendingCount() });
        },
      }),
    'manual-bg: ping route'
  );
}
