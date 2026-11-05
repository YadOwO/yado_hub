import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { claimWithWait, type IClaimOps } from './claim.js';
import { releaseAllWaiters, resetWaitersForTest, waiterCount, wakeWaiters } from './waiters.js';

/** 让出事件循环，等已排队的 Promise 回调跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 内存里的假指令表：记录各动作的调用顺序 */
class FakeOps implements IClaimOps<string> {
  /** 待发的指令 */
  pending: string[] = [];
  /** 各动作的调用顺序 */
  readonly log: string[] = [];
  /** 每次放回待发的指令 */
  readonly given: string[][] = [];
  /** 不为空时落库结果会失败 */
  settleError: Error | null = null;

  settle(): Promise<void> {
    this.log.push('settle');
    return this.settleError === null ? Promise.resolve() : Promise.reject(this.settleError);
  }

  take(): Promise<string[]> {
    this.log.push('take');
    return Promise.resolve(this.pending.splice(0));
  }

  giveBack(items: string[]): Promise<void> {
    this.log.push('giveBack');
    this.given.push(items);
    this.pending.unshift(...items);
    return Promise.resolve();
  }
}

describe('领指令', () => {
  afterEach(() => {
    resetWaitersForTest();
  });

  it('先落库结果再领取；不等待时有指令就返回，没有就返回空数组', async () => {
    const ops = new FakeOps();
    ops.pending = ['c1', 'c2'];
    assert.deepEqual(await claimWithWait('mac', 0, undefined, ops), ['c1', 'c2']);
    assert.deepEqual(ops.log, ['settle', 'take']);

    assert.deepEqual(await claimWithWait('mac', 0, undefined, ops), []);
    assert.equal(waiterCount(), 0);
  });

  it('落库结果失败时不领取，错误抛给调用方', async () => {
    const ops = new FakeOps();
    ops.pending = ['c1'];
    ops.settleError = new Error('数据库不可用');
    await assert.rejects(claimWithWait('mac', 0, undefined, ops), /数据库不可用/);
    assert.deepEqual(ops.log, ['settle']);
    assert.deepEqual(ops.pending, ['c1']);
  });

  it('已经有指令时不挂起；没有时挂起，页面发来指令后被唤醒并领到', async () => {
    const ops = new FakeOps();
    ops.pending = ['c1'];
    assert.deepEqual(await claimWithWait('mac', 30, undefined, ops), ['c1']);
    assert.equal(waiterCount(), 0);

    const pending = claimWithWait('mac', 30, undefined, ops);
    await flush();
    assert.equal(waiterCount('mac'), 1);
    ops.pending.push('c2');
    wakeWaiters('mac');
    assert.deepEqual(await pending, ['c2']);
    assert.equal(waiterCount(), 0);
  });

  it('只有结果、没有指令的请求也会先落库结果，再挂起', async () => {
    const ops = new FakeOps();
    const pending = claimWithWait('mac', 30, undefined, ops);
    await flush();
    assert.deepEqual(ops.log, ['settle', 'take']);
    assert.equal(waiterCount('mac'), 1);
    releaseAllWaiters();
    assert.deepEqual(await pending, []);
  });

  it('超时返回空数组，等待者被移除', async () => {
    const started = Date.now();
    assert.deepEqual(await claimWithWait('mac', 0.03, undefined, new FakeOps()), []);
    assert.ok(Date.now() - started >= 25);
    assert.equal(waiterCount(), 0);
  });

  it('领取前客户端已断开：不领，指令留在待发', async () => {
    const ops = new FakeOps();
    ops.pending = ['c1'];
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await claimWithWait('mac', 30, controller.signal, ops), []);
    assert.deepEqual(ops.log, ['settle']);
    assert.deepEqual(ops.pending, ['c1']);
    assert.equal(waiterCount(), 0);
  });

  it('挂起期间客户端断开：不等到超时，等待者被移除', async () => {
    const ops = new FakeOps();
    const controller = new AbortController();
    const started = Date.now();
    const pending = claimWithWait('mac', 30, controller.signal, ops);
    await flush();
    assert.equal(waiterCount('mac'), 1);

    controller.abort();
    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 1000);
    assert.equal(waiterCount(), 0);
  });

  it('领到之后才发现客户端断开：指令放回待发，下一个请求还能领到', async () => {
    const controller = new AbortController();
    const ops = new FakeOps();
    ops.pending = ['c1'];
    const take = ops.take.bind(ops);
    // 领取的数据库往返过程中，客户端断开了
    ops.take = async () => {
      const items = await take();
      controller.abort();
      return items;
    };
    assert.deepEqual(await claimWithWait('mac', 0, controller.signal, ops), []);
    assert.deepEqual(ops.given, [['c1']]);
    assert.deepEqual(ops.pending, ['c1']);

    ops.take = take;
    assert.deepEqual(await claimWithWait('mac', 0, undefined, ops), ['c1']);
  });

  it('被唤醒但指令已被别的请求领走：返回空数组', async () => {
    const ops = new FakeOps();
    const pending = claimWithWait('mac', 30, undefined, ops);
    await flush();
    wakeWaiters('mac');
    assert.deepEqual(await pending, []);
  });

  it('关机时挂起的领取立即返回', async () => {
    const ops = new FakeOps();
    const pending = claimWithWait('mac', 30, undefined, ops);
    await flush();
    const started = Date.now();
    releaseAllWaiters();
    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 1000);
    assert.equal(waiterCount(), 0);
  });
});
