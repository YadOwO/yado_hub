/**
 * 账号注销：芽豆所有 App 注销账号都只调这几个接口，挂在 /v1/account 下。
 *
 * - GET /summary：注销前各产品的数据量汇总（并行调各下游，见 summary.ts）；
 * - POST /verification/email-code：把验证码发到 Logto 里这个账号的主邮箱；
 * - POST /verification：验证身份（密码、邮箱验证码或重新登录的 ID token），通过后发 10 分钟有效的注销票据（见 verification.ts）；
 * - DELETE /：注销。必须带票据（X-Account-Deletion-Ticket），hub 统一编排：写注销名单 → 删意见反馈 → 删数据联动授权 →
 *   依次调各下游服务的内部删除接口 → 删 Logto 用户，步骤见 deletion.ts。只删除当前用户自己的数据。
 *
 * 这几个接口都用 requireAuthIncludingDeleted：注销中途失败的用户已经在注销名单里，要能重新验证身份并重试。
 */
import { createRoute, z } from '@hono/zod-openapi';

import { requireAuthIncludingDeleted } from '../../middleware/auth.js';
import { accountSummaryRateLimit, accountVerificationRateLimit } from '../../middleware/rate-limit.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import {
  AccountDeletionSchema,
  AccountSummarySchema,
  AccountVerificationCodeSentSchema,
  AccountVerificationRequestSchema,
  AccountVerificationTicketSchema,
} from './schemas.js';
import {
  deleteAccount,
  getAccountSummary,
  sendAccountVerificationCode,
  verifyAccountIdentity,
} from './service.js';
import { ACCOUNT_DELETION_TICKET_HEADER } from './verification.js';

/** 账号注销子应用 */
const app = createApp();

/**
 * 注销接口的请求头：票据。必须是 optional——没带票据要由业务返回 426 APP_UPGRADE_REQUIRED，
 * 如果在这里设为必填，缺头会被校验成 400，旧版 App 就收不到「需要更新」的提示。
 */
const DeleteAccountHeadersSchema = z.object({
  [ACCOUNT_DELETION_TICKET_HEADER]: z.string().max(128).optional().openapi({
    description: '注销票据，POST /v1/account/verification 验证身份后拿到；不带返回 426，无效或过期返回 403',
  }),
});

/** 注销账号的 OpenAPI 契约 */
const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['account'],
  summary: '注销账号',
  description:
    '永久注销芽豆账号：删除当前用户在所有芽豆产品下的意见反馈（反馈单只留不含用户与正文的匿名统计）和数据联动授权记录，' +
    '再依次让各产品后端与 AI 服务删除这个用户的数据，全部成功后删除 Logto 用户，之后所有芽豆 App 都无法再用它登录。' +
    '必须先验证身份：调 POST /v1/account/verification 换取注销票据，放进请求头 X-Account-Deletion-Ticket；' +
    '不带这个头返回 426 APP_UPGRADE_REQUIRED（旧版 App 不认识验证身份这一步），' +
    '票据无效、已过期（10 分钟）或不属于当前用户返回 403 ACCOUNT_VERIFICATION_REQUIRED，App 应回到验证身份这一步。' +
    '第一步就把用户记入注销名单，之后该用户的旧 token 访问 hub 的其他接口一律 401。' +
    '任何一步失败返回 502 ACCOUNT_DELETION_FAILED（details.step 为失败的那一步），已完成的步骤可以重复执行，' +
    'App 用同一个 token 和同一张票据（有效期内）直接重试即可（本接口不拦注销名单里的用户）；' +
    '注销成功返回 200，票据随即作废，之后再用同一张票据调用返回 403；中途失败时，在有效期内可以用同一张票据重试。' +
    '要串行等几个服务，最长约 50 秒，客户端超时要留够。',
  middleware: [requireAuthIncludingDeleted] as const,
  security: [{ Bearer: [] }],
  request: { headers: DeleteAccountHeadersSchema },
  responses: {
    200: {
      description: '已注销',
      content: { 'application/json': { schema: AccountDeletionSchema } },
    },
    400: jsonError('票据请求头格式不对'),
    401: jsonError('未通过身份校验'),
    403: jsonError('注销票据无效、已过期或不属于当前用户（ACCOUNT_VERIFICATION_REQUIRED），需要重新验证身份'),
    426: jsonError('没有带注销票据（APP_UPGRADE_REQUIRED），需要更新 App'),
    500: jsonError('服务内部错误，可重试'),
    502: jsonError('某个服务或 Logto 删除失败，可重试'),
    503: jsonError('注销服务尚未配置'),
  },
});

/** 发邮箱验证码的 OpenAPI 契约 */
const sendVerificationCodeRoute = createRoute({
  method: 'post',
  path: '/verification/email-code',
  tags: ['account'],
  summary: '发送注销验证用的邮箱验证码',
  description:
    '把验证码发到 Logto 里这个账号的主邮箱（hub 自己查邮箱，不接受 App 传邮箱），再用 POST /v1/account/verification 的 email_code 方式提交。' +
    '账号没有主邮箱（例如只用 Apple 登录）返回 400，details.reason 为 email_unavailable，App 应改用密码或重新登录验证。' +
    '与验证身份共用频率限制：每分钟 5 次、每天 30 次，超出返回 429。最坏要等 Logto 三次调用，约 30 秒。',
  middleware: [requireAuthIncludingDeleted, accountVerificationRateLimit] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '验证码已发出', content: { 'application/json': { schema: AccountVerificationCodeSentSchema } } },
    400: jsonError('账号没有可收验证码的主邮箱，details.reason 为 email_unavailable'),
    401: jsonError('未通过身份校验'),
    429: jsonError('尝试过于频繁，details.rule 为 per_minute 或 per_day'),
    502: jsonError('调用 Logto 失败（IDENTITY_VERIFICATION_UNAVAILABLE），可稍后重试'),
    503: jsonError('Logto 的 Machine-to-Machine 凭证尚未配置'),
  },
});

/** 验证身份换注销票据的 OpenAPI 契约 */
const verifyIdentityRoute = createRoute({
  method: 'post',
  path: '/verification',
  tags: ['account'],
  summary: '验证身份并换取注销票据',
  description:
    '注销前必须证明是本人，三种方式选一种：password（hub 让 Logto 校验密码）、email_code（先调 /verification/email-code 发码，hub 让 Logto 校验）、' +
    'id_token（App 重新登录，authorize 请求带 max_age=0，把 LogtoClient.idToken 交来，hub 验签并要求 sub 是当前用户、aud 是芽豆 App、auth_time 在 5 分钟以内）。' +
    '通过后返回 10 分钟有效的注销票据，同一用户再次验证会让旧票据失效。' +
    '没通过返回 400 IDENTITY_VERIFICATION_FAILED，details.reason 为 wrong_password、code_mismatch、code_invalid、email_unavailable 或 login_not_recent。' +
    '与发验证码共用频率限制：每分钟 5 次、每天 30 次，超出返回 429。密码、验证码、ID token 只转给 Logto 或本地验签，不落库、不写日志。',
  middleware: [requireAuthIncludingDeleted, accountVerificationRateLimit] as const,
  security: [{ Bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: AccountVerificationRequestSchema } } },
  },
  responses: {
    200: { description: '注销票据', content: { 'application/json': { schema: AccountVerificationTicketSchema } } },
    400: jsonError('参数校验失败，或身份验证没有通过（IDENTITY_VERIFICATION_FAILED，details.reason 说明原因）'),
    401: jsonError('未通过身份校验'),
    429: jsonError('尝试过于频繁，details.rule 为 per_minute 或 per_day'),
    502: jsonError('调用 Logto 失败（IDENTITY_VERIFICATION_UNAVAILABLE），可稍后重试'),
    503: jsonError('Logto 的 Machine-to-Machine 凭证尚未配置，或用 id_token 方式但 LOGTO_APP_IDS 为空'),
  },
});

/** 注销前数据汇总的 OpenAPI 契约 */
const accountSummaryRoute = createRoute({
  method: 'get',
  path: '/summary',
  tags: ['account'],
  summary: '注销前各产品的数据量汇总',
  description:
    '注销确认页用：并行调各产品后端与 AI 服务的只读汇总接口，每个服务最多等 10 秒，总时长约 10 秒。' +
    '某个服务失败或超时时，那一项的 status 为 unavailable，其余照常，整个接口仍返回 200；不影响注销。' +
    '数量为 0 的项、查到了但没有任何项的服务不返回，所以 services 可能为空。只读，不改任何数据。' +
    '每个用户每分钟最多 10 次、每天 200 次，超出返回 429。',
  middleware: [requireAuthIncludingDeleted, accountSummaryRateLimit] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '各产品的数据量', content: { 'application/json': { schema: AccountSummarySchema } } },
    401: jsonError('未通过身份校验'),
    429: jsonError('调用过于频繁，details.rule 为 per_minute 或 per_day'),
    500: jsonError('服务内部错误'),
  },
});

app.openapi(deleteAccountRoute, async (c) => {
  const headers = c.req.valid('header');
  // 出错不在这里 catch，交给全局 handleError 输出标准错误，App 据此提示重试或重新验证
  await deleteAccount(c.get('userId'), headers[ACCOUNT_DELETION_TICKET_HEADER]);
  return c.json({ deleted: true as const }, 200);
});

app.openapi(sendVerificationCodeRoute, async (c) => {
  await sendAccountVerificationCode(c.get('userId'));
  return c.json({ sent: true as const }, 200);
});

app.openapi(verifyIdentityRoute, async (c) => {
  const issued = await verifyAccountIdentity(c.get('userId'), c.req.valid('json'));
  return c.json({ ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() }, 200);
});

app.openapi(accountSummaryRoute, async (c) => {
  return c.json(await getAccountSummary(c.get('userId')), 200);
});

export default app;
