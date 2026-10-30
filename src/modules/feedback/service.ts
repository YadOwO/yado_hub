/**
 * 意见反馈的数据读写与反馈单规则。
 *
 * 用户端函数都显式接收产品与 userId，查询一律按用户过滤；管理端函数按 ID 访问，权限由路由层把关。
 * 写消息、改状态都先锁住所属对话行，同一对话的写操作串行执行，保证「最多一单待处理」与消息去重成立。
 */
import { and, asc, desc, eq, gt, inArray, lt, max, sql } from 'drizzle-orm';

import type { ProductCode } from '../../config/products.js';
import { db, type DbTransaction } from '../../db/index.js';
import {
  feedbackConversations,
  feedbackMessages,
  feedbackTickets,
  type FeedbackConversationRow,
  type FeedbackMessageRow,
  type FeedbackSender,
  type FeedbackTicketRow,
  type FeedbackTicketStatus,
  type IFeedbackClientInfo,
} from '../../db/schema.js';
import { messageIdConflict, notFound, ticketNotLatest } from '../../shared/errors.js';

/** 一页数据与下一页游标 */
export interface IPage<T> {
  items: T[];
  /** 下一页的 before 游标；没有更多时为 null */
  nextBefore: number | null;
}

/** 写入一条消息所需的内容 */
export interface INewMessage {
  /** 客户端生成的消息 ID */
  id: string;
  /** 已去掉首尾空白的正文 */
  content: string;
  /** 用户消息附带的设备信息；管理员消息为 null */
  clientInfo: IFeedbackClientInfo | null;
}

/** 管理端反馈单列表的筛选条件 */
export interface IAdminTicketFilter {
  status?: FeedbackTicketStatus;
  product?: ProductCode;
  before?: number;
  limit: number;
}

/** 管理端反馈单列表中的一项 */
export interface IAdminTicketItem {
  ticket: FeedbackTicketRow;
  product: string;
  userId: string;
  /** 本单最新一条消息；正常情况下一定存在 */
  lastMessage: FeedbackMessageRow | null;
}

/** 管理端对话详情 */
export interface IAdminConversation {
  conversation: FeedbackConversationRow;
  /** 全部反馈单，从旧到新 */
  tickets: FeedbackTicketRow[];
}

/**
 * 把多查一条的结果切成一页：查询时 limit + 1，多出来的那条说明还有下一页。
 */
function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => number): IPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextBefore: hasMore && last !== undefined ? cursorOf(last) : null };
}

/** 查找用户在某产品下的对话；还没发过消息时不存在 */
async function findUserConversation(
  product: ProductCode,
  userId: string,
): Promise<FeedbackConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(feedbackConversations)
    .where(and(eq(feedbackConversations.product, product), eq(feedbackConversations.userId, userId)))
    .limit(1);
  return row;
}

/** 按序号倒序分页拉取对话中的消息 */
async function listConversationMessages(
  conversationId: string,
  before: number | undefined,
  limit: number,
): Promise<IPage<FeedbackMessageRow>> {
  const rows = await db
    .select()
    .from(feedbackMessages)
    .where(
      and(
        eq(feedbackMessages.conversationId, conversationId),
        before === undefined ? undefined : lt(feedbackMessages.seq, before),
      ),
    )
    .orderBy(desc(feedbackMessages.seq))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => row.seq);
}

/** 统计对话中序号大于已读位置的管理员消息 */
async function countUnread(conversation: FeedbackConversationRow): Promise<number> {
  return db.$count(
    feedbackMessages,
    and(
      eq(feedbackMessages.conversationId, conversation.id),
      eq(feedbackMessages.sender, 'admin'),
      gt(feedbackMessages.seq, conversation.userReadSeq),
    ),
  );
}

/** 对话的最新一单：新消息只归入最新一单，所以最新消息序号最大的就是最新一单 */
async function findLatestTicket(tx: DbTransaction, conversationId: string): Promise<FeedbackTicketRow | undefined> {
  const [row] = await tx
    .select()
    .from(feedbackTickets)
    .where(eq(feedbackTickets.conversationId, conversationId))
    .orderBy(desc(feedbackTickets.lastMessageSeq))
    .limit(1);
  return row;
}

/**
 * 决定新消息归入哪一单。
 *
 * 用户消息：最新一单待处理就归入它，否则新开一单待处理。
 * 管理员回复：归入最新一单且不改状态；对话一定由用户消息创建，所以一定有单。
 */
async function resolveTicketId(tx: DbTransaction, conversationId: string, sender: FeedbackSender): Promise<string> {
  const latest = await findLatestTicket(tx, conversationId);
  if (latest !== undefined && (sender === 'admin' || latest.status === 'pending')) {
    return latest.id;
  }
  if (sender === 'admin') {
    throw new Error(`对话 ${conversationId} 没有反馈单`);
  }
  // 消息写入后才知道序号，先占 0，同一事务内随即更新
  const [created] = await tx
    .insert(feedbackTickets)
    .values({ conversationId, lastMessageSeq: 0 })
    .returning({ id: feedbackTickets.id });
  if (created === undefined) {
    throw new Error('新建反馈单未返回结果');
  }
  return created.id;
}

/**
 * 在已锁住的对话中追加一条消息，并更新所属反馈单的最新消息。
 *
 * 同一 ID 重发时返回已有消息，不重复写入；ID 已被其他对话或另一发送方使用时返回 409。
 */
async function appendMessage(
  tx: DbTransaction,
  conversationId: string,
  sender: FeedbackSender,
  message: INewMessage,
): Promise<FeedbackMessageRow> {
  const messageId = message.id.toLowerCase();
  const [existing] = await tx.select().from(feedbackMessages).where(eq(feedbackMessages.id, messageId)).limit(1);
  if (existing !== undefined) {
    if (existing.conversationId === conversationId && existing.sender === sender) {
      return existing;
    }
    throw messageIdConflict();
  }

  const ticketId = await resolveTicketId(tx, conversationId, sender);
  const [inserted] = await tx
    .insert(feedbackMessages)
    .values({
      id: messageId,
      conversationId,
      ticketId,
      sender,
      content: message.content,
      clientInfo: message.clientInfo,
    })
    // 其他对话并发写入了同一个 ID：不插入，按冲突处理
    .onConflictDoNothing({ target: feedbackMessages.id })
    .returning();
  if (inserted === undefined) {
    throw messageIdConflict();
  }

  await tx
    .update(feedbackTickets)
    .set({ lastMessageSeq: inserted.seq, lastMessageAt: inserted.createdAt })
    .where(eq(feedbackTickets.id, ticketId));
  return inserted;
}

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

/** 分页拉取用户自己的反馈消息；还没发过消息时返回空列表 */
export async function listUserMessages(
  product: ProductCode,
  userId: string,
  before: number | undefined,
  limit: number,
): Promise<IPage<FeedbackMessageRow>> {
  const conversation = await findUserConversation(product, userId);
  if (conversation === undefined) {
    return { items: [], nextBefore: null };
  }
  return listConversationMessages(conversation.id, before, limit);
}

/** 用户发一条反馈消息；第一次发时创建对话 */
export async function sendUserMessage(
  product: ProductCode,
  userId: string,
  message: INewMessage,
): Promise<FeedbackMessageRow> {
  return db.transaction(async (tx) => {
    await tx
      .insert(feedbackConversations)
      .values({ product, userId })
      .onConflictDoNothing({ target: [feedbackConversations.product, feedbackConversations.userId] });
    const [conversation] = await tx
      .select({ id: feedbackConversations.id })
      .from(feedbackConversations)
      .where(and(eq(feedbackConversations.product, product), eq(feedbackConversations.userId, userId)))
      .for('update');
    if (conversation === undefined) {
      throw new Error('创建反馈对话后未查到');
    }
    return appendMessage(tx, conversation.id, 'user', message);
  });
}

/**
 * 把用户已读位置推进到 seq，返回推进后的未读数。
 *
 * 只前进不后退；seq 超过对话实际最新序号时按最新序号算，避免以后的回复被提前算作已读。
 */
export async function markUserRead(product: ProductCode, userId: string, seq: number): Promise<number> {
  const conversation = await findUserConversation(product, userId);
  if (conversation === undefined) {
    return 0;
  }
  const [latest] = await db
    .select({ seq: max(feedbackMessages.seq) })
    .from(feedbackMessages)
    .where(eq(feedbackMessages.conversationId, conversation.id));
  const readSeq = Math.min(seq, latest?.seq ?? 0);
  const [updated] = await db
    .update(feedbackConversations)
    .set({ userReadSeq: sql`greatest(${feedbackConversations.userReadSeq}, ${readSeq})` })
    .where(eq(feedbackConversations.id, conversation.id))
    .returning();
  return countUnread(updated ?? conversation);
}

/** 用户的未读管理员消息数；还没发过消息时为 0 */
export async function countUserUnread(product: ProductCode, userId: string): Promise<number> {
  const conversation = await findUserConversation(product, userId);
  return conversation === undefined ? 0 : countUnread(conversation);
}

// ---------------------------------------------------------------------------
// 管理端
// ---------------------------------------------------------------------------

/** 按状态、产品筛选反馈单，按最新消息倒序分页 */
export async function listAdminTickets(filter: IAdminTicketFilter): Promise<IPage<IAdminTicketItem>> {
  const rows = await db
    .select({
      ticket: feedbackTickets,
      product: feedbackConversations.product,
      userId: feedbackConversations.userId,
    })
    .from(feedbackTickets)
    .innerJoin(feedbackConversations, eq(feedbackTickets.conversationId, feedbackConversations.id))
    .where(
      and(
        filter.status === undefined ? undefined : eq(feedbackTickets.status, filter.status),
        filter.product === undefined ? undefined : eq(feedbackConversations.product, filter.product),
        filter.before === undefined ? undefined : lt(feedbackTickets.lastMessageSeq, filter.before),
      ),
    )
    .orderBy(desc(feedbackTickets.lastMessageSeq))
    .limit(filter.limit + 1);
  const page = toPage(rows, filter.limit, (row) => row.ticket.lastMessageSeq);

  const lastSeqs = page.items.map((row) => row.ticket.lastMessageSeq);
  const lastMessages =
    lastSeqs.length === 0
      ? []
      : await db.select().from(feedbackMessages).where(inArray(feedbackMessages.seq, lastSeqs));
  const messageBySeq = new Map(lastMessages.map((message) => [message.seq, message]));

  return {
    items: page.items.map((row) => ({ ...row, lastMessage: messageBySeq.get(row.ticket.lastMessageSeq) ?? null })),
    nextBefore: page.nextBefore,
  };
}

/** 对话信息与它的全部反馈单 */
export async function getAdminConversation(conversationId: string): Promise<IAdminConversation> {
  const [conversation] = await db
    .select()
    .from(feedbackConversations)
    .where(eq(feedbackConversations.id, conversationId))
    .limit(1);
  if (conversation === undefined) {
    throw notFound('对话不存在');
  }
  const tickets = await db
    .select()
    .from(feedbackTickets)
    .where(eq(feedbackTickets.conversationId, conversationId))
    .orderBy(asc(feedbackTickets.lastMessageSeq));
  return { conversation, tickets };
}

/** 管理端分页拉取对话消息 */
export async function listAdminMessages(
  conversationId: string,
  before: number | undefined,
  limit: number,
): Promise<IPage<FeedbackMessageRow>> {
  const exists = await db.$count(feedbackConversations, eq(feedbackConversations.id, conversationId));
  if (exists === 0) {
    throw notFound('对话不存在');
  }
  return listConversationMessages(conversationId, before, limit);
}

/** 管理员回复，归入对话最新一单，不改变状态 */
export async function sendAdminMessage(conversationId: string, message: INewMessage): Promise<FeedbackMessageRow> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: feedbackConversations.id })
      .from(feedbackConversations)
      .where(eq(feedbackConversations.id, conversationId))
      .for('update');
    if (conversation === undefined) {
      throw notFound('对话不存在');
    }
    return appendMessage(tx, conversation.id, 'admin', message);
  });
}

/**
 * 修改反馈单状态。状态没变时直接返回；只能把对话最新一单改回待处理。
 */
export async function updateTicketStatus(ticketId: string, status: FeedbackTicketStatus): Promise<FeedbackTicketRow> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ conversationId: feedbackTickets.conversationId })
      .from(feedbackTickets)
      .where(eq(feedbackTickets.id, ticketId))
      .limit(1);
    if (found === undefined) {
      throw notFound('反馈单不存在');
    }
    // 锁住所属对话后再读一次，避免与用户发消息新开单交错
    await tx
      .select({ id: feedbackConversations.id })
      .from(feedbackConversations)
      .where(eq(feedbackConversations.id, found.conversationId))
      .for('update');
    const [ticket] = await tx.select().from(feedbackTickets).where(eq(feedbackTickets.id, ticketId)).limit(1);
    if (ticket === undefined) {
      throw notFound('反馈单不存在');
    }
    if (ticket.status === status) {
      return ticket;
    }

    if (status === 'pending') {
      const latest = await findLatestTicket(tx, ticket.conversationId);
      if (latest?.id !== ticket.id) {
        throw ticketNotLatest();
      }
    }
    const [updated] = await tx
      .update(feedbackTickets)
      .set({ status, resolvedAt: status === 'resolved' ? new Date() : null })
      .where(eq(feedbackTickets.id, ticketId))
      .returning();
    if (updated === undefined) {
      throw new Error('更新反馈单状态未返回结果');
    }
    return updated;
  });
}

/** 全部产品的待处理反馈单数 */
export async function countPendingTickets(): Promise<number> {
  return db.$count(feedbackTickets, eq(feedbackTickets.status, 'pending'));
}
