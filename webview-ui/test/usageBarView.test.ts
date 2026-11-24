import { describe, expect, it } from 'vitest';

import { USAGE_HEART_MAX_BPM } from '../src/constants.js';
import {
  formatCompactTokens,
  formatDuration,
  freshnessLabel,
  heartBeatPeriodSec,
  selectVisibleUsageVendors,
  usageBarView,
} from '../src/usage/usageBarView.js';
import type { UsageEntry } from '../src/usage/usageStore.js';

const NOW = 1_800_000_000_000; // ms
const inMs = (ms: number) => (NOW + ms) / 1000; // a resetsAt (seconds) ms from now

describe('usageBarView', () => {
  it('shows the share left and the time to reset', () => {
    expect(
      usageBarView({ usedPercentage: 18, resetsAt: inMs(2 * 3_600_000 + 14 * 60_000) }, NOW),
    ).toEqual({
      remaining: 0.82,
      level: 'ok',
      percent: '82%',
      reset: 'resets in 2h 14m',
    });
  });

  it('warns at half left and turns low at a fifth', () => {
    expect(usageBarView({ usedPercentage: 50, resetsAt: inMs(60_000) }, NOW).level).toBe('warn');
    expect(usageBarView({ usedPercentage: 80, resetsAt: inMs(60_000) }, NOW).level).toBe('low');
    expect(usageBarView({ usedPercentage: 100, resetsAt: inMs(60_000) }, NOW).remaining).toBe(0);
  });

  it('reads a window past its reset time as full, whatever was last reported', () => {
    expect(usageBarView({ usedPercentage: 97, resetsAt: inMs(-1) }, NOW)).toMatchObject({
      remaining: 1,
      level: 'ok',
    });
  });

  it('says so when nothing is known', () => {
    expect(usageBarView(undefined, NOW)).toEqual({
      remaining: null,
      level: 'unknown',
      percent: '--',
      reset: 'no data yet',
    });
  });
});

describe('heartBeatPeriodSec', () => {
  it('beats at full pace with the whole plan left', () => {
    expect(heartBeatPeriodSec(1)).toBeCloseTo(60 / USAGE_HEART_MAX_BPM);
  });

  it('slows in proportion as the plan runs down', () => {
    expect(heartBeatPeriodSec(0.25)).toBeCloseTo(4 * heartBeatPeriodSec(1)!);
  });

  it('has no beat when the plan is empty or unknown', () => {
    expect(heartBeatPeriodSec(0)).toBeNull();
    expect(heartBeatPeriodSec(null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [30_000, '<1m'],
    [9 * 60_000, '9m'],
    [3_600_000, '1h'],
    [(2 * 60 + 14) * 60_000, '2h 14m'],
    [(3 * 24 + 4) * 3_600_000 + 59_000, '3d 4h'],
    [2 * 24 * 3_600_000, '2d'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('freshnessLabel', () => {
  it('names the age of the numbers', () => {
    expect(freshnessLabel(NOW - 10_000, NOW, 'Claude Code')).toBe('Updated just now');
    expect(freshnessLabel(NOW - 12 * 60_000, NOW, 'Claude Code')).toBe('Updated 12m ago');
  });

  it('explains where the numbers will come from before any arrive', () => {
    expect(freshnessLabel(undefined, NOW, 'Claude Code')).toBe(
      'Updates once a Claude Code session replies',
    );
  });
});

describe('formatCompactTokens', () => {
  it.each([
    [0, '0'],
    [850, '850'],
    [12_400, '12.4K'],
    [320_316, '320K'],
    [4_906_685, '4.9M'],
    [1_250_000_000, '1.3B'],
  ])('%i → %s', (tokens, expected) => {
    expect(formatCompactTokens(tokens)).toBe(expected);
  });
});

describe('selectVisibleUsageVendors', () => {
  it('orders visible vendors canonically without mixing or leaking empty inactive vendors', () => {
    const map = new Map<string, UsageEntry>([
      [
        'claude',
        {
          seq: 1,
          status: {
            type: 'usageBridgeStatus',
            providerId: 'claude',
            providerName: 'Claude Code',
            installed: false,
            disclosure: '',
          },
          limits: { type: 'usageLimits', providerId: 'claude' },
        },
      ],
      [
        'antigravity',
        {
          seq: 0,
          limits: {
            type: 'usageLimits',
            providerId: 'antigravity',
            sevenDayActivity: { tokens: 500, inputTokens: 400, outputTokens: 100, turns: 1 },
          },
        },
      ],
      [
        'codex',
        {
          seq: 0,
          limits: {
            type: 'usageLimits',
            providerId: 'codex',
            fiveHour: { usedPercentage: 18, resetsAt: 1_900_000_000 },
          },
        },
      ],
    ]);

    expect(selectVisibleUsageVendors(map, [])).toEqual(['codex', 'antigravity']);
    expect(selectVisibleUsageVendors(map, ['claude'])).toEqual(['codex', 'claude', 'antigravity']);
  });
});
