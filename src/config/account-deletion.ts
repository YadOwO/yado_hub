/**
 * 注销账号要调用的下游服务配置的解析。
 *
 * 用户在任一芽豆 App 注销时，hub 按 ACCOUNT_DELETION_SERVICES 的顺序依次调各服务的内部删除接口
 * （`DELETE {地址}/internal/v1/users/{userId}`），每个服务用 ACCOUNT_DELETION_TOKENS 里各自的机器凭证。
 * 本文件不 import config/env.ts，单元测试不需要环境变量。
 */

/** 注销时要调用的一个下游服务 */
export interface IDownstreamService {
  /** 服务名，例如 yado-ai；日志与错误详情里用它标明是哪一步 */
  name: string;
  /** 容器内网地址，不带末尾的 `/`，例如 http://yado-ai:7790 */
  baseUrl: string;
  /** 发给这个服务的机器凭证明文；对方只存它的 sha256 */
  token: string;
}

/** 服务名的格式，与 agent 机器 ID 的规则一致 */
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 机器凭证的格式：至少 32 位，只含 base64 / 十六进制会用到的字符，不能有逗号、冒号与空白 */
const TOKEN_PATTERN = /^[A-Za-z0-9+/=_-]{32,}$/;

/** 把逗号分隔的配置拆成列表，去掉每项首尾空白并丢弃空项；config/data-links.ts 也用它 */
export function splitItems(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 按第一个分隔符把一项拆成两段；没有分隔符或任一段为空时返回 null */
function splitPair(item: string, separator: string): [string, string] | null {
  const index = item.indexOf(separator);
  if (index <= 0 || index === item.length - 1) {
    return null;
  }
  return [item.slice(0, index).trim(), item.slice(index + 1).trim()];
}

/** 解析 http / https 地址并去掉末尾的 `/`；格式不对时返回 null */
function normalizeBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  return value.replace(/\/+$/, '');
}

/** 解析结果：成功时带有序的服务列表，失败时带一句说明（不含凭证内容） */
export type AccountDeletionServicesResult =
  | { ok: true; services: IDownstreamService[] }
  | { ok: false; message: string };

/**
 * 解析下游服务列表与各自的凭证。
 *
 * - servicesValue：`服务名=地址`，逗号分隔，按调用顺序排列，例如 `yado-ai=http://yado-ai:7790,yadoa-be=http://yadoa-be:7789`；
 * - tokensValue：`服务名:凭证`，逗号分隔，每个服务一个，例如 `yado-ai:<凭证>,yadoa-be:<凭证>`。
 *
 * 两项都为空（含只有空白）时返回空列表，表示未配置。服务名重复、地址不是 http(s)、
 * 某个服务缺凭证、凭证对应的服务不在列表里，都算配置错误。
 */
export function parseAccountDeletionServices(servicesValue: string, tokensValue: string): AccountDeletionServicesResult {
  const tokens = new Map<string, string>();
  for (const item of splitItems(tokensValue)) {
    const pair = splitPair(item, ':');
    if (pair === null || !SERVICE_NAME_PATTERN.test(pair[0])) {
      return { ok: false, message: 'ACCOUNT_DELETION_TOKENS 每项应为 服务名:凭证，服务名只含小写字母、数字和 -' };
    }
    const [name, token] = pair;
    if (!TOKEN_PATTERN.test(token)) {
      return { ok: false, message: `ACCOUNT_DELETION_TOKENS 里 ${name} 的凭证格式不对：至少 32 位，用 openssl rand -hex 32 生成` };
    }
    if (tokens.has(name)) {
      return { ok: false, message: `ACCOUNT_DELETION_TOKENS 里 ${name} 出现了不止一次` };
    }
    tokens.set(name, token);
  }

  const services: IDownstreamService[] = [];
  for (const item of splitItems(servicesValue)) {
    const pair = splitPair(item, '=');
    if (pair === null || !SERVICE_NAME_PATTERN.test(pair[0])) {
      return { ok: false, message: 'ACCOUNT_DELETION_SERVICES 每项应为 服务名=地址，服务名只含小写字母、数字和 -' };
    }
    const [name, rawUrl] = pair;
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (baseUrl === null) {
      return { ok: false, message: `ACCOUNT_DELETION_SERVICES 里 ${name} 的地址应为 http:// 或 https:// 开头` };
    }
    if (services.some((service) => service.name === name)) {
      return { ok: false, message: `ACCOUNT_DELETION_SERVICES 里 ${name} 出现了不止一次` };
    }
    const token = tokens.get(name);
    if (token === undefined) {
      return { ok: false, message: `ACCOUNT_DELETION_TOKENS 里缺少 ${name} 的凭证` };
    }
    services.push({ name, baseUrl, token });
  }

  for (const name of tokens.keys()) {
    if (!services.some((service) => service.name === name)) {
      return { ok: false, message: `ACCOUNT_DELETION_TOKENS 里的 ${name} 不在 ACCOUNT_DELETION_SERVICES 中` };
    }
  }
  return { ok: true, services };
}
