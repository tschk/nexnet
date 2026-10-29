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
 *
 * Every identity-scoped write (prekey publish/remove, lease publish/remove)
 * carries an identity proof (`auth`, see @nexnet/protocol identity-auth) over
 * the rest of the body. Writes are rejected unless the proof verifies for the
 * claimed identity, `issuedAt` is fresh, and `issuedAt` is strictly greater
 * than the last accepted one for that identity and operation family.
 *
 * Status codes: 400 malformed body, 401 missing/invalid proof,
 * 409 stale or replayed issuedAt.
 */

import { isFreshIssuedAt, toHex, verifyIdentityAuthJson } from "@nexnet/protocol";
import { PRESENCE_LEASE_TTL_MS } from "@nexnet/types";
import { ed25519 } from "@noble/curves/ed25519";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ── Types ────────────────────────────────────────────────────────────

/** Stored lease: the signed request fields without `auth`. */
interface PresenceLeaseData {
  identityId: string;
  deviceId: string;
  relayHint?: string;
  issuedAt: number;
  expiresAt: number;
  nonce?: string;
}

interface Env {
  PRESENCE: DurableObjectNamespace;
}

// ── Durable Object: PresenceTracker ──────────────────────────────────

/**
 * X3DH prekey bundle (hex fields for JSON). Signed fields are stored verbatim
 * with the proof so clients can re-verify end to end; `updatedAt` is server-set.
 */
interface PrekeyBundleData {
  identityId: string;
  identityDhPublic: string;
  signedPrekeyPublic: string;
  signedPrekeySig: string;
  identitySignPublic: string;
  oneTimePrekeyPublic?: string;
  oneTimePrekeyId?: number;
  issuedAt: number;
  auth: unknown;
  updatedAt: number;
}

const HEX32 = /^[0-9a-f]{64}$/;
const PREKEY_PUBLISH_KEYS = new Set([
  "identityId",
  "identityDhPublic",
  "signedPrekeyPublic",
  "signedPrekeySig",
  "identitySignPublic",
  "oneTimePrekeyPublic",
  "oneTimePrekeyId",
  "issuedAt",
  "auth",
]);
const LEASE_PUBLISH_KEYS = new Set(["identityId", "deviceId", "issuedAt", "expiresAt", "nonce", "relayHint", "auth"]);
const REMOVE_KEYS = new Set(["identityId", "issuedAt", "auth"]);

type Body = Record<string, unknown>;

/** Parse a JSON object body whose keys are all in `allowed`; null when malformed. */
async function readBody(request: Request, allowed: Set<string>): Promise<Body | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  for (const key of Object.keys(body)) if (!allowed.has(key)) return null;
  const input = body as Body;
  if (typeof input.identityId !== "string" || !HEX32.test(input.identityId)) return null;
  if (typeof input.issuedAt !== "number" || !Number.isSafeInteger(input.issuedAt)) return null;
  return input;
}

const malformed = () => jsonResponse({ error: "malformed request body" }, 400);
const unauthorized = () => jsonResponse({ error: "missing or invalid identity proof" }, 401);
const stale = () => jsonResponse({ error: "stale or replayed issuedAt" }, 409);

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
        return this.handleRemove(request, url);
      case "/do/prekeys/publish":
        return this.handlePrekeyPublish(request);
      case "/do/prekeys/get":
        return this.handlePrekeyGet(url);
      case "/do/prekeys/remove":
        return this.handlePrekeyRemove(request, url);
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

  /**
   * Accept `issuedAt` for `key` only when fresh and strictly greater than the
   * last accepted value; persists it so replays fail across reloads/removals.
   */
  private async claimIssuedAt(key: string, issuedAt: number, now: number): Promise<boolean> {
    if (!isFreshIssuedAt(issuedAt, now)) return false;
    const last = await this.state.storage.get<number>(key);
    if (typeof last === "number" && issuedAt <= last) return false;
    await this.state.storage.put(key, issuedAt);
    return true;
  }

  private async handlePublish(request: Request): Promise<Response> {
    const body = await readBody(request, LEASE_PUBLISH_KEYS);
    if (
      !body ||
      typeof body.deviceId !== "string" ||
      !HEX32.test(body.deviceId) ||
      typeof body.expiresAt !== "number" ||
      !Number.isSafeInteger(body.expiresAt) ||
      (body.nonce !== undefined && typeof body.nonce !== "string") ||
      (body.relayHint !== undefined && typeof body.relayHint !== "string")
    ) {
      return malformed();
    }
    const now = Date.now();
    const verified = verifyIdentityAuthJson(body, "presence.publish", body.identityId, now);
    if (!verified) return unauthorized();
    if (verified.deviceId && toHex(verified.deviceId) !== body.deviceId) return unauthorized();

    // Validate expiresAt in future
    if (body.expiresAt <= now) {
      return jsonResponse({ error: "lease already expired" }, 400);
    }
    if (!(await this.claimIssuedAt(`presence-seq:${body.identityId}`, body.issuedAt as number, now))) return stale();

    const { auth: _auth, ...fields } = body;
    const lease = fields as unknown as PresenceLeaseData;
    // Cap to max TTL (AD-11)
    const maxExpiry = now + PRESENCE_LEASE_TTL_MS;
    if (lease.expiresAt > maxExpiry) {
      lease.expiresAt = maxExpiry;
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
    const body = await readBody(request, PREKEY_PUBLISH_KEYS);
    if (
      !body ||
      typeof body.identityDhPublic !== "string" ||
      typeof body.signedPrekeyPublic !== "string" ||
      typeof body.signedPrekeySig !== "string" ||
      typeof body.identitySignPublic !== "string" ||
      (body.oneTimePrekeyPublic !== undefined && typeof body.oneTimePrekeyPublic !== "string") ||
      (body.oneTimePrekeyId !== undefined &&
        (typeof body.oneTimePrekeyId !== "number" || !Number.isSafeInteger(body.oneTimePrekeyId)))
    ) {
      return malformed();
    }
    const now = Date.now();
    if (!verifyIdentityAuthJson(body, "prekeys.publish", body.identityId, now)) return unauthorized();

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
    if (!(await this.claimIssuedAt(`prekey-seq:${body.identityId}`, body.issuedAt as number, now))) return stale();

    // Signed fields verbatim plus proof; only `updatedAt` is added.
    const stored = { ...body, updatedAt: now } as unknown as PrekeyBundleData;
    this.prekeys.set(stored.identityId, stored);
    await this.state.storage.put(`prekey:${stored.identityId}`, stored);
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

  /**
   * Verify a signed `{ identityId, issuedAt, auth }` removal whose identity
   * matches the `identityId` path param. Returns the identity or an error.
   */
  private async authorizeRemove(
    request: Request,
    url: URL,
    operation: string,
    seqKey: string,
  ): Promise<string | Response> {
    const body = await readBody(request, REMOVE_KEYS);
    if (!body || body.identityId !== url.searchParams.get("identityId")) return malformed();
    const now = Date.now();
    if (!verifyIdentityAuthJson(body, operation, body.identityId, now)) return unauthorized();
    const identityId = body.identityId as string;
    if (!(await this.claimIssuedAt(`${seqKey}:${identityId}`, body.issuedAt as number, now))) return stale();
    return identityId;
  }

  private async handlePrekeyRemove(request: Request, url: URL): Promise<Response> {
    const identityId = await this.authorizeRemove(request, url, "prekeys.remove", "prekey-seq");
    if (identityId instanceof Response) return identityId;
    const removed = this.prekeys.delete(identityId);
    if (removed) {
      await this.state.storage.delete(`prekey:${identityId}`);
    }
    return jsonResponse({ ok: true, removed });
  }

  // ── Remove ─────────────────────────────────────────────────────────

  private async handleRemove(request: Request, url: URL): Promise<Response> {
    const identityId = await this.authorizeRemove(request, url, "presence.remove", "presence-seq");
    if (identityId instanceof Response) return identityId;

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

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.post("/presence/publish", (c) => handlePublish(c.req.raw, c.env));
app.get("/presence/subscribe", (c) => handleSubscribe(c.req.raw, c.env));
app.post("/prekeys/publish", (c) => handlePrekeyPublishHttp(c.req.raw, c.env));
app.get("/presence/:identityId", (c) => handleQueryIdentity(c.req.param("identityId"), c.env));
app.delete("/presence/:identityId", (c) => handleRemoveIdentity(c.req.raw, c.req.param("identityId"), c.env));
app.get("/prekeys/:identityId", (c) => handlePrekeyGetHttp(c.req.param("identityId"), c.env));
app.delete("/prekeys/:identityId", (c) => handlePrekeyRemoveHttp(c.req.raw, c.req.param("identityId"), c.env));
app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : "internal error" }, 500));

export default app;

async function handlePublish(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getPresenceStub(env);
  return stub.fetch("https://presence/do/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleQueryIdentity(identityId: string, env: Env): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(`https://presence/do/query?identityId=${encodeURIComponent(identityId)}`);
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(request);
}

/** Forward a signed removal body; the DO checks it against the path id. */
async function forwardRemove(doPath: string, request: Request, identityId: string, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getPresenceStub(env);
  return stub.fetch(`https://presence${doPath}?identityId=${encodeURIComponent(identityId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleRemoveIdentity(request: Request, identityId: string, env: Env): Promise<Response> {
  return forwardRemove("/do/remove", request, identityId, env);
}

async function handlePrekeyPublishHttp(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getPresenceStub(env);
  return stub.fetch("https://presence/do/prekeys/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handlePrekeyGetHttp(identityId: string, env: Env): Promise<Response> {
  const stub = getPresenceStub(env);
  return stub.fetch(`https://presence/do/prekeys/get?identityId=${encodeURIComponent(identityId)}`);
}

async function handlePrekeyRemoveHttp(request: Request, identityId: string, env: Env): Promise<Response> {
  return forwardRemove("/do/prekeys/remove", request, identityId, env);
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
