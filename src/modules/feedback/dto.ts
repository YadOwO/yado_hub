/**
 * 把数据库行转换为对外响应结构：时刻统一转 ISO 8601，用户端不暴露反馈单与设备信息。
 */
import type { z } from '@hono/zod-openapi';

import type { FeedbackMessageRow, FeedbackTicketRow } from '../../db/schema.js';
import {
  MESSAGE_PREVIEW_LENGTH,
  type AdminMessageSchema,
  type FeedbackMessageSchema,
  type FeedbackTicketSchema,
} from './schemas.js';

/** 用户端消息 */
type FeedbackMessageDTO = z.infer<typeof FeedbackMessageSchema>;

/** 管理端消息 */
type AdminMessageDTO = z.infer<typeof AdminMessageSchema>;

/** 反馈单 */
type FeedbackTicketDTO = z.infer<typeof FeedbackTicketSchema>;

/** 用户端看到的消息：不含所属反馈单与设备信息 */
export function toUserMessageDTO(row: FeedbackMessageRow): FeedbackMessageDTO {
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端看到的消息：带所属反馈单与用户设备信息 */
export function toAdminMessageDTO(row: FeedbackMessageRow): AdminMessageDTO {
  return {
    ...toUserMessageDTO(row),
    ticketId: row.ticketId,
    clientInfo: row.clientInfo,
  };
}

/** 反馈单 */
export function toTicketDTO(row: FeedbackTicketRow): FeedbackTicketDTO {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
  };
}

/** 截取正文摘要；按字符截取，避免把 emoji 等代理对切成两半 */
export function toPreview(content: string): string {
  const chars = Array.from(content);
  return chars.length <= MESSAGE_PREVIEW_LENGTH ? content : chars.slice(0, MESSAGE_PREVIEW_LENGTH).join('');
}
