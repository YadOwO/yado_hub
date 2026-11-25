/**
 * Logto 签发的 JWT 验签：访问令牌（auth.ts）与注销前重新登录拿到的 ID token（account 模块）共用同一份远程公钥。
 *
 * 采用 JWKS 远程公钥验签（非对称），本服务不持有任何签名私钥，jose 会自动缓存并按需刷新公钥。
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { env } from '../config/env.js';
import { identityVerificationFailed } from './errors.js';

/** 远程验签公钥的解析器类型，缓存与刷新由 jose 管理 */
type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

/** 进程内复用公钥解析器，避免每次请求重建缓存与远程获取状态 */
let jwksCache: RemoteJWKSet | null = null;

/**
 * 延迟初始化 JWKS，避免开发态免鉴权时仍要求 Logto 地址可用。
 */
export function getLogtoJwks(): RemoteJWKSet {
  if (jwksCache === null) {
    jwksCache = createRemoteJWKSet(new URL(env.logtoJwksUrl));
  }
  return jwksCache;
}

/** 通过验签的 ID token 里，判断「是不是刚登录过」需要的两个字段 */
export interface ILogtoIdTokenClaims {
  /** 登录用户的 Logto 用户 ID */
  sub: string;
  /** 用户这次完成登录的时间，Unix 秒（OIDC 的 auth_time） */
  authTime: number;
}

/**
 * 校验 App 重新登录后交来的 ID token：验签、issuer、aud 在允许的 App 里、没过期，并取出 sub 与 auth_time。
 *
 * 只做签名与格式校验，「sub 是不是当前用户」「登录是否足够新」由调用方判断。
 * 验签失败、缺 sub 或缺 auth_time 都抛同一个 400 login_not_recent，日志只记错误名，不记 token。
 *
 * @param idToken App 交来的 ID token
 * @param audiences 允许的 aud（芽豆各 App 在 Logto 的应用 ID），不能为空集合
 * @throws 400 IDENTITY_VERIFICATION_FAILED（reason 为 login_not_recent）
 */
export async function verifyLogtoIdToken(
  idToken: string,
  audiences: ReadonlySet<string>,
): Promise<ILogtoIdTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, getLogtoJwks(), {
      issuer: env.LOGTO_ISSUER,
      audience: [...audiences],
    }));
  } catch (error) {
    console.warn('ID token 校验失败：', error instanceof Error ? error.name : 'UnknownError');
    throw identityVerificationFailed('login_not_recent');
  }

  const authTime: unknown = payload.auth_time;
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof authTime !== 'number' ||
    !Number.isFinite(authTime)
  ) {
    console.warn('ID token 缺少 sub 或 auth_time');
    throw identityVerificationFailed('login_not_recent');
  }
  return { sub: payload.sub, authTime };
}
