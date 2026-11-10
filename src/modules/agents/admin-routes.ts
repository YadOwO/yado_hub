/**
 * agent 管理的管理端路由，由 modules/admin 挂在 /v1/admin/agents 下。
 *
 * 每个路由都在 middleware 字段依次挂 requireAuth 与 requireAdmin。
 * 页面上的操作都是"发指令"：hub 存下指令并唤醒 agentd 挂着的长轮询（POST /claim），agentd 取走执行，同步好状态后回报结果；页面据此轮询指令状态。
 */
import { createRoute, type z } from '@hono/zod-openapi';

import type { AgentCommandRow, AgentEventRow, AgentRunRow } from '../../db/schema.js';
import { requireAdmin } from '../../middleware/admin.js';
import { requireAuth } from '../../middleware/auth.js';
import { createApp, jsonError } from '../../shared/openapi.js';
import {
  AgentCommandSchema,
  AgentIdeaListSchema,
  AgentLessonListSchema,
  AgentOverviewSchema,
  AgentRunDetailSchema,
  AgentRunListSchema,
  type AgentRunListItemSchema,
  CommandParamsSchema,
  CreateAgentCommandSchema,
  OverviewQuerySchema,
  RunListQuerySchema,
  RunParamsSchema,
} from './schemas.js';
import {
  createCommand,
  getCommand,
  getRun,
  isOnline,
  listMachines,
  listRuns,
  parseMachineState,
  parseRun,
  summarizeDay,
} from './service.js';

/** agent 管理端子应用 */
const app = createApp();

/** 指令转成响应 */
function toCommandDTO(row: AgentCommandRow): {
  id: string;
  machineId: string;
  type: string;
  payload: unknown;
  status: AgentCommandRow['status'];
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
} {
  return {
    id: row.id,
    machineId: row.machineId,
    type: row.type,
    payload: row.payload,
    status: row.status,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** 事件转成响应 */
function toEventDTO(row: AgentEventRow): {
  id: number;
  at: string;
  instanceId: string | null;
  runId: string | null;
  type: string;
  message: string;
} {
  return {
    id: row.localId,
    at: row.at.toISOString(),
    instanceId: row.instanceId,
    runId: row.runId,
    type: row.type,
    message: row.message,
  };
}

/** 运行列表里的一项：去掉步骤与问题，只留数量；摘要解析不了的跳过 */
function toRunListItem(row: AgentRunRow): z.infer<typeof AgentRunListItemSchema> | null {
  const run = parseRun(row);
  if (run === null) {
    return null;
  }
  const { steps: _steps, findings, ...rest } = run;
  return {
    ...rest,
    machineId: row.machineId,
    seq: row.seq,
    findingCount: findings.length,
    escalatedCount: findings.filter((finding) => finding.verdict === 'escalate').length,
  };
}

/** 总览的 OpenAPI 契约 */
const overviewRoute = createRoute({
  method: 'get',
  path: '/overview',
  tags: ['admin'],
  summary: 'agent 总览',
  description: '机器在线状态、全局设置与可选模型、全部实例、待办、今天的汇总。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { query: OverviewQuerySchema },
  responses: {
    200: { description: '总览', content: { 'application/json': { schema: AgentOverviewSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
  },
});

/** 运行列表的 OpenAPI 契约 */
const listRunsRoute = createRoute({
  method: 'get',
  path: '/runs',
  tags: ['admin'],
  summary: 'agent 运行列表',
  description: '可按机器、流程类型、实例、状态筛选，最新的在前，before 游标分页。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { query: RunListQuerySchema },
  responses: {
    200: { description: '运行列表', content: { 'application/json': { schema: AgentRunListSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
  },
});

/** 运行详情的 OpenAPI 契约 */
const getRunRoute = createRoute({
  method: 'get',
  path: '/runs/{machineId}/{runId}',
  tags: ['admin'],
  summary: 'agent 运行详情',
  description: '步骤、问题与判断、时间线。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { params: RunParamsSchema },
  responses: {
    200: { description: '运行详情', content: { 'application/json': { schema: AgentRunDetailSchema } } },
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('运行不存在'),
  },
});

/** 经验列表的 OpenAPI 契约 */
const listLessonsRoute = createRoute({
  method: 'get',
  path: '/lessons',
  tags: ['admin'],
  summary: 'agent 经验与产品偏好',
  description:
    '全部机器的经验（含已作废的）、产品偏好与各自的上限，是 Mac 最近一次上传时的状态。' +
    '页面上只能作废、恢复（指令 lesson.void / lesson.restore、preference.void / preference.restore），改文字和新增只能在 Mac 上做。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '经验列表', content: { 'application/json': { schema: AgentLessonListSchema } } },
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
  },
});

/** 想法列表的 OpenAPI 契约 */
const listIdeasRoute = createRoute({
  method: 'get',
  path: '/ideas',
  tags: ['admin'],
  summary: '产品探索的想法',
  description:
    '全部机器的想法（全文）与各实例每个产品的上限，是 Mac 最近一次上传时的状态。' +
    '页面上采纳并开工（指令 idea.implement，交给同一个系列的一次实现）、丢弃或标成已实现（指令 idea.decide），都可以写备注。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: { description: '想法列表', content: { 'application/json': { schema: AgentIdeaListSchema } } },
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
  },
});

/** 发指令的 OpenAPI 契约 */
const createCommandRoute = createRoute({
  method: 'post',
  path: '/commands',
  tags: ['admin'],
  summary: '给机器发指令',
  description: '只接受白名单里的指令。Mac 挂着的长轮询（POST /claim）会被立即唤醒取走执行（旧版 agentd 最多等一分钟），结果用 GET /commands/{id} 查。',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateAgentCommandSchema } } },
  },
  responses: {
    200: { description: '已存下的指令', content: { 'application/json': { schema: AgentCommandSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('机器还没同步过'),
  },
});

/** 查指令的 OpenAPI 契约 */
const getCommandRoute = createRoute({
  method: 'get',
  path: '/commands/{id}',
  tags: ['admin'],
  summary: '查指令结果',
  middleware: [requireAuth, requireAdmin] as const,
  security: [{ Bearer: [] }],
  request: { params: CommandParamsSchema },
  responses: {
    200: { description: '指令', content: { 'application/json': { schema: AgentCommandSchema } } },
    400: jsonError('参数校验失败'),
    401: jsonError('未通过身份校验'),
    403: jsonError('不是管理员'),
    404: jsonError('指令不存在'),
  },
});

app.openapi(overviewRoute, async (c) => {
  const { tz, date } = c.req.valid('query');
  const machines = await listMachines();
  const today = await summarizeDay(tz, date);
  const now = Date.now();
  const parsed = machines.map((row) => ({ row, state: parseMachineState(row) }));
  return c.json(
    {
      machines: parsed.map(({ row, state }) => ({
        id: row.id,
        agentdVersion: row.agentdVersion,
        isOnline: isOnline(row, now),
        lastSeenAt: row.lastSeenAt.toISOString(),
        health: state?.health ?? null,
        settings: state?.settings ?? null,
        models: state?.models ?? [],
        modelThinking: state?.modelThinking ?? [],
        flows: state?.flows ?? [],
      })),
      instances: parsed.flatMap(({ row, state }) =>
        (state?.instances ?? []).map((instance) => ({ ...instance, machineId: row.id })),
      ),
      inbox: parsed.flatMap(({ row, state }) => (state?.inbox ?? []).map((item) => ({ ...item, machineId: row.id }))),
      today,
    },
    200,
  );
});

app.openapi(listRunsRoute, async (c) => {
  const page = await listRuns(c.req.valid('query'));
  return c.json(
    {
      runs: page.items.map(toRunListItem).filter((item) => item !== null),
      nextBefore: page.nextBefore,
    },
    200,
  );
});

app.openapi(getRunRoute, async (c) => {
  const { machineId, runId } = c.req.valid('param');
  const { run, events } = await getRun(machineId, runId);
  return c.json({ ...run, machineId, events: events.map(toEventDTO) }, 200);
});

app.openapi(listLessonsRoute, async (c) => {
  const parsed = (await listMachines()).map((row) => ({ row, state: parseMachineState(row) }));
  return c.json(
    {
      lessons: parsed.flatMap(({ row, state }) => (state?.lessons ?? []).map((lesson) => ({ ...lesson, machineId: row.id }))),
      limits: parsed.flatMap(({ row, state }) =>
        state === null || state.lessonLimits === null ? [] : [{ ...state.lessonLimits, machineId: row.id }],
      ),
      preferences: parsed.flatMap(({ row, state }) =>
        (state?.preferences ?? []).map((preference) => ({ ...preference, machineId: row.id })),
      ),
      preferenceLimits: parsed.flatMap(({ row, state }) =>
        state === null || state.preferenceLimit === null ? [] : [{ machineId: row.id, limit: state.preferenceLimit }],
      ),
    },
    200,
  );
});

app.openapi(listIdeasRoute, async (c) => {
  const parsed = (await listMachines()).map((row) => ({ row, state: parseMachineState(row) }));
  return c.json(
    {
      ideas: parsed.flatMap(({ row, state }) => (state?.ideas ?? []).map((idea) => ({ ...idea, machineId: row.id }))),
      limits: parsed.flatMap(({ row, state }) =>
        (state?.instances ?? []).flatMap((instance) =>
          instance.ideaLimit === null
            ? []
            : [{ machineId: row.id, instanceId: instance.id, ideaLimit: instance.ideaLimit, products: instance.products ?? [] }],
        ),
      ),
    },
    200,
  );
});

app.openapi(createCommandRoute, async (c) => {
  const body = c.req.valid('json');
  const row = await createCommand({
    machineId: body.machineId,
    type: body.type,
    payload: body.payload,
    createdBy: c.get('userId'),
  });
  return c.json(toCommandDTO(row), 200);
});

app.openapi(getCommandRoute, async (c) => {
  return c.json(toCommandDTO(await getCommand(c.req.valid('param').id)), 200);
});

export default app;
