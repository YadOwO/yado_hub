/**
 * OpenAPIHono 应用工厂。
 *
 * 统一注入 defaultHook，使 Zod 参数校验失败时也返回平台约定的错误结构，
 * 而不是 Hono 默认的校验错误格式。
 */
import { OpenAPIHono, z } from '@hono/zod-openapi';

import { badRequest } from './errors.js';
import type { AppEnv } from '../types.js';

/** 错误响应的 OpenAPI 定义 */
export const ErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .openapi('Error');

/** 生成 JSON 错误响应的 OpenAPI 配置 */
export function jsonError(description: string): {
  description: string;
  content: { 'application/json': { schema: typeof ErrorSchema } };
} {
  return {
    description,
    content: { 'application/json': { schema: ErrorSchema } },
  };
}

/** 创建具有统一参数校验错误格式的应用，供主应用与各层子应用复用 */
export function createApp(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw badRequest('请求参数校验失败', result.error.issues);
      }
    },
  });
}
