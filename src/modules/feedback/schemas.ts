/**
 * 意见反馈接口的 Zod 契约，用户端与管理端共用。
 *
 * 消息序号（seq）是整数游标，不是金额，因此用 JSON number 表示。
 */
import { z } from '@hono/zod-openapi';

import { PRODUCT_CODES } from '../../config/products.js';
import { FEEDBACK_SENDERS, FEEDBACK_TICKET_STATUSES } from '../../db/schema.js';

/** 单条消息正文的最大长度 */
export const MESSAGE_MAX_LENGTH = 1000;

/** 管理端列表里最后一条消息摘要的最大长度 */
export const MESSAGE_PREVIEW_LENGTH = 100;

/** 产品代号 */
const ProductSchema = z.enum(PRODUCT_CODES).openapi({ description: '产品代号', example: 'yadoa' });

/** 已存入数据库的产品代号；管理端原样输出，以后下线的产品也能显示 */
const StoredProductSchema = z.string().openapi({ description: '产品代号', example: 'yadoa' });

/** 反馈单状态 */
const TicketStatusSchema = z.enum(FEEDBACK_TICKET_STATUSES).openapi({
  description: 'pending 待处理，resolved 已处理',
  example: 'pending',
});

/** 消息发送方 */
const SenderSchema = z.enum(FEEDBACK_SENDERS).openapi({ description: 'user 用户，admin 管理员', example: 'user' });

/** 消息序号：自增整数，越新越大 */
const SeqSchema = z.number().int().positive().openapi({ description: '消息序号，越新越大', example: 42 });

/** 用户端路径参数：产品代号 */
export const ProductParamsSchema = z.object({
  product: ProductSchema.openapi({ param: { name: 'product', in: 'path' } }),
});

/** 管理端路径参数：对话或反馈单 ID */
export const IdParamsSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, description: '对话或反馈单 ID' }),
});

/** 「before 游标 + limit」分页的查询参数 */
export const PageQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional().openapi({
    description: '上一页返回的 nextBefore，只返回比它旧的数据；不传表示从最新开始',
  }),
  limit: z.coerce.number().int().min(1).max(100).default(30).openapi({ description: '每页条数，默认 30，最多 100' }),
});

/** 下一页游标 */
const NextBeforeSchema = z.number().int().nullable().openapi({ description: '下一页的 before；没有更多时为 null' });

/** 用户发消息时附带的设备信息 */
export const FeedbackClientInfoSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(32).openapi({ description: 'App 版本与构建号', example: '1.0.0 (12)' }),
    osVersion: z.string().trim().min(1).max(32).openapi({ description: '系统版本', example: 'iOS 27.1' }),
    deviceModel: z.string().trim().min(1).max(64).openapi({ description: '机型标识', example: 'iPhone18,1' }),
    locale: z.string().trim().min(1).max(32).openapi({ description: 'App 当前语言', example: 'zh-Hans' }),
  })
  .openapi('FeedbackClientInfo');

/** 消息正文：去掉首尾空白后 1–1000 字 */
const ContentSchema = z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).openapi({
  description: `纯文本正文，去掉首尾空白后 1–${MESSAGE_MAX_LENGTH} 字`,
  example: '记账页点保存没反应',
});

/** 客户端生成的消息 ID */
const ClientMessageIdSchema = z.uuid().openapi({
  description: '客户端生成的消息 ID；网络重发时沿用同一个，服务端据此去重。服务端统一存为小写',
});

/** 用户发消息的请求体 */
export const SendUserMessageSchema = z
  .object({
    id: ClientMessageIdSchema,
    content: ContentSchema,
    clientInfo: FeedbackClientInfoSchema,
  })
  .openapi('SendFeedbackMessage');

/** 管理员回复的请求体 */
export const SendAdminMessageSchema = z
  .object({
    id: ClientMessageIdSchema,
    content: ContentSchema,
  })
  .openapi('SendAdminFeedbackMessage');

/** 用户端看到的一条消息 */
export const FeedbackMessageSchema = z
  .object({
    id: z.uuid(),
    seq: SeqSchema,
    sender: SenderSchema,
    content: z.string(),
    createdAt: z.iso.datetime().openapi({ example: '2026-10-29T02:32:00.000Z' }),
  })
  .openapi('FeedbackMessage');

/** 用户端消息列表，按序号倒序 */
export const FeedbackMessageListSchema = z
  .object({
    messages: z.array(FeedbackMessageSchema),
    nextBefore: NextBeforeSchema,
  })
  .openapi('FeedbackMessageList');

/** 标记已读的请求体 */
export const MarkReadSchema = z
  .object({
    seq: z.number().int().nonnegative().openapi({
      description: '已看到的最新消息序号；服务端只前进不后退，超过实际最新序号时按最新序号算',
      example: 42,
    }),
  })
  .openapi('FeedbackMarkRead');

/** 用户未读数 */
export const UnreadCountSchema = z
  .object({
    unreadCount: z.number().int().nonnegative().openapi({ description: '未读的管理员消息条数', example: 1 }),
  })
  .openapi('FeedbackUnreadCount');

/** 反馈单 */
export const FeedbackTicketSchema = z
  .object({
    id: z.uuid(),
    status: TicketStatusSchema,
    createdAt: z.iso.datetime().openapi({ description: '开单时间' }),
    resolvedAt: z.iso.datetime().nullable().openapi({ description: '最近一次标记已处理的时间；待处理时为 null' }),
    lastMessageAt: z.iso.datetime().openapi({ description: '本单最新一条消息的时间' }),
  })
  .openapi('FeedbackTicket');

/** 管理端反馈单列表的查询参数 */
export const AdminTicketListQuerySchema = PageQuerySchema.extend({
  status: TicketStatusSchema.optional().openapi({ description: '按状态筛选；不传表示全部' }),
  product: ProductSchema.optional().openapi({ description: '按产品筛选；不传表示全部' }),
});

/** 管理端反馈单列表中的一项 */
const AdminTicketListItemSchema = FeedbackTicketSchema.extend({
  conversationId: z.uuid(),
  product: StoredProductSchema,
  userId: z.string().openapi({ description: 'Logto 用户 ID' }),
  lastMessage: z
    .object({
      sender: SenderSchema,
      content: z.string().openapi({ description: `正文摘要，最多 ${MESSAGE_PREVIEW_LENGTH} 字` }),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
}).openapi('AdminFeedbackTicketListItem');

/** 管理端反馈单列表，按最新消息倒序 */
export const AdminTicketListSchema = z
  .object({
    tickets: z.array(AdminTicketListItemSchema),
    nextBefore: NextBeforeSchema,
  })
  .openapi('AdminFeedbackTicketList');

/** 管理端对话详情 */
export const AdminConversationSchema = z
  .object({
    id: z.uuid(),
    product: StoredProductSchema,
    userId: z.string().openapi({ description: 'Logto 用户 ID' }),
    createdAt: z.iso.datetime(),
    tickets: z.array(FeedbackTicketSchema).openapi({ description: '全部反馈单，从旧到新' }),
  })
  .openapi('AdminFeedbackConversation');

/** 管理端看到的一条消息 */
export const AdminMessageSchema = FeedbackMessageSchema.extend({
  ticketId: z.uuid().openapi({ description: '所属反馈单，用于在对话中画分隔线' }),
  clientInfo: FeedbackClientInfoSchema.nullable().openapi({ description: '用户消息附带的设备信息；管理员消息为 null' }),
}).openapi('AdminFeedbackMessage');

/** 管理端消息列表，按序号倒序 */
export const AdminMessageListSchema = z
  .object({
    messages: z.array(AdminMessageSchema),
    nextBefore: NextBeforeSchema,
  })
  .openapi('AdminFeedbackMessageList');

/** 修改反馈单状态的请求体 */
export const UpdateTicketStatusSchema = z
  .object({
    status: TicketStatusSchema,
  })
  .openapi('UpdateFeedbackTicketStatus');
