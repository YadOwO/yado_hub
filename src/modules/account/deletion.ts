/**
 * 注销账号的编排：所有芽豆 App 共用一个 Logto 账号，注销统一由 hub 删完各服务的数据，最后删 Logto 用户。
 *
 * 顺序：注销名单 → 意见反馈 → 数据联动授权 → 下游服务 → Logto → 记下已完成。
 * 即：写注销名单 → 删 hub 自己的意见反馈 → 删数据联动授权记录 → 按配置顺序调各下游服务的内部删除接口 → 删 Logto 用户。
 * 任何一步失败立即抛出，后面的步骤都不执行；每一步都可以重复执行，App 重试时从头再走一遍。
 * Logto 用户放在最后删：删了之后 App 就拿不到新 token，也就没法再重试。
 *
 * 本文件不依赖数据库与环境变量（只做类型引用），数据库与配置由调用方通过参数传入，方便单独测试。
 */
import type { IDownstreamService } from '../../config/account-deletion.js';
import { accountDeletionFailed, errorName, serviceNotConfigured } from '../../shared/errors.js';

/**
 * 每个下游服务删除接口的超时（毫秒）。
 *
 * 三个下游各 10 秒、Logto 换 token 与删用户各 10 秒，最坏约 50 秒，低于 nginx 默认的 60 秒读超时；
 * 加下游服务时要一起核对，App 的请求超时也要比总时长长。
 */
export const DOWNSTREAM_DELETION_TIMEOUT_MS = 10_000;

/** 下游服务内部删除接口的路径前缀，后面接 URL 编码后的用户 ID */
const INTERNAL_USERS_PATH = '/internal/v1/users/';

/** 决定这次注销要做哪些步骤所需的配置 */
export interface IAccountDeletionConfig {
  /** 配置的下游服务，按调用顺序 */
  services: readonly IDownstreamService[];
  /** Logto Management API 的 M2M 凭证是否已配置 */
  isLogtoConfigured: boolean;
  /** 是否开发态免鉴权：此时的用户是假用户，Logto 里不存在 */
  isDevAuthBypassEnabled: boolean;
}

/** 这次注销要执行的步骤 */
export interface IAccountDeletionPlan {
  /** 要调用的下游服务，按顺序 */
  services: readonly IDownstreamService[];
  /** 是否删除 Logto 用户；开发态免鉴权的假用户不删 */
  shouldDeleteLogtoUser: boolean;
}

/** 编排用到的每一步动作，由调用方接上数据库、网络与 Logto */
export interface IAccountDeletionSteps {
  /** 把用户写进注销名单，可重复调用 */
  markUserDeleted(userId: string): Promise<void>;
  /** 删除用户在所有产品下的意见反馈，返回删除的对话数 */
  deleteFeedback(userId: string): Promise<number>;
  /** 物理删除用户的数据联动授权记录，返回删除的行数 */
  deleteDataLinks(userId: string): Promise<number>;
  /** 调一个下游服务删除这个用户的数据；失败抛 502 ACCOUNT_DELETION_FAILED */
  deleteFromService(service: IDownstreamService, userId: string): Promise<void>;
  /** 删除 Logto 用户；已删过（404）算成功 */
  deleteLogtoUser(userId: string): Promise<void>;
  /** 记下整套注销已经走完 */
  markCompleted(userId: string): Promise<void>;
}

/**
 * 按配置决定这次注销要做哪些步骤。
 *
 * 和 yadoA_be 以前的做法一致：开发态免鉴权的假用户不删 Logto 用户，下游服务配了几个就调几个（可以一个都不配）；
 * 真实用户缺 Logto 凭证或一个下游服务都没配时直接返回 503，什么都不动，不会悄悄只删一部分。
 * 生产环境（NODE_ENV=production）强制关闭开发态免鉴权，所以线上一定走后一种。
 *
 * @throws 503 SERVICE_NOT_CONFIGURED
 */
export function resolveAccountDeletionPlan(config: IAccountDeletionConfig): IAccountDeletionPlan {
  if (config.isDevAuthBypassEnabled) {
    return { services: config.services, shouldDeleteLogtoUser: false };
  }
  if (!config.isLogtoConfigured || config.services.length === 0) {
    throw serviceNotConfigured();
  }
  return { services: config.services, shouldDeleteLogtoUser: true };
}

/** 写一条注销进度日志：只有步骤、用户 ID、数量与耗时，不含凭证与地址 */
function logStep(fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event: 'account_deletion_step', ...fields }));
}

/**
 * 按计划依次执行注销的每一步；任何一步抛错都原样向上抛，后面的步骤不再执行。
 *
 * 注销名单必须第一个写：写入后该用户的新请求在鉴权时就被拒绝，发反馈消息也会在事务里查到它，
 * 删数据期间不会再写进新数据。
 */
export async function deleteAccountEverywhere(
  userId: string,
  plan: IAccountDeletionPlan,
  steps: IAccountDeletionSteps,
): Promise<void> {
  const startedAt = Date.now();
  await steps.markUserDeleted(userId);

  let stepStartedAt = Date.now();
  const conversationCount = await steps.deleteFeedback(userId);
  logStep({ userId, step: 'feedback', conversationCount, ms: Date.now() - stepStartedAt });

  stepStartedAt = Date.now();
  const linkCount = await steps.deleteDataLinks(userId);
  logStep({ userId, step: 'data_links', linkCount, ms: Date.now() - stepStartedAt });

  for (const service of plan.services) {
    stepStartedAt = Date.now();
    await steps.deleteFromService(service, userId);
    logStep({ userId, step: service.name, ms: Date.now() - stepStartedAt });
  }

  if (plan.shouldDeleteLogtoUser) {
    stepStartedAt = Date.now();
    await steps.deleteLogtoUser(userId);
    logStep({ userId, step: 'logto', ms: Date.now() - stepStartedAt });
  }

  await steps.markCompleted(userId);
  logStep({ userId, step: 'completed', ms: Date.now() - startedAt });
}

/** 调下游删除接口的可选项，测试时注入假 fetch 和更短的超时 */
export interface IDownstreamDeletionOptions {
  /** 发请求用的 fetch，默认是全局 fetch */
  fetch?: typeof fetch;
  /** 超时（毫秒），默认 DOWNSTREAM_DELETION_TIMEOUT_MS */
  timeoutMs?: number;
}

/**
 * 调下游服务的内部删除接口：`DELETE {baseUrl}/internal/v1/users/{userId}`，带这个服务专用的机器凭证。
 *
 * 只有 2xx 算成功；非 2xx、超时、网络错误、读响应体失败都抛 502 ACCOUNT_DELETION_FAILED（details.step 是服务名）。
 * 不跟随重定向，凭证不会被带到别的地址。日志只记服务名、用户 ID、状态码或错误名，不记凭证。
 *
 * @throws 502 ACCOUNT_DELETION_FAILED
 */
export async function deleteUserFromService(
  service: IDownstreamService,
  userId: string,
  options: IDownstreamDeletionOptions = {},
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DOWNSTREAM_DELETION_TIMEOUT_MS;
  let status: number;
  try {
    const response = await fetchFn(`${service.baseUrl}${INTERNAL_USERS_PATH}${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${service.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    // 读完响应体再判断，连接才能复用；响应体很小，读失败按这一步失败处理
    await response.arrayBuffer();
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'account_deletion_service_failed', service: service.name, userId, error: errorName(error) }),
    );
    throw accountDeletionFailed(service.name);
  }
  if (status < 200 || status > 299) {
    console.error(JSON.stringify({ event: 'account_deletion_service_failed', service: service.name, userId, status }));
    throw accountDeletionFailed(service.name);
  }
}
