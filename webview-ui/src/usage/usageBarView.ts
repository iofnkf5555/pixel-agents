/**
 * What the usage bars show, from the last `usageLimits` the server sent per vendor.
 * Pure (no DOM, no clock of its own), so the rules are Node-tested.
 *
 * Quota windows reset automatically once past `resetsAt`. Vendors without a public
 * quota API (e.g. Antigravity) render local rolling 5-hour / 7-day token activity
 * without fabricating quota percentages.
 */

import type { UsageWindow } from '../../../core/src/messages.js';
import {
  USAGE_BAR_LOW_FRACTION,
  USAGE_BAR_WARN_FRACTION,
  USAGE_HEART_MAX_BPM,
} from '../constants.js';
import type { UsageEntry } from './usageStore.js';

const CANONICAL_VENDOR_ORDER: readonly string[] = ['codex', 'claude', 'antigravity'];

/** How full a bar reads, which colour band it is in, and what it says. */
export interface UsageBarView {
  /** Share of the window LEFT, 0-1. Null when nothing is known. */
  remaining: number | null;
  level: 'ok' | 'warn' | 'low' | 'unknown';
  /** Shown beside the bar: "73%", or "--" when nothing is known. */
  percent: string;
  /** Shown on hover: "resets in 2h 14m", or why there is no time. */
  reset: string;
}

/** One bar's view of a window at `nowMs`. */
export function usageBarView(window: UsageWindow | undefined, nowMs: number): UsageBarView {
  if (!window) return { remaining: null, level: 'unknown', percent: '--', reset: 'no data yet' };
  const resetAtMs = window.resetsAt * 1000;
  if (resetAtMs <= nowMs) {
    return { remaining: 1, level: 'ok', percent: '100%', reset: 'reset since the last report' };
  }
  const remaining = Math.min(1, Math.max(0, (100 - window.usedPercentage) / 100));
  const level =
    remaining <= USAGE_BAR_LOW_FRACTION
      ? 'low'
      : remaining <= USAGE_BAR_WARN_FRACTION
        ? 'warn'
        : 'ok';
  return {
    remaining,
    level,
    percent: `${Math.round(remaining * 100)}%`,
    reset: `resets in ${formatDuration(resetAtMs - nowMs)}`,
  };
}

/** Seconds per heartbeat for a share left: the pace is proportional to it
 *  (a full plan beats at USAGE_HEART_MAX_BPM), and an empty or unknown plan
 *  has no beat at all (null). */
export function heartBeatPeriodSec(remaining: number | null): number | null {
  if (remaining === null || remaining <= 0) return null;
  return 60 / (USAGE_HEART_MAX_BPM * remaining);
}

/** "3d 4h", "2h 14m", "9m", "<1m" — the two largest units. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** "updated just now" / "updated 12m ago", or the hint for no report at all
 *  (`providerName`: whose sessions report it). */
export function freshnessLabel(
  updatedAtMs: number | undefined,
  nowMs: number,
  providerName: string,
): string {
  if (updatedAtMs === undefined) return `Updates once a ${providerName} session replies`;
  const age = nowMs - updatedAtMs;
  return age < 60_000 ? 'Updated just now' : `Updated ${formatDuration(age)} ago`;
}

/** Compact non-cached token count for metered local activity bars. */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
  if (tokens < 100_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens < 1_000_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${(tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
}

/**
 * Return strictly isolated vendor IDs to display in the top-left usage stack, ordered
 * canonically (`codex`, `claude`, `antigravity`, then others sorted). A vendor appears
 * only if it is active in the office or has usage/bridge data of its own.
 */
export function selectVisibleUsageVendors(
  entries: ReadonlyMap<string, UsageEntry>,
  activeProviderIds: readonly string[],
): string[] {
  const activeSet = new Set(activeProviderIds.filter(Boolean));
  const candidates = new Set<string>(activeSet);
  for (const id of entries.keys()) {
    candidates.add(id);
  }

  const visible: string[] = [];
  for (const id of candidates) {
    const entry = entries.get(id);
    const hasOwnData =
      activeSet.has(id) ||
      entry?.status?.installed === true ||
      entry?.limits?.fiveHour !== undefined ||
      entry?.limits?.sevenDay !== undefined ||
      (entry?.limits?.sevenDayActivity?.turns ?? 0) > 0 ||
      (entry?.limits?.fiveHourActivity?.turns ?? 0) > 0;
    if (hasOwnData) {
      visible.push(id);
    }
  }

  visible.sort((a, b) => {
    const ia = CANONICAL_VENDOR_ORDER.indexOf(a);
    const ib = CANONICAL_VENDOR_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.localeCompare(b);
  });

  return visible;
}
