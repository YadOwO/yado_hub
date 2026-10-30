/**
 * 统一错误定义与错误响应。
 *
 * 响应结构遵循平台跨服务约定：{ code, message, details? }
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** 业务错误码 */
export const ErrorCode = {
  BadRequest: 'BAD_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  /** 已登录但不是管理员 */
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  TooManyRequests: 'TOO_MANY_REQUESTS',
  /** 消息 ID 已被其他对话或另一发送方使用 */
  MessageIdConflict: 'MESSAGE_ID_CONFLICT',
  /** 只能把对话最新一条反馈单改回待处理 */
  TicketNotLatest: 'TICKET_NOT_LATEST',
  Internal: 'INTERNAL_ERROR',
} as const;

/** 对外错误码的取值集合，防止构造异常时使用未约定的编码 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 可安全返回给客户端的错误状态码 */
export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

/**
 * 业务异常。抛出后由全局 onError 统一转换为标准错误响应。
 */
export class AppError extends Error {
  /** 返回客户端的 HTTP 状态码，与业务错误码配套使用 */
  readonly status: AppErrorStatus;
  /** 供客户端稳定识别错误类型的业务编码 */
  readonly code: ErrorCodeValue;
  /** 可直接返回客户端的补充信息，调用方必须保证不含隐私或密钥 */
  readonly details?: unknown;

  /** 构造可直接转换为标准响应的业务异常；message 与 details 均须适合对外展示 */
  constructor(status: AppErrorStatus, code: ErrorCodeValue, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 请求参数或业务约束不满足时返回 400，可附带安全的校验详情 */
export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, ErrorCode.BadRequest, message, details);

/** 身份凭证缺失或校验失败时返回 401 */
export const unauthorized = (message = '未通过身份校验'): AppError =>
  new AppError(401, ErrorCode.Unauthorized, message);

/** 已登录但没有管理员权限时返回 403 */
export const forbidden = (message = '没有权限'): AppError => new AppError(403, ErrorCode.Forbidden, message);

/** 访问的对话、反馈单不存在时返回 404 */
export const notFound = (message: string): AppError => new AppError(404, ErrorCode.NotFound, message);

/** 用户调用频率耗尽时返回 429，详情可标识命中的限流规则 */
export const tooManyRequests = (message: string, details?: unknown): AppError =>
  new AppError(429, ErrorCode.TooManyRequests, message, details);

/** 消息 ID 已被其他对话或另一发送方使用时返回 409；客户端应换一个新 ID 重发 */
export const messageIdConflict = (): AppError =>
  new AppError(409, ErrorCode.MessageIdConflict, '消息 ID 已被使用');

/** 把旧反馈单改回待处理时返回 409 */
export const ticketNotLatest = (): AppError =>
  new AppError(409, ErrorCode.TicketNotLatest, '只能把最新一条反馈单改回待处理');

/** 全局错误处理输出的标准 JSON 结构 */
interface IErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 全局错误处理。
 *
 * 未预期的异常只向客户端返回通用信息，详细堆栈仅记录在服务端日志，
 * 避免泄露内部实现细节。
 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    const body: IErrorBody = { code: err.code, message: err.message };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    return c.json(body, err.status);
  }

  if (err instanceof HTTPException) {
    const body: IErrorBody = { code: ErrorCode.BadRequest, message: err.message };
    return c.json(body, err.status);
  }

  console.error('未处理的异常：', err);
  const body: IErrorBody = { code: ErrorCode.Internal, message: '服务内部错误' };
  return c.json(body, 500);
}
