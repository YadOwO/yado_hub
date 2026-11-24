/**
 * 账号注销：DELETE /v1/account，芽豆所有 App 注销账号都只调这一个接口。
 *
 * hub 统一编排：写注销名单 → 删意见反馈 → 依次调各下游服务的内部删除接口 → 删 Logto 用户，
 * 步骤见 deletion.ts。必须登录；只删除当前用户自己的数据。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireAuthIncludingDeleted } from '../../middleware/auth.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { AccountDeletionSchema } from './schemas.js';
import { deleteAccount } from './service.js';

/** 账号注销子应用 */
const app = createApp();

/** 注销账号的 OpenAPI 契约 */
const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['account'],
  summary: '注销账号',
  description:
    '永久注销芽豆账号：删除当前用户在所有芽豆产品下的意见反馈（反馈单只留不含用户与正文的匿名统计），' +
    '再依次让各产品后端与 AI 服务删除这个用户的数据，全部成功后删除 Logto 用户，之后所有芽豆 App 都无法再用它登录。' +
    '第一步就把用户记入注销名单，之后该用户的旧 token 访问 hub 的其他接口一律 401。' +
    '任何一步失败返回 502 ACCOUNT_DELETION_FAILED（details.step 为失败的那一步），已完成的步骤可以重复执行，' +
    'App 用同一个 token 直接重试即可（本接口不拦注销名单里的用户）；成功或重复调用都返回 200。' +
    '要串行等几个服务，最长约 50 秒，客户端超时要留够。',
  middleware: [requireAuthIncludingDeleted] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: '已注销',
      content: { 'application/json': { schema: AccountDeletionSchema } },
    },
    401: jsonError('未通过身份校验'),
    500: jsonError('服务内部错误，可重试'),
    502: jsonError('某个服务或 Logto 删除失败，可重试'),
    503: jsonError('注销服务尚未配置'),
  },
});

app.openapi(deleteAccountRoute, async (c) => {
  // 出错不在这里 catch，交给全局 handleError 输出标准错误，App 据此提示重试
  await deleteAccount(c.get('userId'));
  return c.json({ deleted: true as const }, 200);
});

export default app;
