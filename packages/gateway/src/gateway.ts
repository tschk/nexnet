import { createHash, randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import type {
  ChainApiClient,
  DeviceCertificate,
  PasskeyAssertion,
  PasskeyCredential,
  SshKeyCommitment,
} from "@nexnet/types";
import { PROTOCOL_VERSION } from "@nexnet/types";
import {
  formatSshPublicKey,
  identityIdFromWallet,
  parseSshPublicKey,
  signInPreimage,
  sshFingerprint,
  validateEventLimits,
  verifyEvent,
  verifyEventId,
  verifyIdentityProof,
  verifySshSignature,
} from "@nexnet/protocol";
import type { SignInMethod } from "@nexnet/protocol";
import { verify } from "@nexnet/crypto";
import type { GatewayConfig } from "./config.js";
import {
  CHANNELS,
  DuplicateGuard,
  RATE_WINDOW_MS,
  SPAM_DUPLICATE_THRESHOLD,
  SlidingWindow,
  isChannelId,
  validateBody,
} from "./policy.js";
import type { ChannelId } from "./policy.js";
import { Store } from "./store.js";
import type { StoredMessage, StoredSession } from "./store.js";
import {
  WireError,
  base64UrlBytes,
  certificateFromJson,
  certificateToJson,
  decodeChannelPayload,
  eventFromJson,
  hexBytes,
  record,
  revocationFromJson,
  safeInteger,
  toHex,
} from "./wire.js";

const CHALLENGE_TTL_MS = 120_000;
const EVENT_SKEW_MS = 5 * 60_000;
const CERT_SKEW_MS = 5 * 60_000;
const MAX_BODY_JSON_BYTES = 64 * 1024;
const MAX_PENDING_CHALLENGES = 10_000;
const DEFAULT_WS_AUTH_TIMEOUT_MS = 5_000;
const CAPABILITY_POST = 1;
const HISTORY_LIMIT_MAX = 200;
const METHODS: SignInMethod[] = ["wallet", "ssh", "passkey"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface PendingChallenge {
  id: string;
  method: SignInMethod;
  nonce: string;
  expiresAt: number;
  certificate: DeviceCertificate;
}

interface SocketData {
  tokenHash: string | null;
  channels: Set<ChannelId>;
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PublicMessage {
  id: string;
  channel: string;
  author: { id: string; short: string; username: string | null };
  body: string;
  at: number;
  seq: number;
}

export interface GatewayHandle {
  server: Server<SocketData>;
  url: string;
  store: Store;
  close(): Promise<void>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function shortIdentity(identityHex: string): string {
  return `nx1${identityHex.slice(0, 4)}…${identityHex.slice(-4)}`;
}

export class Gateway {
  readonly store: Store;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private readonly postLimits = new Map<ChannelId, SlidingWindow>();
  private readonly duplicateGuards = new Map<ChannelId, DuplicateGuard>();
  private readonly identityCreateLimit = new SlidingWindow(5, 60 * 60_000);
  private readonly identityCreateGlobal = new SlidingWindow(120, 60 * 60_000);
  private readonly challengeLimit = new SlidingWindow(30, 60_000);
  private readonly mutationLimit = new SlidingWindow(30, 60_000);

  constructor(
    private readonly config: GatewayConfig,
    private readonly chain: ChainApiClient,
    store?: Store
  ) {
    this.store = store ?? new Store(config.stateDir ? `${config.stateDir}/gateway.sqlite` : ":memory:");
    for (const policy of Object.values(CHANNELS)) {
      this.postLimits.set(policy.id, new SlidingWindow(policy.rateLimit, RATE_WINDOW_MS));
      this.duplicateGuards.set(policy.id, new DuplicateGuard(SPAM_DUPLICATE_THRESHOLD, RATE_WINDOW_MS));
    }
  }

  private now(): number {
    return this.config.now();
  }

  listen(port: number, hostname = "127.0.0.1"): GatewayHandle {
    const gateway = this;
    const server = Bun.serve<SocketData>({
      port,
      hostname,
      fetch(req, srv) {
        return gateway.handle(req, srv);
      },
      websocket: {
        open(ws) {
          gateway.onSocketOpen(ws);
        },
        message(ws, message) {
          gateway.onSocketMessage(ws, message);
        },
        close(ws) {
          gateway.onSocketClose(ws);
        },
        maxPayloadLength: 8192,
      },
    });
    return {
      server,
      url: `http://${hostname}:${server.port}`,
      store: this.store,
      close: async () => {
        for (const ws of this.sockets) ws.close();
        await server.stop(true);
        this.store.close();
      },
    };
  }

  async handle(req: Request, server: Server<SocketData>): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors = origin !== null && this.config.origins.includes(origin) ? origin : null;
    try {
      if (req.method === "OPTIONS") {
        return this.finish(new Response(null, { status: 204 }), cors, true);
      }
      if (url.pathname === "/v1/stream") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          throw new HttpError(426, "invalid", "WebSocket upgrade required");
        }
        if (origin !== null && cors === null) {
          throw new HttpError(403, "forbidden", "Origin not allowed");
        }
        const data: SocketData = { tokenHash: null, channels: new Set(), ready: false, timer: null };
        if (server.upgrade(req, { data })) return undefined as unknown as Response;
        throw new HttpError(400, "invalid", "WebSocket upgrade failed");
      }
      const ip = server.requestIP(req)?.address ?? "unknown";
      const response = await this.route(req, url, ip);
      return this.finish(response, cors, false);
    } catch (error) {
      return this.finish(this.errorResponse(error), cors, false);
    }
  }

  private finish(response: Response, cors: string | null, preflight: boolean): Response {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.append("vary", "Origin");
    if (cors !== null) {
      headers.set("access-control-allow-origin", cors);
      if (preflight) {
        headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
        headers.set("access-control-allow-headers", "authorization, content-type");
        headers.set("access-control-max-age", "600");
      }
    }
    return new Response(response.body, { status: response.status, headers });
  }

  private errorResponse(error: unknown): Response {
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof WireError) {
      return json({ error: { code: "invalid", message: error.message } }, 400);
    }
    console.error("gateway internal error", error instanceof Error ? error.message : "unknown");
    return json({ error: { code: "internal", message: "Internal error" } }, 500);
  }

  private async route(req: Request, url: URL, ip: string): Promise<Response> {
    const { pathname } = url;
    const method = req.method;
    if (method === "GET" && pathname === "/v1/info") return this.info();
    if (method === "POST" && pathname === "/v1/identity") return this.createIdentity(req, ip);
    if (method === "POST" && pathname === "/v1/credentials/ssh") return this.registerSsh(req, ip);
    if (method === "POST" && pathname === "/v1/credentials/passkey") return this.registerPasskey(req, ip);
    if (method === "POST" && pathname === "/v1/credentials/revoke") return this.revoke(req, ip);
    if (method === "POST" && pathname === "/v1/auth/challenge") return this.issueChallenge(req, ip);
    if (method === "POST" && pathname === "/v1/auth/verify") return this.verifyChallenge(req, ip);
    if (method === "POST" && pathname === "/v1/auth/logout") return this.logout(req);
    if (method === "GET" && pathname === "/v1/session") return this.sessionInfo(req);
    const channelMatch = /^\/v1\/channels\/([a-z]+)\/messages$/.exec(pathname);
    if (channelMatch) {
      const channel = channelMatch[1]!;
      if (!isChannelId(channel)) throw new HttpError(404, "not_found", "Unknown channel");
      if (method === "GET") return this.readMessages(channel, url);
      if (method === "POST") return this.post(req, channel);
    }
    throw new HttpError(404, "not_found", "Not found");
  }

  private info(): Response {
    return json({
      audience: this.config.audience,
      mode: "dev-chain",
      chain: "in-memory development chain; not a consensus chain",
      methods: METHODS.filter((method) => method !== "passkey" || this.config.rpId !== null),
      rpId: this.config.rpId,
      ownerConfigured: this.config.ownerIdentity !== null,
      channels: Object.values(CHANNELS).map((policy) => ({ id: policy.id, writers: policy.writers })),
    });
  }

  private async body(req: Request): Promise<Record<string, unknown>> {
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_JSON_BYTES) throw new HttpError(413, "too_large", "Request too large");
    const text = await req.text();
    if (text.length > MAX_BODY_JSON_BYTES) throw new HttpError(413, "too_large", "Request too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid", "Body must be JSON");
    }
    return record(parsed, "body");
  }

  private limit(window: SlidingWindow, key: string): void {
    if (!window.allow(key, this.now())) {
      throw new HttpError(429, "rate_limited", "Too many requests");
    }
  }

  private async createIdentity(req: Request, ip: string): Promise<Response> {
    const input = await this.body(req);
    const wallet = hexBytes(input.wallet, 32, "wallet");
    const proof = base64UrlBytes(input.proof, "proof", 64);
    if (!verifyIdentityProof(wallet, proof)) {
      throw new HttpError(401, "unauthenticated", "Identity proof is invalid");
    }
    const identityId = identityIdFromWallet(wallet);
    const existing = await this.chain.getIdentity(identityId);
    if (!existing) {
      this.limit(this.identityCreateLimit, ip);
      this.limit(this.identityCreateGlobal, "global");
    }
    try {
      const created = await this.chain.registerIdentity(wallet, identityId, proof);
      return json(
        { identityId: toHex(created.identityId), createdAt: created.createdAt, existed: existing !== null },
        existing ? 200 : 201
      );
    } catch (error) {
      throw new HttpError(409, "conflict", errorMessage(error));
    }
  }

  private async ownedIdentity(input: Record<string, unknown>): Promise<{ identityId: Uint8Array; wallet: Uint8Array }> {
    const identityId = hexBytes(input.identityId, 32, "identityId");
    const identity = await this.chain.getIdentity(identityId);
    if (!identity) throw new HttpError(404, "not_found", "Identity is not registered");
    return { identityId, wallet: identity.wallet };
  }

  private async registerSsh(req: Request, ip: string): Promise<Response> {
    this.limit(this.mutationLimit, ip);
    const input = await this.body(req);
    const { identityId, wallet } = await this.ownedIdentity(input);
    if (typeof input.publicKey !== "string" || input.publicKey.length > 1024) {
      throw new WireError("Invalid publicKey");
    }
    let publicKey: Uint8Array;
    try {
      publicKey = parseSshPublicKey(input.publicKey);
    } catch (error) {
      throw new HttpError(400, "invalid", errorMessage(error));
    }
    const commitment: SshKeyCommitment = {
      algorithm: "ssh-ed25519",
      publicKey,
      fingerprint: sshFingerprint(publicKey),
    };
    try {
      await this.chain.registerSshKey(wallet, identityId, commitment, base64UrlBytes(input.rootSignature, "rootSignature", 64));
    } catch (error) {
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
    return json({ fingerprint: commitment.fingerprint, publicKey: formatSshPublicKey(publicKey) }, 201);
  }

  private async registerPasskey(req: Request, ip: string): Promise<Response> {
    this.limit(this.mutationLimit, ip);
    if (this.config.rpId === null || this.config.origins.length === 0) {
      throw new HttpError(503, "unavailable", "Passkeys are not configured");
    }
    const input = await this.body(req);
    const { identityId, wallet } = await this.ownedIdentity(input);
    const raw = record(input.credential, "credential");
    if (typeof raw.credentialId !== "string" || raw.credentialId.length === 0 || raw.credentialId.length > 1024) {
      throw new WireError("Invalid credential.credentialId");
    }
    const credential: PasskeyCredential = {
      credentialId: raw.credentialId,
      publicKey: base64UrlBytes(raw.publicKey, "credential.publicKey", 1024),
      counter: safeInteger(raw.counter, "credential.counter"),
      rpId: typeof raw.rpId === "string" ? raw.rpId : "",
      origin: typeof raw.origin === "string" ? raw.origin : "",
    };
    if (credential.rpId !== this.config.rpId || !this.config.origins.includes(credential.origin)) {
      throw new HttpError(400, "invalid", "Passkey relying party or origin is not allowed here");
    }
    try {
      await this.chain.registerPasskeyCredential(
        wallet,
        identityId,
        credential,
        base64UrlBytes(input.rootSignature, "rootSignature", 64)
      );
    } catch (error) {
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
    return json({ credentialId: credential.credentialId }, 201);
  }

  private async revoke(req: Request, ip: string): Promise<Response> {
    this.limit(this.mutationLimit, ip);
    const input = await this.body(req);
    const revocation = revocationFromJson(input.revocation);
    const identity = await this.chain.getIdentity(revocation.accountId);
    if (!identity) throw new HttpError(404, "not_found", "Identity is not registered");
    try {
      await this.chain.revokeCredential(identity.wallet, revocation);
    } catch (error) {
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
    await this.sweepSessions(toHex(revocation.accountId));
    return json({ ok: true });
  }

  private async sweepSessions(identityHex: string): Promise<void> {
    const identityId = hexBytes(identityHex, 32, "identity");
    for (const session of this.store.sessionsForIdentity(identityHex)) {
      const certificate = await this.chain.resolveDeviceCertificate(identityId, hexBytes(session.device, 32, "device"));
      if (!certificate) this.endSession(session.tokenHash);
    }
  }

  private endSession(tokenHash: string): void {
    this.store.deleteSession(tokenHash);
    for (const ws of this.sockets) {
      if (ws.data.tokenHash === tokenHash) {
        ws.data.tokenHash = null;
        this.sendSocket(ws, { event: "revoked" });
        ws.close(4401, "session ended");
      }
    }
  }

  private async issueChallenge(req: Request, ip: string): Promise<Response> {
    this.limit(this.challengeLimit, ip);
    const input = await this.body(req);
    const method = input.method;
    if (method !== "wallet" && method !== "ssh" && method !== "passkey") {
      throw new HttpError(400, "invalid", "Unknown sign-in method");
    }
    if (method === "passkey" && this.config.rpId === null) {
      throw new HttpError(503, "unavailable", "Passkeys are not configured");
    }
    const certificate = certificateFromJson(input.certificate);
    const now = this.now();
    this.checkCertificateWindow(certificate, now);
    const identity = await this.chain.getIdentity(certificate.accountId);
    if (!identity) throw new HttpError(404, "not_found", "Identity is not registered");
    if (await this.chain.isRevoked(certificate.accountId, "device", toHex(certificate.deviceId))) {
      throw new HttpError(403, "revoked", "Device is revoked");
    }
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) this.pruneChallenges(now);
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      throw new HttpError(503, "unavailable", "Too many pending sign-ins");
    }
    const challenge: PendingChallenge = {
      id: randomBytes(16).toString("hex"),
      method,
      nonce: randomBytes(32).toString("hex"),
      expiresAt: now + CHALLENGE_TTL_MS,
      certificate,
    };
    let passkeyChallenge: string | null = null;
    if (method === "passkey") {
      try {
        passkeyChallenge = (await this.chain.beginPasskeyDeviceCertificateAuthorization(certificate.accountId, certificate)).challenge;
      } catch (error) {
        throw new HttpError(403, "forbidden", errorMessage(error));
      }
    }
    this.challenges.set(challenge.id, challenge);
    return json({
      challengeId: challenge.id,
      method,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      audience: this.config.audience,
      passkeyChallenge,
      rpId: method === "passkey" ? this.config.rpId : null,
      certificate: certificateToJson(certificate),
    });
  }

  private pruneChallenges(now: number): void {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
  }

  private checkCertificateWindow(certificate: DeviceCertificate, now: number): void {
    const lifetime = certificate.expiresAt - certificate.issuedAt;
    if (
      certificate.expiresAt <= now ||
      certificate.issuedAt > now + CERT_SKEW_MS ||
      lifetime <= 0 ||
      lifetime > this.config.sessionMaxMs ||
      (certificate.capabilities & ~CAPABILITY_POST) !== 0
    ) {
      throw new HttpError(400, "invalid", "Device certificate window or capabilities are not acceptable");
    }
  }

  private async verifyChallenge(req: Request, ip: string): Promise<Response> {
    this.limit(this.challengeLimit, ip);
    const input = await this.body(req);
    if (typeof input.challengeId !== "string" || !/^[0-9a-f]{32}$/.test(input.challengeId)) {
      throw new WireError("Invalid challengeId");
    }
    const challenge = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    const now = this.now();
    if (!challenge || challenge.expiresAt <= now) {
      throw new HttpError(401, "unauthenticated", "Challenge is unknown, used or expired");
    }
    const certificate = challenge.certificate;
    const identityHex = toHex(certificate.accountId);
    const identity = await this.chain.getIdentity(certificate.accountId);
    if (!identity) throw new HttpError(401, "unauthenticated", "Identity is not registered");
    const preimage = signInPreimage({
      audience: this.config.audience,
      method: challenge.method,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      certificate,
    });
    const deviceSignature = base64UrlBytes(input.deviceSignature, "deviceSignature", 64);
    if (!verify(certificate.deviceSigningPublicKey, preimage, deviceSignature)) {
      throw new HttpError(401, "unauthenticated", "Device signature is invalid");
    }
    this.checkCertificateWindow(certificate, now);
    if (await this.chain.isRevoked(certificate.accountId, "device", toHex(certificate.deviceId))) {
      throw new HttpError(403, "revoked", "Device is revoked");
    }
    if (challenge.method === "wallet") {
      try {
        await this.chain.registerDeviceCertificate(identity.wallet, certificate);
      } catch (error) {
        throw new HttpError(401, "unauthenticated", errorMessage(error));
      }
    } else if (challenge.method === "ssh") {
      const ssh = record(input.ssh, "ssh");
      if (typeof ssh.publicKey !== "string" || ssh.publicKey.length > 1024 || typeof ssh.signature !== "string" || ssh.signature.length > 4096) {
        throw new WireError("Invalid ssh");
      }
      let publicKey: Uint8Array;
      try {
        publicKey = parseSshPublicKey(ssh.publicKey);
      } catch {
        throw new HttpError(401, "unauthenticated", "SSH key is invalid");
      }
      const fingerprint = sshFingerprint(publicKey);
      if (await this.chain.isRevoked(certificate.accountId, "ssh", fingerprint)) {
        throw new HttpError(403, "revoked", "SSH key is revoked");
      }
      if (!(await this.chain.resolveSshKey(certificate.accountId, fingerprint))) {
        throw new HttpError(401, "unauthenticated", "SSH key is not authorized by this wallet");
      }
      if (!verifySshSignature(ssh.signature, preimage, publicKey)) {
        throw new HttpError(401, "unauthenticated", "SSH signature is invalid");
      }
      try {
        await this.chain.authorizeDeviceCertificateWithSshKey(certificate.accountId, certificate, fingerprint);
      } catch (error) {
        throw new HttpError(401, "unauthenticated", errorMessage(error));
      }
    } else {
      const assertion = record(input.passkey, "passkey");
      try {
        await this.chain.authorizeDeviceCertificateWithPasskey(
          certificate.accountId,
          certificate,
          passkeyAssertionFromJson(assertion)
        );
      } catch (error) {
        if (error instanceof WireError) throw error;
        throw new HttpError(401, "unauthenticated", errorMessage(error));
      }
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(certificate.expiresAt, now + this.config.sessionMaxMs);
    const session: StoredSession = {
      tokenHash: hashToken(token),
      identity: identityHex,
      device: toHex(certificate.deviceId),
      method: challenge.method,
      expiresAt,
    };
    this.store.deleteExpiredSessions(now);
    this.store.createSession(session);
    return json({ token, ...this.describeSession(session) }, 201);
  }

  private describeSession(session: StoredSession) {
    return {
      identityId: session.identity,
      deviceId: session.device,
      method: session.method,
      expiresAt: session.expiresAt,
      nextSequence: this.store.lastSequence(session.device) + 1,
      owner: this.config.ownerIdentity !== null && session.identity === this.config.ownerIdentity,
    };
  }

  private bearer(req: Request): string {
    const header = req.headers.get("authorization");
    const match = header ? /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header) : null;
    if (!match) throw new HttpError(401, "unauthenticated", "Bearer token required");
    return match[1]!;
  }

  private async authenticate(token: string): Promise<{ session: StoredSession; certificate: DeviceCertificate }> {
    const tokenHash = hashToken(token);
    const session = this.store.getSession(tokenHash);
    if (!session) throw new HttpError(401, "unauthenticated", "Session is unknown or ended");
    if (session.expiresAt <= this.now()) {
      this.endSession(tokenHash);
      throw new HttpError(401, "unauthenticated", "Session expired");
    }
    const certificate = await this.chain.resolveDeviceCertificate(
      hexBytes(session.identity, 32, "identity"),
      hexBytes(session.device, 32, "device")
    );
    if (!certificate) {
      this.endSession(tokenHash);
      throw new HttpError(403, "revoked", "Credential behind this session is revoked or expired");
    }
    return { session, certificate };
  }

  private async logout(req: Request): Promise<Response> {
    const token = this.bearer(req);
    this.endSession(hashToken(token));
    return json({ ok: true });
  }

  private async sessionInfo(req: Request): Promise<Response> {
    const { session } = await this.authenticate(this.bearer(req));
    const identity = await this.chain.getIdentity(hexBytes(session.identity, 32, "identity"));
    return json({
      ...this.describeSession(session),
      short: shortIdentity(session.identity),
      username: identity?.username ?? null,
    });
  }

  private async publicMessage(row: StoredMessage): Promise<PublicMessage> {
    const identity = await this.chain.getIdentity(hexBytes(row.identity, 32, "identity"));
    return {
      id: row.eventId,
      channel: row.channel,
      author: { id: row.identity, short: shortIdentity(row.identity), username: identity?.username ?? null },
      body: row.body,
      at: row.createdAt,
      seq: row.seq,
    };
  }

  private expireChannel(channel: ChannelId): void {
    if (CHANNELS[channel].retains) return;
    const last = this.store.lastMessageAt(channel);
    if (last !== null && this.now() - last >= this.config.publicRetentionMs) {
      this.store.purgeChannel(channel);
    }
  }

  private async readMessages(channel: ChannelId, url: URL): Promise<Response> {
    const rawLimit = url.searchParams.get("limit");
    const rawBefore = url.searchParams.get("before");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const before = rawBefore === null ? null : Number(rawBefore);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) {
      throw new HttpError(400, "invalid", "limit must be 1 to 200");
    }
    if (before !== null && (!Number.isInteger(before) || before < 1)) {
      throw new HttpError(400, "invalid", "before must be a positive integer");
    }
    this.expireChannel(channel);
    const rows = this.store.messages(channel, limit, before);
    return json({ channel, messages: await Promise.all(rows.map((row) => this.publicMessage(row))) });
  }

  private async post(req: Request, channel: ChannelId): Promise<Response> {
    const { session, certificate } = await this.authenticate(this.bearer(req));
    const input = await this.body(req);
    const event = eventFromJson(input.event);
    if (event.protocolVersion !== PROTOCOL_VERSION || event.eventType !== "channel.post") {
      throw new HttpError(400, "invalid", "Unsupported event type");
    }
    if (toHex(event.authorIdentityId) !== session.identity || toHex(event.authorDeviceId) !== session.device) {
      throw new HttpError(403, "forbidden", "Event author does not match the session");
    }
    try {
      validateEventLimits(event);
    } catch (error) {
      throw new HttpError(400, "invalid", errorMessage(error));
    }
    if (!verifyEventId(event) || !verifyEvent(event, certificate.deviceSigningPublicKey)) {
      throw new HttpError(401, "unauthenticated", "Event signature is invalid");
    }
    const now = this.now();
    if (Math.abs(event.createdAt - now) > EVENT_SKEW_MS) {
      throw new HttpError(400, "invalid", "Event timestamp is outside the accepted window");
    }
    const payload = decodeChannelPayload(event.payload);
    if (payload.channel !== channel) {
      throw new HttpError(400, "invalid", "Event is signed for a different channel");
    }
    const problem = validateBody(payload.body);
    if (problem) throw new HttpError(400, "invalid", problem);
    const policy = CHANNELS[channel];
    const isOwner = this.config.ownerIdentity !== null && session.identity === this.config.ownerIdentity;
    if (policy.writers === "owner" && !isOwner) {
      throw new HttpError(403, "forbidden", "Only the owner may post to this channel");
    }
    const eventId = toHex(event.eventId);
    if (this.store.hasEvent(eventId)) {
      throw new HttpError(409, "duplicate", "Event was already accepted");
    }
    if (event.sequence <= this.store.lastSequence(session.device)) {
      throw new HttpError(409, "stale_sequence", "Event sequence must increase");
    }
    this.expireChannel(channel);
    if (!this.postLimits.get(channel)!.allow(session.identity, now)) {
      throw new HttpError(429, "rate_limited", "Posting too fast; wait a moment");
    }
    if (!this.duplicateGuards.get(channel)!.allow(session.identity, payload.body, now)) {
      throw new HttpError(429, "rate_limited", "Repeated message blocked");
    }
    const stored = this.store.insertMessage(
      {
        channel,
        eventId,
        identity: session.identity,
        device: session.device,
        createdAt: event.createdAt,
        receivedAt: now,
        body: payload.body,
      },
      event.sequence
    );
    if (stored === "duplicate") throw new HttpError(409, "duplicate", "Event was already accepted");
    if (stored === "stale_sequence") throw new HttpError(409, "stale_sequence", "Event sequence must increase");
    const message = await this.publicMessage(stored);
    this.broadcast(channel, message);
    return json({ message }, 201);
  }

  private broadcast(channel: ChannelId, message: PublicMessage): void {
    for (const ws of this.sockets) {
      if (ws.data.ready && ws.data.channels.has(channel)) {
        this.sendSocket(ws, { event: "message", channel, message });
      }
    }
  }

  private sendSocket(ws: ServerWebSocket<SocketData>, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      return;
    }
  }

  private onSocketOpen(ws: ServerWebSocket<SocketData>): void {
    this.sockets.add(ws);
    ws.data.timer = setTimeout(() => {
      if (!ws.data.ready) ws.close(4408, "authentication timeout");
    }, this.config.wsAuthTimeoutMs ?? DEFAULT_WS_AUTH_TIMEOUT_MS);
  }

  private onSocketClose(ws: ServerWebSocket<SocketData>): void {
    this.sockets.delete(ws);
    if (ws.data.timer) clearTimeout(ws.data.timer);
  }

  private onSocketMessage(ws: ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (ws.data.ready) return;
    void (async () => {
      try {
        const text = typeof message === "string" ? message : message.toString("utf8");
        const input = record(JSON.parse(text), "frame");
        let tokenHash: string | null = null;
        if (input.token !== undefined) {
          if (typeof input.token !== "string") throw new WireError("Invalid token");
          const { session } = await this.authenticate(input.token);
          tokenHash = session.tokenHash;
        }
        const requested = input.channels === undefined ? ["updates", "public"] : input.channels;
        if (!Array.isArray(requested) || requested.length > 2 || !requested.every((c) => typeof c === "string" && isChannelId(c))) {
          throw new WireError("Invalid channels");
        }
        ws.data.tokenHash = tokenHash;
        ws.data.channels = new Set(requested as ChannelId[]);
        ws.data.ready = true;
        if (ws.data.timer) clearTimeout(ws.data.timer);
        this.sendSocket(ws, { event: "ready", authenticated: tokenHash !== null });
      } catch (error) {
        const code = error instanceof HttpError ? error.code : "invalid";
        this.sendSocket(ws, { event: "error", code, message: errorMessage(error) });
        ws.close(4400, code);
      }
    })();
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function passkeyAssertionFromJson(input: Record<string, unknown>): PasskeyAssertion {
  const response = record(input.response, "passkey.response");
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
      throw new WireError(`Invalid ${field}`);
    }
    return value;
  };
  if (input.type !== "public-key") throw new WireError("Invalid passkey.type");
  return {
    id: text(input.id, "passkey.id"),
    rawId: text(input.rawId, "passkey.rawId"),
    type: "public-key",
    response: {
      clientDataJSON: text(response.clientDataJSON, "passkey.response.clientDataJSON"),
      authenticatorData: text(response.authenticatorData, "passkey.response.authenticatorData"),
      signature: text(response.signature, "passkey.response.signature"),
      ...(typeof response.userHandle === "string" ? { userHandle: response.userHandle } : {}),
    },
    clientExtensionResults: {},
  };
}
