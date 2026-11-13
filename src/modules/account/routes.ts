/**
 * 账号注销：DELETE /v1/account。
 *
 * 本模块汇总各功能的用户数据删除，所以可以引用各功能的 service；目前只有意见反馈。
 * 必须登录；只删除当前用户自己的数据。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireAuth } from '../../middleware/auth.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { deleteUserFeedbackData } from '../feedback/service.js';
import { AccountDeletionSchema } from './schemas.js';

/** 账号注销子应用 */
const app = createApp();

/** 注销账号的 OpenAPI 契约 */
const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['account'],
  summary: '注销账号',
  description:
    '物理删除当前用户在所有产品下的意见反馈对话、消息、设备信息与诊断；反馈单只保留不含用户与正文的匿名统计。' +
    '没有数据或重复调用也返回 200。App 必须在删除 Logto 用户之前调用。' +
    '注销后 24 小时内，该用户再发反馈会返回 403。',
  middleware: [requireAuth] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: '已删除',
      content: { 'application/json': { schema: AccountDeletionSchema } },
    },
    401: jsonError('未通过身份校验'),
    500: jsonError('服务内部错误'),
  },
});

app.openapi(deleteAccountRoute, async (c) => {
  const userId = c.get('userId');
  const startedAt = Date.now();
  // 数据库出错不在这里 catch，交给全局 handleError 输出 500，App 据此中止注销
  const conversationCount = await deleteUserFeedbackData(userId);
  // 只记功能、用户 ID、数量与耗时，不记任何反馈正文
  console.log(
    JSON.stringify({ event: 'account_feedback_deleted', userId, conversationCount, ms: Date.now() - startedAt }),
  );
  return c.json({ deleted: true as const }, 200);
});

export default app;
