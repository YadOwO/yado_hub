/**
 * 用户注销时删除意见反馈的流程：先把每张反馈单匿名后存下来，再删掉对话、反馈单和消息。
 *
 * 匿名统计只留产品、状态和时间，不含用户 ID、对话 ID、原反馈单 ID 与任何正文、设备信息、诊断。
 * 本文件不依赖数据库（只做类型引用），方便单独测试；数据库动作由调用方通过 {@link IUserFeedbackDeletionOps} 传入。
 */
import type { FeedbackTicketRow, FeedbackTicketStatus } from '../../db/schema.js';

/** 匿名反馈单：注销后保留的统计，只有产品、状态和时间 */
export interface IAnonymizedTicket {
  /** 产品代号 */
  product: string;
  /** 注销时反馈单的状态 */
  status: FeedbackTicketStatus;
  /** 开单时间 */
  createdAt: Date;
  /** 最近一次标记已处理的时间；待处理时为 null */
  resolvedAt: Date | null;
  /** 本单最新一条消息的时间 */
  lastMessageAt: Date;
}

/** 参与匿名化的反馈单字段：需要用 conversationId 找产品，其余是要保留的时间与状态 */
export type IDeletableTicket = Pick<
  FeedbackTicketRow,
  'conversationId' | 'status' | 'createdAt' | 'resolvedAt' | 'lastMessageAt'
>;

/** 注销删除反馈用到的数据库动作，实现方应在同一个事务里执行 */
export interface IUserFeedbackDeletionOps {
  /** 锁住并返回该用户在所有产品下的对话，和发消息、管理员回复、改状态的「先锁对话行」串行 */
  lockUserConversations(userId: string): Promise<{ id: string; product: string }[]>;
  /** 查出这些对话下的全部反馈单 */
  listTickets(conversationIds: string[]): Promise<IDeletableTicket[]>;
  /** 保存匿名反馈单 */
  saveAnonymizedTickets(rows: IAnonymizedTicket[]): Promise<void>;
  /** 按外键顺序删掉这些对话的消息、反馈单和对话本身 */
  deleteConversations(conversationIds: string[]): Promise<void>;
}

/**
 * 把反馈单匿名化：按 conversationId 找到产品，逐张只拷贝产品、状态和三个时间。
 *
 * @throws 反馈单不属于传入的任何对话时抛错（正常不会发生）
 */
export function toAnonymizedTickets(
  conversations: { id: string; product: string }[],
  tickets: IDeletableTicket[],
): IAnonymizedTicket[] {
  const productByConversation = new Map(conversations.map((conversation) => [conversation.id, conversation.product]));
  return tickets.map((ticket) => {
    const product = productByConversation.get(ticket.conversationId);
    if (product === undefined) {
      throw new Error('反馈单所属的对话不在待删除的对话中');
    }
    return {
      product,
      status: ticket.status,
      createdAt: ticket.createdAt,
      resolvedAt: ticket.resolvedAt,
      lastMessageAt: ticket.lastMessageAt,
    };
  });
}

/**
 * 删除用户在所有产品下的意见反馈。
 *
 * 先锁对话；没有对话就直接返回 0。否则先存匿名统计再删除，任何一步失败都抛出，由调用方的事务整体回滚。
 *
 * @returns 删除的对话数
 */
export async function deleteUserFeedback(userId: string, ops: IUserFeedbackDeletionOps): Promise<number> {
  const conversations = await ops.lockUserConversations(userId);
  if (conversations.length === 0) {
    return 0;
  }
  const conversationIds = conversations.map((conversation) => conversation.id);
  const tickets = await ops.listTickets(conversationIds);
  const anonymized = toAnonymizedTickets(conversations, tickets);
  if (anonymized.length > 0) {
    await ops.saveAnonymizedTickets(anonymized);
  }
  await ops.deleteConversations(conversationIds);
  return conversations.length;
}
