import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { DISMISSED_COOLDOWN_MS } from '../src/constants.js';
import {
  applyAntigravityRecord,
  applyCodexRecord,
  codexSessionIdFromFilename,
  createExternalSnapshot,
  ExternalLogWatcher,
  listCodexFiles,
  parseLsofLockOutput,
  seedFromFile,
  STALE_WORKING_MS,
} from '../src/externalLogWatcher.js';

describe('externalLogWatcher pure parsers', () => {
  it('parses Codex session_meta, task_started, tool call/output, token_count, and task_complete', () => {
    const s = createExternalSnapshot('fallback');
    applyCodexRecord({ type: 'session_meta', payload: { id: 'cdx-1', cwd: '/repo/visionai' } }, s);
    expect(s.sessionId).toBe('cdx-1');
    expect(s.cwd).toBe('/repo/visionai');

    applyCodexRecord(
      { type: 'event_msg', payload: { type: 'task_started', model_context_window: 272_000 } },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Thinking');
    expect(s.maxContextTokens).toBe(272_000);

    applyCodexRecord(
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-1',
          name: 'apply_patch',
          input: 'SECRET_PATCH_BODY',
        },
      },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Edit');
    expect(s.toolStatus).toBe('Editing files');
    expect(JSON.stringify(s)).not.toContain('SECRET_PATCH_BODY');

    applyCodexRecord(
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: 'SECRET_OUTPUT',
        },
      },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Thinking');

    applyCodexRecord(
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 272_000,
            last_token_usage: { total_tokens: 45_000 },
          },
        },
      },
      s,
    );
    expect(s.contextReported).toBe(true);
    expect(s.contextTokens).toBe(45_000);

    applyCodexRecord(
      {
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'SECRET_FINAL_TEXT' },
      },
      s,
    );
    expect(s.activity).toBe('idle');
    expect(s.awaitingInput).toBe(true);
    expect(s.toolName).toBeNull();
    expect(JSON.stringify(s)).not.toContain('SECRET_FINAL_TEXT');
  });

  it('extracts Codex session UUID from rollout filename', () => {
    expect(
      codexSessionIdFromFilename(
        'rollout-2026-11-19T14-42-45-01a1f28b-1cb4-7d33-88b3-02cd918b18e9.jsonl',
      ),
    ).toBe('01a1f28b-1cb4-7d33-88b3-02cd918b18e9');
  });

  it('parses Antigravity user input, tool calls, tool completion, and final planner response without leaking content', () => {
    const s = createExternalSnapshot('agy-1');
    applyAntigravityRecord(
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'SECRET_USER_PROMPT',
      },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Thinking');

    applyAntigravityRecord(
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 12_000,
        cache_read_tokens: 30_000,
        thinking: 'SECRET_THINKING',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'SECRET_CMD' } }],
      },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Bash');
    expect(s.toolStatus).toBe('Running command');
    expect(s.contextTokens).toBe(42_000);
    expect(s.contextReported).toBe(true);

    applyAntigravityRecord(
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: 'SECRET_TOOL_RESULT',
      },
      s,
    );
    expect(s.activity).toBe('working');
    expect(s.toolName).toBe('Thinking');

    applyAntigravityRecord(
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'SECRET_REPLY',
      },
      s,
    );
    expect(s.activity).toBe('idle');
    expect(s.awaitingInput).toBe(true);
    expect(s.toolName).toBeNull();
    expect(JSON.stringify(s)).not.toContain('SECRET_');
  });
});

describe('ExternalLogWatcher tail-seeding and live polling', () => {
  const tmpDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-watcher-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downgrades stale working session (>2m without writes) to idle on initial seed', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE' })}\n`,
    );
    const stat = fs.statSync(file);
    const seeded = seedFromFile(
      file,
      'antigravity',
      { size: stat.size, mtimeMs: stat.mtimeMs },
      stat.mtimeMs + STALE_WORKING_MS + 5_000,
      'conv-1',
    );
    expect(seeded.state.activity).toBe('idle');
    expect(seeded.state.awaitingInput).toBe(true);
  });

  it('immediately adopts both idle Codex and working Antigravity sessions from existing file tails, then tracks live transitions and dismissal cooldown', () => {
    const root = makeTempDir();
    const codexRoot = path.join(root, 'codex');
    const agyRoot = path.join(root, 'agy');
    const nowMs = Date.now();
    const d = new Date(nowMs);
    const codexDayDir = path.join(
      codexRoot,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDayDir, { recursive: true });

    const codexFile = path.join(
      codexDayDir,
      'rollout-2026-11-20T08-00-00-11111111-2222-3333-4444-555555555555.jsonl',
    );
    const codexInitial =
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '11111111-2222-3333-4444-555555555555', cwd: '/Users/dev/my-app' },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      ].join('\n') + '\n';
    fs.writeFileSync(codexFile, codexInitial);

    const agyDir = path.join(
      agyRoot,
      'aaaa1111-bbbb-cccc-dddd-eeeeffff0000',
      '.system_generated',
      'logs',
    );
    fs.mkdirSync(agyDir, { recursive: true });
    const agyFile = path.join(agyDir, 'transcript.jsonl');
    const agyInitial =
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'read_file' }],
        }),
      ].join('\n') + '\n';
    fs.writeFileSync(agyFile, agyInitial);

    let clock = nowMs;
    const store = new AgentStateStore();
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (msg) => broadcasts.push(msg));

    const watcher = new ExternalLogWatcher({
      store,
      codexRoot,
      antigravityRoot: agyRoot,
      now: () => clock,
    });

    watcher.pollOnce();
    expect(store.size).toBe(2);

    const agents = [...store.values()];
    const codexAgent = agents.find((a) => a.providerId === 'codex')!;
    const agyAgent = agents.find((a) => a.providerId === 'antigravity')!;

    expect(codexAgent).toBeDefined();
    expect(codexAgent.directoryName).toBe('my-app');
    expect(codexAgent.isWaiting).toBe(true);
    expect(codexAgent.awaitingInput).toBe(true);

    expect(agyAgent).toBeDefined();
    expect(agyAgent.directoryName).toBe('Chat aaaa1111');
    expect(agyAgent.isWaiting).toBe(false);
    expect(agyAgent.turnActive).toBe(true);
    expect([...agyAgent.activeToolNames.values()]).toEqual(['Read']);

    // Verify files were never modified by watcher (strictly read-only)
    expect(fs.readFileSync(codexFile, 'utf8')).toBe(codexInitial);
    expect(fs.readFileSync(agyFile, 'utf8')).toBe(agyInitial);

    // Transition Antigravity from working -> idle on new line
    fs.appendFileSync(
      agyFile,
      `${JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' })}\n`,
    );
    clock += 1_000;
    watcher.pollOnce();
    expect(agyAgent.isWaiting).toBe(true);
    expect(agyAgent.turnActive).toBe(false);
    expect(agyAgent.activeToolIds.size).toBe(0);

    // Manual dismissal (user clicks close) suppresses re-adoption during cooldown
    store.delete(codexAgent.id);
    expect(store.size).toBe(1);
    clock += 10_000;
    watcher.pollOnce();
    expect(store.size).toBe(1);

    // But new live activity after dismissal re-adopts immediately even before cooldown ends
    fs.appendFileSync(
      codexFile,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
    );
    clock += 1_000;
    watcher.pollOnce();
    expect(store.size).toBe(2);
    const readoptedCodex = [...store.values()].find((a) => a.providerId === 'codex')!;
    expect(readoptedCodex.turnActive).toBe(true);
    expect(readoptedCodex.isWaiting).toBe(false);

    // Dismiss again and advance past cooldown without new writes -> re-adopted after cooldown
    store.delete(readoptedCodex.id);
    clock += DISMISSED_COOLDOWN_MS + 1_000;
    watcher.pollOnce();
    expect(store.size).toBe(2);

    watcher.dispose();
  });

  it('discovers old resumed Codex sessions via open locks, parses lsof + session_index titles, serves archive, and supports pinning', () => {
    const root = makeTempDir();
    const codexRoot = path.join(root, 'codex-sessions');
    const agyRoot = path.join(root, 'agy-brain');
    const claudeRoot = path.join(root, 'claude-projects');
    const codexLocksDir = path.join(root, 'thread-writer-locks');
    const agyPresenceDir = path.join(root, 'presence');
    const codexIndexFile = path.join(root, 'session_index.jsonl');

    // Old Codex session created 2 months ago (e.g. 2026/09/01)
    const oldSessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const archivedSessionId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const oldDayDir = path.join(codexRoot, '2026', '09', '01');
    fs.mkdirSync(oldDayDir, { recursive: true });
    const oldFile = path.join(oldDayDir, `rollout-2026-09-01T10-00-00-${oldSessionId}.jsonl`);
    const archivedFile = path.join(
      oldDayDir,
      `rollout-2026-09-01T08-00-00-${archivedSessionId}.jsonl`,
    );
    fs.writeFileSync(
      oldFile,
      `${JSON.stringify({ type: 'session_meta', payload: { id: oldSessionId, cwd: '/work/resumed-app' } })}\n`,
    );
    fs.writeFileSync(
      archivedFile,
      `${JSON.stringify({ type: 'session_meta', payload: { id: archivedSessionId, cwd: '/work/old-archive' } })}\n`,
    );

    // Backdate both files by 5 days so they are OUTSIDE recentWindowMs
    const nowMs = Date.now();
    const fiveDaysAgo = new Date(nowMs - 5 * 86_400_000);
    fs.utimesSync(oldFile, fiveDaysAgo, fiveDaysAgo);
    fs.utimesSync(archivedFile, fiveDaysAgo, fiveDaysAgo);

    // Write session_index.jsonl titles
    fs.writeFileSync(
      codexIndexFile,
      [
        JSON.stringify({
          id: oldSessionId,
          thread_name: 'Resumed Checkout Fix',
          updated_at: fiveDaysAgo.toISOString(),
        }),
        JSON.stringify({
          id: archivedSessionId,
          thread_name: 'Archived Migration Task',
          updated_at: fiveDaysAgo.toISOString(),
        }),
      ].join('\n') + '\n',
    );

    // Also create a Claude project log so archive lists all 3 providers
    const claudeProjDir = path.join(claudeRoot, '-Users-dev-claude-repo');
    fs.mkdirSync(claudeProjDir, { recursive: true });
    fs.writeFileSync(path.join(claudeProjDir, 'claude-sess-9999.jsonl'), '{"type":"user"}\n');

    // Verify recursive listCodexFiles finds old-date files
    expect(listCodexFiles(codexRoot).length).toBe(2);

    // Verify parseLsofLockOutput ignores .coordination.lock and resolves lock directories
    const lsofSample = [
      'p90861',
      `n${codexLocksDir}/.coordination.lock`,
      `n${codexLocksDir}/${oldSessionId}.lock`,
      `n${agyPresenceDir}/cccc1111-2222-3333-4444-555555555555.lock`,
    ].join('\n');
    const parsedLocks = parseLsofLockOutput(lsofSample, codexLocksDir, agyPresenceDir);
    expect([...parsedLocks.codex]).toEqual([oldSessionId]);
    expect([...parsedLocks.antigravity]).toEqual(['cccc1111-2222-3333-4444-555555555555']);

    let clock = nowMs;
    const store = new AgentStateStore();
    const watcher = new ExternalLogWatcher({
      store,
      codexRoot,
      antigravityRoot: agyRoot,
      codexLocksDir,
      codexIndexFile,
      antigravityPresenceDir: agyPresenceDir,
      claudeProjectsRoot: claudeRoot,
      detectOpenLocks: () => parsedLocks,
      recentWindowMs: 60 * 60_000,
      expireAfterMs: 60 * 60_000,
      now: () => clock,
    });

    watcher.start();
    // Only oldSessionId is live-locked; archivedSessionId stays archived
    expect(store.size).toBe(1);
    const liveCodex = [...store.values()][0];
    expect(liveCodex.directoryName).toContain('resumed-app');
    expect(liveCodex.directoryName).toContain('Resumed Checkout');

    // Advancing clock way past expireAfterMs MUST NOT expire an open-locked session
    clock += 4 * 60 * 60_000;
    watcher.pollOnce();
    expect(store.size).toBe(1);

    // Archive lists Codex (live + archived) and Claude
    const archive = watcher.getArchiveEntries(50);
    expect(archive.some((b) => b.id === oldSessionId && b.isLive && b.isOpenLock)).toBe(true);
    expect(
      archive.some(
        (b) =>
          b.id === archivedSessionId &&
          !b.isLive &&
          b.title === 'Archived Migration Task' &&
          b.resumeCommand === `codex resume ${archivedSessionId}`,
      ),
    ).toBe(true);
    expect(
      archive.some(
        (b) =>
          b.providerId === 'claude' &&
          b.id === 'claude-sess-9999' &&
          b.resumeCommand === 'claude --resume claude-sess-9999',
      ),
    ).toBe(true);

    // Pin archived Codex session -> summons it onto the office floor immediately
    const pinResult = watcher.pinSession('codex', archivedSessionId);
    expect(pinResult.ok).toBe(true);
    expect(typeof pinResult.agentId).toBe('number');
    expect(store.size).toBe(2);

    // Pinned session also survives past expireAfterMs
    clock += 4 * 60 * 60_000;
    watcher.pollOnce();
    expect(store.size).toBe(2);

    watcher.dispose();
  });

  it('links Codex subagents via parent_thread_id/thread_spawn and emits agentTeamInfo + cleans up isTeamLead on child removal', () => {
    const root = makeTempDir();
    const codexRoot = path.join(root, 'codex');
    const agyRoot = path.join(root, 'agy');
    const nowMs = Date.now();
    const dayDir = path.join(codexRoot, '2026', '11', '24');
    fs.mkdirSync(dayDir, { recursive: true });

    const parentId = '11111111-1111-1111-1111-111111111111';
    const childThreadSpawnId = '22222222-2222-2222-2222-222222222222';
    const childOtherId = '33333333-3333-3333-3333-333333333333';

    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-11-24T10-00-00-${parentId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: parentId, cwd: '/work/proj-a', source: 'vscode' } })}\n`,
    );
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-11-24T10-01-00-${childThreadSpawnId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childThreadSpawnId,
          cwd: '/work/proj-a',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
                agent_nickname: 'Aristotle',
                agent_role: 'explorer',
              },
            },
          },
        },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-11-24T10-02-00-${childOtherId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childOtherId,
          cwd: '/work/proj-a',
          parent_thread_id: parentId,
          source: { subagent: { other: 'memory_consolidation' } },
        },
      })}\n`,
    );

    const store = new AgentStateStore();
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));

    const watcher = new ExternalLogWatcher({
      store,
      codexRoot,
      antigravityRoot: agyRoot,
      now: () => nowMs,
    });
    watcher.pollOnce();

    const agents = [...store.values()];
    const parentAgent = agents.find((a) => a.sessionId === `codex-${parentId}`)!;
    const subSpawnAgent = agents.find((a) => a.sessionId === `codex-${childThreadSpawnId}`)!;
    const subOtherAgent = agents.find((a) => a.sessionId === `codex-${childOtherId}`)!;

    expect(parentAgent.isTeamLead).toBe(true);
    expect(subSpawnAgent.leadAgentId).toBe(parentAgent.id);
    expect(subSpawnAgent.agentName).toBe('Aristotle');
    expect(subOtherAgent.leadAgentId).toBe(parentAgent.id);
    expect(subOtherAgent.agentName).toBe('Memory Consolidation');

    expect(
      broadcasts.some(
        (m) =>
          m.type === 'agentTeamInfo' &&
          m.id === subSpawnAgent.id &&
          m.leadAgentId === parentAgent.id &&
          m.agentName === 'Aristotle',
      ),
    ).toBe(true);

    // Removing all children clears isTeamLead on parent cleanly
    store.delete(subSpawnAgent.id);
    store.delete(subOtherAgent.id);
    expect(parentAgent.isTeamLead).toBeUndefined();

    watcher.dispose();
  });

  it('links Antigravity invoke_subagent Role + GENERIC child UUID without reading Prompt text', () => {
    const root = makeTempDir();
    const codexRoot = path.join(root, 'codex');
    const agyRoot = path.join(root, 'agy');
    const nowMs = Date.now();

    const parentUuid = 'aaaa0000-1111-2222-3333-444455556666';
    const childUuid = 'bbbb0000-1111-2222-3333-444455556666';

    const makeLog = (uuid: string, lines: unknown[]) => {
      const dir = path.join(agyRoot, uuid, '.system_generated', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'transcript.jsonl'),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
    };

    makeLog(parentUuid, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'SECRET_PROMPT',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'invoke_subagent',
            args: { Role: 'UI Auditor', TypeName: 'research', Prompt: 'SECRET_SUB_PROMPT' },
          },
        ],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        content: `Subagent conversation ${childUuid} completed`,
      },
    ]);
    makeLog(childUuid, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'SECRET_SUB_PROMPT',
      },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' },
    ]);

    const store = new AgentStateStore();
    const watcher = new ExternalLogWatcher({
      store,
      codexRoot,
      antigravityRoot: agyRoot,
      now: () => nowMs,
    });
    watcher.pollOnce();

    const parentAgent = [...store.values()].find(
      (a) => a.sessionId === `antigravity-${parentUuid}`,
    )!;
    const childAgent = [...store.values()].find((a) => a.sessionId === `antigravity-${childUuid}`)!;
    expect(parentAgent.isTeamLead).toBe(true);
    expect(childAgent.leadAgentId).toBe(parentAgent.id);
    expect(childAgent.agentName).toBe('UI Auditor');
    expect(JSON.stringify(childAgent)).not.toContain('SECRET_');

    watcher.dispose();
  });

  it('unquotes JSON-encoded Antigravity args, scans >256KB history for subagents, labels workspace, and keeps recent subagents attached to live parent', () => {
    const root = makeTempDir();
    const codexRoot = path.join(root, 'codex');
    const agyRoot = path.join(root, 'agy');
    const agyPres = path.join(root, 'agy-presence');
    fs.mkdirSync(agyPres, { recursive: true });
    const repoDir = path.join(root, 'visionai');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

    const nowMs = Date.now();
    const parentUuid = '1111aaaa-2222-3333-4444-555566667777';
    const recentChildUuid = '2222bbbb-2222-3333-4444-555566667777';
    const staleChildUuid = '3333cccc-2222-3333-4444-555566667777';

    const parentLogDir = path.join(agyRoot, parentUuid, '.system_generated', 'logs');
    const recentChildDir = path.join(agyRoot, recentChildUuid, '.system_generated', 'logs');
    const staleChildDir = path.join(agyRoot, staleChildUuid, '.system_generated', 'logs');
    fs.mkdirSync(parentLogDir, { recursive: true });
    fs.mkdirSync(recentChildDir, { recursive: true });
    fs.mkdirSync(staleChildDir, { recursive: true });

    const fillerLines = Array.from({ length: 420 }, (_, i) =>
      JSON.stringify({
        step_index: 10 + i,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `padding chunk ${i} ${'x'.repeat(700)}`,
      }),
    );

    const parentLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
      }),
      // Step 1: parallel read_file (JSON-quoted args.Path) + invoke_subagent (JSON-quoted Role)
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'read_file',
            args: { Path: JSON.stringify(path.join(repoDir, 'server', 'index.ts')) },
          },
          {
            name: 'invoke_subagent',
            args: { Role: '"Cross-Vendor Reviewer Researcher"', TypeName: '"research"' },
          },
        ],
      }),
      // Noise GENERIC containing an unrelated UUID must NOT consume pending subagent role
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: 'Read output mentioning uuid ffffffff-ffff-ffff-ffff-ffffffffffff',
      }),
      // Real Antigravity spawn GENERIC response at top of a >300KB transcript
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created the following subagent:\n{\n  "conversationId": "${recentChildUuid}",\n  "workspaceUris": ["file://${repoDir}"]\n}`,
      }),
      JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'invoke_subagent',
            args: { Role: '"Stale Legacy Worker"', TypeName: '"general"' },
          },
        ],
      }),
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `Created the following subagent:\n{\n  "conversationId": "${staleChildUuid}"\n}`,
      }),
      ...fillerLines,
    ];

    const parentLogFile = path.join(parentLogDir, 'transcript.jsonl');
    fs.writeFileSync(parentLogFile, `${parentLines.join('\n')}\n`);
    expect(fs.statSync(parentLogFile).size).toBeGreaterThan(260 * 1024);

    const recentChildFile = path.join(recentChildDir, 'transcript.jsonl');
    fs.writeFileSync(
      recentChildFile,
      `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE' })}\n`,
    );
    // 90 minutes old: outside default recentWindowMs (60m), inside SUBAGENT_FOLLOW_WINDOW_MS (4h)
    const ninetyMinAgo = new Date(nowMs - 90 * 60_000);
    fs.utimesSync(recentChildFile, ninetyMinAgo, ninetyMinAgo);

    const staleChildFile = path.join(staleChildDir, 'transcript.jsonl');
    fs.writeFileSync(
      staleChildFile,
      `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE' })}\n`,
    );
    // 6 hours old: outside SUBAGENT_FOLLOW_WINDOW_MS (4h), must not attach
    const sixHoursAgo = new Date(nowMs - 6 * 60 * 60_000);
    fs.utimesSync(staleChildFile, sixHoursAgo, sixHoursAgo);

    const store = new AgentStateStore();
    const watcher = new ExternalLogWatcher({
      store,
      codexRoot,
      antigravityRoot: agyRoot,
      antigravityPresenceDir: agyPres,
      detectOpenLocks: () => ({ codex: new Set(), antigravity: new Set([parentUuid]) }),
      recentWindowMs: 60 * 60_000,
      expireAfterMs: 60 * 60_000,
      now: () => nowMs,
    });

    watcher.pollOnce();

    const agents = [...store.values()];
    const parent = agents.find((a) => a.sessionId === `antigravity-${parentUuid}`);
    const recentChild = agents.find((a) => a.sessionId === `antigravity-${recentChildUuid}`);
    const staleChild = agents.find((a) => a.sessionId === `antigravity-${staleChildUuid}`);

    expect(parent).toBeDefined();
    expect(parent?.projectDir).toBe(repoDir);
    expect(parent?.directoryName).toBe('visionai · Chat 1111aaaa');
    expect(parent?.isTeamLead).toBe(true);

    expect(recentChild).toBeDefined();
    expect(recentChild?.leadAgentId).toBe(parent?.id);
    expect(recentChild?.agentName).toBe('Cross-Vendor Reviewer Researcher');
    expect(staleChild).toBeUndefined();

    // Must remain attached even after another poll tick past expireAfterMs
    watcher.pollOnce();
    expect(store.has(recentChild!.id)).toBe(true);

    watcher.dispose();
  });
});
