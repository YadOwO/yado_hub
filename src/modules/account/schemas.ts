import { z } from '@hono/zod-openapi';

/** 注销账号成功的响应；没有数据或重复调用也返回同样的内容 */
export const AccountDeletionSchema = z
  .object({
    deleted: z.literal(true).openapi({ description: '各服务的数据已删除，Logto 账号已删除' }),
  })
  .openapi('AccountDeletion');

/**
 * 注销前验证身份的请求体：三种方式选一种，用 method 区分。
 * 密码、验证码、ID token 只转给 Logto 或本地验签，不落库、不写日志。
 */
export const AccountVerificationRequestSchema = z
  .discriminatedUnion('method', [
    z.object({
      method: z.literal('password'),
      password: z.string().min(1).max(256).openapi({ description: '登录密码，原样转给 Logto 校验，不做首尾去空格' }),
    }),
    z.object({
      method: z.literal('email_code'),
      code: z.string().regex(/^\d{6}$/).openapi({ description: '邮箱收到的 6 位数字验证码', example: '123456' }),
    }),
    z.object({
      method: z.literal('id_token'),
      idToken: z.string().min(1).max(8192).openapi({
        description: '重新登录后 LogtoClient 给出的 ID token：sub 必须是当前用户，aud 必须是芽豆 App 的应用 ID，auth_time 在 5 分钟以内',
      }),
    }),
  ])
  .openapi('AccountVerificationRequest', {
    description:
      '三种方式选一种：password 用 Logto 账号的登录密码；email_code 用发到 Logto 主邮箱的 6 位验证码' +
      '（先调 POST /v1/account/verification/email-code 发送）；id_token 用刚重新登录（authorize 请求带 max_age=0）拿到的 ID token。',
  });

/** 验证身份通过后签发的注销票据 */
export const AccountVerificationTicketSchema = z
  .object({
    ticket: z.string().openapi({
      description: '注销票据：调用 DELETE /v1/account 时放进请求头 X-Account-Deletion-Ticket；只在这一次返回，同一用户再次验证会让旧票据失效',
    }),
    expiresAt: z.iso.datetime().openapi({
      description: '票据过期时刻，ISO 8601 UTC，签发后 10 分钟；注销成功后票据作废，失败时在有效期内可以拿同一张重试',
      example: '2026-11-25T08:10:00.000Z',
    }),
  })
  .openapi('AccountVerificationTicket');

/** 验证码已发出的响应 */
export const AccountVerificationCodeSentSchema = z
  .object({
    sent: z.literal(true).openapi({ description: '验证码已发到 Logto 里这个账号的主邮箱' }),
  })
  .openapi('AccountVerificationCodeSent');

/** 注销前汇总里的一项数据量 */
const AccountSummaryItemSchema = z
  .object({
    key: z.string().openapi({
      description: '数据类别：yado-ai 是 points_balance（剩余点数），yadoa-be 是 synced_records（同步的记录数），yadoi-be 是 items（物品件数）；App 靠服务名加 key 对应文案，认不出的跳过',
      example: 'points_balance',
    }),
    count: z.number().int().nonnegative().openapi({ description: '数量，非负整数；hub 已去掉数量为 0 的项', example: 120 }),
  })
  .openapi('AccountSummaryItem');

/** 注销前汇总里一个下游服务的结果 */
const AccountServiceSummarySchema = z
  .object({
    service: z.string().openapi({ description: '服务名：yado-ai、yadoa-be 或 yadoi-be', example: 'yado-ai' }),
    status: z.enum(['ok', 'unavailable']).openapi({
      description: 'ok 表示查到了；unavailable 表示这个服务暂时查不到（超时、出错等），App 显示「暂时查不到」，不影响注销',
      example: 'ok',
    }),
    items: z.array(AccountSummaryItemSchema).openapi({ description: '这个服务的各项数据量；unavailable 时为空数组' }),
  })
  .openapi('AccountServiceSummary');

/** 注销前各产品的数据量汇总 */
export const AccountSummarySchema = z
  .object({
    services: z.array(AccountServiceSummarySchema).openapi({
      description: '各下游服务的汇总，顺序与 hub 配置一致；数量为 0 的项、查到了但没有任何项的服务已被去掉，所以可能是空数组',
    }),
  })
  .openapi('AccountSummary');
