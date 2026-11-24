import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import type { ExternalProviderId } from './externalLogWatcher.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';

export type ChatDeliveryMode =
  'codex-queue' | 'codex-exec' | 'agy-print' | 'claude-pty' | 'claude-resume' | 'unsupported';

export interface ChatTargetInfo {
  agentId: number;
  canChat: boolean;
  reason?: 'subagent' | 'cli_missing';
  providerId: string;
  mode: ChatDeliveryMode;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestampMs?: number;
  pending?: boolean;
}

export interface ChatSendResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  mode?: ChatDeliveryMode;
  status?: 'queued' | 'dispatched' | 'sent';
  message?: ChatMessageItem;
}

export interface ChatMessagesResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  target?: ChatTargetInfo;
  messages?: ChatMessageItem[];
  pending?: boolean;
  lastError?: string | null;
}

export interface SpawnedProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface SpawnProcessOptions {
  cwd?: string;
  stdinText?: string;
}

export interface AgentChatBridgeOptions {
  store: AgentStateStore;
  ptyManager?: TerminalSessions;
  isSessionLocked?: (providerId: ExternalProviderId, sessionId: string) => boolean;
  resolveBin?: (name: string) => string | null;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  spawnProcess?: (
    cmd: string,
    args: readonly string[],
    opts: SpawnProcessOptions,
  ) => SpawnedProcessLike;
  now?: () => number;
}

const MAX_READ_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_INPUT_CHARS = 16_000;
const CODEX_ARGV_PROMPT_LIMIT = 4000;
export const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_.:-]{4,128}$/;
const CODEX_QUEUE_TIMEOUT_MS = 15_000;

const CODEX_BOILERPLATE_PREFIXES = [
  '<environment_context>',
  '<INSTRUCTIONS>',
  '# AGENTS.md',
  '<turn_aborted>',
  '<collaboration_mode>',
  '<permissions instructions>',
  '<app-context>',
];

const CLAUDE_META_PREFIXES = [
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clipText(text: string, maxLen = MAX_MESSAGE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const itemType = item.type;
    if (
      (itemType === 'text' || itemType === 'input_text' || itemType === 'output_text') &&
      typeof item.text === 'string' &&
      item.text.trim()
    ) {
      parts.push(item.text.trim());
    }
  }
  return parts.join('\n').trim();
}

/**
 * Pure eligibility rule: only top-level Meeting Room Leads and standalone main sessions
 * are communicable. Subagents, promoted background spawns, agent-spawned sessions,
 * and cross-vendor synthetic reviewers are never communicable.
 */
export function isCommunicableAgent(
  agent: Pick<AgentState, 'leadAgentId' | 'spawnToolUseId' | 'isAgentSpawned' | 'isReviewer'>,
): boolean {
  return (
    agent.leadAgentId === undefined &&
    !agent.spawnToolUseId &&
    agent.isAgentSpawned !== true &&
    agent.isReviewer !== true
  );
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate an executable CLI binary via env override (`AGY_BIN`, `CODEX_BIN`, `CLAUDE_BIN`),
 * PATH, and standard user/Homebrew/Gemini helper directories.
 */
export function resolveCliBinary(name: string, extraDirs?: readonly string[]): string | null {
  if (!extraDirs) {
    const envOverride = process.env[`${name.toUpperCase()}_BIN`];
    if (envOverride && isExecutableFile(envOverride)) {
      return envOverride;
    }
  }

  const dirs = new Set<string>();
  const envPath = process.env.PATH ?? '';
  for (const seg of envPath.split(path.delimiter)) {
    if (seg) dirs.add(seg);
  }
  const fallbackDirs = extraDirs ?? [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/Gemini.app/Contents/Helpers',
  ];
  for (const d of fallbackDirs) {
    if (d) dirs.add(d);
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read up to trailing 512 KB of a session JSONL file and extract user/assistant chat turns
 * for display in the chat dialog. Never reads reasoning/thinking or tool payloads.
 */
export function parseChatMessagesFromJsonl(
  filePath: string,
  providerId: string,
  limit = 24,
): ChatMessageItem[] {
  if (!filePath) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0) return [];

  const startOffset = Math.max(0, stat.size - MAX_READ_BYTES);
  let text = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = stat.size - startOffset;
      const buf = Buffer.alloc(len);
      const bytesRead = fs.readSync(fd, buf, 0, len, startOffset);
      text = buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  if (startOffset > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }

  const out: ChatMessageItem[] = [];
  const pushMsg = (role: 'user' | 'assistant', rawText: string, timestampMs?: number) => {
    const cleaned = clipText(rawText);
    if (!cleaned) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role && prev.text === cleaned) return;
    out.push({
      id: `log-${out.length}-${timestampMs ?? 0}`,
      role,
      text: cleaned,
      timestampMs,
    });
  };

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;

    const tsRaw = typeof obj.timestamp === 'string' ? obj.timestamp : obj.created_at;
    const parsedTs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    const tsMs = Number.isFinite(parsedTs) ? parsedTs : undefined;

    if (providerId === 'codex') {
      const payload = isRecord(obj.payload) ? obj.payload : null;
      if (!payload) continue;
      if (obj.type === 'response_item' && payload.type === 'message') {
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const body = extractTextContent(payload.content);
        if (!body) continue;
        if (role === 'user' && CODEX_BOILERPLATE_PREFIXES.some((p) => body.startsWith(p))) {
          continue;
        }
        pushMsg(role, body, tsMs);
      } else if (
        obj.type === 'event_msg' &&
        payload.type === 'task_complete' &&
        typeof payload.last_agent_message === 'string'
      ) {
        pushMsg('assistant', payload.last_agent_message, tsMs);
      }
    } else if (providerId === 'antigravity') {
      if (obj.type === 'USER_INPUT' && obj.source === 'USER_EXPLICIT') {
        if (typeof obj.content === 'string') {
          pushMsg('user', obj.content, tsMs);
        }
      } else if (obj.type === 'PLANNER_RESPONSE') {
        if (typeof obj.content === 'string') {
          pushMsg('assistant', obj.content, tsMs);
        }
      }
    } else {
      if (obj.isMeta === true) continue;
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const msgObj = isRecord(obj.message) ? obj.message : null;
      const body = msgObj ? extractTextContent(msgObj.content) : '';
      if (!body) continue;
      if (obj.type === 'user' && CLAUDE_META_PREFIXES.some((p) => body.startsWith(p))) {
        continue;
      }
      pushMsg(obj.type, body, tsMs);
    }
  }

  return out.slice(-limit);
}

function defaultExecFileAsync(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd || undefined,
        timeout: opts.timeout ?? CODEX_QUEUE_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || stdout?.trim() || err.message;
          reject(new Error(msg));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

function defaultSpawnProcess(
  cmd: string,
  args: readonly string[],
  opts: SpawnProcessOptions,
): SpawnedProcessLike {
  const useStdin = opts.stdinText !== undefined;
  const child = spawn(cmd, [...args], {
    cwd: opts.cwd || undefined,
    stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (useStdin && child.stdin) {
    child.stdin.on('error', () => {
      /* ignore broken pipe if child exits early */
    });
    child.stdin.end(opts.stdinText);
  }
  return child;
}

export function rawExternalSessionId(agent: AgentState, providerId: string): string {
  const prefix = `${providerId}-`;
  return agent.sessionId.startsWith(prefix)
    ? agent.sessionId.slice(prefix.length)
    : agent.sessionId;
}

export function existingCwd(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* ignore missing cwd */
  }
  return undefined;
}

interface AgentMemoryChat {
  messages: ChatMessageItem[];
  pending: boolean;
  lastError: string | null;
}

export class AgentChatBridge {
  private readonly store: AgentStateStore;
  private readonly ptyManager?: TerminalSessions;
  private readonly isSessionLocked: (providerId: ExternalProviderId, sessionId: string) => boolean;
  private readonly resolveBin: (name: string) => string | null;
  private readonly execFileAsync: (
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  private readonly spawnProcess: (
    cmd: string,
    args: readonly string[],
    opts: SpawnProcessOptions,
  ) => SpawnedProcessLike;
  private readonly now: () => number;
  private readonly memoryByAgent = new Map<number, AgentMemoryChat>();
  private readonly inFlightAgents = new Set<number>();
  private msgSeq = 0;

  constructor(options: AgentChatBridgeOptions) {
    this.store = options.store;
    this.ptyManager = options.ptyManager;
    this.isSessionLocked = options.isSessionLocked ?? (() => false);
    this.resolveBin = options.resolveBin ?? ((name) => resolveCliBinary(name));
    this.execFileAsync = options.execFileAsync ?? defaultExecFileAsync;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.now = options.now ?? (() => Date.now());
    this.store.on('agentRemoved', (id) => {
      this.memoryByAgent.delete(id);
      this.inFlightAgents.delete(id);
    });
  }

  private getMemory(agentId: number): AgentMemoryChat {
    let mem = this.memoryByAgent.get(agentId);
    if (!mem) {
      mem = { messages: [], pending: false, lastError: null };
      this.memoryByAgent.set(agentId, mem);
    }
    return mem;
  }

  targetFor(agent: AgentState): ChatTargetInfo {
    const providerId = agent.providerId ?? 'claude';
    if (!isCommunicableAgent(agent)) {
      return {
        agentId: agent.id,
        canChat: false,
        reason: 'subagent',
        providerId,
        mode: 'unsupported',
      };
    }

    if (providerId === 'codex') {
      const bin = this.resolveBin('codex');
      if (!bin) {
        return {
          agentId: agent.id,
          canChat: false,
          reason: 'cli_missing',
          providerId,
          mode: 'unsupported',
        };
      }
      const rawId = rawExternalSessionId(agent, 'codex');
      const mode = this.isSessionLocked('codex', rawId) ? 'codex-queue' : 'codex-exec';
      return { agentId: agent.id, canChat: true, providerId, mode };
    }

    if (providerId === 'antigravity') {
      const bin = this.resolveBin('agy');
      if (!bin) {
        return {
          agentId: agent.id,
          canChat: false,
          reason: 'cli_missing',
          providerId,
          mode: 'unsupported',
        };
      }
      return { agentId: agent.id, canChat: true, providerId, mode: 'agy-print' };
    }

    const pty = this.ptyManager?.get(agent.id);
    if ((pty && !pty.hasExited) || typeof agent.terminalRef?.sendText === 'function') {
      return { agentId: agent.id, canChat: true, providerId, mode: 'claude-pty' };
    }
    const claudeBin = this.resolveBin('claude');
    if (!claudeBin) {
      return {
        agentId: agent.id,
        canChat: false,
        reason: 'cli_missing',
        providerId,
        mode: 'unsupported',
      };
    }
    return { agentId: agent.id, canChat: true, providerId, mode: 'claude-resume' };
  }

  getTargets(): Record<number, ChatTargetInfo> {
    const out: Record<number, ChatTargetInfo> = {};
    for (const agent of this.store.values()) {
      out[agent.id] = this.targetFor(agent);
    }
    return out;
  }

  getMessages(agentId: number, limit = 24): ChatMessagesResult {
    const agent = this.store.get(agentId);
    if (!agent) {
      return { ok: false, statusCode: 404, error: 'agent_not_found' };
    }
    const target = this.targetFor(agent);
    if (!isCommunicableAgent(agent)) {
      return { ok: false, statusCode: 403, error: 'subagent_not_communicable', target };
    }

    const providerId = agent.providerId ?? 'claude';
    const logPath = agent.externalLogFile || agent.jsonlFile;
    const fromLog = parseChatMessagesFromJsonl(logPath, providerId, limit);
    const mem = this.memoryByAgent.get(agentId);

    const merged = [...fromLog];
    if (mem && mem.messages.length > 0) {
      const recentTail = fromLog.slice(-6);
      for (const m of mem.messages) {
        const alreadyInLog = recentTail.some(
          (l) => l.role === m.role && l.text.trim() === m.text.trim(),
        );
        if (!alreadyInLog) {
          merged.push(m);
        }
      }
    }

    return {
      ok: true,
      target,
      messages: merged.slice(-limit),
      pending: mem?.pending ?? false,
      lastError: mem?.lastError ?? null,
    };
  }

  async sendMessage(agentId: number, rawText: string): Promise<ChatSendResult> {
    const agent = this.store.get(agentId);
    if (!agent) {
      return { ok: false, statusCode: 404, error: 'agent_not_found' };
    }
    if (!isCommunicableAgent(agent)) {
      return { ok: false, statusCode: 403, error: 'subagent_not_communicable' };
    }

    const text = rawText.trim();
    if (!text) {
      return { ok: false, statusCode: 400, error: 'empty_message' };
    }
    if (text.length > MAX_INPUT_CHARS) {
      return { ok: false, statusCode: 400, error: 'message_too_long' };
    }

    const target = this.targetFor(agent);
    if (!target.canChat) {
      return { ok: false, statusCode: 400, error: target.reason ?? 'unsupported' };
    }
    if (this.inFlightAgents.has(agentId)) {
      return { ok: false, statusCode: 409, error: 'dispatch_in_progress' };
    }

    const providerId = agent.providerId ?? 'claude';
    const cwd = existingCwd(agent.projectDir);
    const ts = this.now();
    const userMsg: ChatMessageItem = {
      id: `mem-${++this.msgSeq}`,
      role: 'user',
      text,
      timestampMs: ts,
    };
    const mem = this.getMemory(agentId);
    mem.lastError = null;

    if (providerId === 'claude') {
      const pty = this.ptyManager?.get(agentId);
      if (pty && !pty.hasExited) {
        mem.messages.push(userMsg);
        pty.write(`${text}\r`);
        return { ok: true, mode: 'claude-pty', status: 'sent', message: userMsg };
      }
      if (typeof agent.terminalRef?.sendText === 'function') {
        mem.messages.push(userMsg);
        agent.terminalRef.sendText(text, true);
        return { ok: true, mode: 'claude-pty', status: 'sent', message: userMsg };
      }

      const claudeBin = this.resolveBin('claude');
      if (!claudeBin) {
        return { ok: false, statusCode: 400, error: 'cli_missing' };
      }
      if (!SAFE_SESSION_ID_RE.test(agent.sessionId)) {
        return { ok: false, statusCode: 400, error: 'invalid_session_id' };
      }
      mem.messages.push(userMsg);
      this.spawnReplyProcess(
        agentId,
        mem,
        claudeBin,
        ['--resume', agent.sessionId, '-p', text],
        cwd,
      );
      return { ok: true, mode: 'claude-resume', status: 'dispatched', message: userMsg };
    }

    const rawId = rawExternalSessionId(agent, providerId);
    if (!SAFE_SESSION_ID_RE.test(rawId)) {
      return { ok: false, statusCode: 400, error: 'invalid_session_id' };
    }

    if (providerId === 'codex') {
      const codexBin = this.resolveBin('codex');
      if (!codexBin) {
        return { ok: false, statusCode: 400, error: 'cli_missing' };
      }
      const queueArgs = ['queue', '--thread', rawId, '--message', text, '--resume'];
      if (cwd) {
        queueArgs.push('-C', cwd);
      }
      let queuedOk = false;
      this.inFlightAgents.add(agentId);
      try {
        await this.execFileAsync(codexBin, queueArgs, { cwd, timeout: CODEX_QUEUE_TIMEOUT_MS });
        queuedOk = true;
        mem.messages.push(userMsg);
        return { ok: true, mode: 'codex-queue', status: 'queued', message: userMsg };
      } catch (err) {
        if (this.isSessionLocked('codex', rawId)) {
          const errMsg = err instanceof Error ? clipText(err.message, 240) : 'codex_queue_failed';
          mem.lastError = errMsg;
          return { ok: false, statusCode: 409, error: errMsg };
        }
      } finally {
        this.inFlightAgents.delete(agentId);
      }
      if (!queuedOk) {
        mem.messages.push(userMsg);
        if (text.length > CODEX_ARGV_PROMPT_LIMIT) {
          this.spawnReplyProcess(agentId, mem, codexBin, ['exec', 'resume', rawId, '-'], cwd, text);
        } else {
          this.spawnReplyProcess(agentId, mem, codexBin, ['exec', 'resume', rawId, text], cwd);
        }
        return { ok: true, mode: 'codex-exec', status: 'dispatched', message: userMsg };
      }
    }

    if (providerId === 'antigravity') {
      const agyBin = this.resolveBin('agy');
      if (!agyBin) {
        return { ok: false, statusCode: 400, error: 'cli_missing' };
      }
      mem.messages.push(userMsg);
      this.spawnReplyProcess(agentId, mem, agyBin, ['--conversation', rawId, '-p', text], cwd);
      return { ok: true, mode: 'agy-print', status: 'dispatched', message: userMsg };
    }

    return { ok: false, statusCode: 400, error: 'unsupported' };
  }

  private spawnReplyProcess(
    agentId: number,
    mem: AgentMemoryChat,
    cmd: string,
    args: readonly string[],
    cwd: string | undefined,
    stdinText?: string,
  ): void {
    this.inFlightAgents.add(agentId);
    mem.pending = true;
    let stdoutBuf = '';
    let stderrBuf = '';
    let child: SpawnedProcessLike;
    try {
      const spawnOpts: SpawnProcessOptions = stdinText !== undefined ? { cwd, stdinText } : { cwd };
      child = this.spawnProcess(cmd, args, spawnOpts);
    } catch (err) {
      this.inFlightAgents.delete(agentId);
      mem.pending = false;
      mem.lastError = err instanceof Error ? clipText(err.message, 240) : 'spawn_failed';
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdoutBuf.length < 32_000) {
        stdoutBuf += String(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += String(chunk);
      }
    });
    child.on('error', (err) => {
      this.inFlightAgents.delete(agentId);
      mem.pending = false;
      mem.lastError = clipText(err.message, 240);
    });
    child.on('close', (code) => {
      this.inFlightAgents.delete(agentId);
      mem.pending = false;
      if (code === 0) {
        const reply = clipText(stdoutBuf);
        if (reply) {
          mem.messages.push({
            id: `mem-${++this.msgSeq}`,
            role: 'assistant',
            text: reply,
            timestampMs: this.now(),
          });
        }
      } else {
        const errText = clipText(stderrBuf || stdoutBuf || `exit ${String(code ?? 1)}`, 240);
        mem.lastError = errText;
        console.warn(
          `[AgentChatBridge] delivery failed for agent ${agentId} (exit=${String(code)})`,
        );
      }
    });
  }
}
