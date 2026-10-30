/**
 * 意见反馈的用户端路由，挂在 /v1/feedback 下。
 *
 * 必须登录；只能读写当前用户自己在 {product} 下的对话。发消息额外挂限流。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireAuth } from '../../middleware/auth.js';
import { feedbackMessageRateLimit } from '../../middleware/rate-limit.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { toUserMessageDTO } from './dto.js';
import {
  FeedbackMessageListSchema,
  FeedbackMessageSchema,
  MarkReadSchema,
  PageQuerySchema,
  ProductParamsSchema,
  SendUserMessageSchema,
  UnreadCountSchema,
} from './schemas.js';
import { countUserUnread, listUserMessages, markUserRead, sendUserMessage } from './service.js';

/** 意见反馈用户端子应用 */
const app = createApp();

/** 拉消息的 OpenAPI 契约 */
const listMessagesRoute = createRoute({
  method: 'get',
  path: '/{product}/messages',
  tags: ['feedback'],
  summary: '拉取反馈消息',
  description: '按序号倒序分页返回当前用户在该产品下的对话消息；还没发过消息时返回空列表。',
  middleware: [requireAuth] as const,
  security: [{ Bearer: [] }],
  request: { params: ProductParamsSchema, query: PageQuerySchema },
  responses: {
    200: { description: '消息列表', content: { 'application/json': { schema: FeedbackMessageListSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
  },
});

/** 发消息的 OpenAPI 契约 */
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/{product}/messages',
  tags: ['feedback'],
  summary: '发送反馈消息',
  description:
    '第一次发送时创建对话。同一 id 重发时返回已有消息，不重复写入。' +
    '消息归入对话最新一条待处理的反馈单，没有时新开一条。',
  middleware: [requireAuth, feedbackMessageRateLimit] as const,
  security: [{ Bearer: [] }],
  request: {
    params: ProductParamsSchema,
    body: { required: true, content: { 'application/json': { schema: SendUserMessageSchema } } },
  },
  responses: {
    200: { description: '已保存的消息', content: { 'application/json': { schema: FeedbackMessageSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    409: jsonError('消息 ID 已被使用，需换一个新 ID'),
    429: jsonError('发送过于频繁，details.rule 为 per_minute 或 per_day'),
  },
});

/** 标记已读的 OpenAPI 契约 */
const markReadRoute = createRoute({
  method: 'post',
  path: '/{product}/read',
  tags: ['feedback'],
  summary: '标记已读',
  description: '把已读位置推进到 seq（只前进不后退），返回推进后的未读数。',
  middleware: [requireAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: ProductParamsSchema,
    body: { required: true, content: { 'application/json': { schema: MarkReadSchema } } },
  },
  responses: {
    200: { description: '未读数', content: { 'application/json': { schema: UnreadCountSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
  },
});

/** 未读数的 OpenAPI 契约 */
const unreadRoute = createRoute({
  method: 'get',
  path: '/{product}/unread',
  tags: ['feedback'],
  summary: '未读数',
  description: '当前用户未读的管理员消息条数，用于入口红点。',
  middleware: [requireAuth] as const,
  security: [{ Bearer: [] }],
  request: { params: ProductParamsSchema },
  responses: {
    200: { description: '未读数', content: { 'application/json': { schema: UnreadCountSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
  },
});

app.openapi(listMessagesRoute, async (c) => {
  const { product } = c.req.valid('param');
  const { before, limit } = c.req.valid('query');
  const page = await listUserMessages(product, c.get('userId'), before, limit);
  return c.json({ messages: page.items.map(toUserMessageDTO), nextBefore: page.nextBefore }, 200);
});

app.openapi(sendMessageRoute, async (c) => {
  const { product } = c.req.valid('param');
  const { id, content, clientInfo } = c.req.valid('json');
  const message = await sendUserMessage(product, c.get('userId'), { id, content, clientInfo });
  return c.json(toUserMessageDTO(message), 200);
});

app.openapi(markReadRoute, async (c) => {
  const { product } = c.req.valid('param');
  const { seq } = c.req.valid('json');
  const unreadCount = await markUserRead(product, c.get('userId'), seq);
  return c.json({ unreadCount }, 200);
});

app.openapi(unreadRoute, async (c) => {
  const { product } = c.req.valid('param');
  const unreadCount = await countUserUnread(product, c.get('userId'));
  return c.json({ unreadCount }, 200);
});

export default app;
