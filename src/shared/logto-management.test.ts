import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { AppError, ErrorCode } from './errors.js';
import {
  createLogtoManagementClient,
  type ILogtoManagementClient,
  type ILogtoManagementConfig,
} from './logto-management.js';

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

/** 脚本里的一个响应：状态码与响应体；rawBody 优先，用来模拟不是 JSON 的响应体；204 一律没有响应体 */
interface IScriptedResponse {
  status: number;
  body?: unknown;
  rawBody?: string;
}

/** 把脚本里的响应转成 Response 的响应体 */
function toResponseBody(response: IScriptedResponse): string | null {
  if (response.status === 204) {
    return null;
  }
  if (response.rawBody !== undefined) {
    return response.rawBody;
  }
  return response.body === undefined ? null : JSON.stringify(response.body);
}

/**
 * 假的 Logto：换 token 默认成功（tokenStatus 可改成失败），
 * 发给 Management API 的请求按顺序返回 responses 里的响应，用完后返回 500。
 */
class ScriptedLogto {
  readonly requests: IRecordedRequest[] = [];

  constructor(
    private readonly responses: IScriptedResponse[],
    private readonly tokenStatus = 200,
  ) {}

  /** 去掉换 token 的请求后，发给 Management API 的请求 */
  get apiRequests(): IRecordedRequest[] {
    return this.requests.filter((request) => request.url !== CONFIG.tokenUrl);
  }

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
      return Promise.resolve(Response.json({ access_token: 'token-1', expires_in: 3600 }));
    }
    const next = this.responses.shift() ?? { status: 500 };
    return Promise.resolve(new Response(toResponseBody(next), { status: next.status }));
  };
}

/** 换 token 正常，之后发给 Management API 的请求交给 apiFetch 处理的假 fetch */
function fetchWithToken(apiFetch: typeof fetch): typeof fetch {
  return (input, init) =>
    String(input) === CONFIG.tokenUrl
      ? Promise.resolve(Response.json({ access_token: 'token-1', expires_in: 3600 }))
      : apiFetch(input, init);
}

/** 解析一次请求的 JSON 请求体 */
function requestJson(request: IRecordedRequest | undefined): unknown {
  return JSON.parse(String(request?.init?.body));
}

/** 判断是 502 IDENTITY_VERIFICATION_UNAVAILABLE，且不带 details */
function isVerificationUnavailable(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.status === 502 &&
    error.code === ErrorCode.IdentityVerificationUnavailable &&
    error.details === undefined
  );
}

/** 校验身份用到的四个方法，用来对它们一起测网络错误、超时与日志 */
const VERIFICATION_CALLS: ReadonlyArray<{
  name: string;
  call: (client: ILogtoManagementClient) => Promise<unknown>;
}> = [
  { name: 'getPrimaryEmail', call: (client) => client.getPrimaryEmail('u1') },
  { name: 'verifyPassword', call: (client) => client.verifyPassword('u1', 'password-1') },
  { name: 'sendEmailVerificationCode', call: (client) => client.sendEmailVerificationCode('a@example.com') },
  { name: 'verifyEmailVerificationCode', call: (client) => client.verifyEmailVerificationCode('a@example.com', '123456') },
];

describe('getPrimaryEmail', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('GET 用户详情，带 M2M token，返回主邮箱', async () => {
    const logto = new ScriptedLogto([{ status: 200, body: { id: 'user/1', primaryEmail: 'person@example.com' } }]);
    const email = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).getPrimaryEmail('user/1');

    assert.equal(email, 'person@example.com');
    const [request] = logto.apiRequests;
    assert.equal(request?.url, 'https://accounts.example.invalid/api/users/user%2F1');
    assert.equal(request?.init?.method, 'GET');
    assert.equal(request?.init?.body, undefined);
    assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer token-1');
  });

  it('主邮箱是 null 或空串时返回 null', async () => {
    for (const primaryEmail of [null, '', '  ']) {
      const logto = new ScriptedLogto([{ status: 200, body: { primaryEmail } }]);
      const email = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).getPrimaryEmail('u1');
      assert.equal(email, null, JSON.stringify(primaryEmail));
    }
  });

  it('非 200、响应体不是预期的结构时抛 502，不当作没有邮箱', async () => {
    const cases: IScriptedResponse[] = [
      { status: 401 },
      { status: 404 },
      { status: 500 },
      { status: 200 },
      { status: 200, rawBody: 'not json' },
      { status: 200, body: {} },
      { status: 200, body: ['person@example.com'] },
      { status: 200, body: { primaryEmail: 123 } },
    ];
    for (const response of cases) {
      const logto = new ScriptedLogto([response]);
      await assert.rejects(
        createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).getPrimaryEmail('u1'),
        isVerificationUnavailable,
        JSON.stringify(response),
      );
    }
  });

  it('返回 401 时丢掉缓存的 token，下次换新的', async () => {
    const logto = new ScriptedLogto([{ status: 401 }, { status: 200, body: { primaryEmail: null } }]);
    const client = createLogtoManagementClient(CONFIG, { fetch: logto.fetch });
    await assert.rejects(client.getPrimaryEmail('u1'), isVerificationUnavailable);
    assert.equal(await client.getPrimaryEmail('u1'), null);
    assert.equal(logto.tokenRequestCount, 2);
  });
});

describe('verifyPassword', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('POST 密码校验接口，请求体是 { password }，204 返回 true', async () => {
    const logto = new ScriptedLogto([{ status: 204 }]);
    const isValid = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyPassword('user/1', 'pa"ss\\word');

    assert.equal(isValid, true);
    const [request] = logto.apiRequests;
    assert.equal(request?.url, 'https://accounts.example.invalid/api/users/user%2F1/password/verify');
    assert.equal(request?.init?.method, 'POST');
    const headers = new Headers(request?.init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer token-1');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(requestJson(request), { password: 'pa"ss\\word' });
  });

  it('422 与 400（密码不对）返回 false', async () => {
    for (const status of [422, 400]) {
      const logto = new ScriptedLogto([{ status, body: { code: 'user.password_mismatch' } }]);
      const isValid = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyPassword('u1', 'x');
      assert.equal(isValid, false, `HTTP ${status}`);
    }
  });

  it('其他状态码抛 502，不当作密码不对', async () => {
    for (const status of [200, 401, 404, 429, 500]) {
      const logto = new ScriptedLogto([{ status }]);
      await assert.rejects(
        createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyPassword('u1', 'x'),
        isVerificationUnavailable,
        `HTTP ${status}`,
      );
    }
  });
});

describe('sendEmailVerificationCode', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('POST 发送验证码，请求体是 { email }，2xx 算成功', async () => {
    for (const status of [204, 200]) {
      const logto = new ScriptedLogto([{ status }]);
      await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).sendEmailVerificationCode('person@example.com');

      const [request] = logto.apiRequests;
      assert.equal(request?.url, 'https://accounts.example.invalid/api/verification-codes');
      assert.equal(request?.init?.method, 'POST');
      assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer token-1');
      assert.deepEqual(requestJson(request), { email: 'person@example.com' });
    }
  });

  it('非 2xx 抛 502', async () => {
    for (const status of [400, 401, 422, 500]) {
      const logto = new ScriptedLogto([{ status }]);
      await assert.rejects(
        createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).sendEmailVerificationCode('a@example.com'),
        isVerificationUnavailable,
        `HTTP ${status}`,
      );
    }
  });
});

describe('verifyEmailVerificationCode', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('POST 校验接口，请求体是 { email, verificationCode }，204 返回 ok', async () => {
    const logto = new ScriptedLogto([{ status: 204 }]);
    const result = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyEmailVerificationCode(
      'person@example.com',
      '123456',
    );

    assert.equal(result, 'ok');
    const [request] = logto.apiRequests;
    assert.equal(request?.url, 'https://accounts.example.invalid/api/verification-codes/verify');
    assert.equal(request?.init?.method, 'POST');
    assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer token-1');
    assert.deepEqual(requestJson(request), { email: 'person@example.com', verificationCode: '123456' });
  });

  it('400 且错误码是 code_mismatch 返回 mismatch', async () => {
    const logto = new ScriptedLogto([{ status: 400, body: { code: 'verification_code.code_mismatch' } }]);
    const result = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyEmailVerificationCode('a@example.com', '000000');
    assert.equal(result, 'mismatch');
  });

  it('400 且错误码是 expired / not_found / exceed_max_try / email_mismatch 返回 invalid', async () => {
    for (const code of [
      'verification_code.expired',
      'verification_code.not_found',
      'verification_code.exceed_max_try',
      'verification_code.email_mismatch',
    ]) {
      const logto = new ScriptedLogto([{ status: 400, body: { code } }]);
      const result = await createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyEmailVerificationCode('a@example.com', '000000');
      assert.equal(result, 'invalid', code);
    }
  });

  it('认不出的 400、其他状态码、响应体不是 JSON 都抛 502，不当作验证通过', async () => {
    const cases: IScriptedResponse[] = [
      { status: 400, body: { code: 'something.else' } },
      { status: 400, body: {} },
      { status: 400, rawBody: 'not json' },
      { status: 400 },
      { status: 200 },
      { status: 401 },
      { status: 404 },
      { status: 422, body: { code: 'verification_code.code_mismatch' } },
      { status: 500 },
    ];
    for (const response of cases) {
      const logto = new ScriptedLogto([response]);
      await assert.rejects(
        createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).verifyEmailVerificationCode('a@example.com', '000000'),
        isVerificationUnavailable,
        JSON.stringify(response),
      );
    }
  });
});

describe('验证身份的方法遇到 Logto 不可用', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  for (const { name, call } of VERIFICATION_CALLS) {
    it(`${name}：换 token 失败抛 502 IDENTITY_VERIFICATION_UNAVAILABLE，不发后面的请求`, async () => {
      const logto = new ScriptedLogto([{ status: 204 }], 400);
      await assert.rejects(call(createLogtoManagementClient(CONFIG, { fetch: logto.fetch })), isVerificationUnavailable);
      assert.equal(logto.apiRequests.length, 0);
    });

    it(`${name}：网络错误抛 502 IDENTITY_VERIFICATION_UNAVAILABLE`, async () => {
      const offline = fetchWithToken(() => Promise.reject(new TypeError('fetch failed')));
      await assert.rejects(call(createLogtoManagementClient(CONFIG, { fetch: offline })), isVerificationUnavailable);
    });

    it(`${name}：超时抛 502 IDENTITY_VERIFICATION_UNAVAILABLE`, async () => {
      const hanging = fetchWithToken(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      // AbortSignal.timeout 的计时器不占住事件循环；服务里有 HTTP 监听占着，测试里要自己占住，否则进程会提前结束
      const keepAlive = setInterval(() => undefined, 1_000);
      try {
        await assert.rejects(
          call(createLogtoManagementClient(CONFIG, { fetch: hanging, timeoutMs: 20 })),
          isVerificationUnavailable,
        );
      } finally {
        clearInterval(keepAlive);
      }
    });
  }

  it('删除用户换 token 失败时仍然抛 ACCOUNT_DELETION_FAILED，不受新方法影响', async () => {
    const logto = new ScriptedLogto([{ status: 204 }], 400);
    await assert.rejects(createLogtoManagementClient(CONFIG, { fetch: logto.fetch }).deleteUser('u1'), isLogtoFailure);
  });

  it('日志不出现密码、验证码、邮箱、token 和密钥', async () => {
    const errorLog = mock.method(console, 'error', () => undefined);
    const password = 'pw-secret-123';
    const code = '654321';
    const email = 'person@example.com';
    const leaky = `${password} ${code} ${email}`;

    const calls: Array<{ client: ILogtoManagementClient; run: (client: ILogtoManagementClient) => Promise<unknown> }> = [
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 500, body: { message: leaky } }]).fetch,
        }),
        run: (client) => client.getPrimaryEmail('u1'),
      },
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 200, body: { primaryEmail: { value: email } } }]).fetch,
        }),
        run: (client) => client.getPrimaryEmail('u1'),
      },
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 500, body: { message: leaky } }]).fetch,
        }),
        run: (client) => client.verifyPassword('u1', password),
      },
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 500, body: { message: leaky } }]).fetch,
        }),
        run: (client) => client.sendEmailVerificationCode(email),
      },
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 500, body: { message: leaky } }]).fetch,
        }),
        run: (client) => client.verifyEmailVerificationCode(email, code),
      },
      {
        client: createLogtoManagementClient(CONFIG, {
          fetch: new ScriptedLogto([{ status: 400, body: { code: 'something.else', message: leaky } }]).fetch,
        }),
        run: (client) => client.verifyEmailVerificationCode(email, code),
      },
    ];
    for (const { client, run } of calls) {
      await assert.rejects(run(client), isVerificationUnavailable);
    }

    const logged = errorLog.mock.calls.map((call) => JSON.stringify(call.arguments)).join('\n');
    assert.ok(logged.includes('logto_management_failed'));
    for (const secret of [password, code, email, 'token-1', CONFIG.appSecret]) {
      assert.ok(!logged.includes(secret), `日志里不应出现 ${secret}`);
    }
  });
});
