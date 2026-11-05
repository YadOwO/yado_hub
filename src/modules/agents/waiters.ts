/**
 * 指令长轮询的等待者（waiter）：agentd 问「有没有指令」时，没有就在 hub 挂起，页面发来指令后立刻唤醒。
 *
 * 只放在内存里，当前 hub 是单实例；以后有多个副本时要换成共享通知（例如 Postgres LISTEN/NOTIFY）。
 * 本文件不依赖数据库，方便单独测试；查库的动作由调用方通过 {@link waitForCommands} 的 `hasPending` 传入。
 */

/** 等待结束的原因 */
export type WaitOutcome = 'woken' | 'timeout' | 'aborted' | 'released';

/** 一个挂起的等待者 */
interface IWaiter {
  /** 结束等待；已经结束时什么都不做 */
  settle(outcome: WaitOutcome): void;
}

/** 按机器 ID 分组的等待者；同一台机器重连时可能短暂有多个 */
const waiters = new Map<string, Set<IWaiter>>();

/** 是否已进入关机流程；之后新来的等待者不再挂起，直接放行 */
let isReleased = false;

/** 一次注册的结果 */
interface IRegistration {
  /** 等待结束的原因；先到先得，只会有一个 */
  outcome: Promise<WaitOutcome>;
  /** 清理：从集合里移除并取消计时，等待已结束时无害 */
  dispose(): void;
}

/**
 * 注册一个等待者。
 *
 * 超时、被唤醒、客户端断开（signal abort）、关机释放四种情况都会结束等待并把自己从集合里移除，
 * 不会越积越多。
 */
function register(machineId: string, timeoutMs: number, signal: AbortSignal | undefined): IRegistration {
  let settleOutcome: (outcome: WaitOutcome) => void = () => undefined;
  const outcome = new Promise<WaitOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  let timer: NodeJS.Timeout | null = null;
  const group = waiters.get(machineId) ?? new Set<IWaiter>();

  const waiter: IWaiter = {
    settle(result) {
      dispose();
      settleOutcome(result);
    },
  };
  const onAbort = (): void => waiter.settle('aborted');

  function dispose(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    signal?.removeEventListener('abort', onAbort);
    group.delete(waiter);
    if (group.size === 0 && waiters.get(machineId) === group) {
      waiters.delete(machineId);
    }
  }

  if (isReleased) {
    settleOutcome('released');
    return { outcome, dispose };
  }
  if (signal?.aborted) {
    settleOutcome('aborted');
    return { outcome, dispose };
  }
  group.add(waiter);
  waiters.set(machineId, group);
  timer = setTimeout(() => waiter.settle('timeout'), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  return { outcome, dispose };
}

/**
 * 长轮询：返回这台机器有没有待执行的指令。
 *
 * **先注册等待者，再查一次库**：指令刚好写在「查库」和「挂起」之间时，写入方的唤醒不会落空。
 * 被唤醒后再查一次库：指令可能已经被别的请求（例如同一时刻的 /sync）取走，不能直接回答有。
 *
 * @param hasPending 查库：这台机器现在有没有待发的指令。/claim 传进来的是「领取」，带副作用（把指令标成已发出），
 *   所以它返回 true 之后调用方就不会再调用它
 */
export async function waitForCommands(
  machineId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  hasPending: () => Promise<boolean>,
): Promise<boolean> {
  const registration = register(machineId, timeoutMs, signal);
  try {
    if (await hasPending()) {
      return true;
    }
    const outcome = await registration.outcome;
    return outcome === 'woken' ? await hasPending() : false;
  } finally {
    registration.dispose();
  }
}

/** 这台机器有了新指令：唤醒它所有挂起的等待者 */
export function wakeWaiters(machineId: string): void {
  for (const waiter of [...(waiters.get(machineId) ?? [])]) {
    waiter.settle('woken');
  }
}

/** 关机：让所有等待者立即返回，并且之后新来的也不再挂起，否则挂起的请求会让 server.close() 一直等 */
export function releaseAllWaiters(): void {
  isReleased = true;
  for (const group of [...waiters.values()]) {
    for (const waiter of [...group]) {
      waiter.settle('released');
    }
  }
}

/** 当前挂起的等待者数量（测试与排查用） */
export function waiterCount(machineId?: string): number {
  if (machineId !== undefined) {
    return waiters.get(machineId)?.size ?? 0;
  }
  let total = 0;
  for (const group of waiters.values()) {
    total += group.size;
  }
  return total;
}

/** 重置关机标记（测试用） */
export function resetWaitersForTest(): void {
  isReleased = false;
  waiters.clear();
}
