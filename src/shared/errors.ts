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
  /** 请求体超过接口允许的大小 */
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  /** 消息 ID 已被其他对话或另一发送方使用 */
  MessageIdConflict: 'MESSAGE_ID_CONFLICT',
  /** 只能把对话最新一条反馈单改回待处理 */
  TicketNotLatest: 'TICKET_NOT_LATEST',
  /** 账号已注销，不再接受该用户的反馈写入 */
  AccountDeleted: 'ACCOUNT_DELETED',
  /** 注销账号的某一步（下游服务删除数据或删除 Logto 用户）失败，可重试；details.step 标明是哪一步 */
  AccountDeletionFailed: 'ACCOUNT_DELETION_FAILED',
  /** 服务端缺少必要配置，功能暂不可用 */
  ServiceNotConfigured: 'SERVICE_NOT_CONFIGURED',
  /** 取联动汇总时用户还没授权（或已取消授权） */
  DataLinkNotGranted: 'DATA_LINK_NOT_GRANTED',
  /** 联动来源没有打开（DATA_LINK_SOURCES 里没有它），授权与取汇总都不可用 */
  DataLinkUnavailable: 'DATA_LINK_UNAVAILABLE',
  /** 向来源产品后端取汇总数失败：请求出错、超时或响应不合契约 */
  DataLinkUpstreamFailed: 'DATA_LINK_UPSTREAM_FAILED',
  Internal: 'INTERNAL_ERROR',
} as const;

/** 对外错误码的取值集合，防止构造异常时使用未约定的编码 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 可安全返回给客户端的错误状态码 */
export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

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

/** 请求体超过接口允许的大小时返回 413 */
export const payloadTooLarge = (message = '请求体过大'): AppError =>
  new AppError(413, ErrorCode.PayloadTooLarge, message);

/** 用户调用频率耗尽时返回 429，详情可标识命中的限流规则 */
export const tooManyRequests = (message: string, details?: unknown): AppError =>
  new AppError(429, ErrorCode.TooManyRequests, message, details);

/** 消息 ID 已被其他对话或另一发送方使用时返回 409；客户端应换一个新 ID 重发 */
export const messageIdConflict = (): AppError =>
  new AppError(409, ErrorCode.MessageIdConflict, '消息 ID 已被使用');

/** 把旧反馈单改回待处理时返回 409 */
export const ticketNotLatest = (): AppError =>
  new AppError(409, ErrorCode.TicketNotLatest, '只能把最新一条反馈单改回待处理');

/**
 * 已通过鉴权的发消息请求在事务里发现用户已进注销名单时返回 403（注销与发消息同时发生）；
 * 注销之后的新请求在鉴权时就返回 401，到不了这里。
 */
export const accountDeleted = (): AppError => new AppError(403, ErrorCode.AccountDeleted, '账号已注销');

/**
 * 注销账号的某一步失败时返回 502，App 应提示用户重试；已完成的步骤可以重复执行。
 *
 * @param step 失败的那一步：下游服务名（如 yado-ai）或 logto；不含地址、凭证等内部细节
 */
export const accountDeletionFailed = (step: string): AppError =>
  new AppError(502, ErrorCode.AccountDeletionFailed, '注销没有完成，请稍后重试', { step });

/** 注销账号所需的配置（Logto M2M 凭证或下游服务列表）缺失时返回 503 */
export const serviceNotConfigured = (): AppError =>
  new AppError(503, ErrorCode.ServiceNotConfigured, '注销服务尚未配置');

/** 取联动汇总时用户没有授权返回 403；App 应引导用户先授权 */
export const dataLinkNotGranted = (): AppError =>
  new AppError(403, ErrorCode.DataLinkNotGranted, '尚未授权数据联动');

/** 联动来源没有打开返回 404；此时授权与取汇总都不可用，取消授权不受影响 */
export const dataLinkUnavailable = (): AppError =>
  new AppError(404, ErrorCode.DataLinkUnavailable, '数据联动暂不可用');

/** 向来源产品后端取汇总数失败（请求出错、超时或响应不合契约）时返回 502；message 不带内部地址 */
export const dataLinkUpstreamFailed = (): AppError =>
  new AppError(502, ErrorCode.DataLinkUpstreamFailed, '获取联动数据失败，请稍后重试');

/** 从捕获的异常中取出可安全写入日志的错误名，不带 message（message 里可能有地址等内部细节） */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

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
