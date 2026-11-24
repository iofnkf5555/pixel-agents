import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentChatBridge,
  isCommunicableAgent,
  parseChatMessagesFromJsonl,
  type SpawnedProcessLike,
} from '../src/agentChatBridge.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';
import type { TerminalSession, TerminalSessions } from '../src/terminal/terminalSessions.js';

function createFakeProcess(onSpawn?: (proc: FakeChild) => void): SpawnedProcessLike {
  return new FakeChild(onSpawn);
}

class FakeChild extends EventEmitter implements SpawnedProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(onReady?: (proc: FakeChild) => void) {
    super();
    if (onReady) {
      queueMicrotask(() => onReady(this));
    }
  }
}

describe('agentChatBridge', () => {
  const tmpDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('allows only Leads and standalone main sessions via isCommunicableAgent', () => {
    expect(
      isCommunicableAgent({
        leadAgentId: undefined,
        spawnToolUseId: undefined,
        isAgentSpawned: undefined,
      }),
    ).toBe(true);
    expect(isCommunicableAgent({ leadAgentId: 1 })).toBe(false);
    expect(isCommunicableAgent({ spawnToolUseId: 'toolu_123' })).toBe(false);
    expect(isCommunicableAgent({ isAgentSpawned: true })).toBe(false);
  });

  it('extracts user and assistant turns from Codex, Antigravity, and Claude JSONL while filtering boilerplate & thinking', () => {
    const dir = makeTempDir();

    const codexFile = path.join(dir, 'codex.jsonl');
    fs.writeFileSync(
      codexFile,
      [
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-11-24T10:00:00Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<environment_context><cwd>/tmp</cwd></environment_context>',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-11-24T10:00:01Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect module A' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ text: 'SECRET_THOUGHT' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-11-24T10:00:05Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Module A looks good.' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-24T10:00:06Z',
          payload: { type: 'task_complete', last_agent_message: 'Module A looks good.' },
        }),
      ].join('\n') + '\n',
    );

    const codexMsgs = parseChatMessagesFromJsonl(codexFile, 'codex');
    expect(codexMsgs.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: 'user', text: 'Inspect module A' },
      { role: 'assistant', text: 'Module A looks good.' },
    ]);

    const agyFile = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      agyFile,
      [
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Check logs' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          content: 'Logs verified.',
          thinking: 'PRIVATE_CHAIN_OF_THOUGHT',
        }),
      ].join('\n') + '\n',
    );
    expect(parseChatMessagesFromJsonl(agyFile, 'antigravity').map((m) => [m.role, m.text])).toEqual(
      [
        ['user', 'Check logs'],
        ['assistant', 'Logs verified.'],
      ],
    );

    const claudeFile = path.join(dir, 'claude.jsonl');
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
        JSON.stringify({
          type: 'user',
          message: { content: '<command-message>foo</command-message>' },
        }),
        JSON.stringify({ type: 'user', message: { content: 'Run test suite' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'SECRET_CLAUDE_THINKING' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
              { type: 'text', text: 'All tests passed.' },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    expect(parseChatMessagesFromJsonl(claudeFile, 'claude').map((m) => [m.role, m.text])).toEqual([
      ['user', 'Run test suite'],
      ['assistant', 'All tests passed.'],
    ]);
  });

  it('dispatches messages for Leads and standalone sessions, and rejects subagents/spawned sessions', async () => {
    const store = new AgentStateStore();
    const dir = makeTempDir();

    const ptyWrite = vi.fn();
    const fakePtySession: TerminalSession = {
      agentId: 4,
      pid: 1234,
      cols: 80,
      rows: 24,
      hasExited: false,
      onData: () => () => {},
      onExit: () => () => {},
      replay: async () => ({ data: '', seq: 0, cols: 80, rows: 24 }),
      write: ptyWrite,
      resize: () => {},
    };
    const fakePtyManager: TerminalSessions = {
      enabled: true,
      isAvailable: () => true,
      unavailableReason: () => null,
      moduleId: () => 'fake',
      create: () => fakePtySession,
      get: (id) => (id === 4 ? fakePtySession : undefined),
      has: (id) => id === 4,
      dispose: () => {},
      survivors: () => [],
      shutdown: async () => {},
    };

    const codexLead = createAgentState({
      id: 1,
      sessionId: 'codex-11111111-1111-1111-1111-111111111111',
      isExternal: true,
      isTeamLead: true,
      providerId: 'codex',
      projectDir: dir,
      jsonlFile: '',
    });
    const codexChild = createAgentState({
      id: 2,
      sessionId: 'codex-22222222-2222-2222-2222-222222222222',
      isExternal: true,
      leadAgentId: 1,
      isAgentSpawned: true,
      providerId: 'codex',
      projectDir: dir,
      jsonlFile: '',
    });
    const agySolo = createAgentState({
      id: 3,
      sessionId: 'antigravity-33333333-3333-3333-3333-333333333333',
      isExternal: true,
      providerId: 'antigravity',
      projectDir: dir,
      jsonlFile: '',
    });
    const claudePty = createAgentState({
      id: 4,
      sessionId: 'claude-44444444',
      isExternal: false,
      providerId: 'claude',
      projectDir: dir,
      jsonlFile: '',
    });
    const orphanSub = createAgentState({
      id: 5,
      sessionId: 'antigravity-55555555-5555-5555-5555-555555555555',
      isExternal: true,
      isAgentSpawned: true,
      providerId: 'antigravity',
      projectDir: dir,
      jsonlFile: '',
    });

    for (const a of [codexLead, codexChild, agySolo, claudePty, orphanSub]) store.set(a.id, a);

    const execCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    let lockedCodex = true;

    const bridge = new AgentChatBridge({
      store,
      ptyManager: fakePtyManager,
      isSessionLocked: (p, id) => p === 'codex' && id.startsWith('1111') && lockedCodex,
      resolveBin: (name) => `/usr/local/bin/${name}`,
      execFileAsync: async (cmd, args) => {
        execCalls.push({ cmd, args });
        if (!lockedCodex) throw new Error('daemon offline');
        return { stdout: '', stderr: '' };
      },
      spawnProcess: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return createFakeProcess((proc) => {
          proc.stdout.write('CLI reply text');
          proc.stdout.end();
          proc.emit('close', 0);
        });
      },
    });

    const targets = bridge.getTargets();
    expect(targets[1].canChat).toBe(true);
    expect(targets[1].mode).toBe('codex-queue');
    expect(targets[2]).toMatchObject({ agentId: 2, canChat: false, reason: 'subagent' });
    expect(targets[3]).toMatchObject({ agentId: 3, canChat: true, mode: 'agy-print' });
    expect(targets[4]).toMatchObject({ agentId: 4, canChat: true, mode: 'claude-pty' });
    expect(targets[5]).toMatchObject({ agentId: 5, canChat: false, reason: 'subagent' });

    // Subagent and orphan agent-spawned session blocked
    expect(await bridge.sendMessage(2, 'hi')).toMatchObject({
      ok: false,
      statusCode: 403,
      error: 'subagent_not_communicable',
    });
    expect(await bridge.sendMessage(5, 'hi')).toMatchObject({
      ok: false,
      statusCode: 403,
      error: 'subagent_not_communicable',
    });

    // Codex Lead locked -> codex queue
    const r1 = await bridge.sendMessage(1, 'hello lead');
    expect(r1).toMatchObject({ ok: true, mode: 'codex-queue', status: 'queued' });
    expect(execCalls[0]).toEqual({
      cmd: '/usr/local/bin/codex',
      args: [
        'queue',
        '--thread',
        '11111111-1111-1111-1111-111111111111',
        '--message',
        'hello lead',
        '--resume',
        '-C',
        dir,
      ],
    });

    // Codex unlocked + queue fails -> codex exec resume fallback
    lockedCodex = false;
    const r1b = await bridge.sendMessage(1, 'resume fallback');
    expect(r1b).toMatchObject({ ok: true, mode: 'codex-exec', status: 'dispatched' });
    expect(spawnCalls[0]).toEqual({
      cmd: '/usr/local/bin/codex',
      args: ['exec', 'resume', '11111111-1111-1111-1111-111111111111', 'resume fallback'],
    });

    // Antigravity Solo -> agy --conversation ... -p ...
    const r3 = await bridge.sendMessage(3, 'hello agy');
    expect(r3).toMatchObject({ ok: true, mode: 'agy-print', status: 'dispatched' });
    expect(spawnCalls[1]).toEqual({
      cmd: '/usr/local/bin/agy',
      args: ['--conversation', '33333333-3333-3333-3333-333333333333', '-p', 'hello agy'],
    });

    // Claude PTY -> pty.write
    const r4 = await bridge.sendMessage(4, 'hello claude');
    expect(r4).toMatchObject({ ok: true, mode: 'claude-pty', status: 'sent' });
    expect(ptyWrite).toHaveBeenCalledWith('hello claude\r');

    await new Promise((r) => setTimeout(r, 20));
    const agyHistory = bridge.getMessages(3);
    expect(agyHistory.ok).toBe(true);
    expect(
      agyHistory.messages?.some((m) => m.role === 'assistant' && m.text === 'CLI reply text'),
    ).toBe(true);
  });

  it('enforces token auth and rejects subagent chat HTTP requests with 403', async () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'codex-11111111-1111-1111-1111-111111111111',
        isExternal: true,
        isTeamLead: true,
        providerId: 'codex',
        projectDir: '',
        jsonlFile: '',
      }),
    );
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 'codex-22222222-2222-2222-2222-222222222222',
        isExternal: true,
        leadAgentId: 1,
        isAgentSpawned: true,
        providerId: 'codex',
        projectDir: '',
        jsonlFile: '',
      }),
    );

    const bridge = new AgentChatBridge({
      store,
      resolveBin: () => '/usr/local/bin/codex',
      execFileAsync: async () => ({ stdout: '', stderr: '' }),
    });

    const handle = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      port: 0,
      token: 'secret-token',
      store,
      chatBridge: bridge,
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;

      const unauth = await fetch(`${base}/api/chat/targets`);
      expect(unauth.status).toBe(401);

      const badOrigin = await fetch(`${base}/api/chat/targets?token=secret-token`, {
        headers: { Origin: 'http://evil.example' },
      });
      expect(badOrigin.status).toBe(403);

      const okTargets = await fetch(`${base}/api/chat/targets?token=secret-token`);
      expect(okTargets.status).toBe(200);
      const targetsJson = (await okTargets.json()) as {
        targets: Record<string, { canChat: boolean; reason?: string }>;
      };
      expect(targetsJson.targets['1'].canChat).toBe(true);
      expect(targetsJson.targets['2'].canChat).toBe(false);
      expect(targetsJson.targets['2'].reason).toBe('subagent');

      const subGet = await fetch(`${base}/api/agents/2/messages?token=secret-token`);
      expect(subGet.status).toBe(403);

      const subPost = await fetch(`${base}/api/agents/2/message?token=secret-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello subagent' }),
      });
      expect(subPost.status).toBe(403);
      expect(await subPost.json()).toMatchObject({ ok: false, error: 'subagent_not_communicable' });

      const leadPost = await fetch(`${base}/api/agents/1/message?token=secret-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello lead' }),
      });
      expect(leadPost.status).toBe(200);
      expect(await leadPost.json()).toMatchObject({ ok: true, mode: 'codex-queue' });
    } finally {
      await handle.app.close();
    }
  });
});
