/**
 * 服务启动入口。
 */
import { serve } from '@hono/node-server';

import app from './app.js';
import { env } from './config/env.js';
import { closeDb } from './db/index.js';

/** 进程收到退出信号后，最多等这么久让进行中的请求结束 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** HTTP 服务实例；退出时通过它停止接收新请求 */
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`yado_hub 已启动：http://localhost:${info.port}（${env.NODE_ENV}）`);
  console.log(`接口文档：http://localhost:${info.port}/openapi.json`);
  if (env.isDevAuthBypassEnabled) {
    console.warn(`注意：已开启开发态免鉴权，所有请求都视为用户 ${env.AUTH_DEV_USER_ID}`);
  }
  if (env.adminUserIds.size === 0) {
    console.warn('注意：未配置 ADMIN_USER_IDS，管理端接口对所有人返回 403');
  }
});

/**
 * 优雅退出：停止接收新请求，等进行中的请求结束后关闭数据库连接池再退出。
 */
function shutdown(signal: string): void {
  console.log(`收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    void closeDb().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('关闭数据库连接失败：', error instanceof Error ? error.name : 'UnknownError');
        process.exit(1);
      },
    );
  });
  // 兜底：请求迟迟不结束则强制退出，避免容器停不下来
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
