/**
 * 意见反馈的管理端路由，由 modules/admin 挂在 /v1/admin/feedback 下。
 *
 * 每个路由都在 middleware 字段依次挂 requireAuth 与 requireAdmin。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireAdmin } from '../../middleware/admin.js';
import { requireAuth } from '../../middleware/auth.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { toAdminMessageDTO, toPreview, toTicketDTO } from './dto.js';
import {
  AdminConversationSchema,
  AdminMessageListSchema,
  AdminMessageSchema,
  AdminTicketListQuerySchema,
  AdminTicketListSchema,
  FeedbackTicketSchema,
  IdParamsSchema,
  PageQuerySchema,
  SendAdminMessageSchema,
  UpdateTicketStatusSchema,
} from './schemas.js';
import {
  getAdminConversation,
  listAdminMessages,
  listAdminTickets,
  sendAdminMessage,
  updateTicketStatus,
} from './service.js';

/** 意见反馈管理端子应用 */
const app = createApp();

/** 反馈单列表的 OpenAPI 契约 */
const listTicketsRoute = createRoute({
  method: 'get',
  path: '/tickets',
  tags: ['admin'],
  summary: '反馈单列表',
  description: '全部产品的反馈单，可按状态、产品筛选，按最新消息倒序分页。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { query: AdminTicketListQuerySchema },
  responses: {
    200: { description: '反馈单列表', content: { 'application/json': { schema: AdminTicketListSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
  },
});

/** 对话详情的 OpenAPI 契约 */
const getConversationRoute = createRoute({
  method: 'get',
  path: '/conversations/{id}',
  tags: ['admin'],
  summary: '对话详情',
  description: '对话所属产品、用户与全部反馈单（从旧到新），详情页据此在消息间画分隔线。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { params: IdParamsSchema },
  responses: {
    200: { description: '对话详情', content: { 'application/json': { schema: AdminConversationSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('对话不存在'),
  },
});

/** 对话消息的 OpenAPI 契约 */
const listMessagesRoute = createRoute({
  method: 'get',
  path: '/conversations/{id}/messages',
  tags: ['admin'],
  summary: '对话消息',
  description: '按序号倒序分页返回对话消息，带所属反馈单与用户设备信息。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { params: IdParamsSchema, query: PageQuerySchema },
  responses: {
    200: { description: '消息列表', content: { 'application/json': { schema: AdminMessageListSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('对话不存在'),
  },
});

/** 回复的 OpenAPI 契约 */
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/conversations/{id}/messages',
  tags: ['admin'],
  summary: '回复',
  description: '归入对话最新一条反馈单，不改变其状态。同一 id 重发时返回已有消息。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: {
    params: IdParamsSchema,
    body: { required: true, content: { 'application/json': { schema: SendAdminMessageSchema } } },
  },
  responses: {
    200: {
      description: '已保存的消息',
      content: { 'application/json': { schema: AdminMessageSchema } },
    },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('对话不存在'),
    409: jsonError('消息 ID 已被使用，需换一个新 ID'),
  },
});

/** 改状态的 OpenAPI 契约 */
const updateStatusRoute = createRoute({
  method: 'post',
  path: '/tickets/{id}/status',
  tags: ['admin'],
  summary: '修改反馈单状态',
  description: '标记已处理，或把对话最新一条反馈单改回待处理；旧反馈单不能改回待处理。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: {
    params: IdParamsSchema,
    body: { required: true, content: { 'application/json': { schema: UpdateTicketStatusSchema } } },
  },
  responses: {
    200: { description: '修改后的反馈单', content: { 'application/json': { schema: FeedbackTicketSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('反馈单不存在'),
    409: jsonError('只能把最新一条反馈单改回待处理'),
  },
});

app.openapi(listTicketsRoute, async (c) => {
  const page = await listAdminTickets(c.req.valid('query'));
  return c.json(
    {
      tickets: page.items.map((item) => ({
        ...toTicketDTO(item.ticket),
        conversationId: item.ticket.conversationId,
        product: item.product,
        userId: item.userId,
        lastMessage:
          item.lastMessage === null
            ? null
            : {
                sender: item.lastMessage.sender,
                content: toPreview(item.lastMessage.content),
                createdAt: item.lastMessage.createdAt.toISOString(),
              },
      })),
      nextBefore: page.nextBefore,
    },
    200,
  );
});

app.openapi(getConversationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { conversation, tickets } = await getAdminConversation(id);
  return c.json(
    {
      id: conversation.id,
      product: conversation.product,
      userId: conversation.userId,
      createdAt: conversation.createdAt.toISOString(),
      tickets: tickets.map(toTicketDTO),
    },
    200,
  );
});

app.openapi(listMessagesRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { before, limit } = c.req.valid('query');
  const page = await listAdminMessages(id, before, limit);
  return c.json({ messages: page.items.map(toAdminMessageDTO), nextBefore: page.nextBefore }, 200);
});

app.openapi(sendMessageRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const message = await sendAdminMessage(id, { id: body.id, content: body.content, clientInfo: null });
  return c.json(toAdminMessageDTO(message), 200);
});

app.openapi(updateStatusRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { status } = c.req.valid('json');
  const ticket = await updateTicketStatus(id, status);
  return c.json(toTicketDTO(ticket), 200);
});

export default app;
