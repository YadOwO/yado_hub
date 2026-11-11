import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deleteUserFeedback,
  toAnonymizedTickets,
  type IAnonymizedTicket,
  type IDeletableTicket,
  type IUserFeedbackDeletionOps,
} from './account-deletion.js';

/** 假对话：带所属用户与产品 */
interface IFakeConversation {
  id: string;
  userId: string;
  product: string;
}

/** 假消息：带设备信息与诊断，用来确认它们随对话一起被删 */
interface IFakeMessage {
  id: string;
  conversationId: string;
  content: string;
  clientInfo: { appVersion: string } | null;
  diagnostics: { kind: string }[] | null;
}

/** 内存里的假反馈库：记录各动作的调用顺序与收到的参数 */
class FakeFeedbackStore implements IUserFeedbackDeletionOps {
  conversations: IFakeConversation[] = [];
  /** 删除前的对话快照，用来对照匿名行的产品 */
  conversationsSnapshot: IFakeConversation[] = [];
  tickets: IDeletableTicket[] = [];
  messages: IFakeMessage[] = [];
  /** 保存下来的匿名反馈单 */
  anonymized: IAnonymizedTicket[] = [];
  /** 各动作的调用顺序 */
  readonly log: string[] = [];
  /** 每次删除收到的对话 ID */
  readonly deletedIds: string[][] = [];

  lockUserConversations(userId: string): Promise<{ id: string; product: string }[]> {
    this.log.push('lock');
    return Promise.resolve(
      this.conversations.filter((item) => item.userId === userId).map((item) => ({ id: item.id, product: item.product })),
    );
  }

  listTickets(conversationIds: string[]): Promise<IDeletableTicket[]> {
    this.log.push('listTickets');
    return Promise.resolve(this.tickets.filter((item) => conversationIds.includes(item.conversationId)));
  }

  saveAnonymizedTickets(rows: IAnonymizedTicket[]): Promise<void> {
    this.log.push('saveAnonymizedTickets');
    this.anonymized.push(...rows);
    return Promise.resolve();
  }

  deleteConversations(conversationIds: string[]): Promise<void> {
    this.log.push('deleteConversations');
    this.deletedIds.push(conversationIds);
    this.messages = this.messages.filter((item) => !conversationIds.includes(item.conversationId));
    this.tickets = this.tickets.filter((item) => !conversationIds.includes(item.conversationId));
    this.conversations = this.conversations.filter((item) => !conversationIds.includes(item.id));
    return Promise.resolve();
  }
}

/** 造一张待处理的假反馈单 */
function pendingTicket(conversationId: string, at: string): IDeletableTicket {
  return {
    conversationId,
    status: 'pending',
    createdAt: new Date(at),
    resolvedAt: null,
    lastMessageAt: new Date(at),
  };
}

/** 造一条带设备信息与诊断的假消息 */
function message(id: string, conversationId: string): IFakeMessage {
  return {
    id,
    conversationId,
    content: '这是反馈正文',
    clientInfo: { appVersion: '1.0.0 (1)' },
    diagnostics: [{ kind: 'crash' }],
  };
}

/** 用户 A 在 yadoa、yadoi 下各有一个对话，用户 B 在 yadoa 下有一个 */
function seedStore(): FakeFeedbackStore {
  const store = new FakeFeedbackStore();
  store.conversations = [
    { id: 'c-a-yadoa', userId: 'user-a', product: 'yadoa' },
    { id: 'c-a-yadoi', userId: 'user-a', product: 'yadoi' },
    { id: 'c-b-yadoa', userId: 'user-b', product: 'yadoa' },
  ];
  store.tickets = [
    pendingTicket('c-a-yadoa', '2026-11-01T01:00:00.000Z'),
    {
      conversationId: 'c-a-yadoa',
      status: 'resolved',
      createdAt: new Date('2026-10-01T01:00:00.000Z'),
      resolvedAt: new Date('2026-10-02T01:00:00.000Z'),
      lastMessageAt: new Date('2026-10-01T02:00:00.000Z'),
    },
    pendingTicket('c-a-yadoi', '2026-11-03T01:00:00.000Z'),
    pendingTicket('c-b-yadoa', '2026-11-05T01:00:00.000Z'),
  ];
  store.messages = [
    message('m1', 'c-a-yadoa'),
    message('m2', 'c-a-yadoa'),
    message('m3', 'c-a-yadoi'),
    message('m4', 'c-b-yadoa'),
  ];
  return store;
}

describe('deleteUserFeedback', () => {
  it('只删本人在所有产品下的数据，其他用户原样保留', async () => {
    const store = seedStore();
    const count = await deleteUserFeedback('user-a', store);

    assert.equal(count, 2);
    assert.deepEqual(
      store.conversations.map((item) => item.id),
      ['c-b-yadoa'],
    );
    assert.deepEqual(
      store.tickets.map((item) => item.conversationId),
      ['c-b-yadoa'],
    );
    assert.deepEqual(
      store.messages.map((item) => item.id),
      ['m4'],
    );
  });

  it('匿名行数量等于反馈单数，只有五个字段且与原单一致', async () => {
    const store = seedStore();
    const original = store.tickets.filter((item) => item.conversationId !== 'c-b-yadoa');
    store.conversationsSnapshot = [...store.conversations];
    await deleteUserFeedback('user-a', store);

    assert.equal(store.anonymized.length, 3);
    for (const row of store.anonymized) {
      assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'lastMessageAt', 'product', 'resolvedAt', 'status']);
    }
    const productOf = new Map(store.conversationsSnapshot.map((item) => [item.id, item.product]));
    const expected = original.map((ticket) => ({
      product: productOf.get(ticket.conversationId),
      status: ticket.status,
      createdAt: ticket.createdAt,
      resolvedAt: ticket.resolvedAt,
      lastMessageAt: ticket.lastMessageAt,
    }));
    assert.deepEqual(store.anonymized, expected);
  });

  it('先存匿名统计再删除', async () => {
    const store = seedStore();
    await deleteUserFeedback('user-a', store);

    assert.deepEqual(store.log, ['lock', 'listTickets', 'saveAnonymizedTickets', 'deleteConversations']);
    assert.deepEqual(store.deletedIds, [['c-a-yadoa', 'c-a-yadoi']]);
  });

  it('没有反馈数据的用户返回 0，只调用锁对话', async () => {
    const store = seedStore();
    const count = await deleteUserFeedback('user-none', store);

    assert.equal(count, 0);
    assert.deepEqual(store.log, ['lock']);
    assert.equal(store.conversations.length, 3);
  });

  it('同一用户重复调用不报错，第二次返回 0', async () => {
    const store = seedStore();
    assert.equal(await deleteUserFeedback('user-a', store), 2);
    assert.equal(await deleteUserFeedback('user-a', store), 0);
    assert.equal(store.anonymized.length, 3);
  });

  it('对话没有反馈单时只删对话，不存匿名统计', async () => {
    const store = new FakeFeedbackStore();
    store.conversations = [{ id: 'c1', userId: 'user-a', product: 'yadoa' }];
    const count = await deleteUserFeedback('user-a', store);

    assert.equal(count, 1);
    assert.deepEqual(store.log, ['lock', 'listTickets', 'deleteConversations']);
  });
});

describe('toAnonymizedTickets', () => {
  it('反馈单不属于传入的对话时抛错', () => {
    assert.throws(
      () => toAnonymizedTickets([{ id: 'c1', product: 'yadoa' }], [pendingTicket('other', '2026-11-01T01:00:00.000Z')]),
      Error,
    );
  });
});
