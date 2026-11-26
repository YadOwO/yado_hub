/**
 * 注销前的数据汇总：注销确认页要告诉用户「会删掉什么」，hub 并行调各下游服务的只读内部接口
 * `GET {地址}/internal/v1/users/{userId}/summary`，汇总各产品的数据量。
 *
 * 汇总只是给用户看的参考，不影响注销：某个下游失败、超时或返回了看不懂的内容，只把那一项标为 unavailable，
 * 不让整个汇总失败，更不会拦住注销。
 *
 * 本文件不依赖数据库与环境变量（只做类型引用），配置与 fetch 由调用方通过参数传入，方便单独测试。
 */
import { z } from '@hono/zod-openapi';

import type { IDownstreamService } from '../../config/account-deletion.js';
import { errorName } from '../../shared/errors.js';
import { INTERNAL_USERS_PATH } from './deletion.js';

/**
 * 每个下游服务汇总接口的超时（毫秒）。
 *
 * 各下游并行调用，总时长约 10 秒，低于 nginx 默认的 60 秒读超时。
 */
export const DOWNSTREAM_SUMMARY_TIMEOUT_MS = 10_000;

/** 下游一次最多返回多少项；超过说明对方实现有问题，整个服务按 unavailable 处理 */
const DOWNSTREAM_SUMMARY_MAX_ITEMS = 20;

/** 项 key 的格式：小写字母、数字和下划线，最长 64 位 */
const SUMMARY_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;

/** 下游汇总接口的响应体：{ items: [{ key, count }] }，多余的字段忽略 */
const DownstreamSummarySchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().regex(SUMMARY_KEY_PATTERN),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(DOWNSTREAM_SUMMARY_MAX_ITEMS),
});

/** 汇总里的一项：某类数据的数量，例如 points_balance 的 120 */
export interface IAccountSummaryItem {
  /** 数据类别，由下游约定，例如 points_balance、synced_records、items */
  key: string;
  /** 数量，非负整数 */
  count: number;
}

/** 一个下游服务的汇总结果 */
export interface IServiceSummary {
  /** 服务名，例如 yado-ai；App 靠服务名加 key 对应文案 */
  service: string;
  /** ok 表示查到了；unavailable 表示这个服务暂时查不到（失败、超时或响应看不懂），items 为空 */
  status: 'ok' | 'unavailable';
  /** 这个服务汇总出的各项数据量 */
  items: IAccountSummaryItem[];
}

/** 整个账号的汇总，各服务的顺序与配置一致 */
export interface IAccountSummary {
  services: IServiceSummary[];
}

/** 调下游汇总接口的可选项，测试时注入假 fetch 和更短的超时 */
export interface IDownstreamSummaryOptions {
  /** 发请求用的 fetch，默认是全局 fetch */
  fetch?: typeof fetch;
  /** 超时（毫秒），默认 DOWNSTREAM_SUMMARY_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 记一条下游汇总失败的日志：只有服务名、用户 ID、状态码或错误名，不含凭证与地址 */
function logSummaryFailure(service: IDownstreamService, userId: string, reason: { status: number } | { error: string }): void {
  console.error(JSON.stringify({ event: 'account_summary_service_failed', service: service.name, userId, ...reason }));
}

/** 这个服务暂时查不到的结果 */
function unavailableSummary(service: IDownstreamService): IServiceSummary {
  return { service: service.name, status: 'unavailable', items: [] };
}

/**
 * 调下游服务的内部汇总接口：`GET {baseUrl}/internal/v1/users/{userId}/summary`，带这个服务专用的机器凭证。
 *
 * 只有 2xx 且响应体符合约定才算查到。非 2xx、超时、网络错误、响应体格式不对一律返回 unavailable，不抛错。
 * 不跟随重定向，凭证不会被带到别的地址。日志只记服务名、用户 ID、状态码或错误名，不记凭证。
 */
export async function fetchServiceSummary(
  service: IDownstreamService,
  userId: string,
  options: IDownstreamSummaryOptions = {},
): Promise<IServiceSummary> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DOWNSTREAM_SUMMARY_TIMEOUT_MS;
  let status: number;
  let body: unknown;
  try {
    const response = await fetchFn(`${service.baseUrl}${INTERNAL_USERS_PATH}${encodeURIComponent(userId)}/summary`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${service.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    if (status >= 200 && status <= 299) {
      body = await response.json();
    } else {
      // 非 2xx 的响应体用不上，读完丢弃，连接才能复用
      await response.arrayBuffer();
    }
  } catch (error) {
    logSummaryFailure(service, userId, { error: errorName(error) });
    return unavailableSummary(service);
  }

  if (status < 200 || status > 299) {
    logSummaryFailure(service, userId, { status });
    return unavailableSummary(service);
  }
  const parsed = DownstreamSummarySchema.safeParse(body);
  if (!parsed.success) {
    logSummaryFailure(service, userId, { error: 'InvalidSummaryBody' });
    return unavailableSummary(service);
  }
  return { service: service.name, status: 'ok', items: parsed.data.items };
}

/**
 * 并行查各下游服务的汇总，结果的顺序与 services 一致。
 *
 * 数量为 0 的项不返回；查到了但一项都没有（含全是 0）的服务也不返回，App 不用列「0 件物品」。
 * 查不到的服务（unavailable）保留，App 显示「暂时查不到」。
 */
export async function collectAccountSummary(
  services: readonly IDownstreamService[],
  userId: string,
  options: IDownstreamSummaryOptions = {},
): Promise<IAccountSummary> {
  const results = await Promise.all(services.map((service) => fetchServiceSummary(service, userId, options)));
  return {
    services: results
      .map((result) => ({ ...result, items: result.items.filter((item) => item.count > 0) }))
      .filter((result) => result.status === 'unavailable' || result.items.length > 0),
  };
}
