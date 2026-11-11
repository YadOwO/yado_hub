import { z } from '@hono/zod-openapi';

/** 注销账号成功的响应；没有数据或重复调用也返回同样的内容 */
export const AccountDeletionSchema = z
  .object({
    deleted: z.literal(true).openapi({ description: '账号在本服务的数据已删除' }),
  })
  .openapi('AccountDeletion');
