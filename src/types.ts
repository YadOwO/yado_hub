/**
 * Hono 应用的类型环境定义。
 */
import type { Env } from 'hono';

/** 约束中间件与业务路由共享的请求级上下文 */
export interface AppEnv extends Env {
  Variables: {
    /** 当前请求的用户标识，由鉴权中间件从 JWT 的 sub 写入 */
    userId: string;
  };
}
