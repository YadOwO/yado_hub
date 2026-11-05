/**
 * agent 同步接口，挂在 /v1/agents 下，只给 agentd（跑在 Mac 上的 agent 编排服务）用。
 *
 * 鉴权用机器凭证（requireMachine），不是 Logto 登录；管理端接口在 admin-routes.ts。
 */
import { createRoute } from '@hono/zod-openapi';

import { requireMachine } from '../../middleware/machine.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import {
  AgentCheckQuerySchema,
  AgentCheckResponseSchema,
  AgentClaimRequestSchema,
  AgentClaimResponseSchema,
  AgentSyncRequestSchema,
  AgentSyncResponseSchema,
  MAX_CHECK_WAIT_SECONDS,
} from './schemas.js';
import { applySync, checkCommands, claimCommands } from './service.js';

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

/** 领指令的 OpenAPI 契约 */
const claimRoute = createRoute({
  method: 'post',
  path: '/claim',
  tags: ['agents'],
  summary: 'agentd 领指令、交结果',
  description:
    'agentd 的指令通道：先落库请求里上一批指令的结果，再把待执行的指令领走（hub 把它们标成已发出，一次只会发给一个请求）。' +
    `waitSeconds（最多 ${MAX_CHECK_WAIT_SECONDS}）大于 0 时是长轮询：没有指令就挂起，期间页面发来指令立即返回；到时间仍没有则返回空数组。` +
    '客户端断开时挂起的请求提前结束，已领到的指令放回待发。' +
    '交结果前 agentd 要先用 /sync 把相关状态传上来，页面看到「完成」时数据才是新的。鉴权同 /sync。',
  middleware: [requireMachine] as const,
  security: [{ Bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: AgentClaimRequestSchema } } },
  },
  responses: {
    200: { description: '本次领到的指令', content: { 'application/json': { schema: AgentClaimResponseSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('机器凭证不对'),
  },
});

app.openapi(claimRoute, async (c) => {
  // 客户端断开时，挂起的请求据此提前结束
  return c.json(await claimCommands(c.get('machineId'), c.req.valid('json'), c.req.raw.signal), 200);
});

/** 问指令的 OpenAPI 契约 */
const checkRoute = createRoute({
  method: 'get',
  path: '/check',
  tags: ['agents'],
  summary: 'agentd 问有没有指令（旧版）',
  description:
    '只读不写库：有待执行的指令时 agentd 马上同步一次把它取走。同时用来判断 Mac 是否在线。鉴权同 /sync。' +
    `带 wait（最多 ${MAX_CHECK_WAIT_SECONDS} 秒）时是长轮询：没有指令就挂起，期间页面发来指令立即返回；` +
    '到时间仍没有则返回 hasCommands=false。响应里的 waited=true 表示 hub 处理了 wait 参数。' +
    '不带 wait 时立即返回（旧版 agentd 每分钟调用一次）。',
  middleware: [requireMachine] as const,
  security: [{ Bearer: [] }],
  request: { query: AgentCheckQuerySchema },
  responses: {
    200: { description: '是否有待执行的指令', content: { 'application/json': { schema: AgentCheckResponseSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('机器凭证不对'),
  },
});

app.openapi(checkRoute, async (c) => {
  const { wait } = c.req.valid('query');
  // 客户端断开（agentd 被唤醒做别的事时会主动 abort）时，挂起的请求据此提前结束
  return c.json(await checkCommands(c.get('machineId'), wait, c.req.raw.signal), 200);
});

export default app;
