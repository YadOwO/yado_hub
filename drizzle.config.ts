import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置。
 *
 * schemaFilter 限定为 yado_hub，确保迁移不会误触同一实例上其他服务的 schema（如 yadoa、yadoi、yado_ai、logto）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['yado_hub'],
  /**
   * 迁移记录表放在本服务 schema 内，而不是默认的 drizzle.__drizzle_migrations：
   * 默认位置与其他服务共用会互相干扰。
   */
  migrations: {
    table: '__drizzle_migrations',
    schema: 'yado_hub',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
