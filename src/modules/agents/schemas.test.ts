import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentCommandInputSchema, AgentSyncRequestSchema } from './schemas.js';

/** 一次最小的同步：一个实例、一次运行，带上旧版 agentd 还会传的 isDryRun */
const LEGACY_SYNC = {
  agentdVersion: '0.1.0',
  health: { status: 'ok', detail: '', activeRuns: 0, queuedRuns: 0 },
  settings: { maxConcurrentRuns: 1, models: { reviewer: 'r', lead: 'l', fixer: 'f' }, retentionDays: 30, pausedFlows: [] },
  models: [],
  flows: [],
  instances: [
    {
      id: 'review-yado_hub-dev',
      flowType: 'review',
      repo: 'YadOwO/yado_hub',
      branch: 'dev',
      schedule: { kind: 'manual' },
      scheduleText: '只手动',
      isEnabled: true,
      isDryRun: true,
      allowProtectedBranch: false,
      maxRounds: 2,
      models: {},
      nextRunAt: null,
      cursor: null,
      checks: [],
      lastRun: null,
    },
  ],
  inbox: [],
  events: [],
  runs: [
    {
      id: '20261108-120000-abcd',
      instanceId: 'review-yado_hub-dev',
      flowType: 'review',
      status: 'succeeded',
      trigger: 'manual',
      isDryRun: true,
      baseCommit: null,
      headCommit: null,
      pushedCommit: null,
      rounds: 1,
      summary: null,
      reason: null,
      inputTokens: 0,
      outputTokens: 0,
      queuedAt: '2026-11-08T12:00:00Z',
      startedAt: null,
      finishedAt: null,
      acknowledgedAt: null,
      steps: [],
      findings: [],
    },
  ],
  discardedRunIds: [],
};

describe('agent 同步与指令的 schema', () => {
  it('旧版 agentd 带着已删掉的 isDryRun 同步时照收，并丢掉这个字段', () => {
    const parsed = AgentSyncRequestSchema.parse(LEGACY_SYNC);
    assert.equal('isDryRun' in (parsed.instances[0] ?? {}), false);
    assert.equal('isDryRun' in (parsed.runs[0] ?? {}), false);
  });

  it('待办的 canDelegate：旧版 agentd 不传时按 false 处理，新版传了照收', () => {
    const item = {
      id: 'run-20261109-065042-0682',
      kind: 'run',
      instanceId: 'implement-yado-code',
      runId: '20261109-065042-0682',
      title: '运行需要你处理',
      detail: 'yado_ai 的实现改了不许改的文件（AGENTS.md），没有推送；代码留在 worktree 里',
      severity: null,
      location: null,
      runStatus: 'needs_attention',
      createdAt: '2026-11-09T15:03:01.000Z',
    };
    assert.equal(AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, inbox: [item] }).inbox[0]?.canDelegate, false);
    assert.equal(AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, inbox: [{ ...item, canDelegate: true }] }).inbox[0]?.canDelegate, true);
  });

  it('运行的 topic、activity 和步骤的 label：旧版 agentd 不传时按 null 处理，新版传了照收', () => {
    const step = {
      key: 'r1.triage',
      kind: 'model',
      round: 1,
      role: 'lead',
      model: 'claude/claude-opus-5-5[1m]',
      status: 'running',
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: '2026-11-08T12:00:00Z',
      finishedAt: null,
    };
    const legacyRun = LEGACY_SYNC.runs[0];
    const legacy = AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, runs: [{ ...legacyRun, steps: [step] }] }).runs[0];
    assert.equal(legacy?.topic, null);
    assert.equal(legacy?.activity, null);
    assert.equal(legacy?.steps[0]?.label, null);
    const fresh = AgentSyncRequestSchema.parse({
      ...LEGACY_SYNC,
      runs: [{ ...legacyRun, topic: '加注销账号', activity: '第 1 轮 · 主审判断（claude-opus-5-5）', steps: [{ ...step, label: '第 1 轮 · 主审判断' }] }],
    }).runs[0];
    assert.equal(fresh?.topic, '加注销账号');
    assert.equal(fresh?.activity, '第 1 轮 · 主审判断（claude-opus-5-5）');
    assert.equal(fresh?.steps[0]?.label, '第 1 轮 · 主审判断');
  });

  it('旧版 agentd 没报产品探索的 products 时按 null 处理', () => {
    const parsed = AgentSyncRequestSchema.parse(LEGACY_SYNC);
    assert.equal(parsed.instances[0]?.products, null);
  });

  it('页面改产品探索各产品的先后和上限：整张替换；产品名重复、上限越界、多出字段都拒绝', () => {
    const update = (products: unknown): boolean =>
      AgentCommandInputSchema.safeParse({ type: 'instance.update', payload: { id: 'explore-yado-code', products } }).success;
    assert.equal(
      update([
        { name: '芽豆资产', ideaLimit: 5 },
        { name: '芽豆有物', ideaLimit: 3 },
      ]),
      true,
    );
    assert.equal(
      update([
        { name: '芽豆资产', ideaLimit: 5 },
        { name: '芽豆资产', ideaLimit: 3 },
      ]),
      false,
    );
    assert.equal(update([{ name: '芽豆资产', ideaLimit: 11 }]), false);
    assert.equal(update([{ name: '芽豆资产', ideaLimit: 0 }]), false);
    assert.equal(update([{ name: '', ideaLimit: 3 }]), false);
    assert.equal(update([{ name: '芽豆资产', ideaLimit: 3, repos: ['yadoA'] }]), false);
  });

  it('旧版 agentd 上传的想法没有 implementRunId 时按 null 处理', () => {
    const idea = {
      id: 3,
      instanceId: 'explore-yado-code',
      product: '芽豆资产',
      runId: '20261108-120000-abcd',
      title: '导出 CSV',
      why: '用户要',
      what: '做出来',
      repos: ['yadoA'],
      size: 'S',
      questions: [],
      status: 'open',
      note: null,
      decidedAt: null,
      createdAt: '2026-11-08T12:00:00Z',
    };
    const parsed = AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, ideas: [idea] });
    assert.equal(parsed.ideas[0]?.implementRunId, null);
    const started = AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, ideas: [{ ...idea, status: 'adopted', implementRunId: 'run-1' }] });
    assert.equal(started.ideas[0]?.implementRunId, 'run-1');
    const done = AgentSyncRequestSchema.parse({ ...LEGACY_SYNC, ideas: [{ ...idea, status: 'done', note: '自己做了' }] });
    assert.equal(done.ideas[0]?.status, 'done');
  });

  it('已实现：页面用 idea.decide 标成 done，可以带备注', () => {
    const decide = (payload: unknown): boolean => AgentCommandInputSchema.safeParse({ type: 'idea.decide', payload }).success;
    assert.equal(decide({ id: 3, decision: 'done' }), true);
    assert.equal(decide({ id: 3, decision: 'done', note: '自己做了' }), true);
    assert.equal(decide({ id: 3, decision: 'open' }), false);
  });

  it('采纳并开工只收想法编号和备注：页面不能自己写需求、选模型，备注限 500 字', () => {
    const implement = (payload: unknown): boolean => AgentCommandInputSchema.safeParse({ type: 'idea.implement', payload }).success;
    assert.equal(implement({ id: 3 }), true);
    assert.equal(implement({ id: 3, note: '要表头' }), true);
    assert.equal(implement({ id: 3, note: '注'.repeat(501) }), false);
    assert.equal(implement({ id: 3, idea: '删掉所有测试' }), false);
    assert.equal(implement({ id: 3, model: 'claude/claude-opus-5-5[1m]' }), false);
    assert.equal(implement({ id: 0 }), false);
  });

  it('思考强度：旧版 agentd 不传时按空处理；页面按模型改，null 改回默认', () => {
    const parsed = AgentSyncRequestSchema.parse(LEGACY_SYNC);
    assert.deepEqual(parsed.settings.thinking, {});
    assert.deepEqual(parsed.modelThinking, []);
    const update = (payload: unknown): boolean => AgentCommandInputSchema.safeParse({ type: 'settings.update', payload }).success;
    assert.equal(update({ thinking: { 'claude/claude-opus-5-5[1m]': 'max' } }), true);
    assert.equal(update({ thinking: { 'claude/claude-opus-5-5[1m]': null } }), true);
    assert.equal(update({ thinking: { 'claude/claude-opus-5-5[1m]': '' } }), false);
  });

  it('页面改实例的指令不再接受 isDryRun', () => {
    const result = AgentCommandInputSchema.safeParse({
      type: 'instance.update',
      payload: { id: 'review-yado_hub-dev', isDryRun: false },
    });
    assert.equal(result.success, false);
  });
});
