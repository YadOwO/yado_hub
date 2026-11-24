/**
 * 数据联动的用户端路由，挂在 /v1/links 下。
 *
 * 用户授权后，hub 用来源产品后端的机器凭证（取自 ACCOUNT_DELETION_* 里对应的服务）向它要一份汇总数，
 * 目前只有芽豆有物（yadoi）→ 芽豆资产（yadoa）的物品估值汇总。路径用 {source}/{target}，不按 {product}。
 * 必须登录并按用户限流；只能读写当前用户自己的授权。日志只记事件、用户 ID 与来源，不记金额。
 */
import { createRoute } from '@hono/zod-openapi';

import type { DataLinkSource } from '../../config/data-links.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { dataLinkRateLimit } from '../../middleware/rate-limit.js';
import { dataLinkUnavailable } from '../../shared/errors.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { DataLinkListSchema, DataLinkSchema, LinkedItemValueSummarySchema, LinkParamsSchema } from './schemas.js';
import { grantLink, isLinkGranted, listGrantedAt, revokeLink } from './service.js';
import { buildLinkList, fetchItemValueSummary, resolveItemValueSummary, toDataLink } from './summary.js';

/** 数据联动子应用 */
const app = createApp();

/** 记一条联动事件日志：只有事件名、用户 ID 与来源 */
function logLinkEvent(event: string, userId: string, source: DataLinkSource): void {
  console.log(JSON.stringify({ event, userId, source }));
}

/** 列出联动的 OpenAPI 契约 */
const listLinksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['links'],
  summary: '列出数据联动',
  description:
    '只列出服务端打开的联动来源，每项带当前用户是否已授权；没有打开任何来源时返回 {"links": []}。' +
    'App 据此判断要不要显示联动入口。',
  middleware: [requireAuth, dataLinkRateLimit] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '联动列表', content: { 'application/json': { schema: DataLinkListSchema } } },
    401: jsonError('未通过身份校验'),
    429: jsonError('调用过于频繁，details.rule 为 per_minute 或 per_day'),
  },
});

/** 授权的 OpenAPI 契约 */
const grantLinkRoute = createRoute({
  method: 'put',
  path: '/{source}/{target}',
  tags: ['links'],
  summary: '授权数据联动',
  description:
    '用户同意把来源产品的物品购入价汇总提供给目标产品。可以重复调用，已授权时不改授权时刻；' +
    '取消后再授权会清掉取消标记，授权时刻更新为当时。来源没打开时返回 404 DATA_LINK_UNAVAILABLE。',
  middleware: [requireAuth, dataLinkRateLimit] as const,
  security: [{ Bearer: [] }],
  request: { params: LinkParamsSchema },
  responses: {
    200: { description: '授权后的状态', content: { 'application/json': { schema: DataLinkSchema } } },
    400: jsonError('路径参数不在支持的来源与目标里'),
    401: jsonError('未通过身份校验'),
    404: jsonError('联动来源没有打开，code 为 DATA_LINK_UNAVAILABLE'),
    429: jsonError('调用过于频繁，details.rule 为 per_minute 或 per_day'),
  },
});

/** 取消授权的 OpenAPI 契约 */
const revokeLinkRoute = createRoute({
  method: 'delete',
  path: '/{source}/{target}',
  tags: ['links'],
  summary: '取消数据联动授权',
  description:
    '取消授权，之后取汇总返回 403。可以重复调用，没授权过也返回 200；' +
    '来源有没有打开都允许调用，保证用户随时能取消。',
  middleware: [requireAuth, dataLinkRateLimit] as const,
  security: [{ Bearer: [] }],
  request: { params: LinkParamsSchema },
  responses: {
    200: { description: '取消后的状态', content: { 'application/json': { schema: DataLinkSchema } } },
    400: jsonError('路径参数不在支持的来源与目标里'),
    401: jsonError('未通过身份校验'),
    429: jsonError('调用过于频繁，details.rule 为 per_minute 或 per_day'),
  },
});

/** 取物品购入价汇总的 OpenAPI 契约 */
const itemValueSummaryRoute = createRoute({
  method: 'get',
  path: '/{source}/{target}/item-value-summary',
  tags: ['links'],
  summary: '取联动的物品购入价汇总',
  description:
    '已授权时，hub 带来源产品后端的机器凭证向它要这个用户在用与退役物品的购入价汇总（只有合计与件数，没有物品明细），' +
    '5 秒超时，成功时原样返回汇总数并加上 hub 取到的时刻 fetchedAt。' +
    '来源没打开返回 404 DATA_LINK_UNAVAILABLE；没授权返回 403 DATA_LINK_NOT_GRANTED；' +
    '来源后端失败、超时或响应不合契约返回 502 DATA_LINK_UPSTREAM_FAILED。',
  middleware: [requireAuth, dataLinkRateLimit] as const,
  security: [{ Bearer: [] }],
  request: { params: LinkParamsSchema },
  responses: {
    200: { description: '物品购入价汇总', content: { 'application/json': { schema: LinkedItemValueSummarySchema } } },
    400: jsonError('路径参数不在支持的来源与目标里'),
    401: jsonError('未通过身份校验'),
    403: jsonError('用户没有授权，code 为 DATA_LINK_NOT_GRANTED'),
    404: jsonError('联动来源没有打开，code 为 DATA_LINK_UNAVAILABLE'),
    429: jsonError('调用过于频繁，details.rule 为 per_minute 或 per_day'),
    502: jsonError('来源后端失败、超时或响应不合契约，code 为 DATA_LINK_UPSTREAM_FAILED'),
  },
});

app.openapi(listLinksRoute, async (c) => {
  const granted = await listGrantedAt(c.get('userId'));
  return c.json(buildLinkList([...env.dataLinkSources.keys()], granted), 200);
});

app.openapi(grantLinkRoute, async (c) => {
  const { source } = c.req.valid('param');
  if (!env.dataLinkSources.has(source)) {
    throw dataLinkUnavailable();
  }
  const userId = c.get('userId');
  const grantedAt = await grantLink(userId, source);
  logLinkEvent('data_link_granted', userId, source);
  return c.json(toDataLink(source, grantedAt), 200);
});

app.openapi(revokeLinkRoute, async (c) => {
  const { source } = c.req.valid('param');
  const userId = c.get('userId');
  // 来源开没开都允许取消：来源被关掉后，用户之前的授权仍然能撤销
  await revokeLink(userId, source);
  logLinkEvent('data_link_revoked', userId, source);
  return c.json(toDataLink(source, null), 200);
});

app.openapi(itemValueSummaryRoute, async (c) => {
  const { source } = c.req.valid('param');
  const userId = c.get('userId');
  const summary = await resolveItemValueSummary(userId, {
    service: env.dataLinkSources.get(source),
    isGranted: (id) => isLinkGranted(id, source),
    fetchSummary: (service, id) => fetchItemValueSummary(service, id),
  });
  logLinkEvent('data_link_summary_fetched', userId, source);
  return c.json(summary, 200);
});

export default app;
