import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { AgentChatBridge } from './agentChatBridge.js';
import { agentCreatedMessage } from './agentMessages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  USAGE_API_PREFIX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { applyReportedContext } from './contextUsage.js';
import type { CrossVendorReviewService, ReviewVendor } from './crossVendorReview.js';
import type { ArchiveBookEntry, ExternalProviderId } from './externalLogWatcher.js';
import { hookProviderById } from './providers/index.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';
import {
  allUsageLimits,
  PRIVILEGED_BROADCAST_TYPES,
  recordUsageReport,
  usageLimitsMessage,
} from './usageLimits.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  privilegedHostnames,
  redactTokenQuery,
  standaloneHandshakeVerdict,
  standaloneTokenValid,
} from './wsAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: TerminalSessions;
  /** The package root holding dist/hooks/ (standalone), from which the Usage
   *  Bars toggle installs the status line bridge script. */
  packageRoot?: string;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
  /** Return read-only archive entries (Codex, Antigravity, Claude) for the Bookshelf UI. */
  getArchive?: () => ArchiveBookEntry[];
  /** Summon an archived Codex/Antigravity session onto the office floor. */
  onPinArchiveSession?: (
    providerId: ExternalProviderId,
    id: string,
  ) => { ok: boolean; agentId?: number };
  /** Direct communication bridge for Leads and standalone main sessions. */
  chatBridge?: AgentChatBridge;
  /** Read-only cross-vendor reviewer coordinator (Codex <-> Antigravity). */
  reviewService?: CrossVendorReviewService;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded ? false : { serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  const host = options.host ?? '127.0.0.1';
  const allowedHostnames = privilegedHostnames(host, options.allowedHosts ?? []);

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerUsageRoute(app, options, allowedHostnames);
  registerArchiveRoutes(app, options);
  registerChatRoutes(app, options, allowedHostnames);
  registerReviewRoutes(app, options, allowedHostnames);
  registerWebSocketRoute(app, options, allowedHostnames);
  registerTerminalRoutes(app, {
    token: options.token,
    allowedHostnames,
    ptyManager: options.ptyManager,
  });

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Bookshelf Archive ──────────────────────────────────────────

function requestTokenAuthorized(request: FastifyRequest, expectedToken: string): boolean {
  return (
    bearerTokenValid(request.headers.authorization, expectedToken) ||
    standaloneTokenValid(request.url, expectedToken)
  );
}

function registerArchiveRoutes(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/api/archive', async (request, reply) => {
    if (!requestTokenAuthorized(request, options.token)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const books = options.getArchive ? options.getArchive() : [];
    reply.send({ books, generatedAt: Date.now() });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/archive/pin', async (request, reply) => {
    if (!requestTokenAuthorized(request, options.token)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const body = request.body;
    const providerId = body && typeof body === 'object' ? body.providerId : undefined;
    const id = body && typeof body === 'object' ? body.id : undefined;
    if ((providerId !== 'codex' && providerId !== 'antigravity') || typeof id !== 'string' || !id) {
      reply.code(400).send({ ok: false, error: 'invalid_request' });
      return;
    }
    const result = options.onPinArchiveSession
      ? options.onPinArchiveSession(providerId, id)
      : { ok: false };
    if (!result.ok) {
      reply.code(404).send(result);
      return;
    }
    reply.send(result);
  });
}

// ── Agent Chat (Leads & Solo sessions only) ──────────────────────

function chatAuthError(
  request: FastifyRequest,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): { code: number; error: string } | null {
  if (options.embedded) {
    if (!bearerTokenValid(request.headers.authorization, options.token)) {
      return { code: 401, error: 'unauthorized' };
    }
    return null;
  }
  if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
    return { code: 403, error: 'forbidden_origin' };
  }
  if (bearerTokenValid(request.headers.authorization, options.token)) {
    return null;
  }
  const verdict = standaloneHandshakeVerdict(
    request.url,
    request.headers.host,
    options.token,
    allowedHostnames,
  );
  if (verdict === 'bad-token') {
    return { code: 401, error: 'unauthorized' };
  }
  if (verdict === 'untrusted-host') {
    return { code: 403, error: 'untrusted_host' };
  }
  return null;
}

function registerChatRoutes(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/api/chat/targets', async (request, reply) => {
    const authErr = chatAuthError(request, options, allowedHostnames);
    if (authErr) {
      reply.code(authErr.code).send({ error: authErr.error });
      return;
    }
    const targets = options.chatBridge ? options.chatBridge.getTargets() : {};
    reply.send({ targets });
  });

  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/messages',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[0-9]+$' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const authErr = chatAuthError(request, options, allowedHostnames);
      if (authErr) {
        reply.code(authErr.code).send({ ok: false, error: authErr.error });
        return;
      }
      if (!options.chatBridge) {
        reply.code(503).send({ ok: false, error: 'chat_unavailable' });
        return;
      }
      const agentId = Number(request.params.id);
      const res = options.chatBridge.getMessages(agentId);
      if (!res.ok) {
        reply.code(res.statusCode ?? 400).send(res);
        return;
      }
      reply.send(res);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/agents/:id/message',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[0-9]+$' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const authErr = chatAuthError(request, options, allowedHostnames);
      if (authErr) {
        reply.code(authErr.code).send({ ok: false, error: authErr.error });
        return;
      }
      if (!options.chatBridge) {
        reply.code(503).send({ ok: false, error: 'chat_unavailable' });
        return;
      }
      const body = request.body;
      const text = body && typeof body === 'object' ? body.text : undefined;
      if (typeof text !== 'string' || !text.trim()) {
        reply.code(400).send({ ok: false, error: 'invalid_message' });
        return;
      }
      const agentId = Number(request.params.id);
      const res = await options.chatBridge.sendMessage(agentId, text);
      if (!res.ok) {
        reply.code(res.statusCode ?? 400).send(res);
        return;
      }
      reply.send(res);
    },
  );
}

// ── Cross-Vendor Peer Review Routes ────────────────────────────

function registerReviewRoutes(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get<{ Querystring: { hostAgentId?: string } }>('/api/reviews', async (request, reply) => {
    const authErr = chatAuthError(request, options, allowedHostnames);
    if (authErr) {
      reply.code(authErr.code).send({ ok: false, error: authErr.error });
      return;
    }
    const rawHost = request.query?.hostAgentId;
    let hostAgentId: number | undefined;
    if (rawHost !== undefined && rawHost !== '') {
      if (!/^[0-9]+$/.test(rawHost)) {
        reply.code(400).send({ ok: false, error: 'invalid_host_agent' });
        return;
      }
      hostAgentId = Number(rawHost);
    }
    const reviews = options.reviewService ? options.reviewService.listReviews(hostAgentId) : [];
    reply.send({ ok: true, reviews });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/reviews/invite', async (request, reply) => {
    const authErr = chatAuthError(request, options, allowedHostnames);
    if (authErr) {
      reply.code(authErr.code).send({ ok: false, error: authErr.error });
      return;
    }
    if (!options.reviewService) {
      reply.code(503).send({ ok: false, error: 'review_unavailable' });
      return;
    }
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const hostAgentId = body.hostAgentId;
    if (typeof hostAgentId !== 'number' || !Number.isInteger(hostAgentId) || hostAgentId <= 0) {
      reply.code(400).send({ ok: false, error: 'invalid_host_agent' });
      return;
    }
    const rawVendor = body.reviewerVendor;
    let reviewerVendor: ReviewVendor | undefined;
    if (rawVendor !== undefined) {
      if (rawVendor !== 'codex' && rawVendor !== 'antigravity') {
        reply.code(400).send({ ok: false, error: 'invalid_reviewer_vendor' });
        return;
      }
      reviewerVendor = rawVendor;
    }
    const focus = typeof body.focus === 'string' ? body.focus : undefined;
    const previousReviewId =
      typeof body.previousReviewId === 'string' &&
      /^[A-Za-z0-9_-]{3,80}$/.test(body.previousReviewId)
        ? body.previousReviewId
        : undefined;

    const res = await options.reviewService.inviteReview({
      hostAgentId,
      reviewerVendor,
      focus,
      previousReviewId,
    });
    reply.code(res.statusCode ?? (res.ok ? 202 : 400)).send(res);
  });

  app.post<{ Params: { reviewId: string } }>(
    '/api/reviews/:reviewId/forward',
    {
      schema: {
        params: {
          type: 'object',
          properties: { reviewId: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,80}$' } },
          required: ['reviewId'],
        },
      },
    },
    async (request, reply) => {
      const authErr = chatAuthError(request, options, allowedHostnames);
      if (authErr) {
        reply.code(authErr.code).send({ ok: false, error: authErr.error });
        return;
      }
      if (!options.reviewService) {
        reply.code(503).send({ ok: false, error: 'review_unavailable' });
        return;
      }
      const res = await options.reviewService.forwardReview(request.params.reviewId);
      reply.code(res.statusCode ?? (res.ok ? 200 : 400)).send(res);
    },
  );

  app.post<{ Params: { reviewId: string } }>(
    '/api/reviews/:reviewId/dismiss',
    {
      schema: {
        params: {
          type: 'object',
          properties: { reviewId: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,80}$' } },
          required: ['reviewId'],
        },
      },
    },
    async (request, reply) => {
      const authErr = chatAuthError(request, options, allowedHostnames);
      if (authErr) {
        reply.code(authErr.code).send({ ok: false, error: authErr.error });
        return;
      }
      if (!options.reviewService) {
        reply.code(503).send({ ok: false, error: 'review_unavailable' });
        return;
      }
      const res = options.reviewService.dismissReview(request.params.reviewId);
      reply.code(res.statusCode ?? (res.ok ? 200 : 400)).send(res);
    },
  );
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Usage reports ──────────────────────────────────────────────

/** A provider's usage bridge reports the account's plan limits here. Stored,
 *  and passed on to the office when they moved (recordUsageReport). */
function registerUsageRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/api/usage', async (request, reply) => {
    const authErr = chatAuthError(request, options, allowedHostnames);
    if (authErr) {
      reply.code(authErr.code).send({ error: authErr.error });
      return;
    }
    reply.send({ usage: allUsageLimits() });
  });

  app.post<{ Params: { providerId: string }; Body: unknown }>(
    `${USAGE_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { providerId: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const provider = hookProviderById(request.params.providerId);
      if (provider && recordUsageReport(provider, request.body)) {
        options.store.broadcast({ ...usageLimitsMessage(provider.id) });
      }
      const context = provider?.usageBridge?.normalizeContext(request.body);
      if (context) applyReportedContext(options.store, context);
      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    let privileged = options.embedded;
    if (!options.embedded) {
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        allowedHostnames,
      );
      privileged = verdict === 'privileged';
      if (verdict === 'untrusted-host') {
        // The operator has the right URL but reached us under a name they never
        // listed (typically a reverse proxy). Say how to fix it, or the session
        // silently stays watch-only.
        console.warn(
          `[Pixel Agents] Tokened connection via Host "${request.headers.host ?? ''}" is read-only: restart with --allowed-host <that name> to allow changes from it.`,
        );
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, agentCreatedMessage(id, agent));
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      // The operator's account usage is not for read-only viewers.
      if (!privileged && PRIVILEGED_BROADCAST_TYPES.has(String(message.type))) return;
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          packageRoot: options.packageRoot,
          privileged,
          ptyManager: options.ptyManager,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactTokenQuery(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
