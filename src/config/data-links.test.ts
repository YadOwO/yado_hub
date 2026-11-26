import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IDownstreamService } from './account-deletion.js';
import { DATA_LINK_SOURCE_SERVICES, parseDataLinkSources } from './data-links.js';

/** 测试用的下游服务，含 yadoi 对应的 yadoi-be */
const SERVICES: IDownstreamService[] = [
  { name: 'yado-ai', baseUrl: 'http://yado-ai:7790', token: 'a'.repeat(64) },
  { name: 'yadoi-be', baseUrl: 'http://yadoi-be:7788', token: 'c'.repeat(64) },
];

/** 解析必须失败，返回错误说明 */
function parseError(value: string, services: readonly IDownstreamService[]): string {
  const result = parseDataLinkSources(value, services);
  if (result.ok) {
    throw new Error('应解析失败');
  }
  return result.message;
}

describe('parseDataLinkSources', () => {
  it('空字符串和只有空白都表示没配，返回空 Map', () => {
    for (const value of ['', '   ', ' , ']) {
      const result = parseDataLinkSources(value, SERVICES);
      assert.ok(result.ok, `"${value}" 应解析成功`);
      assert.equal(result.sources.size, 0);
    }
  });

  it('yadoi 能匹配到 yadoi-be', () => {
    const result = parseDataLinkSources('yadoi', SERVICES);
    assert.ok(result.ok);
    assert.equal(DATA_LINK_SOURCE_SERVICES.yadoi, 'yadoi-be');
    assert.deepEqual(result.sources.get('yadoi'), SERVICES[1]);
    assert.equal(result.sources.size, 1);
  });

  it(' yadoi , 去掉空白和空项后正常解析', () => {
    const result = parseDataLinkSources(' yadoi , ', SERVICES);
    assert.ok(result.ok);
    assert.deepEqual([...result.sources.keys()], ['yadoi']);
  });

  it('不认识的来源失败，说明里有来源名', () => {
    assert.match(parseError('yadoz', SERVICES), /yadoz/);
    assert.match(parseError('yadoi,yadoz', SERVICES), /yadoz/);
  });

  it('重复的来源失败', () => {
    assert.match(parseError('yadoi,yadoi', SERVICES), /yadoi 出现了不止一次/);
  });

  it('打开了 yadoi 但 services 里没有 yadoi-be 时失败，说明里只有来源名和服务名', () => {
    const withoutYadoi = SERVICES.filter((service) => service.name !== 'yadoi-be');
    const message = parseError('yadoi', withoutYadoi);
    assert.match(message, /yadoi/);
    assert.match(message, /yadoi-be/);
    for (const service of withoutYadoi) {
      assert.ok(!message.includes(service.baseUrl));
      assert.ok(!message.includes(service.token));
    }
    assert.match(parseError('yadoi', []), /yadoi-be/);
  });
});
