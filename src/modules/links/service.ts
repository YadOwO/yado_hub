/**
 * 数据联动授权记录（yado_hub.data_links）的读写。
 *
 * 一条记录是「用户把 source 产品的某类汇总数提供给 target 产品」的授权；取消授权只记 revoked_at、不删行，
 * 只有用户注销时才物理删除。所有查询都带 userId，只能读写当前用户自己的记录。
 */
import { and, eq, isNull, sql } from 'drizzle-orm';

import { isDataLinkSource, type DataLinkSource } from '../../config/data-links.js';
import { db } from '../../db/index.js';
import { dataLinks } from '../../db/schema.js';
import { DATA_LINK_SCOPE, DATA_LINK_TARGET } from './schemas.js';

/** 一条授权的主键条件：用户 + 来源 + 使用方 + 范围 */
function linkKey(userId: string, source: DataLinkSource): ReturnType<typeof and> {
  return and(
    eq(dataLinks.userId, userId),
    eq(dataLinks.source, source),
    eq(dataLinks.target, DATA_LINK_TARGET),
    eq(dataLinks.scope, DATA_LINK_SCOPE),
  );
}

/**
 * 授权：没有记录就新建；已授权时什么都不改；已取消的再授权时清掉 revoked_at、granted_at 更新为当时。
 * 可以重复调用，重复授权不改 granted_at。
 *
 * @returns 授权生效的时刻
 */
export async function grantLink(userId: string, source: DataLinkSource): Promise<Date> {
  const rows = await db
    .insert(dataLinks)
    .values({ userId, source, target: DATA_LINK_TARGET, scope: DATA_LINK_SCOPE })
    .onConflictDoUpdate({
      target: [dataLinks.userId, dataLinks.source, dataLinks.target, dataLinks.scope],
      set: {
        revokedAt: null,
        grantedAt: sql`case when ${dataLinks.revokedAt} is null then ${dataLinks.grantedAt} else now() end`,
      },
    })
    .returning({ grantedAt: dataLinks.grantedAt });
  const row = rows[0];
  if (row === undefined) {
    throw new Error('授权记录写入后没有返回数据');
  }
  return row.grantedAt;
}

/** 取消授权：把有效的授权标记为已取消；没有记录或已取消时什么都不改，可以重复调用 */
export async function revokeLink(userId: string, source: DataLinkSource): Promise<void> {
  await db
    .update(dataLinks)
    .set({ revokedAt: sql`now()` })
    .where(and(linkKey(userId, source), isNull(dataLinks.revokedAt)));
}

/** 用户当前是否已授权这个来源：有记录且没取消 */
export async function isLinkGranted(userId: string, source: DataLinkSource): Promise<boolean> {
  const rows = await db
    .select({ userId: dataLinks.userId })
    .from(dataLinks)
    .where(and(linkKey(userId, source), isNull(dataLinks.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

/** 用户当前有效的授权：来源 → 授权生效的时刻；只含有效的授权，也只认支持的来源 */
export async function listGrantedAt(userId: string): Promise<Map<DataLinkSource, Date>> {
  const rows = await db
    .select({ source: dataLinks.source, grantedAt: dataLinks.grantedAt })
    .from(dataLinks)
    .where(
      and(
        eq(dataLinks.userId, userId),
        eq(dataLinks.target, DATA_LINK_TARGET),
        eq(dataLinks.scope, DATA_LINK_SCOPE),
        isNull(dataLinks.revokedAt),
      ),
    );
  const granted = new Map<DataLinkSource, Date>();
  for (const row of rows) {
    if (isDataLinkSource(row.source)) {
      granted.set(row.source, row.grantedAt);
    }
  }
  return granted;
}

/**
 * 注销账号用：物理删除这个用户的全部授权记录（含已取消的），可重复调用。
 *
 * @returns 删除的行数；用户没有记录时为 0
 */
export async function deleteUserDataLinks(userId: string): Promise<number> {
  const rows = await db.delete(dataLinks).where(eq(dataLinks.userId, userId)).returning({ source: dataLinks.source });
  return rows.length;
}
