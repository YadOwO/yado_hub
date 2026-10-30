/**
 * 按用户限流中间件。
 *
 * 计数保存在进程内存中：当前只部署单实例，重启后计数清零是可接受的；
 * 将来扩成多实例时，需要改为基于 Redis 的共享计数。
 */
import { createMiddleware } from 'hono/factory';

import { env } from '../config/env.js';
import { tooManyRequests } from '../shared/errors.js';
import type { AppEnv } from '../types.js';

/** 一个固定窗口内的计数状态 */
interface IWindowCounter {
  /** 当前窗口的起始时刻（毫秒时间戳） */
  windowStart: number;
  /** 当前窗口内已发生的调用次数 */
  count: number;
}

/** 一条限流规则 */
interface IRateRule {
  /** 规则名，用于错误详情，便于客户端区分是分钟级还是每日额度用尽 */
  name: 'per_minute' | 'per_day';
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 窗口内允许的最大次数 */
  max: number;
}

/** 分钟级限流窗口的毫秒长度 */
const MINUTE_MS = 60_000;
/** 每日额度使用连续 24 小时的固定窗口，不按日历零点重置 */
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 计数表规模超过该值时清理过期条目，防止长期运行后内存无限增长 */
const SWEEP_THRESHOLD = 10_000;

/**
 * 创建一个按用户限流的中间件。每个中间件有独立的计数表，互不占用额度。
 *
 * 分钟频率与每日额度同时生效，任一规则耗尽即拒绝。必须挂在 requireAuth 之后，依赖其写入的 userId。
 */
function createUserRateLimit(perMinute: number, perDay: number): ReturnType<typeof createMiddleware<AppEnv>> {
  /** 本中间件的限流规则 */
  const rules: readonly IRateRule[] = [
    { name: 'per_minute', windowMs: MINUTE_MS, max: perMinute },
    { name: 'per_day', windowMs: DAY_MS, max: perDay },
  ];
  /** 计数表，key 为 `${规则名}:${userId}` */
  const counters = new Map<string, IWindowCounter>();

  /** 清理所有已过期的窗口 */
  function sweepExpired(now: number): void {
    for (const [key, counter] of counters) {
      if (now - counter.windowStart >= DAY_MS) {
        counters.delete(key);
      }
    }
  }

  /**
   * 检查并占用一次额度；命中限流时返回命中的规则。
   *
   * 先检查所有规则都有余量再统一计数，避免分钟级额度用尽时仍消耗每日额度。
   */
  function consume(userId: string, now: number): IRateRule | null {
    if (counters.size > SWEEP_THRESHOLD) {
      sweepExpired(now);
    }

    /** 暂存已通过检查的窗口，全部规则通过后才统一扣减额度 */
    const active: IWindowCounter[] = [];
    for (const rule of rules) {
      const key = `${rule.name}:${userId}`;
      let counter = counters.get(key);
      if (counter === undefined || now - counter.windowStart >= rule.windowMs) {
        counter = { windowStart: now, count: 0 };
        counters.set(key, counter);
      }
      if (counter.count >= rule.max) {
        return rule;
      }
      active.push(counter);
    }

    for (const counter of active) {
      counter.count += 1;
    }
    return null;
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const exceeded = consume(c.get('userId'), Date.now());
    if (exceeded !== null) {
      throw tooManyRequests('发送过于频繁，请稍后再试', { rule: exceeded.name });
    }
    await next();
  });
}

/** 限制用户发送反馈消息的频率 */
export const feedbackMessageRateLimit = createUserRateLimit(
  env.FEEDBACK_RATE_LIMIT_PER_MINUTE,
  env.FEEDBACK_RATE_LIMIT_PER_DAY,
);
