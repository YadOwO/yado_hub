/**
 * agent 同步接口，挂在 /v1/agents 下，只给 agentd（跑在 Mac 上的 agent 编排服务）用。
 *
 * 鉴权用机器凭证（requireMachine），不是 Logto 登录；管理端接口在 admin-routes.ts。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireMachine } from '../../middleware/machine.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { AgentSyncRequestSchema, AgentSyncResponseSchema } from './schemas.js';
import { applySync } from './service.js';

/** agent 同步子应用 */
const app = createApp();

/** 同步的 OpenAPI 契约 */
const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['agents'],
  summary: 'agentd 同步',
  description:
    'agentd 每 5 秒调用一次：上传状态快照、新事件与相关运行、指令执行结果；返回已收到的最大事件 ID 与待执行的指令。' +
    '用机器凭证鉴权（Authorization: Bearer <凭证>），凭证的 sha256 配置在 AGENT_MACHINE_TOKENS。',
  middleware: [requireMachine] as const,
  security: [{ Bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: AgentSyncRequestSchema } } },
  },
  responses: {
    200: { description: '已收到的位置与待执行的指令', content: { 'application/json': { schema: AgentSyncResponseSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('机器凭证不对'),
  },
});

app.openapi(syncRoute, async (c) => {
  const result = await applySync(c.get('machineId'), c.req.valid('json'));
  return c.json(result, 200);
});

export default app;
