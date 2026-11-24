import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { AppError, ErrorCode } from './errors.js';
import { createLogtoManagementClient, type ILogtoManagementConfig } from './logto-management.js';

/** 测试用的 Management API 配置 */
const CONFIG: ILogtoManagementConfig = {
  tokenUrl: 'https://accounts.example.invalid/oidc/token',
  apiBaseUrl: 'https://accounts.example.invalid/api',
  resource: 'https://default.logto.app/api',
  appId: 'm2m-app',
  appSecret: 'm2m-secret',
};

/** 一次假 fetch 收到的请求 */
interface IRecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/**
 * 假的 Logto：换 token 返回 tokenStatus（200 时带 token），删用户依次返回 deleteStatuses 里的状态码。
 */
class FakeLogto {
  readonly requests: IRecordedRequest[] = [];
  /** 已发出的 token 数，用来区分每次换到的 token */
  private issuedTokens = 0;

  constructor(
    private readonly deleteStatuses: number[],
    private readonly tokenStatus = 200,
    private readonly tokenBody: unknown = null,
  ) {}

  /** 换 token 的请求数 */
  get tokenRequestCount(): number {
    return this.requests.filter((request) => request.url === CONFIG.tokenUrl).length;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = String(input);
    this.requests.push({ url, init });
    if (url === CONFIG.tokenUrl) {
      if (this.tokenStatus !== 200) {
        return Promise.resolve(new Response('{}', { status: this.tokenStatus }));
      }
      this.issuedTokens += 1;
      const body = this.tokenBody ?? { access_token: `token-${this.issuedTokens}`, expires_in: 3600 };
      return Promise.resolve(Response.json(body));
    }
    const status = this.deleteStatuses.shift() ?? 500;
    return Promise.resolve(new Response(status === 204 ? null : '{}', { status }));
  };
}

/** 判断是 502 ACCOUNT_DELETION_FAILED，且 details.step 是 logto */
function isLogtoFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.status === 502 &&
    error.code === ErrorCode.AccountDeletionFailed &&
    JSON.stringify(error.details) === JSON.stringify({ step: 'logto' })
  );
}

describe('createLogtoManagementClient', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('先用 client_credentials 换 token，再带 token 删除用户', async () => {
    const logto = new FakeLogto([204]);
    await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).deleteUser('user/1');

    const [tokenRequest, deleteRequest] = logto.requests;
    assert.equal(tokenRequest?.url, CONFIG.tokenUrl);
    assert.equal(tokenRequest?.init?.method, 'POST');
    const tokenHeaders = new Headers(tokenRequest?.init?.headers);
    assert.equal(tokenHeaders.get('Authorization'), `Basic ${Buffer.from('m2m-app:m2m-secret').toString('base64')}`);
    const form = new URLSearchParams(String(tokenRequest?.init?.body));
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('resource'), CONFIG.resource);
    assert.equal(form.get('scope'), 'all');

    assert.equal(deleteRequest?.url, 'https://accounts.example.invalid/api/users/user%2F1');
    assert.equal(deleteRequest?.init?.method, 'DELETE');
    assert.equal(new Headers(deleteRequest?.init?.headers).get('Authorization'), 'Bearer token-1');
  });

  it('用户已经删过（404）也算成功', async () => {
    const logto = new FakeLogto([404]);
    await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).deleteUser('u1');
  });

  it('token 在有效期内复用，不重复换', async () => {
    const logto = new FakeLogto([204, 204]);
    const client = createLogtoManagementClient(CONFIG, { fetch: logto.fetch });
    await client.deleteUser('u1');
    await client.deleteUser('u2');
    assert.equal(logto.tokenRequestCount, 1);
  });

  it('删除返回 401 时抛 502，并丢掉缓存的 token，下次换新的', async () => {
    const logto = new FakeLogto([401, 204]);
    const client = createLogtoManagementClient(CONFIG, { fetch: logto.fetch });
    await assert.rejects(client.deleteUser('u1'), isLogtoFailure);
    await client.deleteUser('u1');
    assert.equal(logto.tokenRequestCount, 2);
    assert.equal(new Headers(logto.requests.at(-1)?.init?.headers).get('Authorization'), 'Bearer token-2');
  });

  it('删除返回其他错误状态码时抛 502', async () => {
    const logto = new FakeLogto([500]);
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).deleteUser('u1'), isLogtoFailure);
  });

  it('换 token 失败、响应缺字段或网络错误时抛 502，不发删除请求', async () => {
    const rejected = new FakeLogto([204], 400);
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: rejected.fetch }).deleteUser('u1'), isLogtoFailure);
    assert.equal(rejected.requests.length, 1);

    const malformed = new FakeLogto([204], 200, { token_type: 'Bearer' });
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: malformed.fetch }).deleteUser('u1'), isLogtoFailure);

    const offline: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: offline }).deleteUser('u1'), isLogtoFailure);
  });

  it('日志不带 token 与密钥', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    const logto = new FakeLogto([500]);
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).deleteUser('u1'));
    const logged = errorLog.mock.calls.map((call) => JSON.stringify(call.arguments)).join('\n');
    assert.ok(!logged.includes('token-1'));
    assert.ok(!logged.includes('m2m-secret'));
  });
});
