/**
 * 管理员鉴权。
 *
 * 管理员名单来自环境变量 ADMIN_USER_IDS（Logto 用户 ID），不在数据库里维护角色。
 */
import { createMiddleware } from 'hono/factory';

import { env } from '../config/env.js';
import { forbidden } from '../shared/errors.js';
import type { AppEnv } from '../types.js';

/** 判断用户是否为管理员 */
export function isAdmin(userId: string): boolean {
  return env.adminUserIds.has(userId);
}

/**
 * 要求当前用户是管理员。必须挂在 requireAuth 之后，依赖其写入的 userId。
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAdmin(c.get('userId'))) {
    throw forbidden();
  }
  await next();
});
