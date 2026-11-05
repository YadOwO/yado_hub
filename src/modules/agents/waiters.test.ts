import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { releaseAllWaiters, resetWaitersForTest, waiterCount, waitForCommands, wakeWaiters } from './waiters.js';

/** 让出事件循环，等已排队的 Promise 回调跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('指令长轮询', () => {
  afterEach(() => {
    resetWaitersForTest();
  });

  it('createCommand 唤醒挂起的请求，立即返回 true', async () => {
    let hasCommand = false;
    const pending = waitForCommands('mac', 5000, undefined, () => Promise.resolve(hasCommand));
    await flush();
    assert.equal(waiterCount('mac'), 1);

    hasCommand = true;
    wakeWaiters('mac');
    assert.equal(await pending, true);
    assert.equal(waiterCount(), 0);
  });

  it('只唤醒这台机器的等待者', async () => {
    let otherHasCommand = false;
    const other = waitForCommands('other', 5000, undefined, () => Promise.resolve(otherHasCommand));
    await flush();

    wakeWaiters('mac');
    await flush();
    assert.equal(waiterCount('other'), 1);

    otherHasCommand = true;
    wakeWaiters('other');
    assert.equal(await other, true);
  });

  it('竞态：在注册等待者和查库之间写入指令，也能发现', async () => {
    let hasCommand = false;
    let queries = 0;
    const result = await waitForCommands('mac', 5000, undefined, async () => {
      queries += 1;
      if (queries === 1) {
        // 第一次查库时指令还没写入；返回前指令写入并唤醒
        const answer = hasCommand;
        hasCommand = true;
        wakeWaiters('mac');
        return answer;
      }
      return hasCommand;
    });
    assert.equal(result, true);
    assert.equal(queries, 2);
    assert.equal(waiterCount(), 0);
  });

  it('被唤醒但指令已被别的请求取走，返回 false', async () => {
    const pending = waitForCommands('mac', 5000, undefined, () => Promise.resolve(false));
    await flush();
    wakeWaiters('mac');
    assert.equal(await pending, false);
  });

  it('超时返回 false，等待者被移除', async () => {
    const started = Date.now();
    assert.equal(await waitForCommands('mac', 30, undefined, () => Promise.resolve(false)), false);
    assert.ok(Date.now() - started >= 25);
    assert.equal(waiterCount(), 0);
  });

  it('客户端断开后等待者被移除，不等到超时', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = waitForCommands('mac', 5000, controller.signal, () => Promise.resolve(false));
    await flush();
    assert.equal(waiterCount('mac'), 1);

    controller.abort();
    assert.equal(await pending, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(waiterCount(), 0);
  });

  it('请求进来时就已经断开：不注册，直接返回', async () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await waitForCommands('mac', 5000, controller.signal, () => Promise.resolve(false)), false);
    assert.equal(waiterCount(), 0);
  });

  it('关机时所有等待者立即返回；之后新来的也不再挂起', async () => {
    const first = waitForCommands('mac', 5000, undefined, () => Promise.resolve(false));
    const second = waitForCommands('other', 5000, undefined, () => Promise.resolve(false));
    await flush();
    assert.equal(waiterCount(), 2);

    const started = Date.now();
    releaseAllWaiters();
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(waiterCount(), 0);

    assert.equal(await waitForCommands('mac', 5000, undefined, () => Promise.resolve(false)), false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(waiterCount(), 0);
  });
});
