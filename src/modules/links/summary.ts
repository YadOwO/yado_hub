/**
 * 数据联动的取汇总逻辑：向来源产品后端要物品购入价汇总、判断能不能取、拼联动列表。
 *
 * 本文件不依赖数据库与环境变量（只做类型引用与纯函数），数据库读写与配置由调用方通过参数传入，方便单独测试。
 */
import type { IDownstreamService } from '../../config/account-deletion.js';
import type { DataLinkSource } from '../../config/data-links.js';
import { dataLinkNotGranted, dataLinkUnavailable, dataLinkUpstreamFailed, errorName } from '../../shared/errors.js';
import {
  DATA_LINK_SCOPE,
  DATA_LINK_TARGET,
  ItemValueSummarySchema,
  type DataLinkDTO,
  type DataLinkListDTO,
  type ItemValueSummaryDTO,
  type LinkedItemValueSummaryDTO,
} from './schemas.js';

/**
 * 向来源后端取汇总的超时（毫秒）。
 *
 * 用户打开账户页时就会取，所以要短：来源后端慢或挂了，App 宁可 5 秒后用本机缓存，也不要让页面一直等。
 */
export const ITEM_VALUE_SUMMARY_TIMEOUT_MS = 5_000;

/** 来源后端内部接口的路径前缀，后面接 URL 编码后的用户 ID 和 /item-value-summary */
const INTERNAL_USERS_PATH = '/internal/v1/users/';

/** 取汇总的可选项，测试时注入假 fetch 和更短的超时 */
export interface IFetchItemValueSummaryOptions {
  /** 发请求用的 fetch，默认是全局 fetch */
  fetch?: typeof fetch;
  /** 超时（毫秒），默认 ITEM_VALUE_SUMMARY_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 记一条取汇总失败的日志：只有服务名、用户 ID、状态码或错误名，不记凭证、地址与金额 */
function logUpstreamFailure(
  service: IDownstreamService,
  userId: string,
  reason: { status: number } | { error: string },
): void {
  console.error(JSON.stringify({ event: 'data_link_upstream_failed', service: service.name, userId, ...reason }));
}

/**
 * 向来源后端取这个用户的物品购入价汇总：`GET {baseUrl}/internal/v1/users/{userId}/item-value-summary`，
 * 带这个服务专用的机器凭证。只取汇总数，不取物品明细。
 *
 * 只有 2xx 且响应符合 ItemValueSummarySchema 才算成功；非 2xx、超时、网络错误、JSON 解析失败、
 * 响应不合契约一律抛 502 DATA_LINK_UPSTREAM_FAILED。不跟随重定向，凭证不会被带到别的地址。
 *
 * @throws 502 DATA_LINK_UPSTREAM_FAILED
 */
export async function fetchItemValueSummary(
  service: IDownstreamService,
  userId: string,
  options: IFetchItemValueSummaryOptions = {},
): Promise<ItemValueSummaryDTO> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ITEM_VALUE_SUMMARY_TIMEOUT_MS;
  let status: number;
  let text: string;
  try {
    const response = await fetchFn(
      `${service.baseUrl}${INTERNAL_USERS_PATH}${encodeURIComponent(userId)}/item-value-summary`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${service.token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    status = response.status;
    // 无论成败都读完响应体，连接才能复用；读失败或超时按这次取汇总失败处理
    text = await response.text();
  } catch (error) {
    logUpstreamFailure(service, userId, { error: errorName(error) });
    throw dataLinkUpstreamFailed();
  }
  if (status < 200 || status > 299) {
    logUpstreamFailure(service, userId, { status });
    throw dataLinkUpstreamFailed();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    logUpstreamFailure(service, userId, { error: errorName(error) });
    throw dataLinkUpstreamFailed();
  }
  const parsed = ItemValueSummarySchema.safeParse(payload);
  if (!parsed.success) {
    logUpstreamFailure(service, userId, { error: 'InvalidResponse' });
    throw dataLinkUpstreamFailed();
  }
  return parsed.data;
}

/** 取联动汇总所需的依赖，由调用方接上配置、数据库与网络 */
export interface IResolveItemValueSummaryDeps {
  /** 来源对应的下游服务；来源没打开（DATA_LINK_SOURCES 里没有它）时为 undefined */
  service: IDownstreamService | undefined;
  /** 这个用户是否已授权这个来源 */
  isGranted(userId: string): Promise<boolean>;
  /** 向来源后端取汇总；失败抛 502 DATA_LINK_UPSTREAM_FAILED */
  fetchSummary(service: IDownstreamService, userId: string): Promise<ItemValueSummaryDTO>;
  /** 当前时刻，默认取系统时钟；测试时注入固定值 */
  now?: () => Date;
}

/**
 * 取联动汇总：先看来源有没有打开，再看用户有没有授权，都满足才去来源后端取，
 * 成功时把汇总数原样返回并加上取到的时刻 fetchedAt。
 *
 * 顺序固定：来源没开时不查数据库，没授权时不调来源后端，用户没同意过就不会有任何一次对外请求。
 *
 * @throws 404 DATA_LINK_UNAVAILABLE 来源没开
 * @throws 403 DATA_LINK_NOT_GRANTED 用户没授权
 * @throws 502 DATA_LINK_UPSTREAM_FAILED 来源后端失败（由 fetchSummary 抛出）
 */
export async function resolveItemValueSummary(
  userId: string,
  deps: IResolveItemValueSummaryDeps,
): Promise<LinkedItemValueSummaryDTO> {
  const { service } = deps;
  if (service === undefined) {
    throw dataLinkUnavailable();
  }
  if (!(await deps.isGranted(userId))) {
    throw dataLinkNotGranted();
  }
  const summary = await deps.fetchSummary(service, userId);
  const now = deps.now ?? ((): Date => new Date());
  return { ...summary, fetchedAt: now().toISOString() };
}

/**
 * 生成一项联动的对外结构。
 *
 * @param grantedAt 授权生效的时刻；未授权（或刚取消）传 null
 */
export function toDataLink(source: DataLinkSource, grantedAt: Date | null): DataLinkDTO {
  return {
    source,
    target: DATA_LINK_TARGET,
    scope: DATA_LINK_SCOPE,
    granted: grantedAt !== null,
    grantedAt: grantedAt === null ? null : grantedAt.toISOString(),
  };
}

/**
 * 生成联动列表：每个打开的来源一项，带是否已授权。
 *
 * @param enabledSources DATA_LINK_SOURCES 里打开的来源；没打开任何来源时返回空列表
 * @param grantedAt 用户已授权的来源 → 授权时刻；不在里面的来源算未授权
 */
export function buildLinkList(
  enabledSources: readonly DataLinkSource[],
  grantedAt: ReadonlyMap<DataLinkSource, Date>,
): DataLinkListDTO {
  return { links: enabledSources.map((source) => toDataLink(source, grantedAt.get(source) ?? null)) };
}
