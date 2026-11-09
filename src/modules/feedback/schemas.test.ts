import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CALL_STACK_TREE_MAX_LENGTH, DIAGNOSTICS_MAX_COUNT, SendUserMessageSchema } from './schemas.js';

/** 一份合法诊断 */
const DIAGNOSTIC = {
  kind: 'crash',
  timestamp: '2026-11-09T02:32:00Z',
  osVersion: 'iOS 27.1',
  appVersion: '1.0.0',
  buildVersion: '12',
  callStackTree: '{"callStacks":[]}',
};

/** 构造发消息请求体，可覆盖 diagnostics */
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b',
    content: '记账页点保存没反应',
    clientInfo: { appVersion: '1.0.0 (12)', osVersion: 'iOS 27.1', deviceModel: 'iPhone18,1', locale: 'zh-Hans' },
    ...extra,
  };
}

describe('SendUserMessageSchema diagnostics', () => {
  it('不带 diagnostics 通过', () => {
    assert.equal(SendUserMessageSchema.safeParse(body()).success, true);
  });

  it('带 1 份合法诊断通过', () => {
    assert.equal(SendUserMessageSchema.safeParse(body({ diagnostics: [DIAGNOSTIC] })).success, true);
  });

  it('超过 5 份拒绝', () => {
    const list = Array.from({ length: DIAGNOSTICS_MAX_COUNT + 1 }, () => DIAGNOSTIC);
    assert.equal(SendUserMessageSchema.safeParse(body({ diagnostics: list })).success, false);
  });

  it('kind 不认识拒绝', () => {
    const result = SendUserMessageSchema.safeParse(body({ diagnostics: [{ ...DIAGNOSTIC, kind: 'cpu' }] }));
    assert.equal(result.success, false);
  });

  it('timestamp 不是 ISO 拒绝', () => {
    const result = SendUserMessageSchema.safeParse(body({ diagnostics: [{ ...DIAGNOSTIC, timestamp: 'yesterday' }] }));
    assert.equal(result.success, false);
  });

  it('callStackTree 超长拒绝', () => {
    const tree = 'a'.repeat(CALL_STACK_TREE_MAX_LENGTH + 1);
    const result = SendUserMessageSchema.safeParse(body({ diagnostics: [{ ...DIAGNOSTIC, callStackTree: tree }] }));
    assert.equal(result.success, false);
  });
});
