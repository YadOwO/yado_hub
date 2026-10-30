/**
 * 应用组装。
 *
 * modules/ 下每个功能一个文件夹（feedback……），用户端路由挂在 /v1/<功能> 下，产品代号作为路径参数；
 * 管理端路由统一经 modules/admin 挂在 /v1/admin 下。功能之间不互相引用，需要复用的逻辑下沉到 shared/。
 */
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { env } from './config/env.js';
import { pingDb } from './db/index.js';
import adminRoutes from './modules/admin/index.js';
import feedbackRoutes from './modules/feedback/routes.js';
import { handleError } from './shared/errors.js';
import { createApp } from './shared/openapi.js';

/** 服务主应用，统一装配跨域、错误处理与各功能路由 */
const app = createApp();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGINS === '*' ? '*' : env.CORS_ORIGINS.split(',').map((item) => item.trim()),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86_400,
  }),
);

app.onError(handleError);

/**
 * 健康检查：供反向代理与监控使用，不需要鉴权。
 * 数据库不通不算不健康，只在 db 字段中体现，避免部署脚本因此判定失败。
 */
app.get('/health', async (c) => {
  return c.json(
    {
      status: 'ok',
      db: (await pingDb()) ? 'up' : 'down',
      time: new Date().toISOString(),
    },
    200,
  );
});

// 声明 Bearer 认证方式，供 OpenAPI 文档与客户端代码生成使用。
// 业务路由通过 security: [{ Bearer: [] }] 引用它。
app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// 鉴权挂在各路由的 middleware 字段上，不在此处用 app.use。
app.route('/v1/feedback', feedbackRoutes);
app.route('/v1/admin', adminRoutes);

/**
 * OpenAPI 文档。
 * iOS 客户端由此文件生成网络层代码，避免手写请求与模型。
 */
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'yado Hub API',
    version: '0.1.0',
    description: '芽豆系列产品共用的通用业务接口',
  },
});

export default app;
