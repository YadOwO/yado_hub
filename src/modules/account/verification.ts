/**
 * 注销前验证身份，以及验证通过后发的一次性注销票据。
 *
 * 为什么要这一步：Logto 的访问令牌是离线验签的，拿着一个很久以前登录的 token 就能调 DELETE /v1/account。
 * 所以注销必须先用 POST /v1/account/verification 证明是本人（密码、邮箱验证码或刚重新登录拿到的 ID token），
 * 换到一张 10 分钟有效的票据，DELETE /v1/account 再带着票据（X-Account-Deletion-Ticket）才放行。
 *
 * 票据只放内存，和 middleware/rate-limit.ts 的计数一样基于单实例部署：重启后票据丢失，用户重新验证一次即可；
 * 将来扩成多实例时，票据要改放共享存储。Map 里只存票据的 sha256，进程内存被读到也拿不到能直接用的票据。
 *
 * 本文件是纯逻辑：不 import config/env.ts 与数据库，Logto 客户端、验签函数、时钟都通过参数传入，方便单独测试。
 * 密码、验证码、ID token 只转交给 Logto 或本地验签，不落库、不写日志、不进错误响应。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  accountVerificationRequired,
  appUpgradeRequired,
  identityVerificationFailed,
  serviceNotConfigured,
} from '../../shared/errors.js';
import type { ILogtoIdTokenClaims } from '../../shared/logto-jwks.js';
import type { ILogtoManagementClient } from '../../shared/logto-management.js';

/** 注销票据的请求头名（小写），App 调 DELETE /v1/account 时带上 */
export const ACCOUNT_DELETION_TICKET_HEADER = 'x-account-deletion-ticket';

/** 注销票据的有效期：10 分钟，和 App 本地的身份验证有效期一致 */
export const ACCOUNT_DELETION_TICKET_TTL_MS = 10 * 60_000;

/** 用重新登录验证身份时，ID token 的 auth_time 距现在最多多久：5 分钟 */
export const RECENT_LOGIN_MAX_AGE_MS = 5 * 60_000;

/** auth_time 允许比服务器时间「超前」的时钟误差：1 分钟 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** 内存里保存的一张票据：只存 sha256，不存票据本身 */
interface ITicketRecord {
  /** 票据的 sha256 */
  hash: Buffer;
  /** 过期时刻（毫秒时间戳），到这一刻起票据失效 */
  expiresAt: number;
}

/** 刚签发的票据 */
export interface IIssuedTicket {
  /** 票据明文，只在签发这一次返回给 App */
  ticket: string;
  /** 过期时刻 */
  expiresAt: Date;
}

/** 票据明文的 sha256，签发和校验两边用同一个算法 */
function hashTicket(ticket: string): Buffer {
  return createHash('sha256').update(ticket).digest();
}

/**
 * 注销票据库：每个用户同时只有一张有效票据，再签发会让旧的失效。
 */
export class AccountDeletionTicketStore {
  /** userId → 这个用户当前的票据 */
  private readonly records = new Map<string, ITicketRecord>();

  /**
   * @param now 取当前毫秒时间戳，默认是系统时钟；测试时注入假时钟来模拟过期
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** 给用户签发一张新票据，覆盖旧票据；顺手清掉所有已过期的记录，避免 Map 越积越多 */
  issue(userId: string): IIssuedTicket {
    const nowMs = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= nowMs) {
        this.records.delete(id);
      }
    }

    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = nowMs + ACCOUNT_DELETION_TICKET_TTL_MS;
    this.records.set(userId, { hash: hashTicket(ticket), expiresAt });
    return { ticket, expiresAt: new Date(expiresAt) };
  }

  /**
   * 校验这个用户带来的票据，通过时什么都不返回，不通过抛错；校验不会让票据作废（注销失败后可以重试）。
   *
   * @param ticket 请求头里的票据，没带时为 undefined
   * @throws 426 APP_UPGRADE_REQUIRED：没带票据（旧版 App 不认识这一步）
   * @throws 403 ACCOUNT_VERIFICATION_REQUIRED：没有记录、已过期，或票据对不上（包括别的用户的票据）
   */
  require(userId: string, ticket: string | undefined): void {
    if (ticket === undefined || ticket === '') {
      throw appUpgradeRequired();
    }
    const record = this.records.get(userId);
    if (record === undefined || record.expiresAt <= this.now()) {
      throw accountVerificationRequired();
    }
    // 两个都是 sha256，长度相同；用定长比较，避免通过响应时间一位位猜出票据
    if (!timingSafeEqual(hashTicket(ticket), record.hash)) {
      throw accountVerificationRequired();
    }
  }

  /** 注销成功后让这个用户的票据作废 */
  consume(userId: string): void {
    this.records.delete(userId);
  }
}

/**
 * 判断 ID token 是不是「当前用户刚刚登录」：sub 是这个用户，且 auth_time 在最近 5 分钟内。
 * auth_time 比服务器时间超前 1 分钟以内按时钟误差放行，更超前的不可信。
 *
 * @param nowMs 当前毫秒时间戳
 */
export function isRecentLogin(claims: ILogtoIdTokenClaims, userId: string, nowMs: number): boolean {
  if (claims.sub !== userId) {
    return false;
  }
  const ageMs = nowMs - claims.authTime * 1000;
  return ageMs >= -CLOCK_SKEW_TOLERANCE_MS && ageMs <= RECENT_LOGIN_MAX_AGE_MS;
}

/** 用户用来证明本人的凭据，三选一 */
export type IdentityProof =
  | { method: 'password'; password: string }
  | { method: 'email_code'; code: string }
  | { method: 'id_token'; idToken: string };

/** 注销前发验证码所需的依赖 */
export interface IEmailCodeDeps {
  /** Logto Management API 客户端；没配 M2M 凭证时为 null */
  logto: ILogtoManagementClient | null;
}

/** 验证身份所需的依赖，由 service.ts 接上真实的 Logto、配置与票据库 */
export interface IIdentityVerificationDeps extends IEmailCodeDeps {
  /** 允许的 App 在 Logto 的应用 ID（ID token 的 aud）；为空时重新登录这种方式不可用 */
  logtoAppIds: ReadonlySet<string>;
  /** 校验 ID token 的签名并取出 sub 与 auth_time；验签失败抛 400 login_not_recent */
  verifyIdToken: (idToken: string, audiences: ReadonlySet<string>) => Promise<ILogtoIdTokenClaims>;
  /** 签发票据的票据库 */
  ticketStore: AccountDeletionTicketStore;
  /** 取当前毫秒时间戳 */
  now: () => number;
}

/** 取出 Logto 客户端；没配 M2M 凭证时抛 503，这样密码和邮箱验证码两种方式不会悄悄跳过校验 */
function requireLogto(deps: IEmailCodeDeps): ILogtoManagementClient {
  if (deps.logto === null) {
    throw serviceNotConfigured();
  }
  return deps.logto;
}

/**
 * 校验用户给出的凭据，通过后签发一张注销票据。
 *
 * - password：让 Logto 校验密码；
 * - email_code：取 Logto 里的主邮箱，让 Logto 校验这个邮箱收到的验证码；
 * - id_token：本地验签，要求 sub 是当前用户、aud 在允许的 App 里、auth_time 在最近 5 分钟内。
 *
 * @throws 400 IDENTITY_VERIFICATION_FAILED：details.reason 说明哪里没通过
 * @throws 502 IDENTITY_VERIFICATION_UNAVAILABLE：调 Logto 失败
 * @throws 503 SERVICE_NOT_CONFIGURED：Logto M2M 没配（密码、邮箱验证码），或 LOGTO_APP_IDS 为空（重新登录）
 */
export async function verifyIdentity(
  userId: string,
  proof: IdentityProof,
  deps: IIdentityVerificationDeps,
): Promise<IIssuedTicket> {
  switch (proof.method) {
    case 'password': {
      const logto = requireLogto(deps);
      if (!(await logto.verifyPassword(userId, proof.password))) {
        throw identityVerificationFailed('wrong_password');
      }
      break;
    }
    case 'email_code': {
      const logto = requireLogto(deps);
      const email = await logto.getPrimaryEmail(userId);
      if (email === null) {
        throw identityVerificationFailed('email_unavailable');
      }
      const result = await logto.verifyEmailVerificationCode(email, proof.code);
      if (result === 'mismatch') {
        throw identityVerificationFailed('code_mismatch');
      }
      if (result === 'invalid') {
        throw identityVerificationFailed('code_invalid');
      }
      break;
    }
    case 'id_token': {
      if (deps.logtoAppIds.size === 0) {
        throw serviceNotConfigured();
      }
      const claims = await deps.verifyIdToken(proof.idToken, deps.logtoAppIds);
      if (!isRecentLogin(claims, userId, deps.now())) {
        throw identityVerificationFailed('login_not_recent');
      }
      break;
    }
  }
  return deps.ticketStore.issue(userId);
}

/**
 * 给用户在 Logto 里的主邮箱发一封验证码邮件，供「邮箱验证码」这种验证方式使用。
 *
 * @throws 400 IDENTITY_VERIFICATION_FAILED：账号没有主邮箱（reason 为 email_unavailable）
 * @throws 502 IDENTITY_VERIFICATION_UNAVAILABLE：调 Logto 失败
 * @throws 503 SERVICE_NOT_CONFIGURED：Logto M2M 没配
 */
export async function sendDeletionEmailCode(userId: string, deps: IEmailCodeDeps): Promise<void> {
  const logto = requireLogto(deps);
  const email = await logto.getPrimaryEmail(userId);
  if (email === null) {
    throw identityVerificationFailed('email_unavailable');
  }
  await logto.sendEmailVerificationCode(email);
}
