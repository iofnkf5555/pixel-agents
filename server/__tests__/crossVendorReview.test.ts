import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentChatBridge,
  isCommunicableAgent,
  resolveCliBinary,
  type SpawnedProcessLike,
} from '../src/agentChatBridge.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  CrossVendorReviewService,
  formatReviewForHost,
  parseStructuredReviewOutput,
  redactSensitiveText,
  type ReviewSpawnOptions,
} from '../src/crossVendorReview.js';
import {
  applyAntigravityRecord,
  createExternalSnapshot,
  ExternalLogWatcher,
  inferCwdFromToolArgs,
} from '../src/externalLogWatcher.js';
import { createHttpServer } from '../src/httpServer.js';

class FakeReviewChild extends EventEmitter implements SpawnedProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('crossVendorReview & prerequisites', () => {
  const tmpDirs: string[] = [];

  function makeTempDir(prefix = 'cross-review-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('redacts tokens, secrets, and thinking tags without losing safe context', () => {
    const dirty = [
      '<thinking>hidden chain</thinking>',
      'Use api_key="sk-1234567890abcdef12345" or ghp_abcdefghijklmnopqrstuvwxyz1234',
      'Header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload',
      'Safe finding in src/httpServer.ts line 42.',
    ].join('\n');

    const cleaned = redactSensitiveText(dirty);
    expect(cleaned).not.toContain('hidden chain');
    expect(cleaned).not.toContain('sk-1234567890abcdef12345');
    expect(cleaned).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(cleaned).toContain('Safe finding in src/httpServer.ts line 42.');
  });

  it('parses structured review output across raw JSON, markdown fences, and agy wrappers', () => {
    const direct = parseStructuredReviewOutput(
      JSON.stringify({
        verdict: 'caution',
        summary: '整體架構安全，但需要注意並行呼叫。',
        findings: [
          {
            severity: 'high',
            file: 'server/src/httpServer.ts',
            issue: '缺少輸入驗證',
            suggestion: '檢查 hostAgentId 是否為正整數',
          },
        ],
        openQuestions: ['是否需要保留跨頁籤同步？'],
        recommendedNextStep: '補上驗證測試',
      }),
    );
    expect(direct?.result.verdict).toBe('caution');
    expect(direct?.result.findings).toHaveLength(1);
    expect(direct?.result.findings[0].severity).toBe('high');

    const agyWrapped = parseStructuredReviewOutput(
      JSON.stringify({
        conversation_id: 'agy-conv-9988',
        result:
          '```json\n{"verdict":"approve","summary":"沒問題","strengths":["清晰"],"findings":[],"openQuestions":[],"recommendedNextStep":null}\n```',
      }),
    );
    expect(agyWrapped?.conversationId).toBe('agy-conv-9988');
    expect(agyWrapped?.result.verdict).toBe('approve');
    expect(agyWrapped?.result.recommendedNextStep).toBeUndefined();

    expect(parseStructuredReviewOutput('not json at all')).toBeNull();
    expect(
      parseStructuredReviewOutput(JSON.stringify({ verdict: 'unknown', summary: 'x' })),
    ).toBeNull();
  });

  it('formats review summaries for host Lead concisely without leaking secrets', () => {
    const formatted = formatReviewForHost({
      reviewId: 'rev-1',
      hostAgentId: 1,
      hostVendor: 'codex',
      hostLabel: 'visionai · Build',
      reviewerVendor: 'antigravity',
      reviewerRole: 'AGY Reviewer',
      round: 1,
      maxRounds: 2,
      status: 'completed',
      createdAtMs: 100,
      updatedAtMs: 200,
      forwardedRounds: 0,
      result: {
        verdict: 'caution',
        summary: '小心 token=supersecret12345 外洩風險',
        findings: [
          {
            severity: 'medium',
            file: 'a.ts',
            issue: '缺少關閉清理',
            suggestion: '在 shutdown 時呼出 dispose()',
          },
        ],
      },
    });
    expect(formatted).toContain('AGY Reviewer');
    expect(formatted).toContain('caution');
    expect(formatted).toContain('缺少關閉清理');
    expect(formatted).not.toContain('supersecret12345');
  });

  it('orchestrates Codex -> AGY Reviewer lifecycle, forwarding, round 2 conversation reuse, maxRounds=2, and dismissal', async () => {
    const workspace = makeTempDir('ws-codex-');
    const store = new AgentStateStore();
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));

    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'codex-11111111-1111-1111-1111-111111111111',
        isExternal: true,
        providerId: 'codex',
        directoryName: 'visionai · Feature A',
        projectDir: workspace,
        jsonlFile: '',
      }),
    );

    const execCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const bridge = new AgentChatBridge({
      store,
      resolveBin: (n) => `/bin/${n}`,
      execFileAsync: async (cmd, args) => {
        execCalls.push({ cmd, args });
        return { stdout: '', stderr: '' };
      },
    });

    const spawned: Array<{
      cmd: string;
      args: readonly string[];
      opts: ReviewSpawnOptions;
      child: FakeReviewChild;
    }> = [];

    const service = new CrossVendorReviewService({
      store,
      chatBridge: bridge,
      resolveBin: (n) => `/usr/local/bin/${n}`,
      spawnProcess: (cmd, args, opts) => {
        const child = new FakeReviewChild();
        spawned.push({ cmd, args: [...args], opts, child });
        return child;
      },
      now: () => 5000,
    });

    // Round 1 invite: Codex host invites AGY Reviewer
    const r1 = await service.inviteReview({ hostAgentId: 1, focus: '檢查狀態同步' });
    expect(r1.ok).toBe(true);
    expect(r1.statusCode).toBe(202);
    expect(r1.review?.reviewerVendor).toBe('antigravity');
    expect(r1.review?.reviewerRole).toBe('AGY Reviewer');
    expect(r1.review?.round).toBe(1);

    const reviewerId = r1.review!.reviewerAgentId!;
    const reviewerAgent = store.get(reviewerId)!;
    expect(reviewerAgent.isReviewer).toBe(true);
    expect(reviewerAgent.leadAgentId).toBe(1);
    expect(reviewerAgent.isAgentSpawned).toBe(true);
    expect(isCommunicableAgent(reviewerAgent)).toBe(false);
    expect(store.get(1)?.isTeamLead).toBe(true);

    // Invoking while running -> 409 review_in_progress
    const dup = await service.inviteReview({ hostAgentId: 1 });
    expect(dup).toMatchObject({ ok: false, statusCode: 409, error: 'review_in_progress' });

    // Invoking on the synthetic reviewer -> 403 subagent_not_communicable
    const onReviewer = await service.inviteReview({ hostAgentId: reviewerId });
    expect(onReviewer).toMatchObject({
      ok: false,
      statusCode: 403,
      error: 'subagent_not_communicable',
    });

    // Check read-only sandbox flags for agy
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('/usr/local/bin/agy');
    expect(spawned[0].args).toContain('--mode');
    expect(spawned[0].args).toContain('plan');
    expect(spawned[0].args).toContain('--sandbox');
    expect(spawned[0].args).toContain('--disable-slash-commands');
    expect(spawned[0].args).toContain('--json-schema');
    expect(spawned[0].args).toContain('--add-dir');
    expect(spawned[0].args).toContain(workspace);
    expect(spawned[0].opts.env?.PIXEL_REVIEW_DEPTH).toBe('1');

    // Emit completion from mocked agy CLI
    spawned[0].child.stdout.write(
      JSON.stringify({
        conversation_id: 'agy-conv-round1',
        result: JSON.stringify({
          verdict: 'caution',
          summary: '建議補上競爭條件保護',
          strengths: ['模組邊界清楚'],
          findings: [
            { severity: 'high', file: 'a.ts', issue: '重複觸發', suggestion: '加上 lock' },
          ],
          openQuestions: [],
          recommendedNextStep: '修正後再審',
        }),
      }),
    );
    spawned[0].child.emit('close', 0);

    const listed = service.listReviews(1);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('completed');
    expect(listed[0].reviewerConversationId).toBe('agy-conv-round1');
    expect(store.get(reviewerId)?.isWaiting).toBe(true);

    // Forward review to host Lead
    const fwd1 = await service.forwardReview(r1.review!.reviewId);
    expect(fwd1.ok).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toContain('queue');

    // Prevent forwarding the same completed round twice
    const fwdDup = await service.forwardReview(r1.review!.reviewId);
    expect(fwdDup).toMatchObject({ ok: false, statusCode: 409, error: 'review_already_forwarded' });

    // Round 2 reuses reviewer seat and passes --conversation agy-conv-round1
    const r2 = await service.inviteReview({
      hostAgentId: 1,
      previousReviewId: r1.review!.reviewId,
    });
    expect(r2.ok).toBe(true);
    expect(r2.review?.round).toBe(2);
    expect(r2.review?.reviewerAgentId).toBe(reviewerId);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain('--conversation');
    expect(spawned[1].args).toContain('agy-conv-round1');

    spawned[1].child.stdout.write(
      JSON.stringify({
        verdict: 'approve',
        summary: '已修正完畢',
        strengths: [],
        findings: [],
        openQuestions: [],
        recommendedNextStep: null,
      }),
    );
    spawned[1].child.emit('close', 0);

    // Round 3 blocked by maxRounds = 2
    const r3 = await service.inviteReview({
      hostAgentId: 1,
      previousReviewId: r2.review!.reviewId,
    });
    expect(r3).toMatchObject({ ok: false, statusCode: 409, error: 'max_review_rounds_reached' });

    // Dismissing removes synthetic reviewer and clears synthetic isTeamLead
    const dis = service.dismissReview(r2.review!.reviewId);
    expect(dis.ok).toBe(true);
    expect(store.has(reviewerId)).toBe(false);
    expect(store.get(1)?.isTeamLead).toBeUndefined();
    expect(service.listReviews(1)).toHaveLength(0);
    expect(broadcasts.some((b) => b.type === 'agentTeamInfo' && b.isReviewer === true)).toBe(true);
    service.dispose();
  });

  it('orchestrates Antigravity -> CDX Reviewer read-only exec with --json tool progress, -o schema output, and cleanup on host removal', async () => {
    const workspace = makeTempDir('ws-agy-');
    const store = new AgentStateStore();
    store.set(
      10,
      createAgentState({
        id: 10,
        sessionId: 'antigravity-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        isExternal: true,
        providerId: 'antigravity',
        directoryName: 'Chat aaaaaaaa',
        projectDir: workspace,
        jsonlFile: '',
      }),
    );

    const bridge = new AgentChatBridge({ store, resolveBin: (n) => `/bin/${n}` });
    const spawned: Array<{
      cmd: string;
      args: readonly string[];
      opts: ReviewSpawnOptions;
      child: FakeReviewChild;
    }> = [];

    const service = new CrossVendorReviewService({
      store,
      chatBridge: bridge,
      resolveBin: (n) => `/usr/local/bin/${n}`,
      spawnProcess: (cmd, args, opts) => {
        const child = new FakeReviewChild();
        spawned.push({ cmd, args: [...args], opts, child });
        return child;
      },
      now: () => 9000,
    });

    const invite = await service.inviteReview({ hostAgentId: 10 });
    expect(invite.ok).toBe(true);
    expect(invite.review?.reviewerVendor).toBe('codex');
    expect(invite.review?.reviewerRole).toBe('CDX Reviewer');

    const reviewerId = invite.review!.reviewerAgentId!;
    const call = spawned[0];
    expect(call.cmd).toBe('/usr/local/bin/codex');
    expect(call.args.slice(0, 3)).toEqual(['exec', '-s', 'read-only']);
    expect(call.args).toContain('--ephemeral');
    expect(call.args).toContain('--json');
    expect(call.args).toContain('--skip-git-repo-check');
    expect(call.args).toContain('--output-schema');
    expect(call.args).toContain('-o');
    expect(call.args.at(-1)).toBe('-');
    expect(call.opts.stdinText).toContain('antigravity');

    const outIdx = call.args.indexOf('-o');
    const schemaIdx = call.args.indexOf('--output-schema');
    const outPath = call.args[outIdx + 1];
    const schemaPath = call.args[schemaIdx + 1];
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);

    // Simulate Codex --json streaming tool activity
    call.child.stdout.write(
      `${JSON.stringify({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution' } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(Array.from(store.get(reviewerId)!.activeToolNames.values())).toContain('Bash');

    // Write structured result into -o file and exit cleanly
    fs.writeFileSync(
      outPath,
      JSON.stringify({
        verdict: 'approve',
        summary: 'Antigravity 設計與實作一致',
        strengths: ['清楚'],
        findings: [],
        openQuestions: [],
        recommendedNextStep: null,
      }),
    );
    call.child.emit('close', 0);

    // Temp files removed cleanly in finally/close
    expect(fs.existsSync(path.dirname(schemaPath))).toBe(false);
    expect(service.listReviews(10)[0].result?.verdict).toBe('approve');

    // Removing host removes synthetic reviewer too
    store.delete(10);
    expect(store.has(reviewerId)).toBe(false);
    expect(service.listReviews()).toHaveLength(0);
    service.dispose();
  });

  it('rejects unsupported host vendors and exposes /api/reviews HTTP endpoints behind auth', async () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'claude-1',
        providerId: 'claude',
        isExternal: false,
        projectDir: '',
        jsonlFile: '',
      }),
    );
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 'codex-parent',
        providerId: 'codex',
        isExternal: true,
        projectDir: '',
        jsonlFile: '',
      }),
    );
    store.set(
      3,
      createAgentState({
        id: 3,
        sessionId: 'codex-sub',
        providerId: 'codex',
        leadAgentId: 2,
        isAgentSpawned: true,
        isExternal: true,
        projectDir: '',
        jsonlFile: '',
      }),
    );

    const execCalls: string[] = [];
    const bridge = new AgentChatBridge({
      store,
      resolveBin: (n) => `/bin/${n}`,
      execFileAsync: async (cmd) => {
        execCalls.push(cmd);
        return { stdout: '', stderr: '' };
      },
    });
    const service = new CrossVendorReviewService({
      store,
      chatBridge: bridge,
      resolveBin: (n) => `/bin/${n}`,
      spawnProcess: () => {
        const c = new FakeReviewChild();
        queueMicrotask(() => {
          c.stdout.write(
            JSON.stringify({
              verdict: 'approve',
              summary: '審查通過',
              strengths: [],
              findings: [],
              openQuestions: [],
              recommendedNextStep: null,
            }),
          );
          c.emit('close', 0);
        });
        return c;
      },
    });

    const handle = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      port: 0,
      token: 'review-secret',
      store,
      chatBridge: bridge,
      reviewService: service,
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;

      expect((await fetch(`${base}/api/reviews`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/api/reviews?token=review-secret`, {
            headers: { Origin: 'http://evil.example' },
          })
        ).status,
      ).toBe(403);

      const list0 = await fetch(`${base}/api/reviews?token=review-secret`);
      expect(list0.status).toBe(200);
      expect(await list0.json()).toEqual({ ok: true, reviews: [] });

      // Subagent cannot host a review -> 403
      const subInvite = await fetch(`${base}/api/reviews/invite?token=review-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAgentId: 3 }),
      });
      expect(subInvite.status).toBe(403);
      expect(await subInvite.json()).toMatchObject({
        ok: false,
        error: 'subagent_not_communicable',
      });

      // Claude host rejected cleanly -> 400
      const claudeInvite = await fetch(`${base}/api/reviews/invite?token=review-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAgentId: 1 }),
      });
      expect(claudeInvite.status).toBe(400);
      expect(await claudeInvite.json()).toMatchObject({
        ok: false,
        error: 'unsupported_host_vendor',
      });

      // Codex host invite -> complete -> forward -> dismiss
      const okInvite = await fetch(`${base}/api/reviews/invite?token=review-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAgentId: 2, focus: '確認安全性' }),
      });
      expect(okInvite.status).toBe(202);
      const { review } = (await okInvite.json()) as { review: { reviewId: string } };

      await new Promise((r) => setTimeout(r, 20));
      const fwdRes = await fetch(
        `${base}/api/reviews/${review.reviewId}/forward?token=review-secret`,
        { method: 'POST' },
      );
      expect(fwdRes.status).toBe(200);
      expect(execCalls).toHaveLength(1);

      const disRes = await fetch(
        `${base}/api/reviews/${review.reviewId}/dismiss?token=review-secret`,
        { method: 'POST' },
      );
      expect(disRes.status).toBe(200);
    } finally {
      service.dispose();
      await handle.app.close();
    }
  });

  it('infers workspace cwd for Antigravity tool calls and preserves non-file-tracked reviewer leadAgentId during reconcile', async () => {
    const fakeRepo = makeTempDir('agy-repo-');
    fs.mkdirSync(path.join(fakeRepo, '.git'));
    const snap = createExternalSnapshot('agy-1');
    applyAntigravityRecord(
      {
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(fakeRepo, 'src', 'index.ts') } }],
      },
      snap,
    );
    expect(snap.cwd).toBe(fakeRepo);
    expect(
      inferCwdFromToolArgs({ Path: '/Users/dev/.gemini/antigravity/brain/note.md' }),
    ).toBeUndefined();

    // Verify ExternalLogWatcher.pollOnce keeps host isTeamLead=true when synthetic reviewer exists in store
    const codexDir = makeTempDir('codex-sessions-');
    const codexFile = path.join(
      codexDir,
      'rollout-2026-11-24T10-00-00-12345678-1234-1234-1234-1234567890ab.jsonl',
    );
    fs.writeFileSync(
      codexFile,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: '12345678-1234-1234-1234-1234567890ab', cwd: fakeRepo },
      })}\n`,
    );

    const store = new AgentStateStore();
    const watcher = new ExternalLogWatcher({
      store,
      enableCodex: true,
      enableAntigravity: false,
      codexRoot: codexDir,
      codexIndexFile: path.join(codexDir, 'missing-index.jsonl'),
      detectOpenLocks: () => ({ codex: new Set(), antigravity: new Set() }),
    });
    watcher.pollOnce();

    const host = Array.from(store.values())[0];
    expect(host).toBeDefined();

    // Add non-file-tracked synthetic reviewer linking to host
    const revId = store.nextAgentId.current++;
    store.set(
      revId,
      createAgentState({
        id: revId,
        sessionId: `review-antigravity-${host.id}-${revId}`,
        isExternal: true,
        providerId: 'antigravity',
        directoryName: 'AGY Reviewer',
        agentName: 'AGY Reviewer',
        leadAgentId: host.id,
        isAgentSpawned: true,
        isReviewer: true,
        projectDir: fakeRepo,
        jsonlFile: '',
      }),
    );

    watcher.pollOnce();
    expect(store.get(host.id)?.isTeamLead).toBe(true);
    watcher.dispose();
  });

  it('resolves CLI binaries via env overrides when present', () => {
    const binDir = makeTempDir('cli-bin-');
    const fakeAgy = path.join(binDir, 'custom-agy');
    fs.writeFileSync(fakeAgy, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const prev = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;
    try {
      expect(resolveCliBinary('agy')).toBe(fakeAgy);
    } finally {
      if (prev === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prev;
    }
  });
});
