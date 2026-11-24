/**
 * 注销名单（yado_hub.deleted_users）的读写。
 *
 * 鉴权中间件、意见反馈、注销编排都要用，所以放在 shared/，各功能不必互相引用。
 */
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, type DbTransaction } from '../db/index.js';
import { deletedUsers } from '../db/schema.js';

/** 可以执行查询的对象：全局连接池，或调用方已经打开的事务 */
type DbExecutor = typeof db | DbTransaction;

/**
 * 把用户写进注销名单；已在名单里时什么都不改（保留第一次的注销时刻），可以重复调用。
 *
 * 单独提交、不放进后续步骤的事务：写入之后，该用户的新请求在鉴权时就会被拒绝。
 */
export async function markUserDeleted(userId: string): Promise<void> {
  await db.insert(deletedUsers).values({ userId }).onConflictDoNothing({ target: deletedUsers.userId });
}

/**
 * 用户是否在注销名单里，按主键查询。
 *
 * @param executor 在调用方事务里查询时传入事务，例如发反馈消息取到用户锁之后再确认一次
 */
export async function isUserDeleted(userId: string, executor: DbExecutor = db): Promise<boolean> {
  const rows = await executor
    .select({ userId: deletedUsers.userId })
    .from(deletedUsers)
    .where(eq(deletedUsers.userId, userId))
    .limit(1);
  return rows.length > 0;
}

/** 记下整套注销已经走完（各服务数据已删、Logto 用户已删）；已记过时保留第一次的时刻 */
export async function markUserDeletionCompleted(userId: string): Promise<void> {
  await db
    .update(deletedUsers)
    .set({ completedAt: sql`now()` })
    .where(and(eq(deletedUsers.userId, userId), isNull(deletedUsers.completedAt)));
}
