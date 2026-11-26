import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { IDownstreamService } from '../../config/account-deletion.js';
import { AppError, ErrorCode } from '../../shared/errors.js';
import {
  deleteAccountEverywhere,
  deleteUserFromService,
  resolveAccountDeletionPlan,
  type IAccountDeletionPlan,
  type IAccountDeletionSteps,
} from './deletion.js';

/** 测试用的三个下游服务 */
const SERVICES: IDownstreamService[] = [
  { name: 'yado-ai', baseUrl: 'http://yado-ai:7790', token: 'a'.repeat(64) },
  { name: 'yadoa-be', baseUrl: 'http://yadoa-be:7789', token: 'b'.repeat(64) },
  { name: 'yadoi-be', baseUrl: 'http://yadoi-be:7788', token: 'c'.repeat(64) },
];

/** 记录调用顺序的假步骤，可指定某一步抛错 */
class FakeSteps implements IAccountDeletionSteps {
  /** 已调用的步骤，按顺序（抛错的那一步也记录） */
  readonly calls: string[] = [];

  /**
   * @param failingStep 要抛错的那一步，取值同 calls 里的记录
   * @param error 抛出的错误
   */
  constructor(
    private readonly failingStep: string | null = null,
    readonly error: Error = new AppError(502, ErrorCode.AccountDeletionFailed, '注销没有完成'),
  ) {}

  /** 记录一次调用，被指定失败时抛错 */
  private record(step: string): void {
    this.calls.push(step);
    if (step === this.failingStep) {
      throw this.error;
    }
  }

  markUserDeleted(userId: string): Promise<void> {
    this.record(`markDeleted:${userId}`);
    return Promise.resolve();
  }

  deleteFeedback(userId: string): Promise<number> {
    this.record(`feedback:${userId}`);
    return Promise.resolve(2);
  }

  deleteDataLinks(userId: string): Promise<number> {
    this.record(`dataLinks:${userId}`);
    return Promise.resolve(1);
  }

  deleteFromService(service: IDownstreamService, userId: string): Promise<void> {
    this.record(`${service.name}:${userId}`);
    return Promise.resolve();
  }

  deleteLogtoUser(userId: string): Promise<void> {
    this.record(`logto:${userId}`);
    return Promise.resolve();
  }

  markCompleted(userId: string): Promise<void> {
    this.record(`completed:${userId}`);
    return Promise.resolve();
  }
}

/** 真实用户的完整计划 */
const FULL_PLAN: IAccountDeletionPlan = { services: SERVICES, shouldDeleteLogtoUser: true };

/** 判断是 502 ACCOUNT_DELETION_FAILED，且 details.step 是指定的那一步 */
function isDeletionFailure(step: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AppError &&
    error.status === 502 &&
    error.code === ErrorCode.AccountDeletionFailed &&
    JSON.stringify(error.details) === JSON.stringify({ step });
}

describe('deleteAccountEverywhere', () => {
  beforeEach(() => {
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('按顺序执行：注销名单 → 意见反馈 → 数据联动授权 → 各下游服务 → Logto → 记下完成', async () => {
    const steps = new FakeSteps();
    await deleteAccountEverywhere('u1', FULL_PLAN, steps);
    assert.deepEqual(steps.calls, [
      'markDeleted:u1',
      'feedback:u1',
      'dataLinks:u1',
      'yado-ai:u1',
      'yadoa-be:u1',
      'yadoi-be:u1',
      'logto:u1',
      'completed:u1',
    ]);
  });

  it('开发态免鉴权的计划不删 Logto 用户', async () => {
    const steps = new FakeSteps();
    await deleteAccountEverywhere('dev', { services: SERVICES.slice(0, 1), shouldDeleteLogtoUser: false }, steps);
    assert.deepEqual(steps.calls, [
      'markDeleted:dev',
      'feedback:dev',
      'dataLinks:dev',
      'yado-ai:dev',
      'completed:dev',
    ]);
  });

  it('中间一个下游服务失败：原样抛出，后面的服务、Logto 与完成标记都不执行', async () => {
    const steps = new FakeSteps('yadoa-be:u1');
    await assert.rejects(deleteAccountEverywhere('u1', FULL_PLAN, steps), (error) => error === steps.error);
    assert.deepEqual(steps.calls, ['markDeleted:u1', 'feedback:u1', 'dataLinks:u1', 'yado-ai:u1', 'yadoa-be:u1']);
  });

  it('删意见反馈失败：不删联动授权，也不调任何下游服务', async () => {
    const steps = new FakeSteps('feedback:u1', new Error('数据库不可用'));
    await assert.rejects(deleteAccountEverywhere('u1', FULL_PLAN, steps), (error) => error === steps.error);
    assert.deepEqual(steps.calls, ['markDeleted:u1', 'feedback:u1']);
  });

  it('删联动授权失败：后面的下游服务、Logto 与完成标记都不执行', async () => {
    const steps = new FakeSteps('dataLinks:u1', new Error('数据库不可用'));
    await assert.rejects(deleteAccountEverywhere('u1', FULL_PLAN, steps), (error) => error === steps.error);
    assert.deepEqual(steps.calls, ['markDeleted:u1', 'feedback:u1', 'dataLinks:u1']);
  });

  it('写注销名单失败：什么都不删', async () => {
    const steps = new FakeSteps('markDeleted:u1', new Error('数据库不可用'));
    await assert.rejects(deleteAccountEverywhere('u1', FULL_PLAN, steps), (error) => error === steps.error);
    assert.deepEqual(steps.calls, ['markDeleted:u1']);
  });

  it('Logto 失败：不记完成，重试时从头再走一遍', async () => {
    const failing = new FakeSteps('logto:u1');
    await assert.rejects(deleteAccountEverywhere('u1', FULL_PLAN, failing));
    assert.ok(!failing.calls.includes('completed:u1'));

    const retry = new FakeSteps();
    await deleteAccountEverywhere('u1', FULL_PLAN, retry);
    assert.equal(retry.calls[0], 'markDeleted:u1');
    assert.equal(retry.calls.at(-1), 'completed:u1');
  });
});

describe('resolveAccountDeletionPlan', () => {
  it('真实用户：Logto 与下游服务都配了才删，且删 Logto 用户', () => {
    assert.deepEqual(
      resolveAccountDeletionPlan({ services: SERVICES, isLogtoConfigured: true, isDevAuthBypassEnabled: false }),
      { services: SERVICES, shouldDeleteLogtoUser: true },
    );
  });

  it('真实用户缺 Logto 凭证或下游服务列表时返回 503，不悄悄跳过', () => {
    const isNotConfigured = (error: unknown): boolean =>
      error instanceof AppError && error.status === 503 && error.code === ErrorCode.ServiceNotConfigured;
    assert.throws(
      () => resolveAccountDeletionPlan({ services: SERVICES, isLogtoConfigured: false, isDevAuthBypassEnabled: false }),
      isNotConfigured,
    );
    assert.throws(
      () => resolveAccountDeletionPlan({ services: [], isLogtoConfigured: true, isDevAuthBypassEnabled: false }),
      isNotConfigured,
    );
  });

  it('开发态免鉴权：不删 Logto 用户，下游服务配了几个调几个', () => {
    assert.deepEqual(
      resolveAccountDeletionPlan({ services: [], isLogtoConfigured: false, isDevAuthBypassEnabled: true }),
      { services: [], shouldDeleteLogtoUser: false },
    );
    assert.deepEqual(
      resolveAccountDeletionPlan({ services: SERVICES, isLogtoConfigured: true, isDevAuthBypassEnabled: true }),
      { services: SERVICES, shouldDeleteLogtoUser: false },
    );
  });
});

/** 一次假 fetch 收到的请求 */
interface IRecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** 造一个按固定状态码返回的假 fetch，并记录收到的请求 */
function fakeFetch(status: number, requests: IRecordedRequest[] = []): typeof fetch {
  return (input, init) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(new Response(status === 204 ? null : '{"deleted":true}', { status }));
  };
}

describe('deleteUserFromService', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  const service = SERVICES[0] ?? { name: 'missing', baseUrl: 'http://missing', token: 'x'.repeat(64) };

  it('发 DELETE 到内部删除接口，带这个服务的机器凭证，不跟随重定向', async () => {
    const requests: IRecordedRequest[] = [];
    await deleteUserFromService(service, 'user 1/é', { fetch: fakeFetch(200, requests) });

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.url, 'http://yado-ai:7790/internal/v1/users/user%201%2F%C3%A9');
    assert.equal(request?.init?.method, 'DELETE');
    assert.equal(request?.init?.redirect, 'error');
    assert.deepEqual(request?.init?.headers, { Authorization: `Bearer ${'a'.repeat(64)}`, Accept: 'application/json' });
  });

  it('2xx 都算成功', async () => {
    await deleteUserFromService(service, 'u1', { fetch: fakeFetch(200) });
    await deleteUserFromService(service, 'u1', { fetch: fakeFetch(204) });
  });

  it('非 2xx 抛 502，details.step 是服务名', async () => {
    for (const status of [301, 401, 404, 500, 503]) {
      await assert.rejects(
        deleteUserFromService(service, 'u1', { fetch: fakeFetch(status) }),
        isDeletionFailure('yado-ai'),
        `HTTP ${status}`,
      );
    }
  });

  it('网络错误抛 502', async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(deleteUserFromService(service, 'u1', { fetch: failingFetch }), isDeletionFailure('yado-ai'));
  });

  it('超时抛 502', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    // AbortSignal.timeout 的计时器不占住事件循环；服务里有 HTTP 监听占着，测试里要自己占住，否则进程会提前结束
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await assert.rejects(
        deleteUserFromService(service, 'u1', { fetch: hangingFetch, timeoutMs: 20 }),
        isDeletionFailure('yado-ai'),
      );
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('日志不带凭证', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    await assert.rejects(deleteUserFromService(service, 'u1', { fetch: fakeFetch(500) }));
    const logged = errorLog.mock.calls.map((call) => JSON.stringify(call.arguments)).join('\n');
    assert.ok(logged.includes('yado-ai'));
    assert.ok(!logged.includes(service.token));
  });
});
