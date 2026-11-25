import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError, ErrorCode, identityVerificationUnavailable } from '../../shared/errors.js';
import type { ILogtoIdTokenClaims } from '../../shared/logto-jwks.js';
import type { EmailCodeVerificationResult, ILogtoManagementClient } from '../../shared/logto-management.js';
import {
  ACCOUNT_DELETION_TICKET_TTL_MS,
  AccountDeletionTicketStore,
  RECENT_LOGIN_MAX_AGE_MS,
  isRecentLogin,
  sendDeletionEmailCode,
  verifyIdentity,
  type IIdentityVerificationDeps,
} from './verification.js';

/** 测试里「现在」的时刻，整秒，方便换算 auth_time */
const NOW_MS = Date.parse('2026-11-25T08:00:00Z');

/** 测试里允许的 App ID 集合 */
const APP_IDS: ReadonlySet<string> = new Set(['app-1', 'app-2']);

/** 判断是指定状态码与错误码的 AppError；传了 details 时还要求 details 一致 */
function isAppError(status: number, code: string, details?: unknown): (error: unknown) => boolean {
  return (error) =>
    error instanceof AppError &&
    error.status === status &&
    error.code === code &&
    (details === undefined || JSON.stringify(error.details) === JSON.stringify(details));
}

/** 判断是 400 IDENTITY_VERIFICATION_FAILED，且 details.reason 是指定值 */
function isVerificationFailed(reason: string): (error: unknown) => boolean {
  return isAppError(400, ErrorCode.IdentityVerificationFailed, { reason });
}

/** 403 ACCOUNT_VERIFICATION_REQUIRED */
const isVerificationRequired = isAppError(403, ErrorCode.AccountVerificationRequired);

/** 426 APP_UPGRADE_REQUIRED */
const isUpgradeRequired = isAppError(426, ErrorCode.AppUpgradeRequired);

/** 503 SERVICE_NOT_CONFIGURED */
const isNotConfigured = isAppError(503, ErrorCode.ServiceNotConfigured);

describe('AccountDeletionTicketStore', () => {
  /** 可手动拨动的假时钟 */
  let nowMs = NOW_MS;
  /** 每个用例前重新建，互不影响 */
  function createStore(): AccountDeletionTicketStore {
    nowMs = NOW_MS;
    return new AccountDeletionTicketStore(() => nowMs);
  }

  it('签发后能通过校验，过期时刻是 10 分钟后', () => {
    const store = createStore();
    const issued = store.issue('u1');
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.expiresAt.getTime(), NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS);
    store.require('u1', issued.ticket);
    // 校验不会让票据作废：注销失败后可以拿同一张票据重试
    store.require('u1', issued.ticket);
  });

  it('到 10 分钟整就过期，抛 403', () => {
    const store = createStore();
    const { ticket } = store.issue('u1');
    nowMs = NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS - 1;
    store.require('u1', ticket);
    nowMs = NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS;
    assert.throws(() => store.require('u1', ticket), isVerificationRequired);
  });

  it('别的用户的票据抛 403', () => {
    const store = createStore();
    const alice = store.issue('alice');
    store.issue('bob');
    assert.throws(() => store.require('bob', alice.ticket), isVerificationRequired);
  });

  it('没有签发过、或票据是乱写的，抛 403', () => {
    const store = createStore();
    assert.throws(() => store.require('u1', 'whatever'), isVerificationRequired);
    store.issue('u1');
    assert.throws(() => store.require('u1', 'whatever'), isVerificationRequired);
  });

  it('不带票据（没有头或空串）抛 426', () => {
    const store = createStore();
    store.issue('u1');
    assert.throws(() => store.require('u1', undefined), isUpgradeRequired);
    assert.throws(() => store.require('u1', ''), isUpgradeRequired);
    // 没签发过票据时，不带头也是 426，而不是 403
    assert.throws(() => store.require('nobody', undefined), isUpgradeRequired);
  });

  it('再签发后旧票据失效，新票据可用', () => {
    const store = createStore();
    const first = store.issue('u1');
    const second = store.issue('u1');
    assert.notEqual(first.ticket, second.ticket);
    assert.throws(() => store.require('u1', first.ticket), isVerificationRequired);
    store.require('u1', second.ticket);
  });

  it('consume 之后票据作废，抛 403；别的用户的票据不受影响', () => {
    const store = createStore();
    const { ticket } = store.issue('u1');
    const other = store.issue('u2');
    store.consume('u1');
    assert.throws(() => store.require('u1', ticket), isVerificationRequired);
    store.require('u2', other.ticket);
  });

  it('一个用户的票据过期（含签发时顺手清掉），不影响别的用户还没过期的票据', () => {
    const store = createStore();
    const stale = store.issue('stale');
    nowMs = NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS - 1;
    const fresh = store.issue('fresh');
    nowMs = NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS;
    // 过期的和被清掉的对外表现一样：403
    assert.throws(() => store.require('stale', stale.ticket), isVerificationRequired);
    store.require('fresh', fresh.ticket);
  });
});

describe('isRecentLogin', () => {
  /** 构造 auth_time 在「现在 + offsetMs」的 ID token 内容 */
  function claimsAt(offsetMs: number, sub = 'u1'): ILogtoIdTokenClaims {
    return { sub, authTime: (NOW_MS + offsetMs) / 1000 };
  }

  it('sub 相同且 auth_time 在 5 分钟内为 true，含刚好 5 分钟', () => {
    assert.equal(isRecentLogin(claimsAt(-1_000), 'u1', NOW_MS), true);
    assert.equal(isRecentLogin(claimsAt(-RECENT_LOGIN_MAX_AGE_MS), 'u1', NOW_MS), true);
  });

  it('auth_time 超过 5 分钟为 false', () => {
    assert.equal(isRecentLogin(claimsAt(-RECENT_LOGIN_MAX_AGE_MS - 1_000), 'u1', NOW_MS), false);
  });

  it('sub 不是当前用户为 false', () => {
    assert.equal(isRecentLogin(claimsAt(-1_000, 'someone-else'), 'u1', NOW_MS), false);
  });

  it('auth_time 比服务器时间超前 60 秒以内按时钟误差放行，更超前为 false', () => {
    assert.equal(isRecentLogin(claimsAt(60_000), 'u1', NOW_MS), true);
    assert.equal(isRecentLogin(claimsAt(61_000), 'u1', NOW_MS), false);
  });
});

/** 假 Logto 客户端的行为 */
interface IFakeLogtoBehavior {
  /** verifyPassword 的结果 */
  isPasswordValid: boolean;
  /** getPrimaryEmail 的结果 */
  primaryEmail: string | null;
  /** verifyEmailVerificationCode 的结果 */
  codeResult: EmailCodeVerificationResult;
  /** 不为 null 时，所有方法都抛这个错误（模拟 Logto 不可用） */
  failure: Error | null;
}

/** 假 Logto 客户端：按设定返回结果，并记录调用 */
class FakeLogtoClient implements ILogtoManagementClient {
  /** 已发生的调用，按顺序，格式 `方法名:参数` */
  readonly calls: string[] = [];
  private readonly behavior: IFakeLogtoBehavior;

  constructor(overrides: Partial<IFakeLogtoBehavior> = {}) {
    this.behavior = {
      isPasswordValid: true,
      primaryEmail: 'person@example.com',
      codeResult: 'ok',
      failure: null,
      ...overrides,
    };
  }

  /** 记录一次调用，并按设定返回结果或抛错 */
  private respond<T>(call: string, value: T): Promise<T> {
    this.calls.push(call);
    return this.behavior.failure === null ? Promise.resolve(value) : Promise.reject(this.behavior.failure);
  }

  deleteUser(userId: string): Promise<void> {
    return this.respond(`deleteUser:${userId}`, undefined);
  }

  getPrimaryEmail(userId: string): Promise<string | null> {
    return this.respond(`getPrimaryEmail:${userId}`, this.behavior.primaryEmail);
  }

  verifyPassword(userId: string, password: string): Promise<boolean> {
    return this.respond(`verifyPassword:${userId}:${password}`, this.behavior.isPasswordValid);
  }

  sendEmailVerificationCode(email: string): Promise<void> {
    return this.respond(`sendEmailVerificationCode:${email}`, undefined);
  }

  verifyEmailVerificationCode(email: string, code: string): Promise<EmailCodeVerificationResult> {
    return this.respond(`verifyEmailVerificationCode:${email}:${code}`, this.behavior.codeResult);
  }
}

/** 一次 verifyIdToken 调用的入参 */
interface IVerifyIdTokenCall {
  idToken: string;
  audiences: ReadonlySet<string>;
}

/** 假的 ID token 验签：返回给定的内容，或抛给定的错误，并记录入参 */
function fakeTokenVerifier(result: ILogtoIdTokenClaims | Error): {
  verify: IIdentityVerificationDeps['verifyIdToken'];
  calls: IVerifyIdTokenCall[];
} {
  const calls: IVerifyIdTokenCall[] = [];
  return {
    calls,
    verify: (idToken, audiences) => {
      calls.push({ idToken, audiences });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

/** 刚登录的 u1 的 ID token 内容 */
const FRESH_CLAIMS: ILogtoIdTokenClaims = { sub: 'u1', authTime: NOW_MS / 1000 - 30 };

/** 组装验证身份的依赖；ticketStore 与时钟用测试专用的，其余可覆盖 */
function createDeps(overrides: Partial<IIdentityVerificationDeps> = {}): IIdentityVerificationDeps {
  return {
    logto: new FakeLogtoClient(),
    logtoAppIds: APP_IDS,
    verifyIdToken: fakeTokenVerifier(FRESH_CLAIMS).verify,
    ticketStore: new AccountDeletionTicketStore(() => NOW_MS),
    now: () => NOW_MS,
    ...overrides,
  };
}

describe('verifyIdentity：密码', () => {
  it('密码对：签发票据，票据能通过校验', async () => {
    const logto = new FakeLogtoClient();
    const deps = createDeps({ logto });
    const issued = await verifyIdentity('u1', { method: 'password', password: 'secret' }, deps);

    assert.deepEqual(logto.calls, ['verifyPassword:u1:secret']);
    assert.equal(issued.expiresAt.getTime(), NOW_MS + ACCOUNT_DELETION_TICKET_TTL_MS);
    deps.ticketStore.require('u1', issued.ticket);
  });

  it('密码不对：400 wrong_password，不签发票据', async () => {
    const deps = createDeps({ logto: new FakeLogtoClient({ isPasswordValid: false }) });
    await assert.rejects(verifyIdentity('u1', { method: 'password', password: 'bad' }, deps), isVerificationFailed('wrong_password'));
    assert.throws(() => deps.ticketStore.require('u1', 'any'), isVerificationRequired);
  });

  it('Logto 调用失败：502 原样抛出，不签发票据', async () => {
    const deps = createDeps({ logto: new FakeLogtoClient({ failure: identityVerificationUnavailable() }) });
    await assert.rejects(
      verifyIdentity('u1', { method: 'password', password: 'x' }, deps),
      isAppError(502, ErrorCode.IdentityVerificationUnavailable),
    );
    assert.throws(() => deps.ticketStore.require('u1', 'any'), isVerificationRequired);
  });
});

describe('verifyIdentity：邮箱验证码', () => {
  it('验证码对：先取主邮箱再校验，签发票据', async () => {
    const logto = new FakeLogtoClient({ primaryEmail: 'person@example.com', codeResult: 'ok' });
    const deps = createDeps({ logto });
    const issued = await verifyIdentity('u1', { method: 'email_code', code: '123456' }, deps);

    assert.deepEqual(logto.calls, ['getPrimaryEmail:u1', 'verifyEmailVerificationCode:person@example.com:123456']);
    deps.ticketStore.require('u1', issued.ticket);
  });

  it('没有主邮箱：400 email_unavailable，不校验验证码', async () => {
    const logto = new FakeLogtoClient({ primaryEmail: null });
    const deps = createDeps({ logto });
    await assert.rejects(verifyIdentity('u1', { method: 'email_code', code: '123456' }, deps), isVerificationFailed('email_unavailable'));
    assert.deepEqual(logto.calls, ['getPrimaryEmail:u1']);
  });

  it('验证码不对：400 code_mismatch', async () => {
    const deps = createDeps({ logto: new FakeLogtoClient({ codeResult: 'mismatch' }) });
    await assert.rejects(verifyIdentity('u1', { method: 'email_code', code: '000000' }, deps), isVerificationFailed('code_mismatch'));
  });

  it('验证码已失效：400 code_invalid', async () => {
    const deps = createDeps({ logto: new FakeLogtoClient({ codeResult: 'invalid' }) });
    await assert.rejects(verifyIdentity('u1', { method: 'email_code', code: '000000' }, deps), isVerificationFailed('code_invalid'));
  });

  it('验证没通过时不签发票据', async () => {
    const deps = createDeps({ logto: new FakeLogtoClient({ codeResult: 'mismatch' }) });
    await assert.rejects(verifyIdentity('u1', { method: 'email_code', code: '000000' }, deps));
    assert.throws(() => deps.ticketStore.require('u1', 'any'), isVerificationRequired);
  });
});

describe('verifyIdentity：重新登录的 ID token', () => {
  it('刚登录的当前用户：用允许的 App ID 验签，签发票据', async () => {
    const verifier = fakeTokenVerifier(FRESH_CLAIMS);
    const deps = createDeps({ verifyIdToken: verifier.verify });
    const issued = await verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps);

    assert.equal(verifier.calls.length, 1);
    assert.equal(verifier.calls[0]?.idToken, 'jwt-1');
    assert.equal(verifier.calls[0]?.audiences, APP_IDS);
    deps.ticketStore.require('u1', issued.ticket);
  });

  it('不需要 Logto Management 凭证也能用', async () => {
    const deps = createDeps({ logto: null });
    const issued = await verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps);
    deps.ticketStore.require('u1', issued.ticket);
  });

  it('sub 不是当前用户：400 login_not_recent', async () => {
    const deps = createDeps({ verifyIdToken: fakeTokenVerifier({ sub: 'someone-else', authTime: NOW_MS / 1000 }).verify });
    await assert.rejects(verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps), isVerificationFailed('login_not_recent'));
  });

  it('auth_time 超过 5 分钟：400 login_not_recent，不签发票据', async () => {
    const stale: ILogtoIdTokenClaims = { sub: 'u1', authTime: NOW_MS / 1000 - RECENT_LOGIN_MAX_AGE_MS / 1000 - 1 };
    const deps = createDeps({ verifyIdToken: fakeTokenVerifier(stale).verify });
    await assert.rejects(verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps), isVerificationFailed('login_not_recent'));
    assert.throws(() => deps.ticketStore.require('u1', 'any'), isVerificationRequired);
  });

  it('auth_time 比服务器时间超前超过 60 秒：400 login_not_recent', async () => {
    const future: ILogtoIdTokenClaims = { sub: 'u1', authTime: NOW_MS / 1000 + 61 };
    const deps = createDeps({ verifyIdToken: fakeTokenVerifier(future).verify });
    await assert.rejects(verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps), isVerificationFailed('login_not_recent'));
  });

  it('验签失败：验签函数抛的 400 原样抛出', async () => {
    const deps = createDeps({
      verifyIdToken: fakeTokenVerifier(new AppError(400, ErrorCode.IdentityVerificationFailed, '身份验证没有通过', { reason: 'login_not_recent' })).verify,
    });
    await assert.rejects(verifyIdentity('u1', { method: 'id_token', idToken: 'bad' }, deps), isVerificationFailed('login_not_recent'));
  });
});

describe('verifyIdentity：没配置时返回 503', () => {
  it('Logto Management 凭证没配（logto 为 null）：密码和邮箱验证码都返回 503', async () => {
    const deps = createDeps({ logto: null });
    await assert.rejects(verifyIdentity('u1', { method: 'password', password: 'x' }, deps), isNotConfigured);
    await assert.rejects(verifyIdentity('u1', { method: 'email_code', code: '123456' }, deps), isNotConfigured);
  });

  it('LOGTO_APP_IDS 为空：重新登录返回 503，且不去验签', async () => {
    const verifier = fakeTokenVerifier(FRESH_CLAIMS);
    const deps = createDeps({ logtoAppIds: new Set(), verifyIdToken: verifier.verify });
    await assert.rejects(verifyIdentity('u1', { method: 'id_token', idToken: 'jwt-1' }, deps), isNotConfigured);
    assert.equal(verifier.calls.length, 0);
  });

  it('LOGTO_APP_IDS 为空不影响密码方式', async () => {
    const deps = createDeps({ logtoAppIds: new Set() });
    const issued = await verifyIdentity('u1', { method: 'password', password: 'x' }, deps);
    deps.ticketStore.require('u1', issued.ticket);
  });
});

describe('sendDeletionEmailCode', () => {
  it('取主邮箱后给它发验证码', async () => {
    const logto = new FakeLogtoClient({ primaryEmail: 'person@example.com' });
    await sendDeletionEmailCode('u1', { logto });
    assert.deepEqual(logto.calls, ['getPrimaryEmail:u1', 'sendEmailVerificationCode:person@example.com']);
  });

  it('没有主邮箱：400 email_unavailable，不发验证码', async () => {
    const logto = new FakeLogtoClient({ primaryEmail: null });
    await assert.rejects(sendDeletionEmailCode('u1', { logto }), isVerificationFailed('email_unavailable'));
    assert.deepEqual(logto.calls, ['getPrimaryEmail:u1']);
  });

  it('Logto 调用失败：502 原样抛出', async () => {
    const logto = new FakeLogtoClient({ failure: identityVerificationUnavailable() });
    await assert.rejects(sendDeletionEmailCode('u1', { logto }), isAppError(502, ErrorCode.IdentityVerificationUnavailable));
  });

  it('Logto Management 凭证没配：503', async () => {
    await assert.rejects(sendDeletionEmailCode('u1', { logto: null }), isNotConfigured);
  });
});
