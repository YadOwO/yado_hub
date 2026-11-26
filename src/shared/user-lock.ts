/**
 * 按用户加的事务级 advisory lock。
 *
 * 意见反馈、数据联动都要把「同一用户的写操作」与「注销删数据」串行起来，所以放在 shared/，各功能不必互相引用。
 */
import { sql } from 'drizzle-orm';

import type { DbTransaction } from '../db/index.js';

/**
 * 在事务里取该用户在某个功能下的 advisory lock；这是事务级锁，事务提交或回滚时自动释放，不需要手动解锁。
 *
 * 锁键是 `scope:userId` 的哈希：同一功能、同一用户的调用会互相排队，不同用户、不同功能互不影响。
 * scope 用来区分不同功能（例如 feedback_user、data_links_user），避免一个功能持锁时误挡住别的功能；
 * 约定每个功能只在「写数据」与「注销删数据」两条路径上取自己的锁，并且都在锁具体数据行之前取，这样不会死锁。
 *
 * @param tx 调用方已经打开的事务；锁的生命周期跟随这个事务
 * @param scope 功能标识，同一功能的各条路径必须使用同一个值
 * @param userId Logto 用户 ID
 */
export async function lockUserScope(tx: DbTransaction, scope: string, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope + ':' + userId}, 0))`);
}
