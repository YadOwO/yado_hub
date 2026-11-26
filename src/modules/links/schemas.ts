/**
 * 数据联动接口的 Zod 契约。
 *
 * 路径用 {source}/{target}（数据从哪个产品来、给哪个产品用），不是 {product}。
 * 汇总里的金额是两位小数的字符串，不用 JSON number，避免浮点误差；件数是整数。
 */
import { z } from '@hono/zod-openapi';

import { DATA_LINK_SOURCES_SUPPORTED } from '../../config/data-links.js';

/** 联动的使用方产品代号：目前只有芽豆资产 */
export const DATA_LINK_TARGET = 'yadoa' as const;

/** 联动的数据范围：芽豆有物物品的购入价汇总 */
export const DATA_LINK_SCOPE = 'item_value_summary' as const;

/** 金额字符串的格式：非负、恰好两位小数，例如 1234.50 */
const MONEY_PATTERN = /^\d+\.\d{2}$/;

/** 两位小数的金额字符串 */
const MoneySchema = z.string().regex(MONEY_PATTERN);

/** 路径参数：联动来源与使用方；不在白名单里的值返回 400 */
export const LinkParamsSchema = z.object({
  source: z
    .enum(DATA_LINK_SOURCES_SUPPORTED)
    .openapi({ param: { name: 'source', in: 'path' }, description: '数据来源的产品代号', example: 'yadoi' }),
  target: z
    .enum([DATA_LINK_TARGET])
    .openapi({ param: { name: 'target', in: 'path' }, description: '数据使用方的产品代号', example: 'yadoa' }),
});

/** 一项联动授权及其状态 */
export const DataLinkSchema = z
  .object({
    source: z.string().openapi({ description: '数据来源的产品代号', example: 'yadoi' }),
    target: z.string().openapi({ description: '数据使用方的产品代号', example: 'yadoa' }),
    scope: z.literal(DATA_LINK_SCOPE).openapi({ description: '授权的数据范围：物品购入价汇总' }),
    granted: z.boolean().openapi({ description: '当前用户是否已授权' }),
    grantedAt: z.string().nullable().openapi({
      description: '最近一次授权生效的时刻，ISO 8601；未授权为 null',
      example: '2026-11-24T08:00:00.000Z',
    }),
  })
  .openapi('DataLink');

/** 联动列表：只含 DATA_LINK_SOURCES 里打开的来源，没打开任何来源时为空数组 */
export const DataLinkListSchema = z.object({ links: z.array(DataLinkSchema) }).openapi('DataLinkList');

/**
 * 来源产品后端返回的物品购入价汇总，hub 用它校验上游响应，不合契约就当上游失败。
 * 口径：只算在用与退役、未删除的物品；没填购入价的只计入 unpricedItemCount。
 */
export const ItemValueSummarySchema = z.object({
  inServicePurchaseTotal: MoneySchema.openapi({ description: '在用物品的购入价合计', example: '1234.50' }),
  retiredPurchaseTotal: MoneySchema.openapi({ description: '退役物品的购入价合计', example: '300.00' }),
  pricedItemCount: z.number().int().min(0).openapi({ description: '填了购入价的物品件数', example: 12 }),
  unpricedItemCount: z.number().int().min(0).openapi({ description: '没填购入价的物品件数', example: 2 }),
  lastItemUpdatedAt: z.string().nullable().openapi({
    description: '这批物品里最近一次更新的时刻，ISO 8601；没有物品时为 null',
    example: '2026-11-23T10:00:00.000Z',
  }),
});

/** 对外返回的汇总：来源后端的汇总数原样转发，再加上 hub 取到它的时刻 */
export const LinkedItemValueSummarySchema = ItemValueSummarySchema.extend({
  fetchedAt: z.string().openapi({ description: 'hub 取到这份汇总的时刻，ISO 8601', example: '2026-11-24T08:00:00.000Z' }),
}).openapi('LinkedItemValueSummary');

/** 一项联动授权及其状态 */
export type DataLinkDTO = z.infer<typeof DataLinkSchema>;

/** 联动列表 */
export type DataLinkListDTO = z.infer<typeof DataLinkListSchema>;

/** 来源后端返回的物品购入价汇总 */
export type ItemValueSummaryDTO = z.infer<typeof ItemValueSummarySchema>;

/** 对外返回的物品购入价汇总（带 fetchedAt） */
export type LinkedItemValueSummaryDTO = z.infer<typeof LinkedItemValueSummarySchema>;
