/**
 * agent 管理的 Zod 契约：机器同步接口与管理端接口共用。
 *
 * 同步部分与 yado_agents 的 src/sync/schemas.ts 一一对应，改动要两边一起改。
 * hub 只存摘要（运行结论、步骤状态、问题标题与判断理由、时间线），不存代码、diff 与模型原始输出。
 */
import { z } from '@hono/zod-openapi';

import { AGENT_COMMAND_STATUSES } from '../../db/schema.js';

/** 一次同步最多带多少条事件，与 agentd 的批量一致并留余量 */
const MAX_EVENTS_PER_SYNC = 500;

/** 时区：浏览器与 Node 的 Intl 都认识的 IANA 时区名 */
const TimezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: '不支持的时区' },
);

/** 调度：每天定时、每 N 分钟、cron 表达式 */
export const AgentScheduleSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('daily'),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '时间格式应为 HH:MM' }),
      timezone: TimezoneSchema,
    }),
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(10_080) }),
    z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(100), timezone: TimezoneSchema }),
  ])
  .openapi('AgentSchedule');

/** 运行的一步 */
export const AgentStepSchema = z
  .object({
    key: z.string().openapi({ example: 'r1.triage' }),
    kind: z.string().openapi({ description: 'agentd 自己做的（agentd）或调用模型的（model）' }),
    round: z.number().int(),
    role: z.string().nullable().openapi({ description: 'reviewer、lead、fixer' }),
    model: z.string().nullable(),
    status: z.string().openapi({ description: 'running、succeeded、failed' }),
    error: z.string().nullable(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi('AgentStep');

/** 问题与判断 */
export const AgentFindingSchema = z
  .object({
    id: z.number().int().openapi({ description: 'agentd 本地的问题 ID' }),
    round: z.number().int(),
    ref: z.string().openapi({ example: 'F1' }),
    title: z.string(),
    file: z.string(),
    line: z.number().int().nullable(),
    severity: z.string().openapi({ description: 'high、medium、low' }),
    category: z.string().openapi({
      description:
        'bug、security、performance、type-safety、error-handling、maintainability、test、style、other；' +
        '代码清理另有 duplication、complexity、dead-code、naming、layering、consistency',
    }),
    source: z.string().openapi({ description: 'reviewer（DS）或 lead（主审补充）' }),
    verdict: z.string().nullable().openapi({
      description: 'fix 修、wontfix 不修、escalate 交给你、defer 以后再做（代码清理：值得做但不在这次）；还没判时为 null',
    }),
    reason: z.string().nullable().openapi({ description: '主审的理由' }),
    fixCommit: z.string().nullable(),
    resolution: z
      .string()
      .nullable()
      .openapi({ description: '交给你的问题的处理结果：wontfix 不修、done 已处理、delegated 交给主审；还没处理为 null' }),
    // 旧版 agentd 不传，按 null 处理
    delegatedRunId: z.string().nullable().default(null).openapi({ description: '交给主审时，主审决定它的那次运行' }),
  })
  .openapi('AgentFinding');

/** 运行 */
export const AgentRunSchema = z
  .object({
    id: z.string().openapi({ example: '20261103-231657-b4f9' }),
    instanceId: z.string(),
    flowType: z.string(),
    status: z.string().openapi({
      description: 'queued 排队中、running 运行中、succeeded 完成、needs_attention 需要你处理、failed 失败、canceled 已取消、interrupted 被中断',
    }),
    trigger: z.string().openapi({ description: 'schedule 定时、manual 手动、delegate 你把一个问题交给主审决定' }),
    isDryRun: z.boolean(),
    baseCommit: z.string().nullable(),
    headCommit: z.string().nullable(),
    pushedCommit: z.string().nullable(),
    rounds: z.number().int(),
    summary: z.string().nullable(),
    reason: z.string().nullable(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    queuedAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    acknowledgedAt: z.string().nullable(),
    // 旧版 agentd 不传，按 null 处理
    delegatedFrom: z.string().nullable().default(null).openapi({ description: '交给主审的运行：那个问题所在的运行' }),
    steps: z.array(AgentStepSchema),
    findings: z.array(AgentFindingSchema),
  })
  .openapi('AgentRun');

/** 运行 */
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** 实例最近一次运行的摘要 */
const AgentLastRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  reason: z.string().nullable(),
  queuedAt: z.string(),
  finishedAt: z.string().nullable(),
});

/** 实例：流程类型 + 仓库 + 开发分支 + 调度 */
export const AgentInstanceSchema = z
  .object({
    id: z.string().openapi({ example: 'review-yadoI_be-dev' }),
    flowType: z.string(),
    repo: z.string().openapi({ example: 'YadOwO/yadoI_be' }),
    branch: z.string(),
    schedule: AgentScheduleSchema,
    scheduleText: z.string().openapi({ example: '每天 18:00（Asia/Shanghai）' }),
    isEnabled: z.boolean(),
    isDryRun: z.boolean().openapi({ description: '演练模式：只出报告，不推送' }),
    allowProtectedBranch: z.boolean().openapi({ description: '是否允许推到会触发部署的分支；只能在 Mac 上改' }),
    maxRounds: z.number().int(),
    models: z.record(z.string(), z.string()).openapi({ description: '这个实例单独指定的模型' }),
    nextRunAt: z.string().nullable(),
    cursor: z.string().nullable().openapi({ description: '上次 review 到的提交；代码清理（cleanup）没有，恒为 null' }),
    checks: z.array(z.string()),
    lastRun: AgentLastRunSchema.nullable(),
  })
  .openapi('AgentInstance');

/** 一条待办 */
export const AgentInboxItemSchema = z
  .object({
    id: z.string().openapi({ description: 'finding-<问题 ID> 或 run-<运行 ID>' }),
    kind: z.enum(['finding', 'run']),
    instanceId: z.string(),
    runId: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    severity: z.string().nullable(),
    location: z.string().nullable(),
    runStatus: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('AgentInboxItem');

/** 全局设置 */
export const AgentSettingsSchema = z
  .object({
    maxConcurrentRuns: z.number().int(),
    models: z.object({ reviewer: z.string(), lead: z.string(), fixer: z.string() }),
    retentionDays: z.number().int(),
    pausedFlows: z.array(z.string()),
  })
  .openapi('AgentSettings');

/** 流程类型 */
export const AgentFlowSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    description: z.string(),
    isPaused: z.boolean(),
    // 旧版 agentd 不传，按 null 处理
    defaultSchedule: AgentScheduleSchema.nullable()
      .default(null)
      .openapi({ description: '新建这种流程的实例时默认的调度，页面据此预填' }),
  })
  .openapi('AgentFlow');

/**
 * 经验文字的上限，只是防御。
 *
 * 契约是 rule ≤ 60 字、reason ≤ 40 字，由 agentd 保证；hub 这里放宽，免得一条超长就让整次同步（快照、事件）被拒。
 */
const LESSON_TEXT_MAX = 200;

/** 一次同步最多带多少条经验（含已作废的） */
const MAX_LESSONS_PER_SYNC = 1000;

/**
 * 经验：主审从 review、代码清理里总结的一句话规则，以后的 agent 都会照着做，提出后马上生效。
 *
 * 页面上只能作废、恢复（指令 lesson.void、lesson.restore）；改文字和手动新增只能在 Mac 上用 agentctl，
 * 因为经验会写进给模型的提示词，不能让管理员账号被盗的人借页面改。
 */
export const AgentLessonSchema = z
  .object({
    id: z.number().int().openapi({ description: 'agentd 本地的经验 ID，页面上显示为 L<id>' }),
    scope: z.enum(['global', 'repo']).openapi({ description: 'global 所有仓库通用、repo 只用于 repo 那个仓库' }),
    repo: z.string().nullable().openapi({ description: 'scope 为 repo 时的 owner/name', example: 'YadOwO/yado_hub' }),
    rule: z.string().max(LESSON_TEXT_MAX).openapi({ description: '一句话规则（≤ 60 字）' }),
    reason: z.string().max(LESSON_TEXT_MAX).nullable().openapi({ description: '一句话理由（≤ 40 字），可以没有' }),
    status: z.enum(['active', 'void']).openapi({ description: 'active 生效中、void 已作废' }),
    source: z.string().openapi({ description: 'cleanup、review（那次运行的主审提出的）或 manual（在 Mac 上手动加的）' }),
    sourceRunId: z.string().nullable().openapi({ description: '提出它的那次运行' }),
    replacesId: z.number().int().nullable().openapi({ description: '这条替换掉的旧经验' }),
    replacedById: z.number().int().nullable().openapi({ description: '这条（已作废）被哪条新经验替换掉了' }),
    hits: z.number().int().openapi({ description: '之后的运行确认有问题违反了它的次数' }),
    lastHitAt: z.string().nullable(),
    createdAt: z.string(),
    voidedAt: z.string().nullable(),
  })
  .openapi('AgentLesson');

/** 生效中的经验最多几条：通用的、每个仓库的；超过时 agentd 不再加，恢复也会被拒 */
export const AgentLessonLimitsSchema = z
  .object({ global: z.number().int(), repo: z.number().int() })
  .openapi('AgentLessonLimits');

/** 机器的健康状态 */
const AgentHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  detail: z.string(),
  activeRuns: z.number().int(),
  queuedRuns: z.number().int(),
});

/** 机器的快照：每次同步整体替换 */
export const AgentMachineStateSchema = z.object({
  health: AgentHealthSchema,
  settings: AgentSettingsSchema,
  models: z.array(z.string()),
  flows: z.array(AgentFlowSchema),
  instances: z.array(AgentInstanceSchema).max(200),
  inbox: z.array(AgentInboxItemSchema).max(500),
  // 旧版 agentd 不传，按没有经验处理
  lessons: z.array(AgentLessonSchema).max(MAX_LESSONS_PER_SYNC).default([]),
  lessonLimits: AgentLessonLimitsSchema.nullable().default(null),
});

/** 机器的快照 */
export type AgentMachineState = z.infer<typeof AgentMachineStateSchema>;

/** 事件 */
export const AgentEventSchema = z
  .object({
    id: z.number().int().openapi({ description: 'agentd 本地的事件 ID' }),
    at: z.string(),
    instanceId: z.string().nullable(),
    runId: z.string().nullable(),
    type: z.string(),
    message: z.string(),
  })
  .openapi('AgentEvent');

/** 指令的执行结果 */
const CommandResultSchema = z.object({
  id: z.string(),
  status: z.enum(['succeeded', 'failed']),
  message: z.string(),
});

/** 一次最多交多少条指令结果 */
export const MAX_COMMAND_RESULTS = 100;

/**
 * agentd 每次同步上传的内容。
 *
 * commandResults 是过渡期的兼容字段：旧版 agentd 带着它，并从响应里取指令；新版 agentd 不带，指令只走 POST /claim。
 * 旧版 agentd 都升级后，连同 /check 一起删掉。
 */
export const AgentSyncRequestSchema = AgentMachineStateSchema.extend({
  agentdVersion: z.string().max(40),
  events: z.array(AgentEventSchema).max(MAX_EVENTS_PER_SYNC),
  runs: z.array(AgentRunSchema).max(MAX_EVENTS_PER_SYNC),
  discardedRunIds: z.array(z.string()).max(MAX_EVENTS_PER_SYNC),
  commandResults: z.array(CommandResultSchema).max(MAX_COMMAND_RESULTS).optional().openapi({
    description: '旧版 agentd 在这里交指令结果并取指令；不带这个字段时响应里的 commands 恒为空，指令要走 /claim',
  }),
}).openapi('AgentSyncRequest');

/** agentd 每次同步上传的内容 */
export type AgentSyncRequest = z.infer<typeof AgentSyncRequestSchema>;

/** 发给 agentd 的指令 */
const PendingCommandSchema = z.object({ id: z.uuid(), type: z.string(), payload: z.unknown() });

/** 同步的响应 */
export const AgentSyncResponseSchema = z
  .object({
    ackEventId: z.number().int().nonnegative().openapi({ description: 'hub 已存下的最大事件 ID，下次只传比它大的' }),
    commands: z.array(PendingCommandSchema).openapi({ description: '只有旧版 agentd（请求里带 commandResults）才会收到指令' }),
  })
  .openapi('AgentSyncResponse');

/** 长轮询最多挂起多少秒；要低于 nginx 默认的 proxy_read_timeout（60 秒），否则请求会被代理掐断 */
export const MAX_CHECK_WAIT_SECONDS = 45;

/** 领指令的请求：交上一批指令的结果，并领取新的 */
export const AgentClaimRequestSchema = z
  .object({
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_CHECK_WAIT_SECONDS)
      .default(0)
      .openapi({ description: '没有指令时最多挂起多少秒，期间有新指令立即返回；0 表示立即返回', example: MAX_CHECK_WAIT_SECONDS }),
    results: z.array(CommandResultSchema).max(MAX_COMMAND_RESULTS).default([]).openapi({
      description: '已经执行完的指令的结果；agentd 要先把相关状态同步上来，再交结果',
    }),
  })
  .openapi('AgentClaimRequest');

/** 领指令的请求 */
export type AgentClaimRequest = z.infer<typeof AgentClaimRequestSchema>;

/** 领指令的响应 */
export const AgentClaimResponseSchema = z
  .object({
    commands: z.array(PendingCommandSchema).openapi({ description: '本次领到的指令，hub 已把它们标成「已发出」' }),
  })
  .openapi('AgentClaimResponse');

/** 问指令的查询参数 */
export const AgentCheckQuerySchema = z.object({
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_CHECK_WAIT_SECONDS)
    .default(0)
    .openapi({
      description: `没有指令时最多挂起多少秒，期间有新指令立即返回；0 或不带表示立即返回（旧版 agentd 的行为）`,
      example: MAX_CHECK_WAIT_SECONDS,
    }),
});

/** 问指令的响应 */
export const AgentCheckResponseSchema = z
  .object({
    hasCommands: z.boolean().openapi({ description: '有待执行的指令；为 true 时 agentd 马上同步取走' }),
    waited: z.boolean().openapi({
      description: '这个 hub 认识并处理了 wait 参数（带了 wait 时为 true）。agentd 据此区分旧 hub：旧 hub 会忽略 wait 立即返回',
    }),
  })
  .openapi('AgentCheckResponse');

// ---- 指令 ----

/** 实例 ID、运行 ID */
const IdSchema = z.string().min(1).max(200);

/** 经验 ID */
const LessonIdSchema = z.number().int().min(1);

/** 全局设置里各角色的默认模型：只写要改的角色 */
const RoleModelsPatchSchema = z
  .object({ reviewer: z.string().min(1), lead: z.string().min(1), fixer: z.string().min(1) })
  .partial()
  .strict();

/** 实例的模型覆盖：只写要改的角色，null 表示改回跟随全局 */
const RoleModelsOverridePatchSchema = z
  .object({
    reviewer: z.string().min(1).nullable(),
    lead: z.string().min(1).nullable(),
    fixer: z.string().min(1).nullable(),
  })
  .partial()
  .strict();

/**
 * 页面能发的指令（白名单）。参数都是 strict：多出任何字段整条拒绝。
 * agentd 收到后还会按自己的白名单再校验，并且新建的实例一律是演练模式、仓库 owner 必须在 Mac 上的白名单里。
 */
export const AgentCommandInputSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('instance.create'),
      payload: z
        .object({
          flowType: z.string().min(1),
          repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, { message: '仓库格式应为 owner/name' }),
          branch: z.string().min(1),
          schedule: AgentScheduleSchema.optional(),
          from: z.string().optional(),
        })
        .strict(),
    }),
    z.object({
      type: z.literal('instance.update'),
      payload: z
        .object({
          id: IdSchema,
          branch: z.string().min(1).optional(),
          schedule: AgentScheduleSchema.optional(),
          isEnabled: z.boolean().optional(),
          isDryRun: z.boolean().optional(),
          from: z.string().optional(),
          maxRounds: z.number().int().min(1).max(5).optional(),
          models: RoleModelsOverridePatchSchema.optional(),
        })
        .strict(),
    }),
    z.object({ type: z.literal('instance.delete'), payload: z.object({ id: IdSchema }).strict() }),
    z.object({ type: z.literal('instance.run'), payload: z.object({ id: IdSchema }).strict() }),
    z.object({ type: z.literal('run.cancel'), payload: z.object({ runId: IdSchema }).strict() }),
    z.object({
      type: z.literal('settings.update'),
      payload: z
        .object({
          maxConcurrentRuns: z.number().int().min(1).max(8),
          models: RoleModelsPatchSchema,
          retentionDays: z.number().int().min(1).max(90),
          pausedFlows: z.array(z.string()),
        })
        .partial()
        .strict(),
    }),
    z.object({
      type: z.literal('inbox.resolve'),
      payload: z
        .object({
          itemId: IdSchema,
          // delegate：交给主审在修和不修里选一个，Mac 上另开一次运行
          action: z.enum(['wontfix', 'done', 'delegate']),
          // 交给主审时补充给它的信息，会写进给主审看的材料
          note: z.string().max(1000).optional(),
        })
        .strict(),
    }),
    // 让 Mac 马上把最新状态传上来；Mac 平时一小时才完整同步一次
    z.object({ type: z.literal('sync.now'), payload: z.object({}).strict() }),
    // 经验只能作废、恢复，不能改文字或新增（会写进模型的提示词，只能在 Mac 上改）
    z.object({ type: z.literal('lesson.void'), payload: z.object({ id: LessonIdSchema }).strict() }),
    // 生效中的经验已满时 agentd 会拒绝，原因在指令结果里
    z.object({ type: z.literal('lesson.restore'), payload: z.object({ id: LessonIdSchema }).strict() }),
  ])
  .openapi('AgentCommandInput');

/** 发指令的请求体 */
export const CreateAgentCommandSchema = z
  .object({ machineId: z.string().min(1) })
  .and(AgentCommandInputSchema)
  .openapi('CreateAgentCommand');

/** 指令 */
export const AgentCommandSchema = z
  .object({
    id: z.uuid(),
    machineId: z.string(),
    type: z.string(),
    payload: z.unknown(),
    status: z.enum(AGENT_COMMAND_STATUSES).openapi({
      description: 'pending 等 Mac 取走、sent 已送到等结果、succeeded 成功、failed 失败、expired 一直没送到',
    }),
    result: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi('AgentCommand');

// ---- 管理端 ----

/** 机器 */
export const AgentMachineSchema = z
  .object({
    id: z.string(),
    agentdVersion: z.string(),
    isOnline: z.boolean().openapi({ description: '最近 3 分钟内联系过 hub（问指令或同步）' }),
    lastSeenAt: z.string().openapi({ description: '最近一次上传数据的时间；页面上的实例、待办都是这个时刻的状态' }),
    health: AgentHealthSchema.nullable(),
    settings: AgentSettingsSchema.nullable(),
    models: z.array(z.string()),
    flows: z.array(AgentFlowSchema),
  })
  .openapi('AgentMachine');

/** 带机器 ID 的实例 */
export const AgentInstanceItemSchema = AgentInstanceSchema.extend({ machineId: z.string() }).openapi('AgentInstanceItem');

/** 带机器 ID 的待办 */
export const AgentInboxEntrySchema = AgentInboxItemSchema.extend({ machineId: z.string() }).openapi('AgentInboxEntry');

/** 某一天的汇总 */
export const AgentDaySummarySchema = z
  .object({
    date: z.string().openapi({ example: '2026-11-04' }),
    timezone: z.string(),
    runs: z.record(z.string(), z.number().int()).openapi({ description: '各状态的运行数' }),
    findings: z.object({
      total: z.number().int(),
      fixed: z.number().int(),
      wontfix: z.number().int(),
      escalated: z.number().int(),
    }),
    pushed: z.number().int(),
    noChangeChecks: z.number().int().openapi({ description: '到点检查但没有新提交的次数' }),
  })
  .openapi('AgentDaySummary');

/** 总览 */
export const AgentOverviewSchema = z
  .object({
    machines: z.array(AgentMachineSchema),
    instances: z.array(AgentInstanceItemSchema),
    inbox: z.array(AgentInboxEntrySchema),
    today: AgentDaySummarySchema,
  })
  .openapi('AgentOverview');

/** 总览的查询参数 */
export const OverviewQuerySchema = z.object({
  tz: TimezoneSchema.default('Asia/Shanghai').openapi({ description: '按哪个时区算"今天"，传浏览器的时区' }),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({ description: '汇总哪一天，默认今天' }),
});

/** 带机器 ID 的经验 */
export const AgentLessonItemSchema = AgentLessonSchema.extend({ machineId: z.string() }).openapi('AgentLessonItem');

/** 某台机器的经验上限 */
export const AgentLessonLimitsItemSchema = AgentLessonLimitsSchema.extend({ machineId: z.string() }).openapi(
  'AgentLessonLimitsItem',
);

/** 经验列表 */
export const AgentLessonListSchema = z
  .object({
    lessons: z.array(AgentLessonItemSchema).openapi({ description: '全部机器的经验，含已作废的' }),
    limits: z
      .array(AgentLessonLimitsItemSchema)
      .openapi({ description: '各机器生效中经验的上限；旧版 agentd 没报的机器不在里面' }),
  })
  .openapi('AgentLessonList');

/** 运行列表里的一项：不带步骤与问题 */
export const AgentRunListItemSchema = AgentRunSchema.omit({ steps: true, findings: true })
  .extend({
    machineId: z.string(),
    seq: z.number().int(),
    findingCount: z.number().int(),
    escalatedCount: z.number().int(),
  })
  .openapi('AgentRunListItem');

/** 运行列表 */
export const AgentRunListSchema = z
  .object({
    runs: z.array(AgentRunListItemSchema),
    nextBefore: z.number().int().nullable().openapi({ description: '下一页的 before；没有更多时为 null' }),
  })
  .openapi('AgentRunList');

/** 运行列表的查询参数 */
export const RunListQuerySchema = z.object({
  machine: z.string().optional(),
  instance: z.string().optional(),
  status: z.string().optional(),
  before: z.coerce.number().int().positive().optional().openapi({
    description: '上一页返回的 nextBefore，只返回比它旧的数据；不传表示从最新开始',
  }),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** 运行详情：带时间线 */
export const AgentRunDetailSchema = AgentRunSchema.extend({
  machineId: z.string(),
  events: z.array(AgentEventSchema),
}).openapi('AgentRunDetail');

/** 运行详情的路径参数 */
export const RunParamsSchema = z.object({
  machineId: z.string().openapi({ param: { name: 'machineId', in: 'path' } }),
  runId: z.string().openapi({ param: { name: 'runId', in: 'path' } }),
});

/** 指令的路径参数 */
export const CommandParamsSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, description: '指令 ID' }),
});
