/**
 * 数据库表定义（Drizzle ORM）。
 *
 * 隔离约定：本服务所有表都位于 `yado_hub` schema 下，与 yadoa、yadoi、yado_ai、logto 共用同一个 Postgres 实例
 * 但各自独占 schema，不读写其他 schema。用户只以 Logto 用户 ID 标识，不存昵称、邮箱等资料。
 *
 * 通用约定：
 * - 事件时刻用 timestamptz，对外输出 ISO 8601；
 * - 枚举列存 text 而非 pg enum，合法值由代码中的类型与 check 约束把关，值本身用 snake_case；
 * - 本文件供 drizzle-kit 单独加载，不引用业务代码。
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** 本服务独占的 Postgres schema 名 */
export const DB_SCHEMA_NAME = 'yado_hub';

/** 本服务的 schema，所有表都通过 `yadoHubSchema.table()` 定义 */
export const yadoHubSchema = pgSchema(DB_SCHEMA_NAME);

/** 反馈单状态：pending 待处理，resolved 已处理 */
export const FEEDBACK_TICKET_STATUSES = ['pending', 'resolved'] as const;

/** 反馈单状态 */
export type FeedbackTicketStatus = (typeof FEEDBACK_TICKET_STATUSES)[number];

/** 反馈消息的发送方：user 用户，admin 管理员 */
export const FEEDBACK_SENDERS = ['user', 'admin'] as const;

/** 反馈消息的发送方 */
export type FeedbackSender = (typeof FEEDBACK_SENDERS)[number];

/** 用户发消息时附带的设备信息，方便排查问题；不含任何账本数据 */
export interface IFeedbackClientInfo {
  /** App 版本与构建号，例如 1.0.0 (12) */
  appVersion: string;
  /** 系统版本，例如 iOS 27.1 */
  osVersion: string;
  /** 机型标识，例如 iPhone18,1 */
  deviceModel: string;
  /** App 当前语言，例如 zh-Hans */
  locale: string;
}

/**
 * 反馈对话：每个用户在每个产品下一行，用户端始终只看到这一个对话。
 */
export const feedbackConversations = yadoHubSchema.table(
  'feedback_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 产品代号，合法值见 config/products.ts；以后会增加产品，不加 check 约束 */
    product: text('product').notNull(),
    /** 所属用户，取 Logto JWT 的 sub */
    userId: text('user_id').notNull(),
    /** 用户已读到的消息序号；序号比它大的管理员消息算用户未读 */
    userReadSeq: bigint('user_read_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('feedback_conversations_product_user_uniq').on(table.product, table.userId)],
);

/**
 * 反馈单：对话在后台按轮拆分，一轮一行，只给管理端用。
 *
 * 用户发消息时，最新一单待处理就归入它，已处理就新开一单；管理员回复归入最新一单且不改状态。
 * 同一对话同一时刻最多一单待处理，由部分唯一索引兜底；所有写操作都先锁住所属对话行再进行。
 */
export const feedbackTickets = yadoHubSchema.table(
  'feedback_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => feedbackConversations.id),
    status: text('status', { enum: FEEDBACK_TICKET_STATUSES }).notNull().default('pending'),
    /** 开单时间，即这一轮第一条用户消息的时间 */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 最近一次标记已处理的时间；待处理时为空 */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /**
     * 本单最新一条消息的序号。新消息只会归入最新一单，所以同一对话里它最大的就是最新一单；
     * 管理端列表按它倒序，也用它作分页游标。
     */
    lastMessageSeq: bigint('last_message_seq', { mode: 'number' }).notNull(),
    /** 本单最新一条消息的时间 */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('feedback_tickets_one_pending_uniq')
      .on(table.conversationId)
      .where(sql`${table.status} = 'pending'`),
    index('feedback_tickets_conversation_idx').on(table.conversationId, table.lastMessageSeq),
    // 管理端列表按状态筛选、按最新消息倒序
    index('feedback_tickets_status_last_idx').on(table.status, table.lastMessageSeq),
    check('feedback_tickets_status_check', sql`${table.status} in ('pending', 'resolved')`),
  ],
);

/**
 * 反馈消息：只追加，不修改、不删除。
 *
 * seq 用自增序号，既作为主键也作为排序、已读位置与分页游标；id 由客户端生成，网络重发时据此去重。
 */
export const feedbackMessages = yadoHubSchema.table(
  'feedback_messages',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** 客户端生成的消息 ID，全局唯一 */
    id: uuid('id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => feedbackConversations.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => feedbackTickets.id),
    sender: text('sender', { enum: FEEDBACK_SENDERS }).notNull(),
    /** 纯文本正文，长度由接口校验 */
    content: text('content').notNull(),
    /** 用户消息附带的设备信息；管理员消息为空 */
    clientInfo: jsonb('client_info').$type<IFeedbackClientInfo>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('feedback_messages_id_uniq').on(table.id),
    // 按对话分页拉消息、统计未读
    index('feedback_messages_conversation_seq_idx').on(table.conversationId, table.seq),
    check('feedback_messages_sender_check', sql`${table.sender} in ('user', 'admin')`),
  ],
);

/** 对话行 */
export type FeedbackConversationRow = typeof feedbackConversations.$inferSelect;

/** 反馈单行 */
export type FeedbackTicketRow = typeof feedbackTickets.$inferSelect;

/** 消息行 */
export type FeedbackMessageRow = typeof feedbackMessages.$inferSelect;
