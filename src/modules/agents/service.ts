/**
 * agent 管理的数据读写。
 *
 * - 同步：agentd 上传快照与新事件（POST /sync），hub 存下后回报已收到的位置。
 * - 领指令：agentd 长轮询 POST /claim，交上一批指令的结果、领取新指令（没有就挂起，页面发来指令立即唤醒）。
 *   旧版 agentd 还在用 GET /check 问有没有指令，并在 /sync 里交结果、取指令；这部分兼容逻辑等它们都升级后删掉。
 * - 管理端：总览、运行列表与详情、经验、发指令、查指令结果。
 *
 * hub 不参与流程执行，只是 agentd 状态的镜像和指令的中转；指令真正生效以 agentd 回报的结果为准。
 */
import { and, asc, desc, eq, gte, inArray, lt, max, sql } from 'drizzle-orm';

import { db, type DbTransaction } from '../../db/index.js';
import {
  agentCommands,
  agentEvents,
  agentMachines,
  agentRuns,
  type AgentCommandRow,
  type AgentEventRow,
  type AgentMachineRow,
  type AgentRunRow,
} from '../../db/schema.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { claimWithWait } from './claim.js';
import {
  AgentMachineStateSchema,
  AgentRunSchema,
  type AgentMachineState,
  type AgentClaimRequest,
  type AgentRun,
  type AgentSyncRequest,
} from './schemas.js';
import { waitForCommands, wakeWaiters } from './waiters.js';

/** 多久没联系算离线：agentd 的长轮询最长挂 45 秒（关掉长轮询或旧版每分钟一次），要大于这个间隔并留出余量 */
const ONLINE_WINDOW_MS = 3 * 60_000;

/**
 * 每台机器最近一次联系 hub 的时间（领指令、问指令或同步）。
 *
 * 领指令很频繁，只记在内存里不写库；hub 重启后先按库里的最后同步时间算，Mac 一分钟内会再来。
 */
const lastContactAt = new Map<string, number>();

/** 指令多久没送到 Mac 就作废；送到后多久没回报结果就算失败 */
const COMMAND_TTL_MS = 10 * 60_000;

/** 一页数据与下一页游标 */
export interface IPage<T> {
  items: T[];
  nextBefore: number | null;
}

/** 解析机器的快照；版本对不上时按空快照处理，不让一台机器的旧数据拖垮整个页面 */
export function parseMachineState(row: AgentMachineRow): AgentMachineState | null {
  const parsed = AgentMachineStateSchema.safeParse(row.state);
  return parsed.success ? parsed.data : null;
}

/** 解析运行摘要 */
export function parseRun(row: AgentRunRow): AgentRun | null {
  const parsed = AgentRunSchema.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

/** 机器是否在线 */
export function isOnline(row: AgentMachineRow, now = Date.now()): boolean {
  const last = Math.max(row.lastSeenAt.getTime(), lastContactAt.get(row.id) ?? 0);
  return now - last <= ONLINE_WINDOW_MS;
}

/**
 * agentd 问有没有待发的指令；顺便记下联系时间。
 *
 * @param waitSeconds 没有指令时最多挂起多少秒（长轮询），期间 {@link createCommand} 写入指令会立即唤醒；0 表示不挂起
 * @param signal 客户端断开时 abort，挂起的请求据此提前结束，不留在等待集合里
 * @returns hasCommands：是否有待发的指令；waited：这次按长轮询处理了（带了 wait 参数）
 */
export async function checkCommands(
  machineId: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<{ hasCommands: boolean; waited: boolean }> {
  // 请求进入时就记联系时间：挂起期间最长 45 秒，远小于在线窗口
  lastContactAt.set(machineId, Date.now());
  if (waitSeconds <= 0) {
    return { hasCommands: await hasPendingCommands(machineId), waited: false };
  }
  return {
    hasCommands: await waitForCommands(machineId, waitSeconds * 1000, signal, () => hasPendingCommands(machineId)),
    waited: true,
  };
}

/** 这台机器现在有没有待发的指令（只读） */
async function hasPendingCommands(machineId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentCommands.id })
    .from(agentCommands)
    .where(and(eq(agentCommands.machineId, machineId), eq(agentCommands.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/** 指令的 ID、类型与参数，agentd 据此执行 */
export interface IPendingCommand {
  id: string;
  type: string;
  payload: unknown;
}

/**
 * 处理一次同步：存快照、事件、运行。
 *
 * 全部在一个事务里：中途失败时 agentd 下次会从同一位置重传，不会丢也不会重复。
 * 请求里带 commandResults 的是旧版 agentd：顺带落库指令结果、作废过期的指令，并把待发的指令交给它；
 * 新版 agentd 的指令走 {@link claimCommands}，这里恒返回空数组。
 */
export async function applySync(
  machineId: string,
  input: AgentSyncRequest,
): Promise<{ ackEventId: number; commands: IPendingCommand[] }> {
  const now = new Date();
  lastContactAt.set(machineId, now.getTime());
  const state: AgentMachineState = {
    health: input.health,
    settings: input.settings,
    models: input.models,
    flows: input.flows,
    instances: input.instances,
    inbox: input.inbox,
    lessons: input.lessons,
    lessonLimits: input.lessonLimits,
    ideas: input.ideas,
    preferences: input.preferences,
    preferenceLimit: input.preferenceLimit,
  };

  return db.transaction(async (tx) => {
    await tx
      .insert(agentMachines)
      .values({ id: machineId, agentdVersion: input.agentdVersion, state, lastSeenAt: now })
      .onConflictDoUpdate({
        target: agentMachines.id,
        set: { agentdVersion: input.agentdVersion, state, lastSeenAt: now },
      });

    if (input.events.length > 0) {
      await tx
        .insert(agentEvents)
        .values(
          input.events.map((event) => ({
            machineId,
            localId: event.id,
            instanceId: event.instanceId,
            runId: event.runId,
            type: event.type,
            message: event.message,
            at: new Date(event.at),
          })),
        )
        .onConflictDoNothing({ target: [agentEvents.machineId, agentEvents.localId] });
    }

    for (const run of input.runs) {
      const values = {
        instanceId: run.instanceId,
        status: run.status,
        queuedAt: new Date(run.queuedAt),
        finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt),
        data: run,
        updatedAt: now,
      };
      await tx
        .insert(agentRuns)
        .values({ machineId, runId: run.id, ...values })
        .onConflictDoUpdate({ target: [agentRuns.machineId, agentRuns.runId], set: values });
    }

    if (input.discardedRunIds.length > 0) {
      await tx
        .delete(agentRuns)
        .where(and(eq(agentRuns.machineId, machineId), inArray(agentRuns.runId, input.discardedRunIds)));
      await tx
        .delete(agentEvents)
        .where(and(eq(agentEvents.machineId, machineId), inArray(agentEvents.runId, input.discardedRunIds)));
    }

    let commands: IPendingCommand[] = [];
    if (input.commandResults !== undefined) {
      await settleCommands(tx, machineId, input.commandResults, now);
      commands = (await takePendingCommands(tx, machineId, now)).map(toPendingCommand);
    }

    const [ack] = await tx
      .select({ value: max(agentEvents.localId) })
      .from(agentEvents)
      .where(eq(agentEvents.machineId, machineId));

    return { ackEventId: ack?.value ?? 0, commands };
  });
}

/** 指令转成发给 agentd 的结构 */
function toPendingCommand(row: AgentCommandRow): IPendingCommand {
  return { id: row.id, type: row.type, payload: row.payload };
}

/** 落库指令的执行结果，并处理过期的指令：一直没送到的作废，送到后一直没回报的算失败 */
async function settleCommands(
  tx: Pick<DbTransaction, 'update'>,
  machineId: string,
  results: { id: string; status: 'succeeded' | 'failed'; message: string }[],
  now: Date,
): Promise<void> {
  for (const result of results) {
    await tx
      .update(agentCommands)
      .set({ status: result.status, result: result.message, finishedAt: now })
      .where(
        and(
          eq(agentCommands.id, result.id),
          eq(agentCommands.machineId, machineId),
          inArray(agentCommands.status, ['pending', 'sent']),
        ),
      );
  }

  const deadline = new Date(now.getTime() - COMMAND_TTL_MS);
  await tx
    .update(agentCommands)
    .set({ status: 'expired', result: 'Mac 一直没取走这条指令，已作废', finishedAt: now })
    .where(
      and(eq(agentCommands.machineId, machineId), eq(agentCommands.status, 'pending'), lt(agentCommands.createdAt, deadline)),
    );
  await tx
    .update(agentCommands)
    .set({ status: 'failed', result: 'Mac 收到了指令但一直没有回报结果', finishedAt: now })
    .where(and(eq(agentCommands.machineId, machineId), eq(agentCommands.status, 'sent'), lt(agentCommands.sentAt, deadline)));
}

/**
 * 把这台机器所有待发的指令标成已发出并返回，按创建时间从早到晚。
 *
 * 一条 UPDATE ... RETURNING 就是原子的：并发的两个请求不会领到同一条指令。
 */
async function takePendingCommands(
  executor: Pick<DbTransaction, 'update'>,
  machineId: string,
  now: Date,
): Promise<AgentCommandRow[]> {
  const rows = await executor
    .update(agentCommands)
    .set({ status: 'sent', sentAt: now })
    .where(and(eq(agentCommands.machineId, machineId), eq(agentCommands.status, 'pending')))
    .returning();
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** 把已发出但没送到的指令放回待发 */
async function releaseCommands(machineId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db
    .update(agentCommands)
    .set({ status: 'pending', sentAt: null })
    .where(and(eq(agentCommands.machineId, machineId), eq(agentCommands.status, 'sent'), inArray(agentCommands.id, ids)));
}

/**
 * agentd 领指令：交上一批指令的结果，领取新的；没有就挂起，页面发来指令时立即唤醒。
 *
 * @param signal 客户端断开时 abort：挂起的请求提前结束，已领到的指令放回待发
 */
export async function claimCommands(
  machineId: string,
  input: AgentClaimRequest,
  signal?: AbortSignal,
): Promise<{ commands: IPendingCommand[] }> {
  lastContactAt.set(machineId, Date.now());
  const rows = await claimWithWait<AgentCommandRow>(machineId, input.waitSeconds, signal, {
    // 有结果时放进事务，结果和作废要么都生效要么都不生效；空闲的长轮询每次续期不必开事务
    settle: () =>
      input.results.length > 0
        ? db.transaction((tx) => settleCommands(tx, machineId, input.results, new Date()))
        : settleCommands(db, machineId, [], new Date()),
    take: () => takePendingCommands(db, machineId, new Date()),
    giveBack: (items) =>
      releaseCommands(
        machineId,
        items.map((row) => row.id),
      ),
  });
  return { commands: rows.map(toPendingCommand) };
}

/** 全部机器，按 ID 排序 */
export async function listMachines(): Promise<AgentMachineRow[]> {
  return db.select().from(agentMachines).orderBy(asc(agentMachines.id));
}

/** 某个时刻在某个时区是哪一天，例如 2026-11-04 */
function dateIn(timezone: string, date: Date): string {
  // en-CA 的日期格式就是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    date,
  );
}

/** 某一天的汇总 */
export interface IDaySummary {
  date: string;
  timezone: string;
  runs: Record<string, number>;
  findings: { total: number; fixed: number; wontfix: number; escalated: number };
  pushed: number;
  noChangeChecks: number;
}

/**
 * 某个时区某一天的汇总。
 *
 * 先按 UTC 前后各放宽一天查出候选，再在内存里按时区换算日期筛选，不依赖数据库的时区设置。
 */
export async function summarizeDay(timezone: string, date: string | undefined): Promise<IDaySummary> {
  const day = date ?? dateIn(timezone, new Date());
  const center = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(center.getTime())) {
    throw badRequest(`日期不合法：${day}`);
  }
  const from = new Date(center.getTime() - 36 * 3_600_000);
  const to = new Date(center.getTime() + 36 * 3_600_000);

  const runRows = (await db.select().from(agentRuns).where(and(gte(agentRuns.queuedAt, from), lt(agentRuns.queuedAt, to)))).filter(
    (row) => dateIn(timezone, row.queuedAt) === day,
  );
  const noChangeRows = (
    await db
      .select({ at: agentEvents.at })
      .from(agentEvents)
      .where(and(eq(agentEvents.type, 'instance.no-changes'), gte(agentEvents.at, from), lt(agentEvents.at, to)))
  ).filter((row) => dateIn(timezone, row.at) === day);

  const counts: Record<string, number> = {};
  const findings = { total: 0, fixed: 0, wontfix: 0, escalated: 0 };
  let pushed = 0;
  for (const row of runRows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    const run = parseRun(row);
    if (run === null) {
      continue;
    }
    if (run.pushedCommit !== null) {
      pushed += 1;
    }
    for (const finding of run.findings) {
      findings.total += 1;
      if (finding.verdict === 'fix' && finding.fixCommit !== null) {
        findings.fixed += 1;
      } else if (finding.verdict === 'wontfix') {
        findings.wontfix += 1;
      } else if (finding.verdict === 'escalate') {
        findings.escalated += 1;
      }
    }
  }
  return { date: day, timezone, runs: counts, findings, pushed, noChangeChecks: noChangeRows.length };
}

/** 运行列表的筛选条件 */
export interface IRunFilter {
  machine?: string;
  instance?: string;
  status?: string;
  before?: number;
  limit: number;
}

/** 运行列表，最新的在前 */
export async function listRuns(filter: IRunFilter): Promise<IPage<AgentRunRow>> {
  const conditions = [];
  if (filter.machine !== undefined) {
    conditions.push(eq(agentRuns.machineId, filter.machine));
  }
  if (filter.instance !== undefined) {
    conditions.push(eq(agentRuns.instanceId, filter.instance));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(agentRuns.status, filter.status));
  }
  if (filter.before !== undefined) {
    conditions.push(lt(agentRuns.seq, filter.before));
  }
  const rows = await db
    .select()
    .from(agentRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.seq))
    .limit(filter.limit + 1);
  const hasMore = rows.length > filter.limit;
  const items = hasMore ? rows.slice(0, filter.limit) : rows;
  const last = items.at(-1);
  return { items, nextBefore: hasMore && last !== undefined ? last.seq : null };
}

/** 运行详情与时间线 */
export async function getRun(machineId: string, runId: string): Promise<{ run: AgentRun; events: AgentEventRow[] }> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.machineId, machineId), eq(agentRuns.runId, runId)));
  const run = row === undefined ? null : parseRun(row);
  if (run === null) {
    throw notFound(`运行 ${runId} 不存在`);
  }
  const events = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.machineId, machineId), eq(agentEvents.runId, runId)))
    .orderBy(asc(agentEvents.localId));
  return { run, events };
}

/** 发一条指令；机器要已经同步过 */
export async function createCommand(input: {
  machineId: string;
  type: string;
  payload: unknown;
  createdBy: string;
}): Promise<AgentCommandRow> {
  const [machine] = await db.select({ id: agentMachines.id }).from(agentMachines).where(eq(agentMachines.id, input.machineId));
  if (machine === undefined) {
    throw notFound(`机器 ${input.machineId} 还没同步过`);
  }
  const [row] = await db.insert(agentCommands).values(input).returning();
  if (row === undefined) {
    throw new Error('写入指令失败');
  }
  // 写库成功后再唤醒：挂起的 /check 醒来要查库，查得到才对
  wakeWaiters(input.machineId);
  return row;
}

/** 读一条指令 */
export async function getCommand(id: string): Promise<AgentCommandRow> {
  const [row] = await db.select().from(agentCommands).where(eq(agentCommands.id, id));
  if (row === undefined) {
    throw notFound('指令不存在');
  }
  return row;
}

/** 全部机器的待办总数，用于管理入口的角标 */
export async function countAgentInbox(): Promise<number> {
  const rows = await db.select({ count: sql<number>`coalesce(jsonb_array_length(${agentMachines.state} -> 'inbox'), 0)` }).from(agentMachines);
  return rows.reduce((sum, row) => sum + Number(row.count), 0);
}

/** 全部机器还没处理的产品探索想法数，用于「想法」标签的角标 */
export async function countOpenIdeas(): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`coalesce(jsonb_array_length(jsonb_path_query_array(${agentMachines.state}, '$.ideas[*] ? (@.status == "open")')), 0)`,
    })
    .from(agentMachines);
  return rows.reduce((sum, row) => sum + Number(row.count), 0);
}
