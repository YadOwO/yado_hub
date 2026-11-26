import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// routes.js 会间接加载 config/env.ts，它在导入时就校验环境变量，所以必须先设好再动态导入。
// DATABASE_URL 是假地址：postgres.js 第一次查询才会连接，而未带凭证的请求在查注销名单之前就返回 401，不会碰数据库。
process.env.DATABASE_URL = 'postgres://yado:yado@127.0.0.1:1/yado';
process.env.LOGTO_ISSUER = 'https://accounts.example.test/oidc';
process.env.LOGTO_AUDIENCE = 'https://api.example.test/hub';
process.env.AUTH_DEV_BYPASS = 'false';
process.env.NODE_ENV = 'test';

const { default: routes } = await import('./routes.js');
const { createApp } = await import('../../shared/openapi.js');
const { handleError } = await import('../../shared/errors.js');

/** 和 app.ts 一样挂载：统一错误处理 + /v1/links */
const app = createApp();
app.onError(handleError);
app.route('/v1/links', routes);

/** 四个联动接口：方法与路径 */
const ENDPOINTS: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/v1/links' },
  { method: 'PUT', path: '/v1/links/yadoi/yadoa' },
  { method: 'DELETE', path: '/v1/links/yadoi/yadoa' },
  { method: 'GET', path: '/v1/links/yadoi/yadoa/item-value-summary' },
];

describe('数据联动路由的鉴权', () => {
  for (const { method, path } of ENDPOINTS) {
    it(`${method} ${path} 不带 Authorization 返回 401 UNAUTHORIZED`, async () => {
      const response = await app.request(path, { method });
      assert.equal(response.status, 401);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null);
      assert.equal('code' in body ? body.code : undefined, 'UNAUTHORIZED');
    });
  }

  it('Authorization 不是 Bearer 格式也返回 401', async () => {
    const response = await app.request('/v1/links', { headers: { Authorization: 'Basic abc' } });
    assert.equal(response.status, 401);
  });

  it('鉴权先于参数校验：未登录时路径参数不合法也返回 401，不是 400', async () => {
    const response = await app.request('/v1/links/unknown/yadoa/item-value-summary');
    assert.equal(response.status, 401);
  });
});
