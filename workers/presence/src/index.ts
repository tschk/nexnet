/**
 * @nexnet/worker-presence — presence lease management
 *
 * Durable Object: PresenceTracker
 * - Stores presence leases per identity
 * - 90s TTL (AD-11)
 * - Global visibility (AD-12)
 * - WebSocket subscriptions for live updates
 *
 * AD: no read receipts / last-seen in v1 — only online/offline status.
 */

import { PRESENCE_LEASE_TTL_MS } from "@nexnet/types";
import { ed25519 } from "@noble/curves/ed25519";
import { Hono } from "hono";
import { cors } from "hono/cors";

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
  /** Set "1" to allow unsigned presence leases (preview/dev only). */
  ALLOW_UNSIGNED_LEASES?: string;
}

// ── Durable Object: PresenceTracker ──────────────────────────────────

/** X3DH prekey bundle (hex fields for JSON) */
interface PrekeyBundleData {
  identityId: string;
  identityDhPublic: string;
  signedPrekeyPublic: string;
  signedPrekeySig: string;
  identitySignPublic: string;
  oneTimePrekeyPublic?: string;
  oneTimePrekeyId?: number;
  updatedAt: number;
}

export class PresenceTracker {
  private state: DurableObjectState;
  private env: Env;
  // identityId -> lease
  private leases = new Map<string, PresenceLeaseData>();
  // identityId -> prekey bundle (no private keys)
  private prekeys = new Map<string, PrekeyBundleData>();
  // active SSE/WebSocket subscribers
  private subscriptions = new Set<WebSocket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
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
      case "/do/prekeys/publish":
        return this.handlePrekeyPublish(request);
      case "/do/prekeys/get":
        return this.handlePrekeyGet(url);
      case "/do/prekeys/remove":
        return this.handlePrekeyRemove(url);
      case "/do/status":
        return jsonResponse({
          leases: this.leases.size,
          subscribers: this.subscriptions.size,
          prekeys: this.prekeys.size,
        });
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  }

  /** Hydrate maps from DO storage once per isolate lifetime. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const all = await this.state.storage.list();
    for (const [key, value] of all) {
      if (typeof key !== "string") continue;
      if (key.startsWith("lease:")) {
        const lease = value as PresenceLeaseData;
        this.leases.set(lease.identityId, lease);
      } else if (key.startsWith("prekey:")) {
        const bundle = value as PrekeyBundleData;
        this.prekeys.set(bundle.identityId, bundle);
      }
    }
    this.loaded = true;
    if (this.leases.size > 0) this.startCleanupTimer();
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
          `nexnet presence lease v1:${lease.identityId}:${lease.deviceId}:${lease.issuedAt}:${lease.expiresAt}:${lease.nonce ?? ""}`
        );
        if (!ed25519.verify(sig, msg, pk)) {
          return jsonResponse({ error: "invalid lease signature" }, 403);
        }
      } catch {
        return jsonResponse({ error: "malformed signature or public key" }, 400);
      }
    } else {
      // Unsigned leases only when explicitly allowed (preview/tests).
      const allow =
        this.env.ALLOW_UNSIGNED_LEASES === "1" ||
        (typeof process !== "undefined" &&
          process.env?.NODE_ENV !== "production" &&
          process.env?.ALLOW_UNSIGNED_LEASES !== "0");
      if (!allow) {
        return jsonResponse({ error: "lease must be signed" }, 403);
      }
    }

    this.leases.set(lease.identityId, lease);
    await this.state.storage.put(`lease:${lease.identityId}`, lease);
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

  private async handleQuery(url: URL): Promise<Response> {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const lease = this.leases.get(identityId);
    if (!lease || this.isExpired(lease)) {
      if (lease) {
        this.leases.delete(identityId);
        await this.state.storage.delete(`lease:${identityId}`);
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

  // ── Prekeys (X3DH public bundles only) ─────────────────────────────

  private async handlePrekeyPublish(request: Request): Promise<Response> {
    let body: PrekeyBundleData;
    try {
      body = (await request.json()) as PrekeyBundleData;
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }
    if (
      !body.identityId ||
      !body.identityDhPublic ||
      !body.signedPrekeyPublic ||
      !body.signedPrekeySig ||
      !body.identitySignPublic
    ) {
      return jsonResponse(
        {
          error:
            "identityId, identityDhPublic, signedPrekeyPublic, signedPrekeySig, identitySignPublic required",
        },
        400
      );
    }
    // Verify signed prekey over SPK bytes
    try {
      const pk = hexToBytes(body.identitySignPublic);
      const sig = hexToBytes(body.signedPrekeySig);
      const spk = hexToBytes(body.signedPrekeyPublic);
      if (!ed25519.verify(sig, spk, pk)) {
        return jsonResponse({ error: "invalid signed prekey signature" }, 403);
      }
    } catch {
      return jsonResponse({ error: "invalid prekey key material" }, 400);
    }

    const stored: PrekeyBundleData = {
      identityId: body.identityId,
      identityDhPublic: body.identityDhPublic,
      signedPrekeyPublic: body.signedPrekeyPublic,
      signedPrekeySig: body.signedPrekeySig,
      identitySignPublic: body.identitySignPublic,
      oneTimePrekeyPublic: body.oneTimePrekeyPublic,
      oneTimePrekeyId: body.oneTimePrekeyId,
      updatedAt: Date.now(),
    };
    this.prekeys.set(body.identityId, stored);
    await this.state.storage.put(`prekey:${body.identityId}`, stored);
    return jsonResponse({ ok: true, updatedAt: stored.updatedAt });
  }

  private handlePrekeyGet(url: URL): Response {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }
    const bundle = this.prekeys.get(identityId);
    if (!bundle) {
      return jsonResponse({ error: "not found" }, 404);
    }
    return jsonResponse(bundle);
  }

  private async handlePrekeyRemove(url: URL): Promise<Response> {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }
    const removed = this.prekeys.delete(identityId);
    if (removed) {
      await this.state.storage.delete(`prekey:${identityId}`);
    }
    return jsonResponse({ ok: true, removed });
  }

  // ── Remove ─────────────────────────────────────────────────────────

  private async handleRemove(url: URL): Promise<Response> {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const existed = this.leases.delete(identityId);
    if (existed) {
      await this.state.storage.delete(`lease:${identityId}`);
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
    void this.cleanupExpiredAsync();
  }

  private async cleanupExpiredAsync(): Promise<void> {
    for (const [id, lease] of this.leases) {
      if (this.isExpired(lease)) {
        this.leases.delete(id);
        await this.state.storage.delete(`lease:${id}`);
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

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

app.post("/presence/publish", (c) => handlePublish(c.req.raw, c.env));
app.get("/presence/subscribe", (c) => handleSubscribe(c.req.raw, c.env));
app.post("/prekeys/publish", (c) => handlePrekeyPublishHttp(c.req.raw, c.env));
app.get("/presence/:identityId", (c) => handleQueryIdentity(c.req.param("identityId"), c.env));
app.delete("/presence/:identityId", (c) => handleRemoveIdentity(c.req.param("identityId"), c.env));
app.get("/prekeys/:identityId", (c) => handlePrekeyGetHttp(c.req.param("identityId"), c.env));
app.delete("/prekeys/:identityId", (c) => handlePrekeyRemoveHttp(c.req.param("identityId"), c.env));
app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : "internal error" }, 500));

export default app;

async function handlePublish(
  request: Request,
  env: Env
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
  env: Env
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

async function handlePrekeyPublishHttp(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.text();
  const stub = getPresenceStub(env);
  return stub.fetch("https://presence/do/prekeys/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handlePrekeyGetHttp(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(
    `https://presence/do/prekeys/get?identityId=${encodeURIComponent(identityId)}`
  );
}

async function handlePrekeyRemoveHttp(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(
    `https://presence/do/prekeys/remove?identityId=${encodeURIComponent(identityId)}`
  );
}

function getPresenceStub(env: Env): DurableObjectStub {
  const id = env.PRESENCE.idFromName("global");
  return env.PRESENCE.get(id);
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
