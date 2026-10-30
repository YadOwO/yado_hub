/**
 * 数据库客户端。
 *
 * 连接池上限刻意保持较小：目标部署环境内存有限（2G 级别），且同一台机器上还有其他服务共享同一个 Postgres 实例。
 * postgres.js 在第一次查询时才建立连接，数据库暂时不可用时服务照常启动。
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../config/env.js';
import * as schema from './schema.js';

/** 底层连接池，只在本文件内用于探活与关闭 */
const client = postgres(env.DATABASE_URL, {
  max: 3,
  idle_timeout: 20,
  // 数据库与服务在同一台机器上，正常连接远低于 1 秒；连不上时尽快失败
  connect_timeout: 3,
});

/** 全服务共用的 Drizzle 实例 */
export const db = drizzle(client, { schema });

/** 事务内的 Drizzle 实例类型，供需要在调用方事务中执行的函数声明参数 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 关闭连接池，供进程优雅退出时调用 */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

/** 健康检查中数据库探测的最长等待时间，需小于 compose 健康检查的 5 秒超时 */
const PING_TIMEOUT_MS = 2_000;

/**
 * 数据库连通性探测；超过 PING_TIMEOUT_MS 视为不通。
 *
 * 必须带超时：数据库不可达时查询会挂起，健康检查若因此超时，部署脚本会判定容器不健康。
 */
export async function pingDb(): Promise<boolean> {
  /** 超时计时器，探测结束后清除，避免拖住进程退出 */
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
  });
  const query = client`select 1`.then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
