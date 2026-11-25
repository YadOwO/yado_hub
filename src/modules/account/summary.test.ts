import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { IDownstreamService } from '../../config/account-deletion.js';
import { collectAccountSummary, fetchServiceSummary, type IServiceSummary } from './summary.js';

/** 测试用的三个下游服务 */
const SERVICES: IDownstreamService[] = [
  { name: 'yado-ai', baseUrl: 'http://yado-ai:7790', token: 'a'.repeat(64) },
  { name: 'yadoa-be', baseUrl: 'http://yadoa-be:7789', token: 'b'.repeat(64) },
  { name: 'yadoi-be', baseUrl: 'http://yadoi-be:7788', token: 'c'.repeat(64) },
];

/** 一次假 fetch 收到的请求 */
interface IRecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** 造一个 JSON 响应 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 造一个每次都返回 response() 的假 fetch，并记录收到的请求 */
function fakeFetch(response: () => Response, requests: IRecordedRequest[] = []): typeof fetch {
  return (input, init) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(response());
  };
}

/** 按下游地址分别处理请求的假 fetch：handlers 的 key 是服务的 baseUrl */
function hostFetch(
  handlers: Readonly<Record<string, () => Promise<Response>>>,
  requests: IRecordedRequest[] = [],
): typeof fetch {
  return (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const handler = Object.entries(handlers).find(([baseUrl]) => url.startsWith(`${baseUrl}/`))?.[1];
    return handler === undefined ? Promise.reject(new TypeError('没有这个地址的假响应')) : handler();
  };
}

/** 等一会儿，用来让并行的请求有机会同时在途 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把被 mock 的 console.error 的调用记录拼成一个字符串，方便断言日志里有没有某段内容 */
function loggedErrors(calls: ReadonlyArray<{ arguments: unknown }>): string {
  return calls.map((call) => JSON.stringify(call.arguments)).join('\n');
}

describe('fetchServiceSummary', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  const service = SERVICES[0] ?? { name: 'missing', baseUrl: 'http://missing', token: 'x'.repeat(64) };

  it('发 GET 到内部汇总接口，带这个服务的机器凭证，不跟随重定向', async () => {
    const requests: IRecordedRequest[] = [];
    await fetchServiceSummary(service, 'user 1/é', {
      fetch: fakeFetch(() => jsonResponse(200, { items: [] }), requests),
    });

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.url, 'http://yado-ai:7790/internal/v1/users/user%201%2F%C3%A9/summary');
    assert.equal(request?.init?.method, 'GET');
    assert.equal(request?.init?.redirect, 'error');
    assert.deepEqual(request?.init?.headers, { Authorization: `Bearer ${'a'.repeat(64)}`, Accept: 'application/json' });
    assert.ok(request?.init?.signal instanceof AbortSignal);
  });

  it('2xx 且响应体符合约定：返回 ok 和各项，多余的字段忽略', async () => {
    const result = await fetchServiceSummary(service, 'u1', {
      fetch: fakeFetch(() =>
        jsonResponse(200, { items: [{ key: 'points_balance', count: 120, extra: 'x' }, { key: 'other_1', count: 0 }], note: 'x' }),
      ),
    });
    assert.deepEqual(result, {
      service: 'yado-ai',
      status: 'ok',
      items: [
        { key: 'points_balance', count: 120 },
        { key: 'other_1', count: 0 },
      ],
    });
  });

  it('没有数据（items 为空）也是 ok', async () => {
    const result = await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(() => jsonResponse(200, { items: [] })) });
    assert.deepEqual(result, { service: 'yado-ai', status: 'ok', items: [] });
  });

  it('非 2xx 标为 unavailable，不抛错', async () => {
    for (const status of [301, 401, 404, 500, 503]) {
      const result = await fetchServiceSummary(service, 'u1', {
        fetch: fakeFetch(() => jsonResponse(status, { items: [{ key: 'points_balance', count: 5 }] })),
      });
      assert.deepEqual(result, { service: 'yado-ai', status: 'unavailable', items: [] }, `HTTP ${status}`);
    }
  });

  it('网络错误标为 unavailable', async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const result = await fetchServiceSummary(service, 'u1', { fetch: failingFetch });
    assert.deepEqual(result, { service: 'yado-ai', status: 'unavailable', items: [] });
  });

  it('超时标为 unavailable', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    // AbortSignal.timeout 的计时器不占住事件循环；服务里有 HTTP 监听占着，测试里要自己占住，否则进程会提前结束
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      const result = await fetchServiceSummary(service, 'u1', { fetch: hangingFetch, timeoutMs: 20 });
      assert.deepEqual(result, { service: 'yado-ai', status: 'unavailable', items: [] });
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('响应体格式不对标为 unavailable', async () => {
    const bodies: unknown[] = [
      null,
      'items',
      {},
      { items: null },
      { items: {} },
      { items: [{ key: 'points_balance' }] },
      { items: [{ count: 1 }] },
      { items: [{ key: 'Points', count: 1 }] },
      { items: [{ key: 'points-balance', count: 1 }] },
      { items: [{ key: '', count: 1 }] },
      { items: [{ key: 'a'.repeat(65), count: 1 }] },
      { items: [{ key: 'points_balance', count: -1 }] },
      { items: [{ key: 'points_balance', count: 1.5 }] },
      { items: [{ key: 'points_balance', count: '5' }] },
      { items: Array.from({ length: 21 }, (_, index) => ({ key: `key_${index}`, count: 1 })) },
    ];
    for (const body of bodies) {
      const result = await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(() => jsonResponse(200, body)) });
      assert.deepEqual(result, { service: 'yado-ai', status: 'unavailable', items: [] }, JSON.stringify(body));
    }
  });

  it('响应体不是 JSON 或为空标为 unavailable', async () => {
    for (const response of [() => new Response('not json', { status: 200 }), () => new Response(null, { status: 204 })]) {
      const result = await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(response) });
      assert.deepEqual(result, { service: 'yado-ai', status: 'unavailable', items: [] });
    }
  });

  it('items 刚好 20 项时仍然通过（上限是 20）', async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ key: `key_${index}`, count: 1 }));
    const result = await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(() => jsonResponse(200, { items })) });
    assert.equal(result.status, 'ok');
    assert.equal(result.items.length, 20);
  });

  it('日志记录服务名、用户 ID 与失败原因，不带凭证', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(() => jsonResponse(500, {})) });
    await fetchServiceSummary(service, 'u1', { fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await fetchServiceSummary(service, 'u1', { fetch: fakeFetch(() => jsonResponse(200, { items: 'bad' })) });

    const logged = loggedErrors(errorLog.mock.calls);
    assert.ok(logged.includes('account_summary_service_failed'));
    assert.ok(logged.includes('yado-ai'));
    assert.ok(logged.includes('u1'));
    assert.ok(logged.includes('500'));
    assert.ok(logged.includes('TypeError'));
    assert.ok(!logged.includes(service.token));
  });
});

describe('collectAccountSummary', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  /** 一个返回给定 JSON 响应的下游，delayMs 后才响应 */
  function respondWith(status: number, body: unknown, delayMs = 0): () => Promise<Response> {
    return async () => {
      await delay(delayMs);
      return jsonResponse(status, body);
    };
  }

  it('并行调各下游：三个请求同时在途', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    /** 记录同时在途的请求数，再按给定内容响应 */
    const tracked =
      (body: unknown) =>
      async (): Promise<Response> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(20);
        inFlight -= 1;
        return jsonResponse(200, body);
      };
    await collectAccountSummary(SERVICES, 'u1', {
      fetch: hostFetch({
        'http://yado-ai:7790': tracked({ items: [{ key: 'points_balance', count: 1 }] }),
        'http://yadoa-be:7789': tracked({ items: [{ key: 'synced_records', count: 1 }] }),
        'http://yadoi-be:7788': tracked({ items: [{ key: 'items', count: 1 }] }),
      }),
    });
    assert.equal(maxInFlight, 3);
  });

  it('结果的顺序和配置一致，与谁先响应无关', async () => {
    const result = await collectAccountSummary(SERVICES, 'u1', {
      fetch: hostFetch({
        'http://yado-ai:7790': respondWith(200, { items: [{ key: 'points_balance', count: 5 }] }, 40),
        'http://yadoa-be:7789': respondWith(200, { items: [{ key: 'synced_records', count: 3 }] }, 0),
        'http://yadoi-be:7788': respondWith(200, { items: [{ key: 'items', count: 2 }] }, 10),
      }),
    });
    assert.deepEqual(
      result.services.map((summary) => summary.service),
      ['yado-ai', 'yadoa-be', 'yadoi-be'],
    );
    assert.deepEqual(result, {
      services: [
        { service: 'yado-ai', status: 'ok', items: [{ key: 'points_balance', count: 5 }] },
        { service: 'yadoa-be', status: 'ok', items: [{ key: 'synced_records', count: 3 }] },
        { service: 'yadoi-be', status: 'ok', items: [{ key: 'items', count: 2 }] },
      ],
    });
  });

  it('去掉数量为 0 的项，一项都不剩的服务也去掉', async () => {
    const result = await collectAccountSummary(SERVICES, 'u1', {
      fetch: hostFetch({
        'http://yado-ai:7790': respondWith(200, {
          items: [
            { key: 'points_balance', count: 0 },
            { key: 'bonus_points', count: 7 },
          ],
        }),
        'http://yadoa-be:7789': respondWith(200, { items: [{ key: 'synced_records', count: 0 }] }),
        'http://yadoi-be:7788': respondWith(200, { items: [] }),
      }),
    });
    assert.deepEqual(result, {
      services: [{ service: 'yado-ai', status: 'ok', items: [{ key: 'bonus_points', count: 7 }] }],
    });
  });

  it('某个下游失败只影响它自己：标为 unavailable 并保留位置，其他照常', async () => {
    const result = await collectAccountSummary(SERVICES, 'u1', {
      fetch: hostFetch({
        'http://yado-ai:7790': respondWith(200, { items: [{ key: 'points_balance', count: 5 }] }),
        'http://yadoa-be:7789': () => Promise.reject(new TypeError('fetch failed')),
        'http://yadoi-be:7788': respondWith(500, {}),
      }),
    });
    const expected: IServiceSummary[] = [
      { service: 'yado-ai', status: 'ok', items: [{ key: 'points_balance', count: 5 }] },
      { service: 'yadoa-be', status: 'unavailable', items: [] },
      { service: 'yadoi-be', status: 'unavailable', items: [] },
    ];
    assert.deepEqual(result, { services: expected });
  });

  it('全部下游都失败也正常返回，不抛错', async () => {
    const result = await collectAccountSummary(SERVICES, 'u1', {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    assert.deepEqual(
      result.services.map((summary) => [summary.service, summary.status]),
      [
        ['yado-ai', 'unavailable'],
        ['yadoa-be', 'unavailable'],
        ['yadoi-be', 'unavailable'],
      ],
    );
  });

  it('没配置下游时返回空列表', async () => {
    const requests: IRecordedRequest[] = [];
    const result = await collectAccountSummary([], 'u1', { fetch: fakeFetch(() => jsonResponse(200, { items: [] }), requests) });
    assert.deepEqual(result, { services: [] });
    assert.equal(requests.length, 0);
  });

  it('每个下游用自己的凭证，日志不带任何凭证', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    const requests: IRecordedRequest[] = [];
    await collectAccountSummary(SERVICES, 'u1', { fetch: fakeFetch(() => jsonResponse(500, {}), requests) });

    const tokensSent = requests.map((request) => new Headers(request.init?.headers).get('Authorization')).sort();
    assert.deepEqual(
      tokensSent,
      SERVICES.map((service) => `Bearer ${service.token}`).sort(),
    );
    const logged = loggedErrors(errorLog.mock.calls);
    for (const service of SERVICES) {
      assert.ok(logged.includes(service.name));
      assert.ok(!logged.includes(service.token));
    }
  });
});
