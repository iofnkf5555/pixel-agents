import * as fs from 'fs';
import * as path from 'path';

import type { LocalWindowActivity, UsageWindow } from '../../core/src/messages.js';
import { isRecord } from './serverConfig.js';

export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;
const CODEX_RATE_LIMIT_TAIL_BYTES = 256 * 1024;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export interface NormalizedCodexRateLimits {
  limitId: string | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  planType?: string;
}

export interface CodexRateLimitsScanResult {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  planType?: string;
  observedAtMs: number;
}

export interface VendorActivityScanResult {
  fiveHourActivity: LocalWindowActivity;
  sevenDayActivity: LocalWindowActivity;
}

interface ParsedCodexCandidate extends NormalizedCodexRateLimits {
  observedAtMs: number;
}

interface CachedTurn {
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface CachedFileTurns {
  mtimeMs: number;
  size: number;
  turns: CachedTurn[];
}

function emptyActivity(): LocalWindowActivity {
  return {
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
  };
}

function nonNegNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeResetEpochSec(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw > 1e12 ? raw / 1000 : raw;
}

function parseCodexWindow(
  rawWindow: unknown,
): { window: UsageWindow; windowMinutes?: number } | null {
  if (!isRecord(rawWindow)) return null;
  const usedRaw = rawWindow.used_percent;
  const resetsAt = normalizeResetEpochSec(rawWindow.resets_at);
  if (typeof usedRaw !== 'number' || !Number.isFinite(usedRaw) || resetsAt === undefined) {
    return null;
  }
  const usedPercentage = Math.min(100, Math.max(0, usedRaw));
  const windowMinutes =
    typeof rawWindow.window_minutes === 'number' && Number.isFinite(rawWindow.window_minutes)
      ? rawWindow.window_minutes
      : undefined;
  return {
    window: { usedPercentage, resetsAt },
    windowMinutes,
  };
}

/**
 * Parse a Codex `payload.rate_limits` block into normalized 5-hour & weekly windows.
 * Returns null if neither `primary` nor `secondary` holds valid quota data (such as
 * auxiliary `limit_id: "premium"` records with null windows).
 */
export function normalizeCodexRateLimits(rawRateLimits: unknown): NormalizedCodexRateLimits | null {
  if (!isRecord(rawRateLimits)) return null;

  const slots: Array<{
    slot: 'primary' | 'secondary';
    parsed: { window: UsageWindow; windowMinutes?: number };
  }> = [];
  const primary = parseCodexWindow(rawRateLimits.primary);
  if (primary) slots.push({ slot: 'primary', parsed: primary });
  const secondary = parseCodexWindow(rawRateLimits.secondary);
  if (secondary) slots.push({ slot: 'secondary', parsed: secondary });

  if (slots.length === 0) return null;

  let fiveHour: UsageWindow | undefined;
  let sevenDay: UsageWindow | undefined;

  for (const { slot, parsed } of slots) {
    const mins = parsed.windowMinutes;
    if (mins !== undefined) {
      if (mins <= 600 && !fiveHour) {
        fiveHour = parsed.window;
        continue;
      }
      if (mins >= 1440 && !sevenDay) {
        sevenDay = parsed.window;
        continue;
      }
    }
    if (slot === 'primary' && !fiveHour) {
      fiveHour = parsed.window;
    } else if (!sevenDay) {
      sevenDay = parsed.window;
    } else if (!fiveHour) {
      fiveHour = parsed.window;
    }
  }

  if (!fiveHour && !sevenDay) return null;

  const limitId =
    typeof rawRateLimits.limit_id === 'string' && rawRateLimits.limit_id.trim()
      ? rawRateLimits.limit_id.trim()
      : null;
  const planType =
    typeof rawRateLimits.plan_type === 'string' && rawRateLimits.plan_type.trim()
      ? rawRateLimits.plan_type.trim()
      : undefined;

  return {
    limitId,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(planType ? { planType } : {}),
  };
}

function readTailText(filePath: string, maxBytes: number, fileSize: number): string {
  const startOffset = Math.max(0, fileSize - maxBytes);
  const len = fileSize - startOffset;
  if (len <= 0) return '';
  let text = '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, startOffset);
    text = buf.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  if (startOffset > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text;
}

function collectCodexFilesWithStats(
  codexRoot: string,
  nowMs: number,
  maxAgeMs: number,
): Array<{ filePath: string; mtimeMs: number; size: number }> {
  const results: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl')
      ) {
        try {
          const stat = fs.statSync(fullPath);
          if (nowMs - stat.mtimeMs <= maxAgeMs && stat.size > 0) {
            results.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          }
        } catch {
          /* skip unreadable file */
        }
      }
    }
  };
  walk(codexRoot, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/**
 * Scan recent Codex rollout JSONL files (trailing 256 KB each) to recover the newest
 * official `rate_limits` report even before a specific session emits a new delta.
 * Prefers `limit_id === 'codex'` (or null) over secondary limit buckets.
 */
export function scanCodexRateLimitsFromFiles(
  codexRoot: string,
  nowMs: number,
  maxFiles = 25,
): CodexRateLimitsScanResult | null {
  const files = collectCodexFilesWithStats(codexRoot, nowMs, SEVEN_DAYS_MS).slice(0, maxFiles);
  if (files.length === 0) return null;

  let bestPrimary: ParsedCodexCandidate | null = null;
  let bestFallback: ParsedCodexCandidate | null = null;

  for (const file of files) {
    let tail: string;
    try {
      tail = readTailText(file.filePath, CODEX_RATE_LIMIT_TAIL_BYTES, file.size);
    } catch {
      continue;
    }
    if (!tail.includes('rate_limits')) continue;

    for (const rawLine of tail.split('\n')) {
      if (!rawLine.includes('rate_limits')) continue;
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(obj) || obj.type !== 'event_msg' || !isRecord(obj.payload)) continue;
      if (obj.payload.type !== 'token_count') continue;

      const normalized = normalizeCodexRateLimits(obj.payload.rate_limits);
      if (!normalized) continue;

      const parsedTs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      const observedAtMs = Number.isFinite(parsedTs) ? parsedTs : file.mtimeMs;
      const candidate: ParsedCodexCandidate = { ...normalized, observedAtMs };

      if (normalized.limitId === 'codex' || normalized.limitId === null) {
        if (!bestPrimary || observedAtMs >= bestPrimary.observedAtMs) {
          bestPrimary = candidate;
        }
      } else if (!bestFallback || observedAtMs >= bestFallback.observedAtMs) {
        bestFallback = candidate;
      }
    }
  }

  const chosen = bestPrimary ?? bestFallback;
  if (!chosen) return null;
  return {
    ...(chosen.fiveHour ? { fiveHour: chosen.fiveHour } : {}),
    ...(chosen.sevenDay ? { sevenDay: chosen.sevenDay } : {}),
    ...(chosen.planType ? { planType: chosen.planType } : {}),
    observedAtMs: chosen.observedAtMs,
  };
}

function listRecentClaudeJsonlFiles(
  claudeProjectsRoot: string,
  nowMs: number,
): Array<{ filePath: string; mtimeMs: number; size: number }> {
  const results: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          if (nowMs - stat.mtimeMs <= SEVEN_DAYS_MS && stat.size > 0) {
            results.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          }
        } catch {
          /* skip unreadable file */
        }
      }
    }
  };
  walk(claudeProjectsRoot, 0);
  return results;
}

function aggregateTurns(
  turnsList: Iterable<CachedTurn[]>,
  nowMs: number,
): VendorActivityScanResult {
  const fiveHourActivity = emptyActivity();
  const sevenDayActivity = emptyActivity();

  for (const turns of turnsList) {
    for (const turn of turns) {
      const age = nowMs - turn.tsMs;
      if (age < -CLOCK_SKEW_TOLERANCE_MS || age > SEVEN_DAYS_MS) continue;

      const nonCached = turn.inputTokens + turn.outputTokens;
      sevenDayActivity.tokens += nonCached;
      sevenDayActivity.inputTokens += turn.inputTokens;
      sevenDayActivity.outputTokens += turn.outputTokens;
      sevenDayActivity.cacheReadTokens =
        (sevenDayActivity.cacheReadTokens ?? 0) + turn.cacheReadTokens;
      sevenDayActivity.turns += 1;

      if (age <= FIVE_HOURS_MS) {
        fiveHourActivity.tokens += nonCached;
        fiveHourActivity.inputTokens += turn.inputTokens;
        fiveHourActivity.outputTokens += turn.outputTokens;
        fiveHourActivity.cacheReadTokens =
          (fiveHourActivity.cacheReadTokens ?? 0) + turn.cacheReadTokens;
        fiveHourActivity.turns += 1;
      }
    }
  }

  return { fiveHourActivity, sevenDayActivity };
}

function parseAntigravityTurns(filePath: string): CachedTurn[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const byStep = new Map<string | number, CachedTurn>();
  let seq = 0;
  for (const rawLine of content.split('\n')) {
    seq += 1;
    if (!rawLine.includes('PLANNER_RESPONSE')) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(obj) || obj.type !== 'PLANNER_RESPONSE') continue;
    const tsMs = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
    if (!Number.isFinite(tsMs)) continue;

    const key = typeof obj.step_index === 'number' ? obj.step_index : `line-${seq}`;
    byStep.set(key, {
      tsMs,
      inputTokens: nonNegNumber(obj.input_tokens),
      outputTokens: nonNegNumber(obj.output_tokens),
      cacheReadTokens: nonNegNumber(obj.cache_read_tokens),
    });
  }
  return [...byStep.values()];
}

function parseClaudeTurns(filePath: string): CachedTurn[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const byMessage = new Map<string, CachedTurn>();
  let seq = 0;
  for (const rawLine of content.split('\n')) {
    seq += 1;
    if (!rawLine.includes('"usage"')) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(obj) || obj.type !== 'assistant' || !isRecord(obj.message)) continue;
    const usage = obj.message.usage;
    if (!isRecord(usage)) continue;
    const tsMs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(tsMs)) continue;

    const key =
      typeof obj.message.id === 'string' && obj.message.id
        ? obj.message.id
        : typeof obj.requestId === 'string' && obj.requestId
          ? obj.requestId
          : typeof obj.uuid === 'string' && obj.uuid
            ? obj.uuid
            : `line-${seq}`;

    byMessage.set(key, {
      tsMs,
      inputTokens:
        nonNegNumber(usage.input_tokens) + nonNegNumber(usage.cache_creation_input_tokens),
      outputTokens: nonNegNumber(usage.output_tokens),
      cacheReadTokens: nonNegNumber(usage.cache_read_input_tokens),
    });
  }
  return [...byMessage.values()];
}

/**
 * Maintains per-file `(mtimeMs, size)` caches for local rolling 5-hour / 7-day token
 * activity across Antigravity and Claude Code JSONL transcripts. Each vendor is
 * cached and aggregated separately; values are never mixed across vendors.
 */
export class VendorUsageScanner {
  private readonly agyCache = new Map<string, CachedFileTurns>();
  private readonly claudeCache = new Map<string, CachedFileTurns>();

  scanAntigravityLocalUsage(antigravityRoot: string, nowMs: number): VendorActivityScanResult {
    const activeFiles = new Map<string, { mtimeMs: number; size: number }>();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(antigravityRoot, { withFileTypes: true });
    } catch {
      this.agyCache.clear();
      return { fiveHourActivity: emptyActivity(), sevenDayActivity: emptyActivity() };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = path.join(
        antigravityRoot,
        entry.name,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      );
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.isFile() && nowMs - stat.mtimeMs <= SEVEN_DAYS_MS && stat.size > 0) {
          activeFiles.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        /* ignore missing transcript */
      }
    }

    return this.collectFromCache(this.agyCache, activeFiles, parseAntigravityTurns, nowMs);
  }

  scanClaudeLocalUsage(claudeProjectsRoot: string, nowMs: number): VendorActivityScanResult {
    const activeFiles = new Map<string, { mtimeMs: number; size: number }>();
    for (const f of listRecentClaudeJsonlFiles(claudeProjectsRoot, nowMs)) {
      activeFiles.set(f.filePath, { mtimeMs: f.mtimeMs, size: f.size });
    }
    return this.collectFromCache(this.claudeCache, activeFiles, parseClaudeTurns, nowMs);
  }

  private collectFromCache(
    cache: Map<string, CachedFileTurns>,
    activeFiles: Map<string, { mtimeMs: number; size: number }>,
    parseFn: (filePath: string) => CachedTurn[],
    nowMs: number,
  ): VendorActivityScanResult {
    for (const cachedPath of cache.keys()) {
      if (!activeFiles.has(cachedPath)) {
        cache.delete(cachedPath);
      }
    }

    const activeTurnLists: CachedTurn[][] = [];
    for (const [filePath, meta] of activeFiles) {
      const prev = cache.get(filePath);
      if (prev && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) {
        activeTurnLists.push(prev.turns);
        continue;
      }
      const turns = parseFn(filePath);
      cache.set(filePath, { mtimeMs: meta.mtimeMs, size: meta.size, turns });
      activeTurnLists.push(turns);
    }

    return aggregateTurns(activeTurnLists, nowMs);
  }
}
