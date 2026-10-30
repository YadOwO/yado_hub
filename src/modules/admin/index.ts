/**
 * 管理端汇总，整体挂在 /v1/admin 下。
 *
 * 各功能的管理端路由写在功能自己的文件夹里（如 feedback/admin-routes.ts），在这里挂到 /v1/admin/<功能>；
 * 管理入口的状态接口需要各功能的待办数，因此本模块可以引用各功能的 service。
 */
import { createRoute, z } from '@hono/zod-openapi';

import { isAdmin } from '../../middleware/admin.js';
import { requireAuth } from '../../middleware/auth.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import feedbackAdminRoutes from '../feedback/admin-routes.js';
import { countPendingTickets } from '../feedback/service.js';

/** 管理端子应用，由主应用挂载到 /v1/admin */
const app = createApp();

/** 管理入口状态 */
const AdminStatusSchema = z
  .object({
    isAdmin: z.boolean().openapi({ description: '当前账号是否为管理员；App 据此决定是否显示管理端' }),
    pendingTicketCount: z.number().int().nonnegative().nullable().openapi({
      description: '全部产品的待处理反馈单数；非管理员为 null',
      example: 3,
    }),
  })
  .openapi('AdminStatus');

/** 管理入口状态的 OpenAPI 契约 */
const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['admin'],
  summary: '管理入口状态',
  description: '任何已登录用户都可以调用：非管理员返回 isAdmin: false，不返回 403。',
  middleware: [requireAuth] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '管理入口状态', content: { 'application/json': { schema: AdminStatusSchema } } },
    401: jsonError('未通过身份校验'),
  },
});

app.openapi(statusRoute, async (c) => {
  if (!isAdmin(c.get('userId'))) {
    return c.json({ isAdmin: false, pendingTicketCount: null }, 200);
  }
  return c.json({ isAdmin: true, pendingTicketCount: await countPendingTickets() }, 200);
});

/** 意见反馈管理：/v1/admin/feedback/... */
app.route('/feedback', feedbackAdminRoutes);

export default app;
