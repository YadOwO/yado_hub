/**
 * 领指令（POST /v1/agents/claim）的流程：先落库 agentd 交来的结果，再领取指令，没有就挂起等。
 *
 * 和只读的 /check 不同，领取会改库（指令从待发变成已发出），所以要处理好「领到了却没送到」：
 * 客户端在领取前后断开的话，不能让指令白白变成「已发出」。
 * 本文件不依赖数据库，方便单独测试；数据库动作由调用方通过 {@link IClaimOps} 传入。
 */
import { waitForCommands } from './waiters.js';

/** 领指令用到的三个数据库动作 */
export interface IClaimOps<T> {
  /** 记下 agentd 交来的结果、作废过期的指令；不管有没有指令都要先做 */
  settle(): Promise<void>;
  /** 把这台机器待发的指令原子地标成已发出并返回；没有则返回空数组 */
  take(): Promise<T[]>;
  /** 把刚标成已发出的指令放回待发：客户端已经断开，指令没送到 */
  giveBack(items: T[]): Promise<void>;
}

/**
 * 领指令。
 *
 * 先落库结果，保证 agentd 交的结果马上生效，不受后面挂起多久影响；
 * 再领取。waitSeconds > 0 且当前没有指令时挂起，页面发来指令会立即唤醒并领取（见 {@link waitForCommands}）。
 *
 * 断开处理：领取前客户端已断开就不领；领到之后发现客户端断开，把指令放回待发。
 * 领取到响应送出之间的极短空档无法完全避免，真丢了会在 10 分钟后被标成失败。
 *
 * @param signal 客户端断开时 abort
 * @returns 本次领到的指令，没有则为空数组
 */
export async function claimWithWait<T>(
  machineId: string,
  waitSeconds: number,
  signal: AbortSignal | undefined,
  ops: IClaimOps<T>,
): Promise<T[]> {
  await ops.settle();

  let claimed: T[] = [];
  /** 领一次：waitForCommands 先注册等待者再调用它，指令写在注册前后都不会漏 */
  const probe = async (): Promise<boolean> => {
    if (signal?.aborted) {
      return false;
    }
    const items = await ops.take();
    if (items.length > 0 && signal?.aborted) {
      await ops.giveBack(items);
      return false;
    }
    claimed = items;
    return items.length > 0;
  };

  if (waitSeconds <= 0) {
    await probe();
  } else {
    await waitForCommands(machineId, waitSeconds * 1000, signal, probe);
  }
  return claimed;
}
