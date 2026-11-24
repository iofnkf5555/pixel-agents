/**
 * Each vendor's plan usage, for the office's per-vendor usage bars: the last
 * report or local scan each vendor produced, kept in ~/.pixel-agents/usage-limits.json
 * under strict per-vendor keys so Codex, Claude Code, and Antigravity values never mix.
 *
 * Usage is the operator's account data, so it goes to privileged clients only:
 * the handshake sends it only to them and httpServer drops these broadcasts on
 * read-only sockets (PRIVILEGED_BROADCAST_TYPES).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  LocalWindowActivity,
  UsageBridgeStatus,
  UsageLimits,
  UsageWindow,
} from '../../core/src/messages.js';
import type { HookProvider, ReportedUsage } from '../../core/src/provider.js';
import {
  PIXEL_AGENTS_DIR,
  USAGE_LIMITS_FILE_NAME,
  USAGE_UNCHANGED_REFRESH_MS,
} from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { hookProviders } from './providers/index.js';
import { isRecord } from './serverConfig.js';

/** Per-vendor update payload (official quota windows and/or local rolling activity). */
export interface VendorUsageUpdate extends ReportedUsage {
  planType?: string;
  fiveHourActivity?: LocalWindowActivity;
  sevenDayActivity?: LocalWindowActivity;
}

/** A vendor's last stored usage entry plus internal timestamps. */
interface StoredUsage extends VendorUsageUpdate {
  updatedAt: number;
  quotaUpdatedAt?: number;
}

/** Wire message types only privileged sockets receive. */
export const PRIVILEGED_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'usageLimits',
  'usageBridgeStatus',
]);

const EXTERNAL_VENDOR_ORDER: readonly string[] = ['codex', 'antigravity'];

let cache: Record<string, StoredUsage> | null = null;

function usageFilePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, USAGE_LIMITS_FILE_NAME);
}

function isWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value)) return false;
  const { usedPercentage, resetsAt } = value;
  return (
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt)
  );
}

function isActivity(value: unknown): value is LocalWindowActivity {
  if (!isRecord(value)) return false;
  const { tokens, inputTokens, outputTokens, cacheReadTokens, turns } = value;
  if (
    typeof tokens !== 'number' ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof inputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    typeof turns !== 'number' ||
    !Number.isFinite(turns) ||
    turns < 0
  ) {
    return false;
  }
  if (
    cacheReadTokens !== undefined &&
    (typeof cacheReadTokens !== 'number' ||
      !Number.isFinite(cacheReadTokens) ||
      cacheReadTokens < 0)
  ) {
    return false;
  }
  return true;
}

/** Parse the file's content, keeping only well-formed per-vendor entries. */
function parseStored(raw: unknown): Record<string, StoredUsage> {
  const out: Record<string, StoredUsage> = {};
  if (!isRecord(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const {
      fiveHour,
      sevenDay,
      planType,
      fiveHourActivity,
      sevenDayActivity,
      updatedAt,
      quotaUpdatedAt,
    } = entry;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;
    out[id] = {
      updatedAt,
      ...(typeof quotaUpdatedAt === 'number' && Number.isFinite(quotaUpdatedAt)
        ? { quotaUpdatedAt }
        : {}),
      ...(typeof planType === 'string' && planType ? { planType } : {}),
      ...(isWindow(fiveHour) ? { fiveHour } : {}),
      ...(isWindow(sevenDay) ? { sevenDay } : {}),
      ...(isActivity(fiveHourActivity) ? { fiveHourActivity } : {}),
      ...(isActivity(sevenDayActivity) ? { sevenDayActivity } : {}),
    };
  }
  return out;
}

function stored(): Record<string, StoredUsage> {
  if (cache) return cache;
  try {
    cache = parseStored(JSON.parse(fs.readFileSync(usageFilePath(), 'utf-8')));
  } catch {
    cache = {}; // absent or unreadable: no usage known yet
  }
  return cache;
}

/**
 * Record usage data strictly under `providerId` (never merging across vendors).
 * Returns true when the persisted value changed or `USAGE_UNCHANGED_REFRESH_MS` elapsed.
 */
export function recordProviderUsageLimits(
  providerId: string,
  update: VendorUsageUpdate,
  now: number = Date.now(),
): boolean {
  if (!providerId) return false;
  const all = stored();
  const prev = all[providerId];

  const hasIncomingQuota = update.fiveHour !== undefined || update.sevenDay !== undefined;
  const acceptQuota =
    hasIncomingQuota && (prev?.quotaUpdatedAt === undefined || now >= prev.quotaUpdatedAt);

  if (
    hasIncomingQuota &&
    !acceptQuota &&
    update.fiveHourActivity === undefined &&
    update.sevenDayActivity === undefined
  ) {
    return false;
  }

  const nextFiveHour = acceptQuota ? (update.fiveHour ?? prev?.fiveHour) : prev?.fiveHour;
  const nextSevenDay = acceptQuota ? (update.sevenDay ?? prev?.sevenDay) : prev?.sevenDay;
  const nextPlanType = acceptQuota ? (update.planType ?? prev?.planType) : prev?.planType;
  const nextFiveHourActivity = update.fiveHourActivity ?? prev?.fiveHourActivity;
  const nextSevenDayActivity = update.sevenDayActivity ?? prev?.sevenDayActivity;
  const nextQuotaUpdatedAt = acceptQuota ? now : prev?.quotaUpdatedAt;

  const hasAnyField =
    nextFiveHour !== undefined ||
    nextSevenDay !== undefined ||
    nextFiveHourActivity !== undefined ||
    nextSevenDayActivity !== undefined;
  if (!hasAnyField) return false;

  const next: StoredUsage = {
    ...(nextFiveHour ? { fiveHour: nextFiveHour } : {}),
    ...(nextSevenDay ? { sevenDay: nextSevenDay } : {}),
    ...(nextPlanType ? { planType: nextPlanType } : {}),
    ...(nextFiveHourActivity ? { fiveHourActivity: nextFiveHourActivity } : {}),
    ...(nextSevenDayActivity ? { sevenDayActivity: nextSevenDayActivity } : {}),
    ...(nextQuotaUpdatedAt !== undefined ? { quotaUpdatedAt: nextQuotaUpdatedAt } : {}),
    updatedAt: now,
  };

  const {
    updatedAt: _prevAt,
    quotaUpdatedAt: _prevQuotaAt,
    ...prevComparable
  } = prev ?? {
    updatedAt: 0,
  };
  const { updatedAt: _nextAt, quotaUpdatedAt: _nextQuotaAt, ...nextComparable } = next;
  const moved = !isDeepStrictEqual(prevComparable, nextComparable);
  if (!moved && prev && now - prev.updatedAt < USAGE_UNCHANGED_REFRESH_MS) return false;

  all[providerId] = next;
  try {
    writeJsonAtomic(usageFilePath(), all);
  } catch (err) {
    // The office still gets the report; only a restart would lose it.
    console.error('[Pixel Agents] Could not save usage limits:', err);
  }
  return true;
}

/**
 * Take one report from a provider's usage bridge. Returns true when the office
 * should hear about it: the numbers moved, or the last word is old enough that
 * "updated N min ago" would mislead. A status line runs on every assistant
 * message, so identical reports in between are dropped, not written.
 *
 * A window missing from the report keeps its last value: Claude Code drops a
 * window once it resets, and the client already shows a window past its reset
 * time as full.
 */
export function recordUsageReport(
  provider: HookProvider,
  raw: unknown,
  now: number = Date.now(),
): boolean {
  const limits = provider.usageBridge?.normalizeReport(raw);
  if (!limits) return false;
  return recordProviderUsageLimits(provider.id, limits, now);
}

/** The `usageLimits` message for a vendor (no windows when none is known). */
export function usageLimitsMessage(providerId: string): UsageLimits {
  const entry = stored()[providerId];
  if (!entry) return { type: 'usageLimits', providerId };
  const { quotaUpdatedAt: _internalQuotaAt, ...wireFields } = entry;
  return { type: 'usageLimits', providerId, ...wireFields };
}

/** Map of every known vendor's latest `UsageLimits` keyed strictly by `providerId`. */
export function allUsageLimits(): Record<string, UsageLimits> {
  const out: Record<string, UsageLimits> = {};
  for (const provider of hookProviders) {
    if (provider.usageBridge) {
      out[provider.id] = usageLimitsMessage(provider.id);
    }
  }
  for (const id of Object.keys(stored())) {
    out[id] = usageLimitsMessage(id);
  }
  return out;
}

/** The `usageBridgeStatus` message: install state, plus why a change failed. */
export function usageBridgeStatusMessage(
  provider: HookProvider,
  error?: string,
): UsageBridgeStatus {
  return {
    type: 'usageBridgeStatus',
    providerId: provider.id,
    providerName: provider.displayName,
    installed: provider.usageBridge?.isInstalled() ?? false,
    disclosure: provider.usageBridge?.disclosure ?? '',
    ...(error ? { error } : {}),
  };
}

/** What a privileged office is told about usage when it connects: for each
 *  provider with a usage bridge, in registration order, its install state and
 *  then its last known usage, followed by any non-bridged vendors in storage
 *  (e.g. Codex, Antigravity). Both surfaces' handshakes send exactly this. */
export function usageSnapshotMessages(): Array<UsageBridgeStatus | UsageLimits> {
  const bridged = hookProviders.filter((provider) => provider.usageBridge);
  const bridgedIds = new Set(bridged.map((p) => p.id));
  const messages: Array<UsageBridgeStatus | UsageLimits> = bridged.flatMap((provider) => [
    usageBridgeStatusMessage(provider),
    usageLimitsMessage(provider.id),
  ]);

  const extraIds = Object.keys(stored())
    .filter((id) => !bridgedIds.has(id))
    .sort((a, b) => {
      const ia = EXTERNAL_VENDOR_ORDER.indexOf(a);
      const ib = EXTERNAL_VENDOR_ORDER.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return a.localeCompare(b);
    });

  for (const id of extraIds) {
    messages.push(usageLimitsMessage(id));
  }
  return messages;
}

/**
 * Carry out the Usage Bars toggle: install (the click IS the consent — the
 * disclosure was on screen) or restore the user's status line. Never rejects;
 * answers with the ACTUAL install state and, on failure, the reason, so the
 * checkbox never shows an intent the file doesn't hold.
 */
export async function applyUsageBridgeChoice(
  provider: HookProvider,
  packageRoot: string | undefined,
  enabled: boolean,
): Promise<UsageBridgeStatus> {
  const bridge = provider.usageBridge;
  if (!bridge) return usageBridgeStatusMessage(provider);
  try {
    if (enabled) {
      if (!packageRoot) throw new Error('This server cannot install the usage bridge.');
      await bridge.install(packageRoot);
    } else {
      await bridge.uninstall();
    }
    return usageBridgeStatusMessage(provider);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Pixel Agents] ${reason}`);
    return usageBridgeStatusMessage(provider, reason);
  }
}

/** Tests only: forget the cached file content. */
export function resetUsageLimitsCacheForTests(): void {
  cache = null;
}
