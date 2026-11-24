/**
 * Logto Management API 客户端。
 *
 * 只实现注销账号最后一步需要的「删除用户」（从 yadoA_be 挪来，现在只有 hub 删 Logto 用户）。
 * 用 Machine-to-Machine 应用的 client_credentials 换取 access token，缓存在客户端里，到期前 60 秒重新获取。
 * 日志只记录状态码和错误名，不记录 token 与密钥。本文件不 import config/env.ts，配置由调用方传入，方便单独测试。
 */
import { accountDeletionFailed } from './errors.js';

/** 注销失败时 details.step 的取值，表示卡在删除 Logto 用户这一步 */
export const LOGTO_DELETION_STEP = 'logto';

/** 单次请求默认超时（毫秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** token 提前多少毫秒视为过期，避免用到刚好失效的 token */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

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

/** Management API 客户端 */
export interface ILogtoManagementClient {
  /**
   * 删除 Logto 用户。204 与 404（已经删过）都算成功；网络错误、超时与其他状态码抛 502 ACCOUNT_DELETION_FAILED。
   */
  deleteUser(userId: string): Promise<void>;
}

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

/** 从捕获的异常中取出可安全写入日志的错误名，不带 message，避免把上游返回的敏感内容写进日志 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** 记录上游错误并返回对外的 502 错误，日志只含步骤与状态码或错误名 */
function upstreamFailure(step: string, detail: string): Error {
  console.error(JSON.stringify({ event: 'logto_management_failed', step, detail }));
  return accountDeletionFailed(LOGTO_DELETION_STEP);
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

  /** 获取可用的 Management API access token */
  async function getToken(): Promise<string> {
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
      throw upstreamFailure('token', errorName(error));
    }

    if (!response.ok) {
      throw upstreamFailure('token', `HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw upstreamFailure('token_body', errorName(error));
    }
    const token = parseTokenResponse(body);
    if (token === null) {
      throw upstreamFailure('token_body', '缺少 access_token 或 expires_in');
    }

    cachedToken = {
      value: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return token.accessToken;
  }

  return {
    async deleteUser(userId: string): Promise<void> {
      const token = await getToken();

      let response: Response;
      try {
        response = await fetchFn(`${config.apiBaseUrl}/users/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw upstreamFailure('delete_user', errorName(error));
      }

      if (response.status === 204 || response.status === 404) {
        return;
      }
      if (response.status === 401) {
        // token 可能被提前吊销，丢弃缓存让下次重试换新的
        cachedToken = null;
      }
      throw upstreamFailure('delete_user', `HTTP ${response.status}`);
    },
  };
}
