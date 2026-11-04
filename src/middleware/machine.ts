/**
 * 机器鉴权：agentd（跑在 Mac 上的 agent 编排服务）用机器凭证同步状态。
 *
 * 机器凭证与 Logto 登录无关，只能访问 /v1/agents 下的同步接口。服务端只存凭证的 sha256（AGENT_MACHINE_TOKENS），
 * 比对时用定长比较，避免按耗时猜出哈希。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { createMiddleware } from 'hono/factory';

import { env } from '../config/env.js';
import { unauthorized } from '../shared/errors.js';
import type { AppEnv } from '../types.js';

/** 按凭证找机器 ID；找不到时返回 null */
function findMachine(token: string): string | null {
  const digest = createHash('sha256').update(token).digest();
  for (const [hash, machineId] of env.agentMachineTokens) {
    if (timingSafeEqual(digest, Buffer.from(hash, 'hex'))) {
      return machineId;
    }
  }
  return null;
}

/**
 * 要求请求带有效的机器凭证，并把机器 ID 写入 context。
 */
export const requireMachine = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('缺少机器凭证');
  }
  const machineId = findMachine(header.slice('bearer '.length).trim());
  if (machineId === null) {
    throw unauthorized('机器凭证不对');
  }
  c.set('machineId', machineId);
  await next();
});
