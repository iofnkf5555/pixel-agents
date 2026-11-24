import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { ExternalLogWatcher } = await import('../src/externalLogWatcher.js');
const { createHttpServer } = await import('../src/httpServer.js');
const { recordProviderUsageLimits, resetUsageLimitsCacheForTests } =
  await import('../src/usageLimits.js');
const {
  FIVE_HOURS_MS,
  normalizeCodexRateLimits,
  scanCodexRateLimitsFromFiles,
  SEVEN_DAYS_MS,
  VendorUsageScanner,
} = await import('../src/vendorUsageScanner.js');

describe('vendorUsageScanner & multi-vendor HTTP endpoint', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix = 'vendor-usage-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tmpHome = makeTmpDir('pxl-home-');
    resetUsageLimitsCacheForTests();
  });

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('normalizeCodexRateLimits parses primary 300m & secondary 10080m, clamps %, normalizes ms, and drops null premium records', () => {
    expect(
      normalizeCodexRateLimits({
        limit_id: 'codex',
        plan_type: 'plus',
        primary: { used_percent: 18, window_minutes: 300, resets_at: 1_795_507_481 },
        secondary: { used_percent: 140, window_minutes: 10080, resets_at: 1_795_672_590_000 },
      }),
    ).toEqual({
      limitId: 'codex',
      planType: 'plus',
      fiveHour: { usedPercentage: 18, resetsAt: 1_795_507_481 },
      sevenDay: { usedPercentage: 100, resetsAt: 1_795_672_590 },
    });

    expect(
      normalizeCodexRateLimits({
        limit_id: 'premium',
        primary: null,
        secondary: null,
        plan_type: 'plus',
      }),
    ).toBeNull();
  });

  it('scanCodexRateLimitsFromFiles picks newest limit_id "codex", skips null premium entries, and handles missing dirs', () => {
    const missing = path.join(makeTmpDir(), 'does-not-exist');
    expect(scanCodexRateLimitsFromFiles(missing, Date.now())).toBeNull();

    const codexRoot = makeTmpDir();
    const dayDir = path.join(codexRoot, '2026', '11', '24');
    fs.mkdirSync(dayDir, { recursive: true });

    const nowMs = Date.parse('2026-11-24T08:00:00Z');
    const olderFile = path.join(
      dayDir,
      'rollout-2026-11-24T04-00-00-11111111-1111-1111-1111-111111111111.jsonl',
    );
    const newerFile = path.join(
      dayDir,
      'rollout-2026-11-24T06-00-00-22222222-2222-2222-2222-222222222222.jsonl',
    );

    fs.writeFileSync(
      olderFile,
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-24T04:00:00Z',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            plan_type: 'plus',
            primary: { used_percent: 10, window_minutes: 300, resets_at: 1_800_010_000 },
            secondary: { used_percent: 50, window_minutes: 10080, resets_at: 1_800_500_000 },
          },
        },
      }) + '\n',
    );
    fs.writeFileSync(
      newerFile,
      [
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-24T06:00:00Z',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              limit_id: 'codex',
              plan_type: 'plus',
              primary: { used_percent: 22, window_minutes: 300, resets_at: 1_800_020_000 },
              secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1_800_600_000 },
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-24T07:00:00Z',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              limit_id: 'premium',
              primary: null,
              secondary: null,
              plan_type: 'plus',
            },
          },
        }),
      ].join('\n') + '\n',
    );

    const res = scanCodexRateLimitsFromFiles(codexRoot, nowMs);
    expect(res).toEqual({
      fiveHour: { usedPercentage: 22, resetsAt: 1_800_020_000 },
      sevenDay: { usedPercentage: 61, resetsAt: 1_800_600_000 },
      planType: 'plus',
      observedAtMs: Date.parse('2026-11-24T06:00:00Z'),
    });
  });

  it('VendorUsageScanner aggregates Antigravity 5h vs 7d turns, deduplicates by step_index, and caches unchanged files', () => {
    const agyRoot = makeTmpDir();
    const convLogs = path.join(agyRoot, 'conv-1', '.system_generated', 'logs');
    fs.mkdirSync(convLogs, { recursive: true });
    const file = path.join(convLogs, 'transcript.jsonl');

    const nowMs = Date.parse('2026-11-24T12:00:00Z');
    const within5h = new Date(nowMs - 60 * 60_000).toISOString();
    const within3d = new Date(nowMs - 3 * 86_400_000).toISOString();
    const expired8d = new Date(nowMs - SEVEN_DAYS_MS - 60_000).toISOString();

    fs.writeFileSync(
      file,
      [
        // Duplicate step_index=1 should keep only the latest record (200 input + 50 output)
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: within5h,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 500,
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: within5h,
          input_tokens: 200,
          output_tokens: 50,
          cache_read_tokens: 1000,
        }),
        // Within 7d but outside 5h
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 2,
          created_at: within3d,
          input_tokens: 400,
          output_tokens: 100,
          cache_read_tokens: 2000,
        }),
        // Older than 7d (excluded)
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 3,
          created_at: expired8d,
          input_tokens: 9999,
          output_tokens: 9999,
          cache_read_tokens: 9999,
        }),
      ].join('\n') + '\n',
    );

    const scanner = new VendorUsageScanner();
    const first = scanner.scanAntigravityLocalUsage(agyRoot, nowMs);
    expect(first).toEqual({
      fiveHourActivity: {
        tokens: 250,
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 1000,
        turns: 1,
      },
      sevenDayActivity: {
        tokens: 750,
        inputTokens: 600,
        outputTokens: 150,
        cacheReadTokens: 3000,
        turns: 2,
      },
    });

    // Cached second read stays consistent
    const second = scanner.scanAntigravityLocalUsage(agyRoot, nowMs + FIVE_HOURS_MS);
    expect(second.fiveHourActivity.turns).toBe(0);
    expect(second.sevenDayActivity.turns).toBe(2);
  });

  it('VendorUsageScanner aggregates Claude Code 5h vs 7d usage deduplicated by message.id', () => {
    const claudeRoot = makeTmpDir();
    const projDir = path.join(claudeRoot, '-repo-project');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlFile = path.join(projDir, 'sess-1.jsonl');

    const nowMs = Date.parse('2026-11-24T12:00:00Z');
    const within2h = new Date(nowMs - 2 * 3_600_000).toISOString();
    const within4d = new Date(nowMs - 4 * 86_400_000).toISOString();

    fs.writeFileSync(
      jsonlFile,
      [
        // Streamed chunk 1 & final chunk 2 for same message.id='msg_1'
        JSON.stringify({
          type: 'assistant',
          timestamp: within2h,
          message: {
            id: 'msg_1',
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 500,
              output_tokens: 5,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: within2h,
          message: {
            id: 'msg_1',
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 90,
              cache_read_input_tokens: 500,
              output_tokens: 25,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: within4d,
          message: {
            id: 'msg_2',
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 200,
              output_tokens: 50,
            },
          },
        }),
      ].join('\n') + '\n',
    );

    const scanner = new VendorUsageScanner();
    const res = scanner.scanClaudeLocalUsage(claudeRoot, nowMs);
    expect(res).toEqual({
      fiveHourActivity: {
        tokens: 125,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 500,
        turns: 1,
      },
      sevenDayActivity: {
        tokens: 275,
        inputTokens: 200,
        outputTokens: 75,
        cacheReadTokens: 700,
        turns: 2,
      },
    });
  });

  it('ExternalLogWatcher emits Codex rate_limits via onVendorUsage even when payload.info is null', () => {
    const store = new AgentStateStore();
    const codexRoot = makeTmpDir();
    const agyRoot = makeTmpDir();
    const claudeRoot = makeTmpDir();
    const sessionFile = path.join(
      codexRoot,
      'rollout-2026-11-24T08-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    );
    const fixedNow = Date.parse('2026-11-24T08:05:00Z');

    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: '/repo' },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-24T08:04:00Z',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              limit_id: 'codex',
              plan_type: 'pro',
              primary: { used_percent: 33, window_minutes: 300, resets_at: 1_800_111_000 },
              secondary: { used_percent: 44, window_minutes: 10080, resets_at: 1_800_777_000 },
            },
          },
        }),
      ].join('\n') + '\n',
    );

    const emitted: Array<{ providerId: string; update: unknown }> = [];
    const watcher = new ExternalLogWatcher({
      store,
      enableCodex: true,
      enableAntigravity: true,
      codexRoot,
      antigravityRoot: agyRoot,
      claudeProjectsRoot: claudeRoot,
      detectOpenLocks: () => ({ codex: new Set(), antigravity: new Set() }),
      now: () => fixedNow,
      onVendorUsage: (providerId, update) => {
        emitted.push({ providerId, update });
      },
    });

    watcher.start();
    watcher.dispose();

    expect(emitted.some((e) => e.providerId === 'codex')).toBe(true);
    const codexEvent = emitted.find((e) => e.providerId === 'codex')!;
    expect(codexEvent.update).toEqual({
      planType: 'pro',
      fiveHour: { usedPercentage: 33, resetsAt: 1_800_111_000 },
      sevenDay: { usedPercentage: 44, resetsAt: 1_800_777_000 },
    });
    expect(emitted.some((e) => e.providerId === 'antigravity')).toBe(false);
    expect(emitted.some((e) => e.providerId === 'claude')).toBe(false);
  });

  it('GET /api/usage enforces auth and returns isolated entries per vendor', async () => {
    const store = new AgentStateStore();
    recordProviderUsageLimits(
      'codex',
      {
        planType: 'plus',
        fiveHour: { usedPercentage: 18, resetsAt: 1_800_010_000 },
        sevenDay: { usedPercentage: 60, resetsAt: 1_800_500_000 },
      },
      1000,
    );
    recordProviderUsageLimits(
      'antigravity',
      {
        fiveHourActivity: { tokens: 1200, inputTokens: 1000, outputTokens: 200, turns: 3 },
        sevenDayActivity: { tokens: 9000, inputTokens: 7000, outputTokens: 2000, turns: 20 },
      },
      2000,
    );

    const handle = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      port: 0,
      token: 'secret-token',
      store,
    });

    try {
      const base = `http://127.0.0.1:${handle.port}`;

      const unauth = await fetch(`${base}/api/usage`);
      expect(unauth.status).toBe(401);

      const foreign = await fetch(`${base}/api/usage?token=secret-token`, {
        headers: { Origin: 'http://evil.example' },
      });
      expect(foreign.status).toBe(403);

      const okRes = await fetch(`${base}/api/usage?token=secret-token`);
      expect(okRes.status).toBe(200);
      const body = (await okRes.json()) as {
        usage: Record<
          string,
          { providerId: string; planType?: string; fiveHour?: unknown; fiveHourActivity?: unknown }
        >;
      };

      expect(body.usage.claude.providerId).toBe('claude');
      expect(body.usage.claude.fiveHour).toBeUndefined();
      expect(body.usage.codex).toMatchObject({
        providerId: 'codex',
        planType: 'plus',
        fiveHour: { usedPercentage: 18, resetsAt: 1_800_010_000 },
      });
      expect(body.usage.antigravity).toMatchObject({
        providerId: 'antigravity',
        fiveHourActivity: { tokens: 1200, turns: 3 },
      });
      expect((body.usage.antigravity as Record<string, unknown>).fiveHour).toBeUndefined();
    } finally {
      await handle.app.close();
    }
  });
});
