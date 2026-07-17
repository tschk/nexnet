/**
 * @nettle/worker-presence — presence lease management
 *
 * Durable Object: PresenceTracker
 * - Stores presence leases per identity
 * - 90s TTL (AD-11)
 * - Global visibility (AD-12)
 * - WebSocket subscriptions for live updates
 *
 * AD: no read receipts / last-seen in v1 — only online/offline status.
 */

import { PRESENCE_LEASE_TTL_MS } from "@nettle/types";
import { ed25519 } from "@noble/curves/ed25519";

// ── Types ────────────────────────────────────────────────────────────

interface PresenceLeaseData {
  identityId: string;
  deviceId: string;
  publicKey?: string; // hex-encoded Ed25519 public key
  relayHint?: string;
  issuedAt: number;
  expiresAt: number;
  nonce?: string; // hex-encoded 32-byte nonce
  signature?: string; // hex-encoded Ed25519 signature
}

interface Env {
  PRESENCE: DurableObjectNamespace;
}

type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

// ── Durable Object: PresenceTracker ──────────────────────────────────

export class PresenceTracker {
  private state: DurableObjectState;
  // identityId -> lease
  private leases = new Map<string, PresenceLeaseData>();
  // active SSE/WebSocket subscribers
  private subscriptions = new Set<WebSocket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/do/publish":
        return this.handlePublish(request);
      case "/do/query":
        return this.handleQuery(url);
      case "/do/subscribe":
        return this.handleSubscribe(request);
      case "/do/remove":
        return this.handleRemove(url);
      case "/do/status":
        return jsonResponse({
          leases: this.leases.size,
          subscribers: this.subscriptions.size,
        });
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  }

  // ── Publish lease ──────────────────────────────────────────────────

  private async handlePublish(request: Request): Promise<Response> {
    let lease: PresenceLeaseData;
    try {
      const body = (await request.json()) as PresenceLeaseData;
      if (!body.identityId || !body.deviceId || !body.expiresAt) {
        return jsonResponse({ error: "identityId, deviceId, expiresAt required" }, 400);
      }
      lease = body;
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    // Validate expiresAt in future
    if (lease.expiresAt <= Date.now()) {
      return jsonResponse({ error: "lease already expired" }, 400);
    }

    // Cap to max TTL (AD-11)
    const maxExpiry = Date.now() + PRESENCE_LEASE_TTL_MS;
    if (lease.expiresAt > maxExpiry) {
      lease.expiresAt = maxExpiry;
    }

    // Verify Ed25519 signature when present (AD-11)
    if (lease.signature && lease.publicKey) {
      try {
        const pk = hexToBytes(lease.publicKey);
        const sig = hexToBytes(lease.signature);
        const msg = new TextEncoder().encode(
          `nettle presence lease v1:${lease.identityId}:${lease.deviceId}:${lease.issuedAt}:${lease.expiresAt}:${lease.nonce ?? ""}`
        );
        if (!ed25519.verify(sig, msg, pk)) {
          return jsonResponse({ error: "invalid lease signature" }, 403);
        }
      } catch {
        return jsonResponse({ error: "malformed signature or public key" }, 400);
      }
    } else {
      // Reject unsigned leases in production
      // ponytail: env flag, replace with proper env injection when wrangler is used
      // In tests/dev, DEBUG env is typically set. Without it, reject.
      const isDev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
      if (!isDev) {
        return jsonResponse({ error: "lease must be signed" }, 403);
      }
    }

    this.leases.set(lease.identityId, lease);
    this.startCleanupTimer();

    // Broadcast to subscribers
    this.broadcast({
      type: "presence_update",
      identityId: lease.identityId,
      status: "online",
      expiresAt: lease.expiresAt,
    });

    return jsonResponse({ ok: true, expiresAt: lease.expiresAt });
  }

  // ── Query ──────────────────────────────────────────────────────────

  private handleQuery(url: URL): Response {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const lease = this.leases.get(identityId);
    if (!lease || this.isExpired(lease)) {
      if (lease) {
        this.leases.delete(identityId);
      }
      return jsonResponse({ identityId, status: "offline" });
    }

    return jsonResponse({
      identityId,
      status: "online",
      expiresAt: lease.expiresAt,
      relayHint: lease.relayHint,
    });
  }

  // ── Subscribe (WebSocket for live presence updates) ────────────────

  private handleSubscribe(request: Request): Response {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Upgrade: websocket required" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);
    this.subscriptions.add(server);
    this.startCleanupTimer();

    // Send current snapshot on connect
    const snapshot: Record<string, unknown> = {};
    for (const [id, lease] of this.leases) {
      if (!this.isExpired(lease)) {
        snapshot[id] = { status: "online", expiresAt: lease.expiresAt };
      }
    }
    try {
      server.send(JSON.stringify({ type: "presence_snapshot", leases: snapshot }));
    } catch {
      // Client disconnected immediately
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(ws: WebSocket) {
    this.subscriptions.delete(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.subscriptions.delete(ws);
  }

  // ── Remove ─────────────────────────────────────────────────────────

  private handleRemove(url: URL): Response {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const existed = this.leases.delete(identityId);
    if (existed) {
      this.broadcast({
        type: "presence_update",
        identityId,
        status: "offline",
      });
    }

    return jsonResponse({ ok: true, removed: existed });
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  private isExpired(lease: PresenceLeaseData): boolean {
    return lease.expiresAt <= Date.now();
  }

  private cleanupExpired(): void {
    let changed = false;
    for (const [id, lease] of this.leases) {
      if (this.isExpired(lease)) {
        this.leases.delete(id);
        changed = true;
        this.broadcast({
          type: "presence_update",
          identityId: id,
          status: "offline",
        });
      }
    }

    if (this.leases.size === 0 && this.subscriptions.size === 0) {
      this.stopCleanupTimer();
    }
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 10_000);
  }

  private stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ── Broadcast ──────────────────────────────────────────────────────

  private broadcast(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const ws of this.subscriptions) {
      try {
        ws.send(payload);
      } catch {
        this.subscriptions.delete(ws);
      }
    }
  }
}

// ── Fetch handler ────────────────────────────────────────────────────

const routes: Record<string, RouteHandler> = {
  "POST /presence/publish": handlePublish,
  "GET /presence/subscribe": handleSubscribe,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const url = new URL(request.url);
      const routeKey = `${request.method} ${url.pathname}`;

      // Check static routes first
      const handler = routes[routeKey];
      if (handler) {
        return addCorsHeaders(await handler(request, env, ctx));
      }

      // /presence/:identityId (GET or DELETE)
      const identityMatch = url.pathname.match(/^\/presence\/([^/]+)$/);
      if (identityMatch) {
        const identityId = identityMatch[1];
        if (request.method === "GET") {
          return addCorsHeaders(await handleQueryIdentity(identityId, env));
        }
        if (request.method === "DELETE") {
          return addCorsHeaders(await handleRemoveIdentity(identityId, env));
        }
      }

      return addCorsHeaders(jsonResponse({ error: "not found" }, 404));
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return addCorsHeaders(jsonResponse({ error: message }, 500));
    }
  },
};

async function handlePublish(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const stub = getPresenceStub(env);
  return stub.fetch("https://presence/do/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleQueryIdentity(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(`https://presence/do/query?identityId=${encodeURIComponent(identityId)}`);
}

async function handleSubscribe(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(request);
}

async function handleRemoveIdentity(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(`https://presence/do/remove?identityId=${encodeURIComponent(identityId)}`);
}

function getPresenceStub(env: Env): DurableObjectStub {
  const id = env.PRESENCE.idFromName("global");
  return env.PRESENCE.get(id);
}

// ── Helpers ──────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
    webSocket: (response as any).webSocket,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
