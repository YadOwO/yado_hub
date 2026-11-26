/**
 * 数据联动来源配置的解析。
 *
 * 数据联动：用户授权后，hub 用机器凭证向「来源」产品的后端要一份汇总数（目前只有芽豆有物 yadoi 的物品估值汇总）。
 * DATA_LINK_SOURCES 决定打开哪些来源；来源后端的地址与凭证不单独配置，复用 ACCOUNT_DELETION_SERVICES /
 * ACCOUNT_DELETION_TOKENS 里对应的那一项（见 DATA_LINK_SOURCE_SERVICES）。
 * 本文件不 import config/env.ts，单元测试不需要环境变量。
 */
import { type IDownstreamService } from './account-deletion.js';
import { splitCommaSeparated } from './comma-separated.js';

/** 目前支持的联动来源（产品代号）；以后加来源时在这里加一项，并补上 DATA_LINK_SOURCE_SERVICES */
export const DATA_LINK_SOURCES_SUPPORTED = ['yadoi'] as const;

/** 联动来源的产品代号 */
export type DataLinkSource = (typeof DATA_LINK_SOURCES_SUPPORTED)[number];

/** 联动来源对应的下游服务名，即 ACCOUNT_DELETION_SERVICES 里的服务名；地址与机器凭证取自那一项 */
export const DATA_LINK_SOURCE_SERVICES: Record<DataLinkSource, string> = {
  yadoi: 'yadoi-be',
};

/** 判断一个字符串是不是支持的联动来源，同时收窄类型 */
export function isDataLinkSource(value: string): value is DataLinkSource {
  return DATA_LINK_SOURCES_SUPPORTED.some((source) => source === value);
}

/** 解析结果：成功时带「来源 → 下游服务」的映射，失败时带一句说明（只含来源名与服务名，不含地址和凭证） */
export type DataLinkSourcesResult =
  | { ok: true; sources: ReadonlyMap<DataLinkSource, IDownstreamService> }
  | { ok: false; message: string };

/**
 * 解析 DATA_LINK_SOURCES：逗号分隔的来源产品代号，例如 `yadoi`。
 *
 * 空字符串或只有空白表示没配（不开任何联动），返回空 Map。不认识的来源、重复的来源、
 * 在 services 里找不到对应服务（yadoi 对应 yadoi-be）都算配置错误，调用方据此让服务启动失败。
 *
 * @param value DATA_LINK_SOURCES 的原始值
 * @param services 已解析的 ACCOUNT_DELETION_SERVICES，来源后端的地址与机器凭证从中取
 */
export function parseDataLinkSources(value: string, services: readonly IDownstreamService[]): DataLinkSourcesResult {
  const sources = new Map<DataLinkSource, IDownstreamService>();
  for (const item of splitCommaSeparated(value)) {
    if (!isDataLinkSource(item)) {
      return {
        ok: false,
        message: `DATA_LINK_SOURCES 里的 ${item} 不认识，目前只支持 ${DATA_LINK_SOURCES_SUPPORTED.join('、')}`,
      };
    }
    if (sources.has(item)) {
      return { ok: false, message: `DATA_LINK_SOURCES 里 ${item} 出现了不止一次` };
    }
    const serviceName = DATA_LINK_SOURCE_SERVICES[item];
    const service = services.find((candidate) => candidate.name === serviceName);
    if (service === undefined) {
      return {
        ok: false,
        message: `DATA_LINK_SOURCES 打开了 ${item}，但 ACCOUNT_DELETION_SERVICES / ACCOUNT_DELETION_TOKENS 里没有 ${serviceName}`,
      };
    }
    sources.set(item, service);
  }
  return { ok: true, sources };
}
