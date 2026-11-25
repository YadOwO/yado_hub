import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAccountDeletionServices, type AccountDeletionServicesResult } from './account-deletion.js';

/** 一个合法的 64 位十六进制凭证，按服务名区分 */
function token(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

/** 解析必须成功，失败直接让用例报错 */
function parseOk(services: string, tokens: string): AccountDeletionServicesResult & { ok: true } {
  const result = parseAccountDeletionServices(services, tokens);
  if (!result.ok) {
    throw new Error(`应解析成功：${result.message}`);
  }
  return result;
}

/** 解析必须失败，返回错误说明 */
function parseError(services: string, tokens: string): string {
  const result = parseAccountDeletionServices(services, tokens);
  if (result.ok) {
    throw new Error('应解析失败');
  }
  return result.message;
}

describe('parseAccountDeletionServices', () => {
  it('两项都为空或只有空白时返回空列表，表示未配置', () => {
    assert.deepEqual(parseOk('', '').services, []);
    assert.deepEqual(parseOk('  ', ' , ').services, []);
  });

  it('按配置顺序返回，去掉首尾空白和地址末尾的 /', () => {
    const result = parseOk(
      ' yado-ai=http://yado-ai:7790/ , yadoa-be=http://yadoa-be:7789,yadoi-be=https://yadoi-be:7788// ',
      `yadoi-be:${token('c')}, yado-ai:${token('a')},yadoa-be:${token('b')}`,
    );
    assert.deepEqual(result.services, [
      { name: 'yado-ai', baseUrl: 'http://yado-ai:7790', token: token('a') },
      { name: 'yadoa-be', baseUrl: 'http://yadoa-be:7789', token: token('b') },
      { name: 'yadoi-be', baseUrl: 'https://yadoi-be:7788', token: token('c') },
    ]);
  });

  it('凭证可以是 base64 字符', () => {
    const base64Token = 'q1W2e3R4t5Y6u7I8o9P0a+S/d=F-g_H1j2K3l4Z5x6C7';
    assert.equal(parseOk('yado-ai=http://yado-ai:7790', `yado-ai:${base64Token}`).services[0]?.token, base64Token);
  });

  it('某个服务缺凭证时报错', () => {
    const message = parseError('yado-ai=http://yado-ai:7790,yadoa-be=http://yadoa-be:7789', `yado-ai:${token('a')}`);
    assert.match(message, /缺少 yadoa-be 的凭证/);
  });

  it('凭证对应的服务不在列表里时报错', () => {
    const message = parseError('yado-ai=http://yado-ai:7790', `yado-ai:${token('a')},yadoi-be:${token('c')}`);
    assert.match(message, /yadoi-be 不在 ACCOUNT_DELETION_SERVICES 中/);
  });

  it('只配了凭证、没配服务时报错，不当成未配置', () => {
    assert.match(parseError('', `yado-ai:${token('a')}`), /不在 ACCOUNT_DELETION_SERVICES 中/);
  });

  it('服务名或凭证重复时报错', () => {
    assert.match(
      parseError('yado-ai=http://a:1,yado-ai=http://b:2', `yado-ai:${token('a')}`),
      /yado-ai 出现了不止一次/,
    );
    assert.match(
      parseError('yado-ai=http://a:1', `yado-ai:${token('a')},yado-ai:${token('b')}`),
      /yado-ai 出现了不止一次/,
    );
  });

  it('两个服务用了同一个凭证时报错，错误说明里不带凭证内容', () => {
    const sharedToken = token('a');
    const message = parseError(
      'yado-ai=http://yado-ai:7790,yadoa-be=http://yadoa-be:7789',
      `yado-ai:${sharedToken},yadoa-be:${sharedToken}`,
    );
    assert.match(message, /yadoa-be 的凭证和其他服务重复/);
    assert.ok(!message.includes(sharedToken));
  });

  it('地址不是 http(s) 时报错', () => {
    for (const url of ['ftp://yado-ai', 'yado-ai:7790', 'not a url']) {
      assert.match(parseError(`yado-ai=${url}`, `yado-ai:${token('a')}`), /地址应为/, url);
    }
  });

  it('服务名格式不对、缺分隔符时报错', () => {
    assert.match(parseError('Yado-AI=http://a:1', ''), /服务名=地址/);
    assert.match(parseError('yado-ai', ''), /服务名=地址/);
    assert.match(parseError('', 'yado-ai'), /服务名:凭证/);
    assert.match(parseError('', `YADO:${token('a')}`), /服务名:凭证/);
  });

  it('凭证太短时报错，错误说明里不带凭证内容', () => {
    const message = parseError('yado-ai=http://a:1', 'yado-ai:short-secret-value');
    assert.match(message, /凭证格式不对/);
    assert.ok(!message.includes('short-secret-value'));
  });
});
