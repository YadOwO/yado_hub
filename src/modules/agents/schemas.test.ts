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

  it('页面改实例的指令不再接受 isDryRun', () => {
    const result = AgentCommandInputSchema.safeParse({
      type: 'instance.update',
      payload: { id: 'review-yado_hub-dev', isDryRun: false },
    });
    assert.equal(result.success, false);
  });
});
