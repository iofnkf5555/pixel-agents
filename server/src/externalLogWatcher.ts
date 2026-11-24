import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { UsageWindow } from '../../core/src/messages.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, DISMISSED_COOLDOWN_MS } from './constants.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import type { AgentState } from './types.js';
import type { VendorUsageUpdate } from './usageLimits.js';
import {
  normalizeCodexRateLimits,
  type NormalizedCodexRateLimits,
  scanCodexRateLimitsFromFiles,
  VendorUsageScanner,
} from './vendorUsageScanner.js';

export type ExternalProviderId = 'codex' | 'antigravity';

export interface ArchiveBookEntry {
  id: string;
  providerId: 'codex' | 'antigravity' | 'claude';
  title: string;
  project: string;
  cwd?: string;
  filePath: string;
  updatedAtMs: number;
  isLive: boolean;
  isOpenLock: boolean;
  activity: 'working' | 'idle' | 'archived';
  agentId?: number;
  contextTokens?: number;
  maxContextTokens?: number;
  resumeCommand?: string;
}

export interface OpenLockSnapshot {
  codex: Set<string>;
  antigravity: Set<string>;
}

export interface ExternalSessionSnapshot {
  activity: 'working' | 'idle' | 'unknown';
  awaitingInput: boolean;
  toolName: string | null;
  toolStatus: string | null;
  cwd?: string;
  sessionId?: string;
  contextTokens: number;
  maxContextTokens: number;
  contextReported: boolean;
  openCalls: Set<string>;
  openToolCount: number;
  isSubagent?: boolean;
  parentThreadId?: string;
  subagentRole?: string;
  pendingSubagentRoles?: string[];
  spawnedChildren?: Map<string, string>;
  latestRateLimits?: {
    fiveHour?: UsageWindow;
    sevenDay?: UsageWindow;
    planType?: string;
    observedAtMs?: number;
    limitId: string | null;
  };
}

export interface ExternalLogWatcherOptions {
  store: AgentStateStore;
  enableCodex?: boolean;
  enableAntigravity?: boolean;
  codexRoot?: string;
  antigravityRoot?: string;
  codexLocksDir?: string;
  codexIndexFile?: string;
  antigravityPresenceDir?: string;
  claudeProjectsRoot?: string;
  detectOpenLocks?: () => OpenLockSnapshot;
  recentWindowMs?: number;
  expireAfterMs?: number;
  maxSessionsPerProvider?: number;
  pollIntervalMs?: number;
  now?: () => number;
  onVendorUsage?: (providerId: string, update: VendorUsageUpdate, observedAtMs: number) => void;
}

export const DEFAULT_RECENT_WINDOW_MS = 60 * 60_000;
export const DEFAULT_EXPIRE_AFTER_MS = 60 * 60_000;
export const SUBAGENT_FOLLOW_WINDOW_MS = 4 * 60 * 60_000;
export const DEFAULT_MAX_SESSIONS_PER_PROVIDER = 16;
export const DEFAULT_EXTERNAL_LOG_POLL_MS = 1000;
export const STALE_WORKING_MS = 120_000;
export const LIVE_STALE_WORKING_MS = 10 * 60_000;
const MAX_ATTACHED_SUBAGENTS_PER_PARENT = 4;
const LOCK_REFRESH_INTERVAL_MS = 5000;
const VENDOR_USAGE_REFRESH_MS = 30_000;
const LSOF_TIMEOUT_MS = 1500;
const TAIL_SEED_BYTES = 256 * 1024;
const HEAD_META_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const ANTIGRAVITY_DEFAULT_WINDOW = 1_000_000;

const CODEX_TOOL_ALIASES: Record<string, string> = {
  apply_patch: 'Edit',
  shell: 'Bash',
  exec: 'Bash',
  exec_command: 'Bash',
  local_shell: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  web_search: 'WebSearch',
  view_image: 'Read',
};

const ANTIGRAVITY_TOOL_ALIASES: Record<string, string> = {
  run_command: 'Bash',
  write_file: 'Write',
  edit_file: 'Edit',
  read_file: 'Read',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
  list_dir: 'Grep',
  find_by_name: 'Grep',
  grep_search: 'Grep',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function truncateText(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 1))}…`;
}

function safeRealpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function normalizeExternalToolName(
  providerId: ExternalProviderId,
  rawName: unknown,
): string {
  if (typeof rawName !== 'string' || rawName === '') return 'Tool';
  const aliases = providerId === 'codex' ? CODEX_TOOL_ALIASES : ANTIGRAVITY_TOOL_ALIASES;
  return aliases[rawName] ?? rawName;
}

export function formatExternalToolStatus(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return 'Reading files';
    case 'Edit':
    case 'Write':
      return 'Editing files';
    case 'Bash':
      return 'Running command';
    case 'WebSearch':
      return 'Searching web';
    case 'Grep':
      return 'Searching code';
    case 'Task':
      return 'Running subagent';
    case 'Thinking':
      return 'Thinking...';
    default:
      return `Using ${toolName}`;
  }
}

export function createExternalSnapshot(sessionId?: string): ExternalSessionSnapshot {
  return {
    activity: 'unknown',
    awaitingInput: false,
    toolName: null,
    toolStatus: null,
    sessionId,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    contextReported: false,
    openCalls: new Set(),
    openToolCount: 0,
  };
}

export function codexSessionIdFromFilename(filePath: string): string | undefined {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    filePath,
  );
  return m ? m[1] : undefined;
}

/**
 * Parse `lsof -Fn` output to extract UUIDs of lock files currently held open by live processes.
 */
export function parseLsofLockOutput(
  stdout: string,
  codexLocksDir: string,
  antigravityPresenceDir: string,
): OpenLockSnapshot {
  const codex = new Set<string>();
  const antigravity = new Set<string>();
  const resolvedCodex = codexLocksDir ? path.resolve(codexLocksDir) : '';
  const resolvedAgy = antigravityPresenceDir ? path.resolve(antigravityPresenceDir) : '';
  const realCodex = codexLocksDir ? safeRealpath(codexLocksDir) : '';
  const realAgy = antigravityPresenceDir ? safeRealpath(antigravityPresenceDir) : '';

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.startsWith('n')) continue;
    const filePath = rawLine.slice(1).trim();
    if (!filePath) continue;
    const base = path.basename(filePath);
    if (!base.endsWith('.lock') || base.startsWith('.')) continue;
    const id = base.slice(0, -'.lock'.length);
    if (!id) continue;
    const dir = path.dirname(filePath);
    if (resolvedCodex && (dir === resolvedCodex || dir === realCodex)) {
      codex.add(id);
    } else if (resolvedAgy && (dir === resolvedAgy || dir === realAgy)) {
      antigravity.add(id);
    }
  }
  return { codex, antigravity };
}

function buildLsofArgs(dirs: string[]): string[] {
  const args = ['-Fn'];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) {
        args.push('+d', d);
      }
    } catch {
      /* skip inaccessible dir */
    }
  }
  return args;
}

function probeOpenLocksSync(
  codexLocksDir: string,
  antigravityPresenceDir: string,
): OpenLockSnapshot {
  const args = buildLsofArgs([codexLocksDir, antigravityPresenceDir]);
  if (args.length <= 1) return { codex: new Set(), antigravity: new Set() };
  try {
    const out = execFileSync('lsof', args, {
      encoding: 'utf8',
      timeout: LSOF_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseLsofLockOutput(out, codexLocksDir, antigravityPresenceDir);
  } catch (err) {
    // lsof exits 1 when no files are open, or may include partial stdout in err.stdout
    const partial =
      err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string'
        ? err.stdout
        : '';
    if (partial) {
      return parseLsofLockOutput(partial, codexLocksDir, antigravityPresenceDir);
    }
    return { codex: new Set(), antigravity: new Set() };
  }
}

function probeOpenLocksAsync(
  codexLocksDir: string,
  antigravityPresenceDir: string,
): Promise<OpenLockSnapshot> {
  const args = buildLsofArgs([codexLocksDir, antigravityPresenceDir]);
  if (args.length <= 1) {
    return Promise.resolve({ codex: new Set(), antigravity: new Set() });
  }
  return new Promise((resolve) => {
    execFile(
      'lsof',
      args,
      { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (_err, stdout) => {
        if (stdout) {
          resolve(parseLsofLockOutput(stdout, codexLocksDir, antigravityPresenceDir));
        } else {
          resolve({ codex: new Set(), antigravity: new Set() });
        }
      },
    );
  });
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function formatSubagentOtherRole(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed || trimmed.toLowerCase() === 'other') return undefined;
  return trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function nonEmptyString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed ? trimmed : undefined;
}

const TOOL_ARG_DIR_KEYS = [
  'Cwd',
  'cwd',
  'WorkingDirectory',
  'workingDirectory',
  'DirectoryPath',
  'SearchDirectory',
  'SearchPath',
  'directory',
] as const;

const TOOL_ARG_FILE_KEYS = [
  'Path',
  'path',
  'FilePath',
  'filePath',
  'file_path',
  'TargetFile',
  'AbsolutePath',
] as const;

const PROJECT_ROOT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];

function normalizeCandidateWorkspaceDir(rawDir: string): string | undefined {
  let cleaned = rawDir.trim();
  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.slice('file://'.length);
  }
  if (!cleaned.startsWith('/')) return undefined;
  if (
    cleaned.includes('/.gemini/') ||
    cleaned === '/tmp' ||
    cleaned.startsWith('/tmp/') ||
    cleaned.startsWith('/private/tmp/')
  ) {
    return undefined;
  }
  const home = os.homedir();
  let cur = path.resolve(cleaned);
  for (let depth = 0; depth < 8; depth++) {
    try {
      for (const marker of PROJECT_ROOT_MARKERS) {
        if (fs.existsSync(path.join(cur, marker))) {
          return cur;
        }
      }
    } catch {
      /* ignore stat errors on synthetic paths */
    }
    const parent = path.dirname(cur);
    if (parent === cur || cur === home || cur === '/') break;
    cur = parent;
  }
  return cleaned.startsWith('/var/folders/') ? undefined : cleaned;
}

function unquoteArgString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  let trimmed = val.trim();
  if (!trimmed) return undefined;
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') {
        trimmed = parsed.trim();
      }
    } catch {
      trimmed = trimmed.slice(1, -1).trim();
    }
  }
  return trimmed ? trimmed : undefined;
}

/** Infer a workspace directory path from structured Antigravity tool arguments without reading file contents. */
export function inferCwdFromToolArgs(args: Record<string, unknown>): string | undefined {
  for (const key of TOOL_ARG_DIR_KEYS) {
    const raw = unquoteArgString(args[key]);
    if (raw) {
      const normalized = normalizeCandidateWorkspaceDir(raw);
      if (normalized) return normalized;
    }
  }
  for (const key of TOOL_ARG_FILE_KEYS) {
    const raw = unquoteArgString(args[key]);
    if (raw) {
      const normalized = normalizeCandidateWorkspaceDir(path.dirname(raw));
      if (normalized) return normalized;
    }
  }
  return undefined;
}

/**
 * Parse one Codex rollout JSONL record into the mutable session snapshot.
 * Privacy: reads only structural metadata (type, tool name, cwd, id, token counts, subagent role).
 * Prompts, model text, thinking, arguments, and outputs are never read or copied.
 */
export function applyCodexRecord(raw: unknown, state: ExternalSessionSnapshot): void {
  if (!isRecord(raw)) return;
  const payload = isRecord(raw.payload) ? raw.payload : {};

  switch (raw.type) {
    case 'session_meta': {
      if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd;
      if (typeof payload.id === 'string' && payload.id) state.sessionId = payload.id;
      if (typeof payload.context_window === 'number' && payload.context_window > 0) {
        state.maxContextTokens = Math.max(state.maxContextTokens, payload.context_window);
      }
      const sourceObj = isRecord(payload.source) ? payload.source : undefined;
      const subagentObj =
        sourceObj && isRecord(sourceObj.subagent) ? sourceObj.subagent : undefined;
      const threadSpawn =
        subagentObj && isRecord(subagentObj.thread_spawn) ? subagentObj.thread_spawn : undefined;

      const parentThreadId =
        nonEmptyString(payload.parent_thread_id) ?? nonEmptyString(threadSpawn?.parent_thread_id);
      if (parentThreadId) {
        state.parentThreadId = parentThreadId;
        state.isSubagent = true;
      } else if (sourceObj && 'subagent' in sourceObj) {
        state.isSubagent = true;
      }

      const role =
        nonEmptyString(threadSpawn?.agent_nickname) ??
        nonEmptyString(payload.agent_nickname) ??
        nonEmptyString(threadSpawn?.agent_role) ??
        nonEmptyString(payload.agent_role) ??
        formatSubagentOtherRole(subagentObj?.other);
      if (role) {
        state.subagentRole = role;
      }
      return;
    }
    case 'turn_context': {
      if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd;
      const win =
        typeof payload.model_context_window === 'number'
          ? payload.model_context_window
          : payload.context_window;
      if (typeof win === 'number' && win > 0) {
        state.maxContextTokens = Math.max(state.maxContextTokens, win);
      }
      return;
    }
    case 'event_msg': {
      const pType = payload.type;
      if (pType === 'task_started') {
        state.activity = 'working';
        state.awaitingInput = false;
        state.openCalls.clear();
        state.toolName = 'Thinking';
        state.toolStatus = formatExternalToolStatus('Thinking');
        if (typeof payload.model_context_window === 'number' && payload.model_context_window > 0) {
          state.maxContextTokens = Math.max(state.maxContextTokens, payload.model_context_window);
        }
      } else if (pType === 'task_complete' || pType === 'turn_aborted') {
        state.activity = 'idle';
        state.awaitingInput = true;
        state.openCalls.clear();
        state.toolName = null;
        state.toolStatus = null;
      } else if (pType === 'token_count') {
        const normalizedLimits: NormalizedCodexRateLimits | null = normalizeCodexRateLimits(
          payload.rate_limits,
        );
        if (normalizedLimits) {
          const prevLimitId = state.latestRateLimits?.limitId;
          const isPrimaryBucket =
            normalizedLimits.limitId === 'codex' || normalizedLimits.limitId === null;
          if (isPrimaryBucket || !state.latestRateLimits || prevLimitId !== 'codex') {
            const parsedTs = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
            state.latestRateLimits = {
              limitId: normalizedLimits.limitId,
              ...(normalizedLimits.fiveHour ? { fiveHour: normalizedLimits.fiveHour } : {}),
              ...(normalizedLimits.sevenDay ? { sevenDay: normalizedLimits.sevenDay } : {}),
              ...(normalizedLimits.planType ? { planType: normalizedLimits.planType } : {}),
              ...(Number.isFinite(parsedTs) ? { observedAtMs: parsedTs } : {}),
            };
          }
        }
        if (isRecord(payload.info)) {
          const info = payload.info;
          if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
            state.maxContextTokens = Math.max(state.maxContextTokens, info.model_context_window);
          }
          const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
          const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
          const tokens =
            typeof lastUsage?.total_tokens === 'number'
              ? lastUsage.total_tokens
              : typeof totalUsage?.input_tokens === 'number'
                ? totalUsage.input_tokens
                : undefined;
          if (typeof tokens === 'number' && tokens >= 0) {
            state.contextTokens = tokens;
            state.maxContextTokens = Math.max(state.maxContextTokens, tokens);
            state.contextReported = true;
          }
        }
      }
      return;
    }
    case 'response_item': {
      const pType = payload.type;
      if (pType === 'function_call' || pType === 'custom_tool_call') {
        state.activity = 'working';
        state.awaitingInput = false;
        if (typeof payload.call_id === 'string' && payload.call_id) {
          state.openCalls.add(payload.call_id);
        }
        const toolName = normalizeExternalToolName('codex', payload.name);
        state.toolName = toolName;
        state.toolStatus = formatExternalToolStatus(toolName);
      } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        if (typeof payload.call_id === 'string') {
          state.openCalls.delete(payload.call_id);
        }
        if (state.openCalls.size === 0 && state.activity === 'working') {
          state.toolName = 'Thinking';
          state.toolStatus = formatExternalToolStatus('Thinking');
        }
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Parse one Antigravity transcript.jsonl record into the mutable session snapshot.
 * Privacy: reads only step_index, source, type, status, tool_calls[].name, workspace dir paths from tool args, and token counts.
 */
export function applyAntigravityRecord(raw: unknown, state: ExternalSessionSnapshot): void {
  if (!isRecord(raw)) return;

  if (raw.step_index === 0 && raw.source === 'SYSTEM') {
    state.isSubagent = true;
  }

  if (raw.type === 'USER_INPUT' || raw.source === 'USER_EXPLICIT') {
    state.activity = 'working';
    state.awaitingInput = false;
    state.openToolCount = 0;
    state.toolName = 'Thinking';
    state.toolStatus = formatExternalToolStatus('Thinking');
    return;
  }

  if (raw.type === 'PLANNER_RESPONSE') {
    if (typeof raw.input_tokens === 'number' && raw.input_tokens >= 0) {
      const cacheRead =
        typeof raw.cache_read_tokens === 'number' && raw.cache_read_tokens > 0
          ? raw.cache_read_tokens
          : 0;
      const used = raw.input_tokens + cacheRead;
      state.contextTokens = used;
      state.maxContextTokens = Math.max(state.maxContextTokens, ANTIGRAVITY_DEFAULT_WINDOW, used);
      state.contextReported = true;
    }

    const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const rawCall of calls) {
      if (!isRecord(rawCall) || !isRecord(rawCall.args)) continue;
      if (!state.cwd) {
        const inferredCwd = inferCwdFromToolArgs(rawCall.args);
        if (inferredCwd) {
          state.cwd = inferredCwd;
        }
      }
      if (rawCall.name === 'invoke_subagent') {
        const role = unquoteArgString(rawCall.args.Role) ?? unquoteArgString(rawCall.args.TypeName);
        if (role) {
          (state.pendingSubagentRoles ??= []).push(role);
        }
      } else if (rawCall.name === 'swarm') {
        const action = unquoteArgString(rawCall.args.action);
        if (action === 'add') {
          const role = unquoteArgString(rawCall.args.name) ?? 'Swarm Worker';
          (state.pendingSubagentRoles ??= []).push(role);
        }
      }
    }
    if (calls.length > 0) {
      state.activity = 'working';
      state.awaitingInput = false;
      state.openToolCount = calls.length;
      const firstCall = isRecord(calls[0]) ? calls[0] : {};
      const toolName = normalizeExternalToolName('antigravity', firstCall.name);
      state.toolName = toolName;
      state.toolStatus = formatExternalToolStatus(toolName);
    } else if (raw.status === 'DONE') {
      state.activity = 'idle';
      state.awaitingInput = true;
      state.openToolCount = 0;
      state.toolName = null;
      state.toolStatus = null;
    }
    return;
  }

  if (raw.type === 'GENERIC') {
    if (typeof raw.content === 'string') {
      if (!state.cwd) {
        const wsMatch = /"workspaceUris"\s*:\s*\[\s*"([^"]+)"/i.exec(raw.content);
        if (wsMatch?.[1]) {
          const inferred = normalizeCandidateWorkspaceDir(wsMatch[1]);
          if (inferred) state.cwd = inferred;
        }
      }

      let spawnedUuid: string | undefined;
      if (raw.content.includes('Created the following subagent:')) {
        const convMatch =
          /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(
            raw.content,
          ) ?? UUID_RE.exec(raw.content);
        spawnedUuid = convMatch?.[1] ?? convMatch?.[0];
      } else if (state.pendingSubagentRoles?.length && /^Subagent\b/i.test(raw.content.trim())) {
        const legacyMatch = UUID_RE.exec(raw.content);
        if (legacyMatch) spawnedUuid = legacyMatch[0];
      }

      if (spawnedUuid) {
        const shiftedRole = state.pendingSubagentRoles?.shift();
        const existingRole = state.spawnedChildren?.get(spawnedUuid);
        const resolvedRole = shiftedRole || existingRole || 'Subagent';
        (state.spawnedChildren ??= new Map()).set(spawnedUuid, resolvedRole);
      }
    }
    if (raw.source === 'MODEL') {
      if (raw.status === 'RUNNING') {
        state.activity = 'working';
        state.awaitingInput = false;
        if (!state.toolName) {
          state.toolName = 'Bash';
          state.toolStatus = formatExternalToolStatus('Bash');
        }
      } else if (raw.status === 'DONE') {
        state.openToolCount = Math.max(0, state.openToolCount - 1);
        if (state.openToolCount === 0 && state.activity === 'working') {
          state.toolName = 'Thinking';
          state.toolStatus = formatExternalToolStatus('Thinking');
        }
      }
    }
  }
}

function readRangeSync(filePath: string, offset: number, length: number): string {
  if (length <= 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, offset);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function applyRecord(
  providerId: ExternalProviderId,
  raw: unknown,
  state: ExternalSessionSnapshot,
): void {
  if (providerId === 'codex') applyCodexRecord(raw, state);
  else applyAntigravityRecord(raw, state);
}

function scanAntigravitySeedMetadata(
  filePath: string,
  fileSize: number,
  state: ExternalSessionSnapshot,
): void {
  if (fileSize <= 0) return;
  const metaSnap = createExternalSnapshot(state.sessionId);
  metaSnap.cwd = state.cwd;
  const chunkSize = 256 * 1024;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(chunkSize, fileSize));
    let offset = 0;
    let pending = '';
    while (offset < fileSize) {
      const toRead = Math.min(chunkSize, fileSize - offset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const combined = pending + buf.toString('utf8', 0, bytesRead);
      const lines = combined.split('\n');
      pending = offset < fileSize ? (lines.pop() ?? '') : '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const mightBeSubagent =
          line.includes('"invoke_subagent"') ||
          line.includes('"swarm"') ||
          line.includes('Created the following subagent:') ||
          line.includes('Subagent ');
        const mightHaveCwd =
          !metaSnap.cwd &&
          (line.includes('workspaceUris') ||
            line.includes('"Path"') ||
            line.includes('"Cwd"') ||
            line.includes('"DirectoryPath"') ||
            line.includes('"SearchDirectory"') ||
            line.includes('"TargetFile"'));
        if (!mightBeSubagent && !mightHaveCwd) continue;
        try {
          applyAntigravityRecord(JSON.parse(line), metaSnap);
        } catch {
          /* ignore malformed metadata row */
        }
      }
    }
    if (pending.trim()) {
      try {
        applyAntigravityRecord(JSON.parse(pending.trim()), metaSnap);
      } catch {
        /* ignore trailing partial row */
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!state.cwd && metaSnap.cwd) {
    state.cwd = metaSnap.cwd;
  }
  if (metaSnap.spawnedChildren && metaSnap.spawnedChildren.size > 0) {
    state.spawnedChildren = new Map(metaSnap.spawnedChildren);
  }
}

/**
 * Seed a newly-discovered log file by reading its metadata header and trailing chunk
 * so an already-running or recently-idle session appears immediately on connect.
 */
export function seedFromFile(
  filePath: string,
  providerId: ExternalProviderId,
  stat: Pick<fs.Stats, 'size' | 'mtimeMs'>,
  nowMs: number,
  defaultSessionId: string,
): { state: ExternalSessionSnapshot; offset: number } {
  const state = createExternalSnapshot(defaultSessionId);

  // Read line 0 for metadata (Codex session_meta / Antigravity subagent flag)
  try {
    const headLen = Math.min(stat.size, providerId === 'codex' ? HEAD_META_BYTES : 4096);
    if (headLen > 0) {
      const head = readRangeSync(filePath, 0, headLen);
      const firstLine = head.split('\n')[0]?.trim();
      if (firstLine) {
        try {
          applyRecord(providerId, JSON.parse(firstLine), state);
        } catch {
          /* ignore unparseable first line */
        }
      }
    }
  } catch {
    /* ignore head read error */
  }

  if (providerId === 'antigravity') {
    try {
      scanAntigravitySeedMetadata(filePath, stat.size, state);
      state.pendingSubagentRoles = undefined;
    } catch {
      /* ignore metadata scan error */
    }
  }

  // Read up to trailing 256 KB to reconstruct current state immediately
  const startOffset = Math.max(0, stat.size - TAIL_SEED_BYTES);
  if (stat.size > startOffset) {
    try {
      let text = readRangeSync(filePath, startOffset, stat.size - startOffset);
      if (startOffset > 0) {
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          applyRecord(providerId, JSON.parse(trimmed), state);
        } catch {
          /* ignore partial or malformed line */
        }
      }
    } catch {
      /* ignore tail read error */
    }
  }

  // Safety guard: a stale log stuck mid-turn should display as idle, not forever working
  if (state.activity === 'working' && nowMs - stat.mtimeMs > STALE_WORKING_MS) {
    state.activity = 'idle';
    state.awaitingInput = true;
    state.toolName = null;
    state.toolStatus = null;
  } else if (state.activity === 'unknown') {
    state.activity = 'idle';
    state.awaitingInput = true;
  }

  return { state, offset: stat.size };
}

/**
 * Recursively collect all Codex rollout JSONL files across all dates (supports resumed
 * sessions originally created days or weeks ago).
 */
export function listCodexFiles(root: string): string[] {
  const out: string[] = [];
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
        out.push(fullPath);
      }
    }
  };
  walk(root, 0);
  return out;
}

function listAntigravityFiles(root: string): string[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of dirs) {
    const candidate = path.join(root, id, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      if (fs.existsSync(candidate)) out.push(candidate);
    } catch {
      /* ignore inaccessible entry */
    }
  }
  return out;
}

function listClaudeFiles(root: string): Array<{ filePath: string; project: string }> {
  let projDirs: fs.Dirent[];
  try {
    projDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ filePath: string; project: string }> = [];
  for (const dirEntry of projDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirName = dirEntry.name;
    const parts = dirName.replace(/^-+/, '').split('-');
    const project = parts[parts.length - 1] || dirName;
    const dirPath = path.join(root, dirName);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        out.push({ filePath: path.join(dirPath, f.name), project });
      }
    }
  }
  return out;
}

function defaultSessionIdFor(filePath: string, providerId: ExternalProviderId): string {
  if (providerId === 'codex') {
    return codexSessionIdFromFilename(filePath) ?? path.basename(filePath, '.jsonl');
  }
  // .../<id>/.system_generated/logs/transcript.jsonl
  return path.basename(path.dirname(path.dirname(path.dirname(filePath))));
}

interface TrackedFile {
  agentId: number;
  filePath: string;
  providerId: ExternalProviderId;
  sessionId: string;
  offset: number;
  pending: string;
  lastWriteMs: number;
  state: ExternalSessionSnapshot;
  lastEmittedActivity: 'working' | 'idle' | 'unknown';
  lastEmittedToolName: string | null;
  lastEmittedToolId: string | null;
  lastEmittedContextTokens: number;
  lastEmittedMaxContextTokens: number;
}

interface DismissRecord {
  at: number;
  size: number;
}

interface CachedFileMeta {
  mtimeMs: number;
  size: number;
  sessionId?: string;
  cwd?: string;
  isSubagent?: boolean;
  parentThreadId?: string;
  subagentRole?: string;
}

interface CodexIndexEntry {
  title: string;
  updatedAtMs?: number;
}

/**
 * Watches local Codex and Antigravity JSONL logs directly in strictly read-only mode
 * and populates AgentStateStore so active, open-locked (including resumed), and recently
 * idle sessions appear immediately. Also indexes historical sessions for the Bookshelf archive.
 */
export class ExternalLogWatcher {
  private readonly store: AgentStateStore;
  private readonly enableCodex: boolean;
  private readonly enableAntigravity: boolean;
  private readonly codexRoot: string;
  private readonly antigravityRoot: string;
  private readonly codexLocksDir: string;
  private readonly codexIndexFile: string;
  private readonly antigravityPresenceDir: string;
  private readonly claudeProjectsRoot: string;
  private readonly customDetectOpenLocks?: () => OpenLockSnapshot;
  private readonly recentWindowMs: number;
  private readonly expireAfterMs: number;
  private readonly maxSessionsPerProvider: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly onVendorUsage?: (
    providerId: string,
    update: VendorUsageUpdate,
    observedAtMs: number,
  ) => void;

  private readonly trackedByFile = new Map<string, TrackedFile>();
  private readonly agentToFile = new Map<number, string>();
  private readonly dismissed = new Map<string, DismissRecord>();
  private readonly pinnedFiles = new Set<string>();
  private readonly metaCache = new Map<string, CachedFileMeta>();
  private readonly vendorUsageScanner = new VendorUsageScanner();
  private codexIndexCache: {
    mtimeMs: number;
    size: number;
    entries: Map<string, CodexIndexEntry>;
  } | null = null;
  private openLocks: OpenLockSnapshot = { codex: new Set(), antigravity: new Set() };
  private lockRefreshInFlight = false;
  private lastLockRefreshMs = 0;
  private lastCodexRateLimitAtMs = 0;
  private lastVendorUsageRefreshMs = 0;
  private reportedAgyActivity = false;
  private reportedClaudeActivity = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toolSeq = 0;

  private readonly onAgentRemoved = (id: number): void => {
    const filePath = this.agentToFile.get(id);
    if (!filePath) return;
    this.agentToFile.delete(id);
    const rec = this.trackedByFile.get(filePath);
    this.trackedByFile.delete(filePath);
    this.pinnedFiles.delete(filePath);
    if (rec) {
      this.dismissed.set(filePath, { at: this.now(), size: rec.offset });
      this.reconcileExternalTeams();
    }
  };

  constructor(options: ExternalLogWatcherOptions) {
    this.store = options.store;
    this.enableCodex = options.enableCodex ?? true;
    this.enableAntigravity = options.enableAntigravity ?? true;
    this.codexRoot = options.codexRoot ?? path.join(os.homedir(), '.codex', 'sessions');
    this.antigravityRoot =
      options.antigravityRoot ?? path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.codexLocksDir =
      options.codexLocksDir ?? path.join(os.homedir(), '.codex', 'thread-writer-locks');
    this.codexIndexFile =
      options.codexIndexFile ?? path.join(os.homedir(), '.codex', 'session_index.jsonl');
    this.antigravityPresenceDir =
      options.antigravityPresenceDir ??
      path.join(os.homedir(), '.gemini', 'antigravity', 'presence');
    this.claudeProjectsRoot =
      options.claudeProjectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
    this.customDetectOpenLocks = options.detectOpenLocks;
    this.recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
    this.expireAfterMs = options.expireAfterMs ?? DEFAULT_EXPIRE_AFTER_MS;
    this.maxSessionsPerProvider =
      options.maxSessionsPerProvider ?? DEFAULT_MAX_SESSIONS_PER_PROVIDER;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_EXTERNAL_LOG_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    this.onVendorUsage = options.onVendorUsage;
    this.store.on('agentRemoved', this.onAgentRemoved);
  }

  start(): void {
    this.refreshOpenLocksSync();
    this.pollOnce();
    this.refreshVendorUsage(this.now(), true);
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        try {
          this.pollOnce();
        } catch (err) {
          console.error('[Pixel Agents] ExternalLogWatcher poll error:', err);
        }
      }, this.pollIntervalMs);
    }
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.trackedByFile.clear();
    this.agentToFile.clear();
    this.pinnedFiles.clear();
  }

  trackedCount(): number {
    return this.trackedByFile.size;
  }

  openLockCount(): number {
    return this.openLocks.codex.size + this.openLocks.antigravity.size;
  }

  isSessionOpenLocked(providerId: ExternalProviderId, sessionId: string): boolean {
    return this.isSessionLocked(providerId, sessionId);
  }

  private refreshOpenLocksSync(): void {
    if (this.customDetectOpenLocks) {
      this.openLocks = this.customDetectOpenLocks();
    } else {
      this.openLocks = probeOpenLocksSync(this.codexLocksDir, this.antigravityPresenceDir);
    }
    this.lastLockRefreshMs = this.now();
  }

  private maybeRefreshOpenLocksAsync(nowMs: number): void {
    if (this.customDetectOpenLocks) {
      this.openLocks = this.customDetectOpenLocks();
      this.lastLockRefreshMs = nowMs;
      return;
    }
    if (this.lockRefreshInFlight || nowMs - this.lastLockRefreshMs < LOCK_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lockRefreshInFlight = true;
    this.lastLockRefreshMs = nowMs;
    void probeOpenLocksAsync(this.codexLocksDir, this.antigravityPresenceDir)
      .then((snap) => {
        this.openLocks = snap;
      })
      .finally(() => {
        this.lockRefreshInFlight = false;
      });
  }

  private isSessionLocked(providerId: ExternalProviderId, sessionId: string): boolean {
    return providerId === 'codex'
      ? this.openLocks.codex.has(sessionId)
      : this.openLocks.antigravity.has(sessionId);
  }

  private nextToolId(): string {
    this.toolSeq += 1;
    return `ext-${this.toolSeq}`;
  }

  private readCodexIndex(): Map<string, CodexIndexEntry> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.codexIndexFile);
    } catch {
      return new Map();
    }
    if (
      this.codexIndexCache &&
      this.codexIndexCache.mtimeMs === stat.mtimeMs &&
      this.codexIndexCache.size === stat.size
    ) {
      return this.codexIndexCache.entries;
    }
    const entries = new Map<string, CodexIndexEntry>();
    try {
      const content = fs.readFileSync(this.codexIndexFile, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as unknown;
          if (!isRecord(obj) || typeof obj.id !== 'string' || typeof obj.thread_name !== 'string') {
            continue;
          }
          const updatedAtMs =
            typeof obj.updated_at === 'string' ? Date.parse(obj.updated_at) : undefined;
          entries.set(obj.id, {
            title: obj.thread_name,
            updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
          });
        } catch {
          /* skip malformed index row */
        }
      }
    } catch {
      /* ignore unreadable index */
    }
    this.codexIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
    return entries;
  }

  private readCachedMeta(
    filePath: string,
    providerId: ExternalProviderId,
    stat: Pick<fs.Stats, 'mtimeMs' | 'size'>,
  ): CachedFileMeta {
    const cached = this.metaCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }
    const meta: CachedFileMeta = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: defaultSessionIdFor(filePath, providerId),
    };
    try {
      const headLen = Math.min(stat.size, providerId === 'codex' ? HEAD_META_BYTES : 4096);
      if (headLen > 0) {
        const firstLine = readRangeSync(filePath, 0, headLen).split('\n')[0]?.trim();
        if (firstLine) {
          const obj = JSON.parse(firstLine) as unknown;
          const snap = createExternalSnapshot(meta.sessionId);
          applyRecord(providerId, obj, snap);
          meta.sessionId = snap.sessionId ?? meta.sessionId;
          meta.cwd = snap.cwd;
          meta.isSubagent = snap.isSubagent;
          meta.parentThreadId = snap.parentThreadId;
          meta.subagentRole = snap.subagentRole;
        }
      }
    } catch {
      /* ignore unparseable header */
    }
    this.metaCache.set(filePath, meta);
    return meta;
  }

  pollOnce(): void {
    const nowMs = this.now();
    this.maybeRefreshOpenLocksAsync(nowMs);
    const liveAttachedSubagents = this.collectLiveParentSubagentIds(nowMs);

    // 1. Poll existing tracked files (never expire open-locked, pinned, or live-parent subagent sessions)
    for (const [filePath, rec] of [...this.trackedByFile.entries()]) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        this.closeTracked(filePath, rec);
        continue;
      }

      if (stat.size < rec.offset) {
        rec.offset = 0;
        rec.pending = '';
      }

      if (stat.size > rec.offset) {
        rec.lastWriteMs = Math.max(nowMs, stat.mtimeMs);
        this.readIncrement(rec, stat.size);
      } else if (
        !this.isSessionLocked(rec.providerId, rec.sessionId) &&
        !this.pinnedFiles.has(filePath) &&
        !(rec.providerId === 'antigravity' && liveAttachedSubagents.has(rec.sessionId)) &&
        nowMs - rec.lastWriteMs > this.expireAfterMs
      ) {
        this.closeTracked(filePath, rec);
        continue;
      } else if (
        rec.lastEmittedActivity === 'working' &&
        nowMs - rec.lastWriteMs > LIVE_STALE_WORKING_MS
      ) {
        rec.state.activity = 'idle';
        rec.state.awaitingInput = true;
        rec.state.toolName = null;
        rec.state.toolStatus = null;
        this.syncAgentState(rec);
      }
    }

    // 2. Discover active/recent/open-locked candidates for each enabled provider
    if (this.enableCodex) {
      this.discoverProvider('codex', listCodexFiles(this.codexRoot), nowMs);
    }
    if (this.enableAntigravity) {
      const agyFiles = listAntigravityFiles(this.antigravityRoot);
      this.discoverProvider('antigravity', agyFiles, nowMs, liveAttachedSubagents);
      const refreshedAttached = this.collectLiveParentSubagentIds(nowMs);
      if (refreshedAttached.size > 0) {
        this.discoverProvider('antigravity', agyFiles, nowMs, refreshedAttached);
      }
    }

    this.reconcileExternalTeams();
    this.refreshVendorUsage(nowMs, false);
  }

  private collectLiveParentSubagentIds(nowMs: number): Set<string> {
    const attached = new Set<string>();
    if (!this.enableAntigravity || !this.antigravityRoot) return attached;

    for (const rec of this.trackedByFile.values()) {
      if (rec.providerId !== 'antigravity' || rec.state.isSubagent) continue;
      const parentLive =
        this.isSessionLocked('antigravity', rec.sessionId) ||
        nowMs - rec.lastWriteMs <= this.recentWindowMs;
      if (!parentLive || !rec.state.spawnedChildren || rec.state.spawnedChildren.size === 0) {
        continue;
      }

      const recentChildren: Array<{ childId: string; mtimeMs: number }> = [];
      for (const childId of rec.state.spawnedChildren.keys()) {
        const childLog = path.join(
          this.antigravityRoot,
          childId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        try {
          const st = fs.statSync(childLog);
          if (nowMs - st.mtimeMs <= SUBAGENT_FOLLOW_WINDOW_MS) {
            recentChildren.push({ childId, mtimeMs: st.mtimeMs });
          }
        } catch {
          /* ignore missing child log */
        }
      }

      recentChildren.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const child of recentChildren.slice(0, MAX_ATTACHED_SUBAGENTS_PER_PARENT)) {
        attached.add(child.childId);
      }
    }

    return attached;
  }

  private discoverProvider(
    providerId: ExternalProviderId,
    candidates: string[],
    nowMs: number,
    attachedSubagentIds?: ReadonlySet<string>,
  ): void {
    const eligible: Array<{
      filePath: string;
      stat: fs.Stats;
      lockedOrPinned: boolean;
    }> = [];

    for (const filePath of candidates) {
      if (this.trackedByFile.has(filePath)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const rawId = defaultSessionIdFor(filePath, providerId);
      const locked = this.isSessionLocked(providerId, rawId);
      const pinned = this.pinnedFiles.has(filePath);
      const attached = attachedSubagentIds?.has(rawId) ?? false;
      const isRecent = nowMs - stat.mtimeMs <= this.recentWindowMs;
      if (!locked && !pinned && !attached && !isRecent) continue;

      const dis = this.dismissed.get(filePath);
      if (dis) {
        const cooledDown = nowMs - dis.at >= DISMISSED_COOLDOWN_MS;
        const grewAfterDismiss = stat.size > dis.size;
        if (!pinned && !cooledDown && !grewAfterDismiss) continue;
        this.dismissed.delete(filePath);
      }
      eligible.push({ filePath, stat, lockedOrPinned: locked || pinned || attached });
    }

    eligible.sort((a, b) => {
      if (a.lockedOrPinned !== b.lockedOrPinned) {
        return a.lockedOrPinned ? -1 : 1;
      }
      return b.stat.mtimeMs - a.stat.mtimeMs;
    });

    let alreadyTracked = 0;
    for (const rec of this.trackedByFile.values()) {
      if (rec.providerId === providerId) alreadyTracked += 1;
    }
    const availableSlots = Math.max(0, this.maxSessionsPerProvider - alreadyTracked);
    for (const item of eligible.slice(0, availableSlots)) {
      this.adoptFile(item.filePath, providerId, item.stat, nowMs);
    }
  }

  private formatDirectoryLabel(
    providerId: ExternalProviderId,
    sessionId: string,
    cwd: string | undefined,
    isSubagent: boolean | undefined,
    codexIndex: Map<string, CodexIndexEntry>,
  ): string {
    const shortId = sessionId.slice(0, 8);
    const cwdBase = cwd ? path.basename(cwd) : '';
    if (providerId === 'codex') {
      const threadName = codexIndex.get(sessionId)?.title;
      if (cwdBase && threadName) {
        return `${cwdBase} · ${truncateText(threadName, 28)}`;
      }
      if (threadName) return truncateText(threadName, 32);
      return cwdBase || shortId;
    }
    const tag = isSubagent ? `Sub ${shortId}` : `Chat ${shortId}`;
    return cwdBase ? `${cwdBase} · ${tag}` : tag;
  }

  private adoptFile(
    filePath: string,
    providerId: ExternalProviderId,
    stat: Pick<fs.Stats, 'size' | 'mtimeMs'>,
    nowMs: number,
  ): number {
    const rawId = defaultSessionIdFor(filePath, providerId);
    const { state, offset } = seedFromFile(filePath, providerId, stat, nowMs, rawId);
    const sessionId = state.sessionId ?? rawId;
    const sessionKey = `${providerId}-${sessionId}`;
    const codexIndex = providerId === 'codex' ? this.readCodexIndex() : new Map();
    const directoryName = this.formatDirectoryLabel(
      providerId,
      sessionId,
      state.cwd,
      state.isSubagent,
      codexIndex,
    );

    const id = this.store.nextAgentId.current++;
    const agent: AgentState = createAgentState({
      id,
      sessionId: sessionKey,
      isExternal: true,
      projectDir: state.cwd ?? '',
      jsonlFile: '',
      hookDelivered: true,
      hooksOnly: true,
      providerId,
      directoryName,
      lastDataAt: stat.mtimeMs,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      contextReported: state.contextReported,
      isAgentSpawned: state.isSubagent === true ? true : undefined,
      externalLogFile: filePath,
    });
    assignPaletteIfNeeded(agent, this.store);

    let initialToolId: string | null = null;
    if (state.activity === 'working') {
      const toolName = state.toolName ?? 'Thinking';
      const toolStatus = state.toolStatus ?? formatExternalToolStatus(toolName);
      initialToolId = this.nextToolId();
      agent.isWaiting = false;
      agent.awaitingInput = false;
      agent.turnActive = true;
      agent.activeToolIds.add(initialToolId);
      agent.activeToolNames.set(initialToolId, toolName);
      agent.activeToolStatuses.set(initialToolId, toolStatus);
      state.toolName = toolName;
      state.toolStatus = toolStatus;
    } else {
      agent.isWaiting = true;
      agent.awaitingInput = state.awaitingInput;
      agent.turnActive = false;
    }

    const rec: TrackedFile = {
      agentId: id,
      filePath,
      providerId,
      sessionId,
      offset,
      pending: '',
      lastWriteMs: stat.mtimeMs,
      state,
      lastEmittedActivity: state.activity,
      lastEmittedToolName: state.activity === 'working' ? state.toolName : null,
      lastEmittedToolId: initialToolId,
      lastEmittedContextTokens: state.contextTokens,
      lastEmittedMaxContextTokens: state.maxContextTokens,
    };

    this.trackedByFile.set(filePath, rec);
    this.agentToFile.set(id, filePath);
    this.store.set(id, agent);

    if (state.activity === 'working' && initialToolId) {
      this.store.broadcast({
        type: 'agentToolStart',
        id,
        toolId: initialToolId,
        status: state.toolStatus,
        toolName: state.toolName,
      });
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'active',
      });
    } else {
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: state.awaitingInput || undefined,
      });
    }

    if (state.contextReported) {
      this.store.broadcast({
        type: 'agentContextUsage',
        id,
        contextTokens: state.contextTokens,
        maxContextTokens: state.maxContextTokens,
      });
    }

    this.emitCodexRateLimits(rec, stat.mtimeMs);
    this.reconcileExternalTeams();

    return id;
  }

  /**
   * Build sorted historical + live book entries across Codex, Antigravity, and Claude Code
   * for the Pixel Bookshelf archive UI. Strictly read-only, zero prompt text exposed.
   */
  getArchiveEntries(limit = 80): ArchiveBookEntry[] {
    const books: ArchiveBookEntry[] = [];
    const codexIndex = this.readCodexIndex();

    const liveClaudeBySession = new Map<string, AgentState>();
    for (const agent of this.store.values()) {
      const p = agent.providerId ?? 'claude';
      if (p === 'claude' && agent.sessionId) {
        liveClaudeBySession.set(agent.sessionId, agent);
      }
    }

    if (this.enableCodex) {
      for (const filePath of listCodexFiles(this.codexRoot)) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        const meta = this.readCachedMeta(filePath, 'codex', stat);
        const id = meta.sessionId ?? defaultSessionIdFor(filePath, 'codex');
        const tracked = this.trackedByFile.get(filePath);
        const idx = codexIndex.get(id);
        const project = meta.cwd ? path.basename(meta.cwd) : 'Codex';
        const title = idx?.title ? truncateText(idx.title, 48) : `${project} · ${id.slice(0, 8)}`;
        const isOpenLock = this.openLocks.codex.has(id);
        books.push({
          id,
          providerId: 'codex',
          title,
          project,
          cwd: meta.cwd,
          filePath,
          updatedAtMs: Math.max(stat.mtimeMs, idx?.updatedAtMs ?? 0),
          isLive: Boolean(tracked),
          isOpenLock,
          activity: tracked
            ? tracked.lastEmittedActivity === 'working'
              ? 'working'
              : 'idle'
            : 'archived',
          agentId: tracked?.agentId,
          contextTokens: tracked?.state.contextTokens,
          maxContextTokens: tracked?.state.maxContextTokens,
          resumeCommand: `codex resume ${id}`,
        });
      }
    }

    if (this.enableAntigravity) {
      for (const filePath of listAntigravityFiles(this.antigravityRoot)) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        const meta = this.readCachedMeta(filePath, 'antigravity', stat);
        const id = meta.sessionId ?? defaultSessionIdFor(filePath, 'antigravity');
        const tracked = this.trackedByFile.get(filePath);
        const isSub = tracked?.state.isSubagent ?? meta.isSubagent;
        const isOpenLock = this.openLocks.antigravity.has(id);
        books.push({
          id,
          providerId: 'antigravity',
          title: `${isSub ? 'Subagent' : 'Chat'} ${id.slice(0, 8)}`,
          project: 'Antigravity',
          filePath,
          updatedAtMs: stat.mtimeMs,
          isLive: Boolean(tracked),
          isOpenLock,
          activity: tracked
            ? tracked.lastEmittedActivity === 'working'
              ? 'working'
              : 'idle'
            : 'archived',
          agentId: tracked?.agentId,
          contextTokens: tracked?.state.contextTokens,
          maxContextTokens: tracked?.state.maxContextTokens,
        });
      }
    }

    for (const item of listClaudeFiles(this.claudeProjectsRoot)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(item.filePath);
      } catch {
        continue;
      }
      const id = path.basename(item.filePath, '.jsonl');
      const liveAgent = liveClaudeBySession.get(id);
      books.push({
        id,
        providerId: 'claude',
        title: `${item.project} · ${id.slice(0, 8)}`,
        project: item.project,
        filePath: item.filePath,
        updatedAtMs: stat.mtimeMs,
        isLive: Boolean(liveAgent),
        isOpenLock: false,
        activity: liveAgent ? (liveAgent.isWaiting ? 'idle' : 'working') : 'archived',
        agentId: liveAgent?.id,
        contextTokens: liveAgent?.contextTokens,
        maxContextTokens: liveAgent?.maxContextTokens,
        resumeCommand: `claude --resume ${id}`,
      });
    }

    books.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      if (a.isOpenLock !== b.isOpenLock) return a.isOpenLock ? -1 : 1;
      return b.updatedAtMs - a.updatedAtMs;
    });

    return books.slice(0, limit);
  }

  /**
   * Summon an archived Codex or Antigravity session onto the office floor so the user
   * can watch it alongside active agents even if it was modified before recentWindowMs.
   */
  pinSession(providerId: ExternalProviderId, sessionId: string): { ok: boolean; agentId?: number } {
    for (const rec of this.trackedByFile.values()) {
      if (rec.providerId === providerId && rec.sessionId === sessionId) {
        this.pinnedFiles.add(rec.filePath);
        return { ok: true, agentId: rec.agentId };
      }
    }

    const candidates =
      providerId === 'codex'
        ? listCodexFiles(this.codexRoot)
        : listAntigravityFiles(this.antigravityRoot);

    for (const filePath of candidates) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const rawId = defaultSessionIdFor(filePath, providerId);
      const meta = rawId === sessionId ? null : this.readCachedMeta(filePath, providerId, stat);
      const resolvedId = meta?.sessionId ?? rawId;
      if (resolvedId !== sessionId) continue;

      this.dismissed.delete(filePath);
      this.pinnedFiles.add(filePath);
      const agentId = this.adoptFile(filePath, providerId, stat, this.now());
      return { ok: true, agentId };
    }

    return { ok: false };
  }

  private readIncrement(rec: TrackedFile, fileSize: number): void {
    while (rec.offset < fileSize) {
      const len = Math.min(fileSize - rec.offset, MAX_CHUNK_BYTES);
      let chunk = '';
      try {
        chunk = readRangeSync(rec.filePath, rec.offset, len);
      } catch {
        break;
      }
      if (!chunk) break;
      rec.offset += len;
      const combined = rec.pending + chunk;
      const lines = combined.split('\n');
      rec.pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          applyRecord(rec.providerId, JSON.parse(trimmed), rec.state);
        } catch {
          /* ignore partial or unknown line */
        }
      }
    }
    this.syncAgentState(rec);
    this.emitCodexRateLimits(rec, rec.lastWriteMs);
  }

  private emitCodexRateLimits(rec: TrackedFile, fallbackObservedAtMs: number): void {
    if (!this.onVendorUsage || rec.providerId !== 'codex') return;
    const rl = rec.state.latestRateLimits;
    if (!rl) return;
    const observedAtMs = rl.observedAtMs ?? fallbackObservedAtMs;
    if (observedAtMs < this.lastCodexRateLimitAtMs) return;
    this.lastCodexRateLimitAtMs = observedAtMs;
    this.onVendorUsage(
      'codex',
      {
        ...(rl.fiveHour ? { fiveHour: rl.fiveHour } : {}),
        ...(rl.sevenDay ? { sevenDay: rl.sevenDay } : {}),
        ...(rl.planType ? { planType: rl.planType } : {}),
      },
      observedAtMs,
    );
  }

  private refreshVendorUsage(nowMs: number, force: boolean): void {
    if (!this.onVendorUsage) return;
    if (!force && nowMs - this.lastVendorUsageRefreshMs < VENDOR_USAGE_REFRESH_MS) return;
    this.lastVendorUsageRefreshMs = nowMs;

    if (this.enableCodex) {
      const codexQuota = scanCodexRateLimitsFromFiles(this.codexRoot, nowMs);
      if (codexQuota && codexQuota.observedAtMs >= this.lastCodexRateLimitAtMs) {
        this.lastCodexRateLimitAtMs = codexQuota.observedAtMs;
        this.onVendorUsage(
          'codex',
          {
            ...(codexQuota.fiveHour ? { fiveHour: codexQuota.fiveHour } : {}),
            ...(codexQuota.sevenDay ? { sevenDay: codexQuota.sevenDay } : {}),
            ...(codexQuota.planType ? { planType: codexQuota.planType } : {}),
          },
          codexQuota.observedAtMs,
        );
      }
    }

    if (this.enableAntigravity) {
      const agy = this.vendorUsageScanner.scanAntigravityLocalUsage(this.antigravityRoot, nowMs);
      if (
        agy.fiveHourActivity.turns > 0 ||
        agy.sevenDayActivity.turns > 0 ||
        this.reportedAgyActivity
      ) {
        this.reportedAgyActivity = true;
        this.onVendorUsage(
          'antigravity',
          {
            fiveHourActivity: agy.fiveHourActivity,
            sevenDayActivity: agy.sevenDayActivity,
          },
          nowMs,
        );
      }
    }

    const claude = this.vendorUsageScanner.scanClaudeLocalUsage(this.claudeProjectsRoot, nowMs);
    if (
      claude.fiveHourActivity.turns > 0 ||
      claude.sevenDayActivity.turns > 0 ||
      this.reportedClaudeActivity
    ) {
      this.reportedClaudeActivity = true;
      this.onVendorUsage(
        'claude',
        {
          fiveHourActivity: claude.fiveHourActivity,
          sevenDayActivity: claude.sevenDayActivity,
        },
        nowMs,
      );
    }
  }

  private syncAgentState(rec: TrackedFile): void {
    const agent = this.store.get(rec.agentId);
    if (!agent) return;
    agent.lastDataAt = rec.lastWriteMs;

    const { state } = rec;
    const id = rec.agentId;
    if (!agent.projectDir && state.cwd) {
      agent.projectDir = state.cwd;
      const codexIndex = rec.providerId === 'codex' ? this.readCodexIndex() : new Map();
      const nextLabel = this.formatDirectoryLabel(
        rec.providerId,
        rec.sessionId,
        state.cwd,
        state.isSubagent,
        codexIndex,
      );
      if (nextLabel && nextLabel !== agent.directoryName) {
        agent.directoryName = nextLabel;
        this.store.broadcast({
          type: 'agentTeamInfo',
          id,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: agent.teamUsesTmux,
          isReviewer: agent.isReviewer,
          directoryName: agent.directoryName,
        });
      }
    }

    if (state.activity === 'working') {
      const nextToolName = state.toolName ?? 'Thinking';
      const nextToolStatus = state.toolStatus ?? formatExternalToolStatus(nextToolName);
      const wasWorking = rec.lastEmittedActivity === 'working';
      const toolChanged = nextToolName !== rec.lastEmittedToolName || !wasWorking;

      if (toolChanged) {
        if (rec.lastEmittedToolId) {
          agent.activeToolIds.delete(rec.lastEmittedToolId);
          agent.activeToolNames.delete(rec.lastEmittedToolId);
          agent.activeToolStatuses.delete(rec.lastEmittedToolId);
          this.store.broadcast({ type: 'agentToolDone', id, toolId: rec.lastEmittedToolId });
        }
        const newToolId = this.nextToolId();
        agent.activeToolIds.add(newToolId);
        agent.activeToolNames.set(newToolId, nextToolName);
        agent.activeToolStatuses.set(newToolId, nextToolStatus);
        rec.lastEmittedToolId = newToolId;
        rec.lastEmittedToolName = nextToolName;
        this.store.broadcast({
          type: 'agentToolStart',
          id,
          toolId: newToolId,
          status: nextToolStatus,
          toolName: nextToolName,
        });
      }

      if (!wasWorking) {
        agent.isWaiting = false;
        agent.awaitingInput = false;
        agent.turnActive = true;
        rec.lastEmittedActivity = 'working';
        this.store.broadcast({ type: 'agentStatus', id, status: 'active' });
      }
    } else if (state.activity === 'idle' && rec.lastEmittedActivity !== 'idle') {
      agent.activeToolIds.clear();
      agent.activeToolNames.clear();
      agent.activeToolStatuses.clear();
      agent.isWaiting = true;
      agent.awaitingInput = state.awaitingInput;
      agent.turnActive = false;
      rec.lastEmittedToolId = null;
      rec.lastEmittedToolName = null;
      rec.lastEmittedActivity = 'idle';
      this.store.broadcast({ type: 'agentToolsClear', id });
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: state.awaitingInput || undefined,
      });
    }

    if (
      state.contextReported &&
      (state.contextTokens !== rec.lastEmittedContextTokens ||
        state.maxContextTokens !== rec.lastEmittedMaxContextTokens)
    ) {
      agent.contextTokens = state.contextTokens;
      agent.maxContextTokens = state.maxContextTokens;
      agent.contextReported = true;
      rec.lastEmittedContextTokens = state.contextTokens;
      rec.lastEmittedMaxContextTokens = state.maxContextTokens;
      this.store.broadcast({
        type: 'agentContextUsage',
        id,
        contextTokens: state.contextTokens,
        maxContextTokens: state.maxContextTokens,
      });
    }
  }

  private reconcileExternalTeams(): void {
    const bySessionId = new Map<string, TrackedFile>();
    for (const rec of this.trackedByFile.values()) {
      bySessionId.set(`${rec.providerId}:${rec.sessionId}`, rec);
    }

    const parentOfRec = new Map<TrackedFile, { parentRec: TrackedFile; role?: string }>();
    const activeParentIds = new Set<number>();

    for (const rec of this.trackedByFile.values()) {
      if (rec.state.parentThreadId) {
        const parentRec = bySessionId.get(`${rec.providerId}:${rec.state.parentThreadId}`);
        if (parentRec && parentRec.agentId !== rec.agentId) {
          parentOfRec.set(rec, { parentRec, role: rec.state.subagentRole });
          activeParentIds.add(parentRec.agentId);
        }
      }
      if (rec.state.spawnedChildren) {
        for (const [childId, role] of rec.state.spawnedChildren) {
          const childRec = bySessionId.get(`${rec.providerId}:${childId}`);
          if (childRec && childRec.agentId !== rec.agentId && !parentOfRec.has(childRec)) {
            parentOfRec.set(childRec, { parentRec: rec, role });
            activeParentIds.add(rec.agentId);
          }
        }
      }
    }

    // Preserve host -> reviewer links for non-file-tracked synthetic agents in the store.
    for (const agent of this.store.values()) {
      if (
        !this.agentToFile.has(agent.id) &&
        agent.leadAgentId !== undefined &&
        this.store.has(agent.leadAgentId)
      ) {
        activeParentIds.add(agent.leadAgentId);
      }
    }

    for (const rec of this.trackedByFile.values()) {
      const agent = this.store.get(rec.agentId);
      if (!agent) continue;

      const link = parentOfRec.get(rec);
      const nextLeadAgentId = link ? link.parentRec.agentId : undefined;
      const nextAgentName = link ? rec.state.subagentRole || link.role || undefined : undefined;
      const nextIsTeamLead = activeParentIds.has(rec.agentId) ? true : undefined;
      if (link || rec.state.isSubagent) {
        agent.isAgentSpawned = true;
      }

      if (
        agent.leadAgentId !== nextLeadAgentId ||
        agent.agentName !== nextAgentName ||
        agent.isTeamLead !== nextIsTeamLead
      ) {
        agent.leadAgentId = nextLeadAgentId;
        agent.agentName = nextAgentName;
        agent.isTeamLead = nextIsTeamLead;
        this.store.broadcast({
          type: 'agentTeamInfo',
          id: rec.agentId,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: agent.teamUsesTmux,
          isReviewer: agent.isReviewer,
        });
      }
    }
  }

  private closeTracked(filePath: string, rec: TrackedFile): void {
    // Delete mapping before store.delete so onAgentRemoved does not record a manual dismissal.
    this.agentToFile.delete(rec.agentId);
    this.trackedByFile.delete(filePath);
    this.pinnedFiles.delete(filePath);
    this.store.delete(rec.agentId);
    this.reconcileExternalTeams();
  }
}
