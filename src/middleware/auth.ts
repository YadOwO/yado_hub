/**
 * 鉴权中间件：校验 Logto 签发的 JWT。
 *
 * 采用 JWKS 远程公钥验签（非对称），本服务不持有任何签名私钥，
 * 也不需要在每次请求时回调 Logto。jose 会自动缓存并按需刷新公钥。
 * JWT 是离线验签的，Logto 删除用户后旧 token 仍能通过验签，所以 requireAuth 验签后还要查注销名单。
 */
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';

import { env } from '../config/env.js';
import { parseBearerToken } from '../shared/bearer.js';
import { isUserDeleted } from '../shared/deleted-users.js';
import { unauthorized } from '../shared/errors.js';
import { getLogtoJwks } from '../shared/logto-jwks.js';
import type { AppEnv } from '../types.js';

/** 从 Authorization 头中提取 Bearer token */
function extractBearerToken(header: string | undefined): string {
  const token = parseBearerToken(header);
  if (token === null) {
    throw unauthorized('缺少 Bearer token');
  }
  if (token.length === 0) {
    throw unauthorized('Bearer token 为空');
  }
  return token;
}

/**
 * 解析当前请求的用户标识：开发态免鉴权取固定用户，否则校验 Bearer JWT 并返回 sub。
 * 不查注销名单，由调用方决定是否检查。
 */
async function resolveUserId(c: Context<AppEnv>): Promise<string> {
  if (env.isDevAuthBypassEnabled) {
    return env.AUTH_DEV_USER_ID;
  }

  const token = extractBearerToken(c.req.header('Authorization'));

  try {
    const { payload } = await jwtVerify(token, getLogtoJwks(), {
      issuer: env.LOGTO_ISSUER,
      audience: env.LOGTO_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw unauthorized('token 中缺少 sub');
    }
    return payload.sub;
  } catch (error) {
    // 区分"配置/网络问题"与"token 无效"，便于排查；对外统一返回 401
    console.warn('JWT 校验失败：', error instanceof Error ? error.message : String(error));
    throw unauthorized();
  }
}

/**
 * 要求请求已认证，并把用户标识写入 context。
 *
 * 已在注销名单里的用户（开发态免鉴权的固定用户也查）即使 token 仍在有效期内也返回 401。
 * 查名单时数据库出错不在这里 catch，交给全局 handleError 返回 500。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const userId = await resolveUserId(c);
  if (await isUserDeleted(userId)) {
    throw unauthorized();
  }
  c.set('userId', userId);
  await next();
});

/**
 * 只验签、不查注销名单的鉴权，仅给 /v1/account 下注销相关的接口用（注销、注销前验证身份、注销前数据汇总）：
 * 注销中途失败后，用户已经在注销名单里，要靠它才能用同一个 token 重新验证身份并重试。
 */
export const requireAuthIncludingDeleted = createMiddleware<AppEnv>(async (c, next) => {
  c.set('userId', await resolveUserId(c));
  await next();
});
