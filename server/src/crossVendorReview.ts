import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type AgentChatBridge,
  type ChatSendResult,
  clipText,
  existingCwd,
  isCommunicableAgent,
  parseChatMessagesFromJsonl,
  resolveCliBinary,
  type SpawnedProcessLike,
  type SpawnProcessOptions,
} from './agentChatBridge.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { ExternalProviderId } from './externalLogWatcher.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import type { AgentState as FullAgentState } from './types.js';

export type ReviewVendor = 'codex' | 'antigravity';
export type CrossVendorVerdict = 'approve' | 'caution' | 'block' | 'needs_info';
export type ReviewStatus = 'running' | 'completed' | 'failed';
export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface CrossVendorFinding {
  severity: ReviewSeverity;
  file?: string;
  issue: string;
  suggestion?: string;
}

export interface CrossVendorReviewResult {
  verdict: CrossVendorVerdict;
  summary: string;
  strengths?: string[];
  findings: CrossVendorFinding[];
  openQuestions?: string[];
  recommendedNextStep?: string;
}

export interface CrossVendorReviewRecord {
  reviewId: string;
  hostAgentId: number;
  hostVendor: string;
  hostLabel: string;
  reviewerAgentId?: number;
  reviewerVendor: ReviewVendor;
  reviewerRole: string;
  reviewerConversationId?: string;
  focus?: string;
  round: number;
  maxRounds: number;
  status: ReviewStatus;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  forwardedAtMs?: number;
  forwardedRounds: number;
  result?: CrossVendorReviewResult;
  error?: string;
}

export interface InviteReviewInput {
  hostAgentId: number;
  reviewerVendor?: ReviewVendor;
  focus?: string;
  previousReviewId?: string;
}

export interface ReviewActionResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  review?: CrossVendorReviewRecord;
  chatResult?: ChatSendResult;
}

export interface ReviewSpawnOptions extends SpawnProcessOptions {
  env?: NodeJS.ProcessEnv;
}

export interface CrossVendorReviewServiceOptions {
  store: AgentStateStore;
  chatBridge: AgentChatBridge;
  resolveBin?: (name: string) => string | null;
  spawnProcess?: (
    cmd: string,
    args: readonly string[],
    opts: ReviewSpawnOptions,
  ) => SpawnedProcessLike;
  now?: () => number;
  timeoutMs?: number;
}

export interface ParsedReviewEnvelope {
  result: CrossVendorReviewResult;
  conversationId?: string;
}

export const MAX_REVIEW_ROUNDS = 2;
const DEFAULT_REVIEW_TIMEOUT_MS = 180_000;
const MAX_FOCUS_CHARS = 1000;
const MAX_FORWARD_CHARS = 3800;

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'strengths', 'findings', 'openQuestions', 'recommendedNextStep'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'caution', 'block', 'needs_info'],
    },
    summary: { type: 'string' },
    strengths: {
      type: 'array',
      items: { type: 'string' },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'issue', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: ['string', 'null'] },
          issue: { type: 'string' },
          suggestion: { type: ['string', 'null'] },
        },
      },
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
    },
    recommendedNextStep: { type: ['string', 'null'] },
  },
} as const;

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /<thinking>[\s\S]*?<\/thinking>/gi, replacement: '[REDACTED_THINKING]' },
  { re: /<environment_context>[\s\S]*?<\/environment_context>/gi, replacement: '' },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED_KEY]' },
  { re: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { re: /\bAIza[0-9A-Za-z\-_]{20,}\b/g, replacement: '[REDACTED_KEY]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/gi, replacement: 'Bearer [REDACTED]' },
  {
    re: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)\s*([:=])\s*['"]?[A-Za-z0-9._\-+/=]{8,}['"]?/gi,
    replacement: '$1$2 [REDACTED]',
  },
];

/** Strip tokens, credentials, and private reasoning blocks before storing or forwarding text. */
export function redactSensitiveText(input: string): string {
  let out = input;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* try brace slice below */
      }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeVerdict(raw: unknown): CrossVendorVerdict | null {
  if (raw === 'approve' || raw === 'caution' || raw === 'block' || raw === 'needs_info') {
    return raw;
  }
  return null;
}

function normalizeSeverity(raw: unknown): ReviewSeverity {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

function cleanOptionalString(raw: unknown, maxLen = 600): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = redactSensitiveText(clipText(raw, maxLen));
  return cleaned || undefined;
}

function cleanStringList(raw: unknown, limit = 8, maxLen = 400): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const cleaned = redactSensitiveText(clipText(entry, maxLen));
    if (cleaned) items.push(cleaned);
    if (items.length >= limit) break;
  }
  return items.length > 0 ? items : undefined;
}

function extractReviewObject(candidate: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof candidate === 'string') {
    const parsed = tryParseJson(candidate);
    return parsed ? extractReviewObject(parsed, depth + 1) : null;
  }
  if (!isRecord(candidate)) return null;
  if (normalizeVerdict(candidate.verdict) && typeof candidate.summary === 'string') {
    return candidate;
  }
  for (const key of ['structured_output', 'result', 'response', 'output', 'message', 'data']) {
    if (key in candidate && candidate[key] !== undefined && candidate[key] !== null) {
      const nested = extractReviewObject(candidate[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function extractConversationId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of ['conversation_id', 'conversationId', 'session_id', 'sessionId', 'thread_id']) {
    const val = raw[key];
    if (typeof val === 'string' && /^[A-Za-z0-9_.:-]{4,128}$/.test(val.trim())) {
      return val.trim();
    }
  }
  return undefined;
}

/** Parse structured review JSON from raw output, JSON fences, or CLI wrapper objects. */
export function parseStructuredReviewOutput(raw: string): ParsedReviewEnvelope | null {
  const top = tryParseJson(raw);
  if (!top) return null;

  const conversationId = extractConversationId(top);
  const obj = extractReviewObject(top);
  if (!obj) return null;

  const verdict = normalizeVerdict(obj.verdict);
  const summary = cleanOptionalString(obj.summary, 1500);
  if (!verdict || !summary) return null;

  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: CrossVendorFinding[] = [];
  for (const item of rawFindings) {
    if (!isRecord(item)) continue;
    const issue = cleanOptionalString(item.issue, 600);
    if (!issue) continue;
    findings.push({
      severity: normalizeSeverity(item.severity),
      file: cleanOptionalString(item.file, 260),
      issue,
      suggestion: cleanOptionalString(item.suggestion, 600),
    });
    if (findings.length >= 12) break;
  }

  return {
    conversationId,
    result: {
      verdict,
      summary,
      strengths: cleanStringList(obj.strengths),
      findings,
      openQuestions: cleanStringList(obj.openQuestions),
      recommendedNextStep: cleanOptionalString(obj.recommendedNextStep, 600),
    },
  };
}

/** Detect CLI wrapper failure envelopes (e.g. empty response or denied Bash/command actions). */
export function inspectCliFailureEnvelope(raw: string): string | null {
  const top = tryParseJson(raw);
  if (!isRecord(top)) return null;

  const isEnvelope =
    'denied_actions' in top ||
    'conversation_id' in top ||
    'json_schema' in top ||
    'num_turns' in top;
  if (!isEnvelope) return null;

  if (Array.isArray(top.denied_actions) && top.denied_actions.length > 0) {
    const names = top.denied_actions
      .map((item) => {
        if (!isRecord(item)) return '';
        const disp = typeof item.display_name === 'string' ? item.display_name.trim() : '';
        const act = typeof item.action === 'string' ? item.action.trim() : '';
        return disp || act;
      })
      .filter(Boolean);
    const label = names.length > 0 ? names.join(', ') : '受限工具';
    return `審查者嘗試執行被唯讀環境禁止的操作（${redactSensitiveText(label)}），導致本次未產出結論；請點擊「重試本輪」。`;
  }

  if (typeof top.error === 'string' && top.error.trim()) {
    return `審查中斷：${redactSensitiveText(clipText(top.error, 200))}`;
  }

  return '審查者未回傳有效審查結論（response 為空），請點擊「重試本輪」。';
}

function readGitWorkspaceSummary(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    const status = execFileSync('git', ['status', '--short'], {
      cwd,
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const diffStat = execFileSync('git', ['diff', '--stat'], {
      cwd,
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parts: string[] = [];
    if (status) {
      parts.push(`git status:\n${clipText(status, 400)}`);
    }
    if (diffStat) {
      parts.push(`git diff --stat:\n${clipText(diffStat, 400)}`);
    }
    if (parts.length === 0) return undefined;
    return redactSensitiveText(clipText(parts.join('\n'), 800));
  } catch {
    return undefined;
  }
}

/** Pick the opposite-vendor reviewer allowed for a host provider. */
export function defaultReviewerVendorFor(hostVendor: string): ReviewVendor | null {
  if (hostVendor === 'codex') return 'antigravity';
  if (hostVendor === 'antigravity') return 'codex';
  return null;
}

/** Display role title shown on the meeting room seat and card. */
export function reviewerRoleFor(vendor: ReviewVendor): string {
  return vendor === 'antigravity' ? 'AGY Reviewer' : 'CDX Reviewer';
}

const VERDICT_LABELS: Record<CrossVendorVerdict, string> = {
  approve: '贊同推進 (approve)',
  caution: '建議調整 (caution)',
  block: '建議暫緩／阻塞 (block)',
  needs_info: '需補充脈絡 (needs_info)',
};

/** Format a completed review into a concise, sanitized handoff message for the host Lead. */
export function formatReviewForHost(record: CrossVendorReviewRecord): string {
  const result = record.result;
  if (!result) return '';
  const lines: string[] = [
    `[跨模型審查意見｜${record.reviewerRole} · 第 ${record.round} 輪]`,
    `結論：${VERDICT_LABELS[result.verdict]}`,
    `摘要：${redactSensitiveText(result.summary)}`,
  ];

  if (result.findings.length > 0) {
    lines.push('重點發現：');
    result.findings.slice(0, 6).forEach((f, idx) => {
      const loc = f.file ? ` (${redactSensitiveText(f.file)})` : '';
      lines.push(`${idx + 1}. [${f.severity.toUpperCase()}]${loc} ${redactSensitiveText(f.issue)}`);
      if (f.suggestion) {
        lines.push(`   建議：${redactSensitiveText(f.suggestion)}`);
      }
    });
  }

  if (result.openQuestions && result.openQuestions.length > 0) {
    lines.push('待釐清問題：');
    result.openQuestions.slice(0, 4).forEach((q) => {
      lines.push(`- ${redactSensitiveText(q)}`);
    });
  }

  if (result.recommendedNextStep) {
    lines.push(`建議下一步：${redactSensitiveText(result.recommendedNextStep)}`);
  }

  lines.push('（以上為唯讀審查者建議，請主導者評估後決定是否採納並直接修改實作。）');
  return clipText(lines.join('\n'), MAX_FORWARD_CHARS);
}

function defaultReviewSpawnProcess(
  cmd: string,
  args: readonly string[],
  opts: ReviewSpawnOptions,
): SpawnedProcessLike {
  const useStdin = opts.stdinText !== undefined;
  const child = spawn(cmd, [...args], {
    cwd: opts.cwd || undefined,
    env: {
      ...process.env,
      ...opts.env,
      PIXEL_REVIEW_DEPTH: '1',
    },
    stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (useStdin && child.stdin) {
    child.stdin.on('error', () => {
      /* ignore EPIPE if child exits early */
    });
    child.stdin.end(opts.stdinText);
  }
  return child;
}

function mapCodexJsonEventToTool(rawLine: string): {
  phase: 'start' | 'done';
  itemId: string;
  toolName: string;
  toolStatus: string;
} | null {
  const parsed = tryParseJson(rawLine);
  if (!isRecord(parsed)) return null;
  const eventType = typeof parsed.type === 'string' ? parsed.type : '';
  if (eventType !== 'item.started' && eventType !== 'item.completed') return null;
  if (!isRecord(parsed.item)) return null;
  const itemType = typeof parsed.item.type === 'string' ? parsed.item.type : '';
  const itemId =
    typeof parsed.item.id === 'string' && parsed.item.id ? parsed.item.id : `codex-${itemType}`;
  const phase = eventType === 'item.started' ? 'start' : 'done';

  switch (itemType) {
    case 'command_execution':
      return { phase, itemId, toolName: 'Bash', toolStatus: 'Checking workspace...' };
    case 'file_read':
      return { phase, itemId, toolName: 'Read', toolStatus: 'Reading files...' };
    case 'web_search':
      return { phase, itemId, toolName: 'WebSearch', toolStatus: 'Searching web...' };
    case 'reasoning':
      return { phase, itemId, toolName: 'Thinking', toolStatus: 'Reviewing findings...' };
    case 'mcp_tool_call':
      return { phase, itemId, toolName: 'Read', toolStatus: 'Inspecting tools...' };
    default:
      return null;
  }
}

function extractCodexLastAgentMessage(stdoutJsonl: string): string | undefined {
  let latest: string | undefined;
  for (const line of stdoutJsonl.split('\n')) {
    const parsed = tryParseJson(line);
    if (!isRecord(parsed)) continue;
    if (
      (parsed.type === 'item.completed' || parsed.type === 'item.updated') &&
      isRecord(parsed.item) &&
      parsed.item.type === 'agent_message' &&
      typeof parsed.item.text === 'string' &&
      parsed.item.text.trim()
    ) {
      latest = parsed.item.text;
    }
  }
  return latest;
}

interface ActiveRunHandle {
  child: SpawnedProcessLike & { kill?: (signal?: NodeJS.Signals | number) => boolean };
  timer: ReturnType<typeof setTimeout>;
  aborted: boolean;
  cleanupFiles: () => void;
}

/**
 * Coordinates read-only cross-vendor peer reviews (`Codex <-> Antigravity`) inside Pixel Agents.
 * Reviewers are spawned cleanly in read-only mode, seated in the Meeting Room as non-chatable
 * participants (`isReviewer: true`), and require explicit user action to invite or forward.
 */
export class CrossVendorReviewService {
  private readonly store: AgentStateStore;
  private readonly chatBridge: AgentChatBridge;
  private readonly resolveBin: (name: string) => string | null;
  private readonly spawnProcess: (
    cmd: string,
    args: readonly string[],
    opts: ReviewSpawnOptions,
  ) => SpawnedProcessLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly reviewsById = new Map<string, CrossVendorReviewRecord>();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private readonly onAgentRemovedBound: (id: number) => void;
  private seq = 0;

  constructor(options: CrossVendorReviewServiceOptions) {
    this.store = options.store;
    this.chatBridge = options.chatBridge;
    this.resolveBin = options.resolveBin ?? ((name) => resolveCliBinary(name));
    this.spawnProcess = options.spawnProcess ?? defaultReviewSpawnProcess;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

    this.onAgentRemovedBound = (removedId: number) => {
      this.handleAgentRemoved(removedId);
    };
    this.store.on('agentRemoved', this.onAgentRemovedBound);
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemovedBound);
    for (const reviewId of Array.from(this.activeRuns.keys())) {
      this.abortActiveRun(reviewId);
    }
  }

  listReviews(hostAgentId?: number): CrossVendorReviewRecord[] {
    const items: CrossVendorReviewRecord[] = [];
    for (const rec of this.reviewsById.values()) {
      if (hostAgentId !== undefined && rec.hostAgentId !== hostAgentId) continue;
      items.push(this.snapshotRecord(rec));
    }
    items.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs);
    return items;
  }

  async inviteReview(input: InviteReviewInput): Promise<ReviewActionResult> {
    if (Number(process.env.PIXEL_REVIEW_DEPTH || '0') >= 1) {
      return { ok: false, statusCode: 403, error: 'review_recursion_blocked' };
    }

    const host = this.store.get(input.hostAgentId);
    if (!host) {
      return { ok: false, statusCode: 404, error: 'agent_not_found' };
    }
    if (!isCommunicableAgent(host)) {
      return { ok: false, statusCode: 403, error: 'subagent_not_communicable' };
    }

    const hostVendor = host.providerId ?? 'claude';
    const expectedVendor = defaultReviewerVendorFor(hostVendor);
    if (!expectedVendor) {
      return { ok: false, statusCode: 400, error: 'unsupported_host_vendor' };
    }
    if (input.reviewerVendor && input.reviewerVendor !== expectedVendor) {
      return { ok: false, statusCode: 400, error: 'invalid_reviewer_vendor' };
    }
    const reviewerVendor = expectedVendor;

    for (const existing of this.reviewsById.values()) {
      if (existing.hostAgentId === host.id && existing.status === 'running') {
        return { ok: false, statusCode: 409, error: 'review_in_progress' };
      }
    }

    const binaryName = reviewerVendor === 'antigravity' ? 'agy' : 'codex';
    const binaryPath = this.resolveBin(binaryName);
    if (!binaryPath) {
      return { ok: false, statusCode: 400, error: 'cli_missing' };
    }

    const previous = input.previousReviewId
      ? this.reviewsById.get(input.previousReviewId)
      : this.findLatestReviewForHost(host.id, reviewerVendor);

    if (input.previousReviewId && (!previous || previous.hostAgentId !== host.id)) {
      return { ok: false, statusCode: 404, error: 'review_not_found' };
    }

    let nextRound = 1;
    let existingReviewerAgentId: number | undefined;
    let reviewerConversationId: string | undefined;
    if (previous) {
      nextRound = previous.status === 'failed' ? previous.round : previous.round + 1;
      if (nextRound > MAX_REVIEW_ROUNDS) {
        return { ok: false, statusCode: 409, error: 'max_review_rounds_reached' };
      }
      if (previous.reviewerAgentId !== undefined && this.store.has(previous.reviewerAgentId)) {
        existingReviewerAgentId = previous.reviewerAgentId;
      }
      reviewerConversationId = previous.reviewerConversationId;
      // Supersede prior record in place so the Meeting Room keeps one coherent reviewer seat.
      this.reviewsById.delete(previous.reviewId);
    }

    const focus = input.focus
      ? redactSensitiveText(clipText(input.focus, MAX_FOCUS_CHARS))
      : undefined;
    const cwd = existingCwd(host.projectDir);
    const prompt = this.buildReviewPrompt(
      host,
      hostVendor as ExternalProviderId,
      reviewerVendor,
      cwd,
      nextRound,
      focus,
      previous?.result,
    );

    const reviewerAgentId = this.ensureReviewerSeat(
      host,
      reviewerVendor,
      cwd,
      existingReviewerAgentId,
    );
    const ts = this.now();
    const reviewId = `rev-${ts}-${++this.seq}`;
    const record: CrossVendorReviewRecord = {
      reviewId,
      hostAgentId: host.id,
      hostVendor,
      hostLabel: host.directoryName || `${hostVendor} #${host.id}`,
      reviewerAgentId,
      reviewerVendor,
      reviewerRole: reviewerRoleFor(reviewerVendor),
      reviewerConversationId,
      focus,
      round: nextRound,
      maxRounds: MAX_REVIEW_ROUNDS,
      status: 'running',
      createdAtMs: ts,
      updatedAtMs: ts,
      forwardedRounds: previous?.forwardedRounds ?? 0,
    };
    this.reviewsById.set(reviewId, record);

    const reviewerAgent = this.store.get(reviewerAgentId);
    if (reviewerAgent) {
      reviewerAgent.reviewId = reviewId;
    }

    this.launchReviewProcess(record, binaryPath, prompt, cwd);
    return { ok: true, statusCode: 202, review: this.snapshotRecord(record) };
  }

  async forwardReview(reviewId: string): Promise<ReviewActionResult> {
    const rec = this.reviewsById.get(reviewId);
    if (!rec) {
      return { ok: false, statusCode: 404, error: 'review_not_found' };
    }
    if (rec.status !== 'completed' || !rec.result) {
      return { ok: false, statusCode: 400, error: 'review_not_completed' };
    }
    if (rec.forwardedRounds >= rec.round) {
      return { ok: false, statusCode: 409, error: 'review_already_forwarded' };
    }

    const formatted = formatReviewForHost(rec);
    const chatResult = await this.chatBridge.sendMessage(rec.hostAgentId, formatted);
    if (!chatResult.ok) {
      return {
        ok: false,
        statusCode: chatResult.statusCode ?? 500,
        error: chatResult.error ?? 'forward_failed',
        chatResult,
      };
    }

    const ts = this.now();
    rec.forwardedRounds = rec.round;
    rec.forwardedAtMs = ts;
    rec.updatedAtMs = ts;
    return { ok: true, statusCode: 200, review: this.snapshotRecord(rec), chatResult };
  }

  dismissReview(reviewId: string): ReviewActionResult {
    const rec = this.reviewsById.get(reviewId);
    if (!rec) {
      return { ok: false, statusCode: 404, error: 'review_not_found' };
    }
    this.abortActiveRun(reviewId);
    this.reviewsById.delete(reviewId);

    if (rec.reviewerAgentId !== undefined && this.store.has(rec.reviewerAgentId)) {
      this.store.delete(rec.reviewerAgentId);
    }
    this.reconcileHostLeadFlag(rec.hostAgentId);
    return { ok: true, statusCode: 200, review: this.snapshotRecord(rec) };
  }

  private handleAgentRemoved(removedId: number): void {
    for (const [reviewId, rec] of this.reviewsById.entries()) {
      if (rec.hostAgentId === removedId) {
        this.abortActiveRun(reviewId);
        this.reviewsById.delete(reviewId);
        if (rec.reviewerAgentId !== undefined && this.store.has(rec.reviewerAgentId)) {
          this.store.delete(rec.reviewerAgentId);
        }
      } else if (rec.reviewerAgentId === removedId) {
        this.abortActiveRun(reviewId);
        rec.reviewerAgentId = undefined;
      }
    }
  }

  private findLatestReviewForHost(
    hostAgentId: number,
    reviewerVendor: ReviewVendor,
  ): CrossVendorReviewRecord | undefined {
    let latest: CrossVendorReviewRecord | undefined;
    for (const rec of this.reviewsById.values()) {
      if (rec.hostAgentId === hostAgentId && rec.reviewerVendor === reviewerVendor) {
        if (!latest || rec.updatedAtMs >= latest.updatedAtMs) {
          latest = rec;
        }
      }
    }
    return latest;
  }

  private ensureReviewerSeat(
    host: FullAgentState,
    reviewerVendor: ReviewVendor,
    cwd: string | undefined,
    existingReviewerAgentId?: number,
  ): number {
    const role = reviewerRoleFor(reviewerVendor);
    if (!host.isTeamLead) {
      host.isTeamLead = true;
      this.store.broadcast({
        type: 'agentTeamInfo',
        id: host.id,
        teamName: host.teamName,
        agentName: host.agentName,
        isTeamLead: true,
        leadAgentId: host.leadAgentId,
        teamUsesTmux: host.teamUsesTmux,
        isReviewer: host.isReviewer,
      });
    }

    if (existingReviewerAgentId !== undefined) {
      const existing = this.store.get(existingReviewerAgentId);
      if (existing) {
        this.setReviewerToolState(existing, 'Thinking', 'Reviewing workspace...');
        return existingReviewerAgentId;
      }
    }

    let reviewerId = this.store.nextAgentId.current++;
    while (this.store.has(reviewerId)) {
      reviewerId = this.store.nextAgentId.current++;
    }
    const reviewer = createAgentState({
      id: reviewerId,
      sessionId: `review-${reviewerVendor}-${host.id}-${reviewerId}`,
      isExternal: true,
      projectDir: cwd ?? '',
      jsonlFile: '',
      hookDelivered: true,
      hooksOnly: true,
      providerId: reviewerVendor,
      directoryName: role,
      agentName: role,
      teamName: host.teamName,
      leadAgentId: host.id,
      isAgentSpawned: true,
      isReviewer: true,
      lastDataAt: this.now(),
    });
    assignPaletteIfNeeded(reviewer, this.store);

    const initToolId = `rev-tool-${reviewerId}-init`;
    reviewer.isWaiting = false;
    reviewer.awaitingInput = false;
    reviewer.turnActive = true;
    reviewer.activeToolIds.add(initToolId);
    reviewer.activeToolNames.set(initToolId, 'Thinking');
    reviewer.activeToolStatuses.set(initToolId, 'Reviewing workspace...');

    this.store.set(reviewerId, reviewer);
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: reviewerId,
      teamName: reviewer.teamName,
      agentName: reviewer.agentName,
      isTeamLead: undefined,
      leadAgentId: reviewer.leadAgentId,
      isReviewer: true,
    });
    this.store.broadcast({
      type: 'agentToolStart',
      id: reviewerId,
      toolId: initToolId,
      toolName: 'Thinking',
      status: 'Reviewing workspace...',
    });
    this.store.broadcast({ type: 'agentStatus', id: reviewerId, status: 'active' });
    return reviewerId;
  }

  private setReviewerToolState(reviewer: FullAgentState, toolName: string, status: string): void {
    const id = reviewer.id;
    for (const oldId of reviewer.activeToolIds) {
      this.store.broadcast({ type: 'agentToolDone', id, toolId: oldId });
    }
    reviewer.activeToolIds.clear();
    reviewer.activeToolNames.clear();
    reviewer.activeToolStatuses.clear();

    const toolId = `rev-tool-${id}-${Date.now()}-${++this.seq}`;
    reviewer.isWaiting = false;
    reviewer.awaitingInput = false;
    reviewer.turnActive = true;
    reviewer.activeToolIds.add(toolId);
    reviewer.activeToolNames.set(toolId, toolName);
    reviewer.activeToolStatuses.set(toolId, status);

    this.store.broadcast({ type: 'agentToolStart', id, toolId, toolName, status });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });
  }

  private setReviewerIdle(reviewerId: number | undefined): void {
    if (reviewerId === undefined) return;
    const reviewer = this.store.get(reviewerId);
    if (!reviewer) return;
    reviewer.activeToolIds.clear();
    reviewer.activeToolNames.clear();
    reviewer.activeToolStatuses.clear();
    reviewer.isWaiting = true;
    reviewer.awaitingInput = true;
    reviewer.turnActive = false;
    this.store.broadcast({ type: 'agentToolsClear', id: reviewerId });
    this.store.broadcast({
      type: 'agentStatus',
      id: reviewerId,
      status: 'waiting',
      awaitingInput: true,
    });
  }

  private reconcileHostLeadFlag(hostId: number): void {
    const host = this.store.get(hostId);
    if (!host || !host.isTeamLead || host.teamName) return;
    const hasChildren = Array.from(this.store.values()).some((a) => a.leadAgentId === hostId);
    if (!hasChildren) {
      host.isTeamLead = undefined;
      this.store.broadcast({
        type: 'agentTeamInfo',
        id: hostId,
        teamName: host.teamName,
        agentName: host.agentName,
        isTeamLead: undefined,
        leadAgentId: host.leadAgentId,
        teamUsesTmux: host.teamUsesTmux,
        isReviewer: host.isReviewer,
      });
    }
  }

  private buildReviewPrompt(
    host: FullAgentState,
    hostVendor: ExternalProviderId,
    reviewerVendor: ReviewVendor,
    cwd: string | undefined,
    round: number,
    focus?: string,
    previousResult?: CrossVendorReviewResult,
  ): string {
    const logPath = host.externalLogFile || host.jsonlFile;
    const logTurns = logPath ? parseChatMessagesFromJsonl(logPath, hostVendor, 12) : [];
    const assistantTurns = logTurns
      .filter((t) => t.role === 'assistant')
      .slice(-3)
      .map((t, idx) => `(${idx + 1}) ${redactSensitiveText(clipText(t.text, 900))}`)
      .filter((s) => s.length > 4);

    const lines: string[] = [
      `你是受邀進入會議室的唯讀跨模型審查者（${reviewerRoleFor(reviewerVendor)}，第 ${round}/${MAX_REVIEW_ROUNDS} 輪），負責協助主導者（${hostVendor}）檢視程式碼與實作決策。`,
      '嚴格限制：僅可進行唯讀檢視與分析，絕對不可修改檔案、不可執行寫入／破壞性指令、不可呼叫或啟動其他跨模型審查流程。',
      `主導工作階段名稱：${host.directoryName || host.sessionId}`,
      cwd ? `工作目錄：${cwd}` : '工作目錄：未提供具體目錄，請依據提供的脈絡與重點回答。',
    ];

    if (reviewerVendor === 'antigravity') {
      lines.push(
        '沙盒與工具規範（務必遵守）：目前運行於非互動唯讀沙盒，run_command / Bash / 終端機指令與 invoke_subagent 都會被系統阻擋並導致輸出空白。請勿執行任何終端機指令或建立子代理人，請僅使用唯讀檔案工具（view_file、list_dir、grep_search、find_by_name）讀取工作區檔案後，直接依 JSON Schema 回傳結構化審查結果。',
      );
    }

    if (focus) {
      lines.push(`使用者指定審查重點：${focus}`);
      lines.push(
        '多角色／多領域分析要求：若審查重點指定了特定工程師或角色視角（例如 Android Engineer、QNX Engineer 等），請直接在 summary 與 findings 中明確以 `[角色名稱]` 分段分析各視角的檢查重點、風險與結論，不要嘗試呼叫 invoke_subagent。',
      );
    } else {
      lines.push('預設審查重點：檢查近期變更的正確性、邊界條件、安全性、測試覆蓋與架構風險。');
    }

    const gitSummary = readGitWorkspaceSummary(cwd);
    if (gitSummary) {
      lines.push(`工作區變更概覽（唯讀快照）：\n${gitSummary}`);
    }

    if (previousResult) {
      lines.push(
        `上一輪審查結論（${previousResult.verdict}）：${redactSensitiveText(clipText(previousResult.summary, 600))}`,
      );
    }

    if (assistantTurns.length > 0) {
      lines.push('主導者近期回覆摘要（已去敏，僅供背景參考）：');
      lines.push(...assistantTurns);
    }

    lines.push(
      '請嚴格依照指定的 JSON Schema 輸出結構化審查結果（繁體中文撰寫 summary、issue、suggestion、recommendedNextStep）。',
    );
    return clipText(lines.join('\n\n'), 4500);
  }

  private launchReviewProcess(
    record: CrossVendorReviewRecord,
    binaryPath: string,
    prompt: string,
    cwd: string | undefined,
  ): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-review-'));
    try {
      fs.chmodSync(tmpDir, 0o700);
    } catch {
      /* best-effort permission hardening */
    }
    const schemaPath = path.join(tmpDir, `schema-${crypto.randomUUID()}.json`);
    const outputPath = path.join(tmpDir, `output-${crypto.randomUUID()}.json`);
    fs.writeFileSync(schemaPath, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(outputPath, '', { mode: 0o600 });

    const cleanupFiles = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    };

    const args =
      record.reviewerVendor === 'antigravity'
        ? [
            '--sandbox',
            '--disable-slash-commands',
            '--output-format',
            'json',
            '--json-schema',
            schemaPath,
            '--print-timeout',
            `${Math.max(15, Math.ceil(this.timeoutMs / 1000))}s`,
            '--effort',
            'medium',
            ...(cwd ? ['--add-dir', cwd] : []),
            ...(record.reviewerConversationId
              ? ['--conversation', record.reviewerConversationId]
              : []),
            '-p',
            prompt,
          ]
        : [
            'exec',
            '-s',
            'read-only',
            ...(cwd ? ['-C', cwd] : []),
            '--skip-git-repo-check',
            '-c',
            'approval_policy="never"',
            '--ephemeral',
            '--json',
            '--output-schema',
            schemaPath,
            '-o',
            outputPath,
            '-',
          ];

    const spawnOpts: ReviewSpawnOptions =
      record.reviewerVendor === 'codex'
        ? { cwd, stdinText: prompt, env: { PIXEL_REVIEW_DEPTH: '1' } }
        : { cwd, env: { PIXEL_REVIEW_DEPTH: '1' } };

    let child: SpawnedProcessLike & { kill?: (signal?: NodeJS.Signals | number) => boolean };
    try {
      child = this.spawnProcess(binaryPath, args, spawnOpts) as SpawnedProcessLike & {
        kill?: (signal?: NodeJS.Signals | number) => boolean;
      };
    } catch (err) {
      cleanupFiles();
      this.failReview(record, err instanceof Error ? err.message : 'review_spawn_failed');
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let lineRemainder = '';

    const timer = setTimeout(() => {
      const handle = this.activeRuns.get(record.reviewId);
      if (!handle || handle.aborted) return;
      handle.aborted = true;
      try {
        handle.child.kill?.('SIGTERM');
      } catch {
        /* ignore kill error */
      }
      this.activeRuns.delete(record.reviewId);
      handle.cleanupFiles();
      this.failReview(record, 'review_timeout');
    }, this.timeoutMs);

    const handle: ActiveRunHandle = {
      child,
      timer,
      aborted: false,
      cleanupFiles,
    };
    this.activeRuns.set(record.reviewId, handle);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      if (stdoutBuf.length < 128_000) {
        stdoutBuf += text;
      }
      if (record.reviewerVendor === 'codex') {
        lineRemainder += text;
        let idx = lineRemainder.indexOf('\n');
        while (idx !== -1) {
          const line = lineRemainder.slice(0, idx).trim();
          lineRemainder = lineRemainder.slice(idx + 1);
          const ev = line ? mapCodexJsonEventToTool(line) : null;
          if (ev && !handle.aborted && record.reviewerAgentId !== undefined) {
            const reviewer = this.store.get(record.reviewerAgentId);
            if (reviewer && ev.phase === 'start') {
              this.setReviewerToolState(reviewer, ev.toolName, ev.toolStatus);
            }
          }
          idx = lineRemainder.indexOf('\n');
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrBuf.length < 8192) {
        stderrBuf += String(chunk);
      }
    });

    child.on('error', (err) => {
      if (handle.aborted) return;
      handle.aborted = true;
      clearTimeout(handle.timer);
      this.activeRuns.delete(record.reviewId);
      handle.cleanupFiles();
      this.failReview(record, err.message);
    });

    child.on('close', (code) => {
      if (handle.aborted) return;
      handle.aborted = true;
      clearTimeout(handle.timer);
      this.activeRuns.delete(record.reviewId);

      let outputText = stdoutBuf;
      if (record.reviewerVendor === 'codex') {
        try {
          if (fs.existsSync(outputPath)) {
            const fileOut = fs.readFileSync(outputPath, 'utf8');
            if (fileOut.trim()) {
              outputText = fileOut;
            }
          }
        } catch {
          /* fall back to stdout events below */
        }
        if (outputText === stdoutBuf) {
          const lastMsg = extractCodexLastAgentMessage(stdoutBuf);
          if (lastMsg) outputText = lastMsg;
        }
      }
      handle.cleanupFiles();

      if (code !== 0) {
        const envelopeErr = inspectCliFailureEnvelope(outputText);
        this.failReview(
          record,
          envelopeErr || stderrBuf || stdoutBuf || `exit ${String(code ?? 1)}`,
        );
        return;
      }

      const envelope = parseStructuredReviewOutput(outputText);
      if (envelope) {
        if (envelope.conversationId) {
          record.reviewerConversationId = envelope.conversationId;
        }
        this.completeReview(record, envelope.result);
        return;
      }

      const failureReason = inspectCliFailureEnvelope(outputText);
      if (failureReason) {
        this.failReview(record, failureReason);
        return;
      }

      const trimmedOut = outputText.trim();
      if (trimmedOut.startsWith('{') || trimmedOut.startsWith('[')) {
        this.failReview(record, 'invalid_structured_review_output');
        return;
      }

      const fallbackSummary = redactSensitiveText(clipText(outputText, 1200));
      if (fallbackSummary) {
        this.completeReview(record, {
          verdict: 'needs_info',
          summary: fallbackSummary,
          findings: [],
        });
        return;
      }

      this.failReview(record, 'empty_review_output');
    });
  }

  private completeReview(record: CrossVendorReviewRecord, result: CrossVendorReviewResult): void {
    if (!this.reviewsById.has(record.reviewId)) return;
    const ts = this.now();
    record.status = 'completed';
    record.result = result;
    record.error = undefined;
    record.completedAtMs = ts;
    record.updatedAtMs = ts;
    this.setReviewerIdle(record.reviewerAgentId);
  }

  private failReview(record: CrossVendorReviewRecord, rawError: string): void {
    if (!this.reviewsById.has(record.reviewId)) return;
    const ts = this.now();
    record.status = 'failed';
    record.error = redactSensitiveText(clipText(rawError, 240)) || 'review_failed';
    record.updatedAtMs = ts;
    this.setReviewerIdle(record.reviewerAgentId);
  }

  private abortActiveRun(reviewId: string): void {
    const handle = this.activeRuns.get(reviewId);
    if (!handle) return;
    handle.aborted = true;
    clearTimeout(handle.timer);
    this.activeRuns.delete(reviewId);
    try {
      handle.child.kill?.('SIGTERM');
    } catch {
      /* ignore kill failure */
    }
    handle.cleanupFiles();
  }

  private snapshotRecord(rec: CrossVendorReviewRecord): CrossVendorReviewRecord {
    return {
      ...rec,
      result: rec.result
        ? {
            ...rec.result,
            strengths: rec.result.strengths ? [...rec.result.strengths] : undefined,
            findings: rec.result.findings.map((f) => ({ ...f })),
            openQuestions: rec.result.openQuestions ? [...rec.result.openQuestions] : undefined,
          }
        : undefined,
    };
  }
}
