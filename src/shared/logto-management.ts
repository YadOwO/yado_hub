/**
 * Logto Management API 客户端。
 *
 * 用在两处：注销账号最后一步「删除用户」（从 yadoA_be 挪来，现在只有 hub 删 Logto 用户），
 * 以及注销前验证身份——校验密码、取主邮箱、发送并校验邮箱验证码。
 * 用 Machine-to-Machine 应用的 client_credentials 换取 access token，缓存在客户端里，到期前 60 秒重新获取。
 * 日志只记录步骤、状态码和错误名，绝不记录 token、密钥、密码、验证码与邮箱。
 * 本文件不 import config/env.ts，配置由调用方传入，方便单独测试。
 */
import { accountDeletionFailed, identityVerificationUnavailable, type AppError } from './errors.js';

/** 注销失败时 details.step 的取值，表示卡在删除 Logto 用户这一步 */
export const LOGTO_DELETION_STEP = 'logto';

/** 单次请求默认超时（毫秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** token 提前多少毫秒视为过期，避免用到刚好失效的 token */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** 校验邮箱验证码时 Logto 返回的错误码：验证码不对，用户可以再输一次 */
const CODE_MISMATCH_ERROR = 'verification_code.code_mismatch';

/** 校验邮箱验证码时 Logto 返回的错误码：验证码已失效、没有记录、尝试次数用完或邮箱对不上，需要重新发送 */
const CODE_INVALID_ERRORS: ReadonlySet<string> = new Set([
  'verification_code.expired',
  'verification_code.not_found',
  'verification_code.exceed_max_try',
  'verification_code.email_mismatch',
]);

/** 调用 Management API 需要的配置，由 env.logtoManagement 提供 */
export interface ILogtoManagementConfig {
  /** 换取 M2M access token 的地址：{issuer}/token */
  tokenUrl: string;
  /** Management API 根地址：Logto 域名根下的 /api */
  apiBaseUrl: string;
  /** Management API 的 resource indicator */
  resource: string;
  /** M2M 应用 ID */
  appId: string;
  /** M2M 应用密钥 */
  appSecret: string;
}

/** 客户端的可选项，测试时注入假 fetch 和更短的超时 */
export interface ILogtoManagementOptions {
  /** 发请求用的 fetch，默认是全局 fetch */
  fetch?: typeof fetch;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

/** 校验邮箱验证码的结果：通过、验证码不对（可再输）、验证码已失效（需重发） */
export type EmailCodeVerificationResult = 'ok' | 'mismatch' | 'invalid';

/** Management API 客户端 */
export interface ILogtoManagementClient {
  /**
   * 删除 Logto 用户。204 与 404（已经删过）都算成功；网络错误、超时与其他状态码抛 502 ACCOUNT_DELETION_FAILED。
   */
  deleteUser(userId: string): Promise<void>;

  /**
   * 取用户在 Logto 里的主邮箱；没有主邮箱（null 或空串）时返回 null。
   * 非 200、响应体不是预期的结构、网络错误或超时抛 502 IDENTITY_VERIFICATION_UNAVAILABLE。
   */
  getPrimaryEmail(userId: string): Promise<string | null>;

  /**
   * 校验用户的登录密码：204 返回 true，422 与 400（密码不对）返回 false；
   * 其他状态码、网络错误或超时抛 502 IDENTITY_VERIFICATION_UNAVAILABLE。
   */
  verifyPassword(userId: string, password: string): Promise<boolean>;

  /**
   * 向邮箱发送验证码：2xx 算成功；其他状态码、网络错误或超时抛 502 IDENTITY_VERIFICATION_UNAVAILABLE。
   */
  sendEmailVerificationCode(email: string): Promise<void>;

  /**
   * 校验邮箱收到的验证码：204 为 ok；400 且错误码是 code_mismatch 为 mismatch，
   * 是 expired / not_found / exceed_max_try / email_mismatch 为 invalid；
   * 其他情况（含无法识别的 400）抛 502 IDENTITY_VERIFICATION_UNAVAILABLE，不当作验证通过。
   */
  verifyEmailVerificationCode(email: string, code: string): Promise<EmailCodeVerificationResult>;
}

/** 决定上游调用失败时对外抛哪个错误：注销删用户抛 ACCOUNT_DELETION_FAILED，验证身份抛 IDENTITY_VERIFICATION_UNAVAILABLE */
type FailureFactory = () => AppError;

/** 删除 Logto 用户这一步失败时抛的错误：502 ACCOUNT_DELETION_FAILED，details.step 是 logto */
const deletionFailure: FailureFactory = () => accountDeletionFailed(LOGTO_DELETION_STEP);

/** 验证身份时调用 Logto 失败抛的错误：502 IDENTITY_VERIFICATION_UNAVAILABLE */
const verificationFailure: FailureFactory = () => identityVerificationUnavailable();

/** 从 unknown 响应体中收窄出 access_token 与 expires_in */
function parseTokenResponse(body: unknown): { accessToken: string; expiresIn: number } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const accessToken: unknown = 'access_token' in body ? body.access_token : undefined;
  const expiresIn: unknown = 'expires_in' in body ? body.expires_in : undefined;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return null;
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return null;
  }
  return { accessToken, expiresIn };
}

/** 主邮箱的解析结果：ok 为 false 表示响应体不是预期的结构 */
type PrimaryEmailParseResult = { ok: true; email: string | null } | { ok: false };

/**
 * 从 GET /users/{id} 的响应体里取主邮箱。
 *
 * primaryEmail 字段必须存在：Logto 没有主邮箱时返回 null，字段缺失说明响应结构变了，按解析失败处理。
 */
function parsePrimaryEmail(body: unknown): PrimaryEmailParseResult {
  if (typeof body !== 'object' || body === null || !('primaryEmail' in body)) {
    return { ok: false };
  }
  const primaryEmail: unknown = body.primaryEmail;
  if (primaryEmail === null) {
    return { ok: true, email: null };
  }
  if (typeof primaryEmail !== 'string') {
    return { ok: false };
  }
  return { ok: true, email: primaryEmail.trim().length === 0 ? null : primaryEmail };
}

/** 从 Logto 的错误响应体里取出 code 字段；不是预期的结构时返回 null */
function parseErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    return null;
  }
  const code: unknown = body.code;
  return typeof code === 'string' ? code : null;
}

/** 从捕获的异常中取出可安全写入日志的错误名，不带 message，避免把上游返回的敏感内容写进日志 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** 记录上游错误并返回对外的错误，日志只含步骤与状态码或错误名；对外抛哪个错误由 toError 决定 */
function upstreamFailure(step: string, detail: string, toError: FailureFactory): AppError {
  console.error(JSON.stringify({ event: 'logto_management_failed', step, detail }));
  return toError();
}

/** 读响应体并解析成 JSON；读取或解析失败按上游失败处理，日志只记错误名 */
async function readJsonBody(response: Response, step: string, toError: FailureFactory): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw upstreamFailure(step, errorName(error), toError);
  }
}

/**
 * 创建 Management API 客户端；token 缓存在返回的客户端里，进程内复用同一个客户端即可共享缓存。
 */
export function createLogtoManagementClient(
  config: ILogtoManagementConfig,
  options: ILogtoManagementOptions = {},
): ILogtoManagementClient {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  /** 缓存的 M2M access token */
  let cachedToken: { value: string; expiresAt: number } | null = null;

  /** 获取可用的 Management API access token；失败时抛 toError() */
  async function getToken(toError: FailureFactory): Promise<string> {
    if (cachedToken !== null && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    let response: Response;
    try {
      response = await fetchFn(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: config.resource,
          scope: 'all',
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw upstreamFailure('token', errorName(error), toError);
    }

    if (!response.ok) {
      throw upstreamFailure('token', `HTTP ${response.status}`, toError);
    }

    const body = await readJsonBody(response, 'token_body', toError);
    const token = parseTokenResponse(body);
    if (token === null) {
      throw upstreamFailure('token_body', '缺少 access_token 或 expires_in', toError);
    }

    cachedToken = {
      value: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return token.accessToken;
  }

  /**
   * 带 token 调一次 Management API，返回响应，由调用方按状态码判断结果。
   * 取 token 失败、网络错误和超时都抛 toError()；body 有值时按 JSON 发送。
   */
  async function callApi(
    step: string,
    toError: FailureFactory,
    path: string,
    request: { method: 'GET' | 'POST' | 'DELETE'; body?: Record<string, string> },
  ): Promise<Response> {
    const token = await getToken(toError);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetchFn(`${config.apiBaseUrl}${path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw upstreamFailure(step, errorName(error), toError);
    }
    if (response.status === 401) {
      // token 可能被提前吊销，丢弃缓存让下次重试换新的
      cachedToken = null;
    }
    return response;
  }

  return {
    async deleteUser(userId: string): Promise<void> {
      const response = await callApi('delete_user', deletionFailure, `/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
      if (response.status === 204 || response.status === 404) {
        return;
      }
      throw upstreamFailure('delete_user', `HTTP ${response.status}`, deletionFailure);
    },

    async getPrimaryEmail(userId: string): Promise<string | null> {
      const response = await callApi('get_user', verificationFailure, `/users/${encodeURIComponent(userId)}`, {
        method: 'GET',
      });
      if (response.status !== 200) {
        throw upstreamFailure('get_user', `HTTP ${response.status}`, verificationFailure);
      }
      const body = await readJsonBody(response, 'get_user_body', verificationFailure);
      const parsed = parsePrimaryEmail(body);
      if (!parsed.ok) {
        throw upstreamFailure('get_user_body', '缺少 primaryEmail 或类型不对', verificationFailure);
      }
      return parsed.email;
    },

    async verifyPassword(userId: string, password: string): Promise<boolean> {
      const response = await callApi(
        'verify_password',
        verificationFailure,
        `/users/${encodeURIComponent(userId)}/password/verify`,
        { method: 'POST', body: { password } },
      );
      if (response.status === 204) {
        return true;
      }
      if (response.status === 422 || response.status === 400) {
        return false;
      }
      throw upstreamFailure('verify_password', `HTTP ${response.status}`, verificationFailure);
    },

    async sendEmailVerificationCode(email: string): Promise<void> {
      const response = await callApi('send_code', verificationFailure, '/verification-codes', {
        method: 'POST',
        body: { email },
      });
      if (response.status >= 200 && response.status <= 299) {
        return;
      }
      throw upstreamFailure('send_code', `HTTP ${response.status}`, verificationFailure);
    },

    async verifyEmailVerificationCode(email: string, code: string): Promise<EmailCodeVerificationResult> {
      const response = await callApi('verify_code', verificationFailure, '/verification-codes/verify', {
        method: 'POST',
        body: { email, verificationCode: code },
      });
      if (response.status === 204) {
        return 'ok';
      }
      if (response.status === 400) {
        const body = await readJsonBody(response, 'verify_code_body', verificationFailure);
        const errorCode = parseErrorCode(body);
        if (errorCode === CODE_MISMATCH_ERROR) {
          return 'mismatch';
        }
        if (errorCode !== null && CODE_INVALID_ERRORS.has(errorCode)) {
          return 'invalid';
        }
        throw upstreamFailure('verify_code', 'HTTP 400 无法识别的错误码', verificationFailure);
      }
      throw upstreamFailure('verify_code', `HTTP ${response.status}`, verificationFailure);
    },
  };
}
