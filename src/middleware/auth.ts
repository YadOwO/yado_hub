/**
 * 鉴权中间件：校验 Logto 签发的 JWT。
 *
 * 采用 JWKS 远程公钥验签（非对称），本服务不持有任何签名私钥，
 * 也不需要在每次请求时回调 Logto。jose 会自动缓存并按需刷新公钥。
 */
import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { env } from '../config/env.js';
import { unauthorized } from '../shared/errors.js';
import type { AppEnv } from '../types.js';

/** 远程验签公钥的解析器类型，缓存与刷新由 jose 管理 */
type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

/** 进程内复用公钥解析器，避免每次请求重建缓存与远程获取状态 */
let jwksCache: RemoteJWKSet | null = null;

/**
 * 延迟初始化 JWKS，避免开发态免鉴权时仍要求 Logto 地址可用。
 */
function getJwks(): RemoteJWKSet {
  if (jwksCache === null) {
    jwksCache = createRemoteJWKSet(new URL(env.logtoJwksUrl));
  }
  return jwksCache;
}

/** 从 Authorization 头中提取 Bearer token */
function extractBearerToken(header: string | undefined): string {
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) {
    throw unauthorized('缺少 Bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  if (token.length === 0) {
    throw unauthorized('Bearer token 为空');
  }
  return token;
}

/**
 * 要求请求已认证，并把用户标识写入 context。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (env.isDevAuthBypassEnabled) {
    c.set('userId', env.AUTH_DEV_USER_ID);
    await next();
    return;
  }

  const token = extractBearerToken(c.req.header('Authorization'));

  /** 只有验签通过且 sub 非空后，才作为当前请求的用户标识 */
  let subject: string;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: env.LOGTO_ISSUER,
      audience: env.LOGTO_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw unauthorized('token 中缺少 sub');
    }
    subject = payload.sub;
  } catch (error) {
    // 区分"配置/网络问题"与"token 无效"，便于排查；对外统一返回 401
    console.warn('JWT 校验失败：', error instanceof Error ? error.message : String(error));
    throw unauthorized();
  }

  c.set('userId', subject);
  await next();
});
