/**
 * agent 同步接口，挂在 /v1/agents 下，只给 agentd（跑在 Mac 上的 agent 编排服务）用。
 *
 * 鉴权用机器凭证（requireMachine），不是 Logto 登录；管理端接口在 admin-routes.ts。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireMachine } from '../../middleware/machine.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import { AgentCheckResponseSchema, AgentSyncRequestSchema, AgentSyncResponseSchema } from './schemas.js';
import { applySync, hasPendingCommands } from './service.js';

/** agent 同步子应用 */
const app = createApp();

/** 同步的 OpenAPI 契约 */
const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['agents'],
  summary: 'agentd 同步',
  description:
    'agentd 在有指令、本地有新事件或距上次同步满一小时时调用：上传状态快照、新事件与相关运行、指令执行结果；' +
    '返回已收到的最大事件 ID 与待执行的指令。' +
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

/** 问指令的 OpenAPI 契约 */
const checkRoute = createRoute({
  method: 'get',
  path: '/check',
  tags: ['agents'],
  summary: 'agentd 问有没有指令',
  description:
    'agentd 每分钟调用一次，只读不写库：有待执行的指令时 agentd 马上同步一次把它取走。' +
    '同时用来判断 Mac 是否在线。鉴权同 /sync。',
  middleware: [requireMachine] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '是否有待执行的指令', content: { 'application/json': { schema: AgentCheckResponseSchema } } },
    401: jsonError('机器凭证不对'),
  },
});

app.openapi(checkRoute, async (c) => {
  return c.json({ hasCommands: await hasPendingCommands(c.get('machineId')) }, 200);
});

export default app;
