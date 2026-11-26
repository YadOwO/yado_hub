import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { IDownstreamService } from '../../config/account-deletion.js';
import type { DataLinkSource } from '../../config/data-links.js';
import { AppError, ErrorCode } from '../../shared/errors.js';
import type { ItemValueSummaryDTO } from './schemas.js';
import {
  buildLinkList,
  fetchItemValueSummary,
  resolveItemValueSummary,
  type IResolveItemValueSummaryDeps,
} from './summary.js';

/** 测试用的 yadoi-be 服务 */
const SERVICE: IDownstreamService = { name: 'yadoi-be', baseUrl: 'http://yadoi-be:7788', token: 'c'.repeat(64) };

/** 来源后端的一份合法汇总 */
const SUMMARY: ItemValueSummaryDTO = {
  inServicePurchaseTotal: '1234.50',
  retiredPurchaseTotal: '300.00',
  pricedItemCount: 12,
  unpricedItemCount: 2,
  lastItemUpdatedAt: '2026-11-23T10:00:00.000Z',
};

/** 一次假 fetch 收到的请求 */
interface IRecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** 造一个按固定状态码和响应体返回的假 fetch，并记录收到的请求 */
function fakeFetch(status: number, body: unknown, requests: IRecordedRequest[] = []): typeof fetch {
  return (input, init) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  };
}

/** 判断是 502 DATA_LINK_UPSTREAM_FAILED */
function isUpstreamFailure(error: unknown): boolean {
  return error instanceof AppError && error.status === 502 && error.code === ErrorCode.DataLinkUpstreamFailed;
}

describe('fetchItemValueSummary', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('成功时原样返回汇总数', async () => {
    const result = await fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(200, SUMMARY) });
    assert.deepEqual(result, SUMMARY);
  });

  it('没有数据时的全 0 汇总也合契约', async () => {
    const empty: ItemValueSummaryDTO = {
      inServicePurchaseTotal: '0.00',
      retiredPurchaseTotal: '0.00',
      pricedItemCount: 0,
      unpricedItemCount: 0,
      lastItemUpdatedAt: null,
    };
    assert.deepEqual(await fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(200, empty) }), empty);
  });

  it('GET 到内部汇总接口，带这个服务的机器凭证，不跟随重定向，用户 ID 做 URL 编码', async () => {
    const requests: IRecordedRequest[] = [];
    await fetchItemValueSummary(SERVICE, 'user 1/é', { fetch: fakeFetch(200, SUMMARY, requests) });

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.url, 'http://yadoi-be:7788/internal/v1/users/user%201%2F%C3%A9/item-value-summary');
    assert.equal(request?.init?.method, 'GET');
    assert.equal(request?.init?.redirect, 'error');
    assert.deepEqual(request?.init?.headers, { Authorization: `Bearer ${'c'.repeat(64)}`, Accept: 'application/json' });
  });

  it('非 2xx 抛 502', async () => {
    for (const status of [301, 401, 404, 500, 503]) {
      await assert.rejects(
        fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(status, { code: 'X' }) }),
        isUpstreamFailure,
        `HTTP ${status}`,
      );
    }
  });

  it('网络错误抛 502', async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(fetchItemValueSummary(SERVICE, 'u1', { fetch: failingFetch }), isUpstreamFailure);
  });

  it('超时抛 502', async () => {
    // 一直挂起，直到 signal 被 abort 才 reject
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    // AbortSignal.timeout 的计时器不占住事件循环；服务里有 HTTP 监听占着，测试里要自己占住，否则进程会提前结束
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await assert.rejects(
        fetchItemValueSummary(SERVICE, 'u1', { fetch: hangingFetch, timeoutMs: 1 }),
        isUpstreamFailure,
      );
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('响应不是合法 JSON 抛 502', async () => {
    await assert.rejects(fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(200, 'not json') }), isUpstreamFailure);
  });

  it('字段不合契约抛 502：金额是 number、金额不是两位小数、件数为负或缺字段', async () => {
    const badBodies: unknown[] = [
      { ...SUMMARY, inServicePurchaseTotal: 1234.5 },
      { ...SUMMARY, retiredPurchaseTotal: '300' },
      { ...SUMMARY, pricedItemCount: -1 },
      { ...SUMMARY, unpricedItemCount: 1.5 },
      { ...SUMMARY, lastItemUpdatedAt: undefined },
      null,
      [],
    ];
    for (const body of badBodies) {
      await assert.rejects(
        fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(200, body) }),
        isUpstreamFailure,
        JSON.stringify(body),
      );
    }
  });

  it('lastItemUpdatedAt 不是 ISO 8601 时刻抛 502', async () => {
    for (const lastItemUpdatedAt of ['yesterday', '2026-11-23 10:00:00', '1732356000']) {
      await assert.rejects(
        fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(200, { ...SUMMARY, lastItemUpdatedAt }) }),
        isUpstreamFailure,
        lastItemUpdatedAt,
      );
    }
  });

  it('失败日志不带凭证与地址', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    await assert.rejects(fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(500, 'oops') }), isUpstreamFailure);
    const logged = errorLog.mock.calls.map((call) => JSON.stringify(call.arguments)).join('\n');
    assert.ok(logged.includes('data_link_upstream_failed'));
    assert.ok(logged.includes('yadoi-be'));
    assert.ok(!logged.includes(SERVICE.token));
    assert.ok(!logged.includes(SERVICE.baseUrl));
  });

  it('502 的错误响应不带地址与凭证', async () => {
    await assert.rejects(fetchItemValueSummary(SERVICE, 'u1', { fetch: fakeFetch(500, 'oops') }), (error) => {
      assert.ok(error instanceof AppError);
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      return !serialized.includes(SERVICE.token) && !serialized.includes('yadoi-be');
    });
  });
});

describe('resolveItemValueSummary', () => {
  /** 记录调用的假依赖 */
  function fakeDeps(options: { service: IDownstreamService | undefined; isGranted: boolean }): {
    calls: string[];
    deps: IResolveItemValueSummaryDeps;
  } {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        service: options.service,
        isGranted: (userId) => {
          calls.push(`isGranted:${userId}`);
          return Promise.resolve(options.isGranted);
        },
        fetchSummary: (service, userId) => {
          calls.push(`fetchSummary:${service.name}:${userId}`);
          return Promise.resolve(SUMMARY);
        },
        now: () => new Date('2026-11-24T08:00:00.000Z'),
      },
    };
  }

  it('来源没打开：404 DATA_LINK_UNAVAILABLE，不查授权也不调来源后端', async () => {
    const { calls, deps } = fakeDeps({ service: undefined, isGranted: true });
    await assert.rejects(
      resolveItemValueSummary('u1', deps),
      (error) =>
        error instanceof AppError && error.status === 404 && error.code === ErrorCode.DataLinkUnavailable,
    );
    assert.deepEqual(calls, []);
  });

  it('没授权：403 DATA_LINK_NOT_GRANTED，不调来源后端', async () => {
    const { calls, deps } = fakeDeps({ service: SERVICE, isGranted: false });
    await assert.rejects(
      resolveItemValueSummary('u1', deps),
      (error) =>
        error instanceof AppError && error.status === 403 && error.code === ErrorCode.DataLinkNotGranted,
    );
    assert.deepEqual(calls, ['isGranted:u1']);
  });

  it('已授权：返回汇总数并带上 fetchedAt', async () => {
    const { calls, deps } = fakeDeps({ service: SERVICE, isGranted: true });
    const result = await resolveItemValueSummary('u1', deps);
    assert.deepEqual(result, { ...SUMMARY, fetchedAt: '2026-11-24T08:00:00.000Z' });
    assert.deepEqual(calls, ['isGranted:u1', 'fetchSummary:yadoi-be:u1']);
  });

  it('来源后端失败：原样抛出，不吞掉', async () => {
    const failure = new AppError(502, ErrorCode.DataLinkUpstreamFailed, '获取联动数据失败');
    const { deps } = fakeDeps({ service: SERVICE, isGranted: true });
    await assert.rejects(
      resolveItemValueSummary('u1', { ...deps, fetchSummary: () => Promise.reject(failure) }),
      (error) => error === failure,
    );
  });
});

describe('buildLinkList', () => {
  it('没打开任何来源时返回空列表', () => {
    assert.deepEqual(buildLinkList([], new Map<DataLinkSource, Date>()), { links: [] });
    // 用户有授权记录但来源已被关掉时也不列出
    assert.deepEqual(buildLinkList([], new Map<DataLinkSource, Date>([['yadoi', new Date()]])), { links: [] });
  });

  it('已打开但没授权：granted 为 false，grantedAt 为 null', () => {
    assert.deepEqual(buildLinkList(['yadoi'], new Map<DataLinkSource, Date>()), {
      links: [
        { source: 'yadoi', target: 'yadoa', scope: 'item_value_summary', granted: false, grantedAt: null },
      ],
    });
  });

  it('已授权：granted 为 true，grantedAt 是 ISO 时间', () => {
    const grantedAt = new Date('2026-11-24T08:00:00.000Z');
    assert.deepEqual(buildLinkList(['yadoi'], new Map<DataLinkSource, Date>([['yadoi', grantedAt]])), {
      links: [
        {
          source: 'yadoi',
          target: 'yadoa',
          scope: 'item_value_summary',
          granted: true,
          grantedAt: '2026-11-24T08:00:00.000Z',
        },
      ],
    });
  });
});
