import { generateKeyPair, generateSigningKeyPair, randomBytes, sign } from "@nexnet/crypto";
import {
  cdeEncode,
  certificateToJson,
  eventToJson,
  identityIdFromWallet,
  issueDeviceCert,
  signEvent,
  signIdentityProof,
  signInPreimage,
  toBase64Url,
  toHex,
} from "@nexnet/protocol";
import type { SignInMethod } from "@nexnet/protocol";
import type { DeviceCertificate } from "@nexnet/types";
import { GatewayApi } from "./api.js";
import { AgentError } from "./errors.js";
import type { ChannelName, AgentState, Message, Outbound, Platform, WalletSecret } from "./types.js";

export const MAX_LINE_BYTES = 65_536;
export const MAX_BODY_BYTES = 2000;
const PROTOCOL_VERSION = 1;
const CERT_LIFETIME_MS = 11 * 60 * 60 * 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const HISTORY_FETCH = 50;

interface DeviceKeys {
  signingSecretKey: Uint8Array;
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  deviceId: Uint8Array;
}

interface ActiveSession {
  token: string;
  method: SignInMethod;
  expiresAt: number;
  nextSequence: number;
  owner: boolean;
  short: string;
  username: string | null;
}

interface WireMessage {
  id: string;
  channel: string;
  author: { id: string; short: string; username: string | null };
  body: string;
  at: number;
  seq: number;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function shortId(identityHex: string): string {
  return `nx1${identityHex.slice(0, 4)}…${identityHex.slice(-4)}`;
}

function isChannel(value: unknown): value is ChannelName {
  return value === "updates" || value === "public";
}

function strip(message: WireMessage): Message {
  return { id: message.id, author: message.author, body: message.body, at: message.at };
}

export class AgentCore {
  private readonly api: GatewayApi | null;
  private wallet: WalletSecret | null = null;
  private device: DeviceKeys | null = null;
  private session: ActiveSession | null = null;
  private status: AgentState["gateway"]["status"];
  private queue: Promise<unknown> = Promise.resolve();
  private channels = new Set<ChannelName>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_START_MS;
  private closed = false;
  private readonly lastSeq = new Map<ChannelName, number>();
  private streamGeneration = 0;

  constructor(
    private readonly platform: Platform,
    private readonly emit: (output: Outbound) => void,
    fetcher?: typeof fetch
  ) {
    this.api = platform.gatewayUrl ? new GatewayApi(platform.gatewayUrl, fetcher) : null;
    this.status = this.api ? "offline" : "unconfigured";
  }

  async init(): Promise<void> {
    this.wallet = await this.platform.wallet.load();
  }

  close(): void {
    this.closed = true;
    this.stopStream();
  }

  async handleLine(line: string): Promise<void> {
    if (byteLength(line) > MAX_LINE_BYTES) {
      this.emit({ id: null, ok: false, error: { code: "invalid", message: "Line too long" } });
      return;
    }
    let request: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      request = parsed as Record<string, unknown>;
    } catch {
      this.emit({ id: null, ok: false, error: { code: "invalid", message: "Request must be a JSON object" } });
      return;
    }
    const id = typeof request.id === "number" || typeof request.id === "string" ? request.id : null;
    if (id === null) {
      this.emit({ id: null, ok: false, error: { code: "invalid", message: "Request needs an id" } });
      return;
    }
    const run = this.queue.then(() => this.dispatch(request));
    this.queue = run.catch(() => undefined);
    try {
      const result = await run;
      this.emit({ id, ok: true, result });
    } catch (error) {
      if (error instanceof AgentError) {
        this.emit({ id, ok: false, error: { code: error.code, message: error.message } });
      } else {
        this.emit({ id, ok: false, error: { code: "internal", message: "Internal error" } });
      }
    }
  }

  private async dispatch(request: Record<string, unknown>): Promise<unknown> {
    switch (request.cmd) {
      case "hello":
        return { agent: "nexnet-agent", protocol: PROTOCOL_VERSION, methods: this.platform.methods() };
      case "state":
        await this.probe();
        return this.state();
      case "identity.create":
        return this.createIdentity();
      case "signin":
        return this.signIn(request.method);
      case "signout":
        return this.signOut();
      case "history":
        return this.history(request.channel, request.limit);
      case "post":
        return this.post(request.channel, request.body);
      case "subscribe":
        return this.subscribe(request.channels);
      default:
        throw new AgentError("invalid", "Unknown command");
    }
  }

  private requireApi(): GatewayApi {
    if (!this.api) throw new AgentError("unconfigured", "No gateway is configured");
    return this.api;
  }

  private mark(next: AgentState["gateway"]["status"]): void {
    if (this.status === next) return;
    this.status = next;
    this.emit({ event: "state", state: this.state() });
  }

  private async call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const api = this.requireApi();
    try {
      const result = await api.request<T>(method, path, body, token);
      this.mark("online");
      return result;
    } catch (error) {
      if (error instanceof AgentError) {
        if (error.code === "offline") this.mark("offline");
        else this.mark("online");
      }
      throw error;
    }
  }

  private async probe(): Promise<void> {
    if (!this.api) return;
    try {
      await this.call("GET", "/v1/info");
    } catch {
      return;
    }
  }

  state(): AgentState {
    this.expireSession();
    const identityHex = this.wallet ? toHex(identityIdFromWallet(this.wallet.publicKey)) : null;
    return {
      gateway: { status: this.status, url: this.api?.url ?? null },
      identity: identityHex
        ? {
            id: identityHex,
            short: shortId(identityHex),
            username: this.session?.username ?? null,
          }
        : null,
      session: this.session ? { method: this.session.method, expiresAt: this.session.expiresAt } : null,
      owner: this.session?.owner ?? false,
    };
  }

  private expireSession(): void {
    if (this.session && this.session.expiresAt <= this.platform.now()) {
      this.session = null;
    }
  }

  private dropSession(): void {
    this.session = null;
    this.restartStream();
    this.emit({ event: "state", state: this.state() });
  }

  private async createIdentity(): Promise<AgentState> {
    this.requireApi();
    if (this.wallet) throw new AgentError("invalid", "An identity already exists on this device");
    await this.probe();
    if (this.status !== "online") throw new AgentError("offline", "Cannot reach the gateway");
    this.wallet = await this.platform.wallet.create();
    await this.register();
    return this.state();
  }

  private async register(): Promise<void> {
    const wallet = this.wallet!;
    await this.call("POST", "/v1/identity", {
      wallet: toHex(wallet.publicKey),
      proof: toBase64Url(signIdentityProof(wallet.secretKey, wallet.publicKey)),
    });
  }

  private deviceKeys(): DeviceKeys {
    if (!this.device) {
      const signing = generateSigningKeyPair();
      const encryption = generateKeyPair();
      this.device = {
        signingSecretKey: signing.secretKey,
        signingPublicKey: signing.publicKey,
        encryptionPublicKey: encryption.publicKey,
        deviceId: randomBytes(32),
      };
    }
    return this.device;
  }

  private async signIn(requested: unknown): Promise<AgentState> {
    this.requireApi();
    if (requested !== "wallet" && requested !== "ssh" && requested !== "passkey") {
      throw new AgentError("invalid", "Unknown sign-in method");
    }
    const method: SignInMethod = requested;
    if (!this.platform.methods().includes(method)) {
      throw new AgentError("invalid", `Sign-in with ${method} is not available here`);
    }
    if (!this.wallet) throw new AgentError("unauthenticated", "Create an identity first");
    const wallet = this.wallet;
    await this.register();
    const device = this.deviceKeys();
    const accountId = identityIdFromWallet(wallet.publicKey);
    const issuedAt = this.platform.now();
    const expiresAt = issuedAt + CERT_LIFETIME_MS;
    const certificate: DeviceCertificate =
      method === "wallet"
        ? issueDeviceCert(
            wallet.secretKey,
            device.signingPublicKey,
            device.encryptionPublicKey,
            device.deviceId,
            accountId,
            issuedAt,
            expiresAt,
            1
          )
        : {
            accountId,
            deviceId: device.deviceId,
            deviceSigningPublicKey: device.signingPublicKey,
            deviceEncryptionPublicKey: device.encryptionPublicKey,
            issuedAt,
            expiresAt,
            capabilities: 1,
            rootSignature: new Uint8Array(64),
          };
    const challenge = await this.call<{
      challengeId: string;
      nonce: string;
      expiresAt: number;
      audience: string;
      passkeyChallenge: string | null;
      rpId: string | null;
    }>("POST", "/v1/auth/challenge", { method, certificate: certificateToJson(certificate) });
    const preimage = signInPreimage({
      audience: challenge.audience,
      method,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      certificate,
    });
    const body: Record<string, unknown> = {
      challengeId: challenge.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
    };
    if (method === "ssh") {
      if (!this.platform.signSsh) throw new AgentError("invalid", "SSH signing is not available here");
      body.ssh = await this.platform.signSsh(preimage);
    } else if (method === "passkey") {
      if (!this.platform.assertPasskey || !challenge.passkeyChallenge || !challenge.rpId) {
        throw new AgentError("invalid", "Passkeys are not available here");
      }
      body.passkey = await this.platform.assertPasskey(challenge.passkeyChallenge, challenge.rpId);
    }
    const verified = await this.call<{
      token: string;
      identityId: string;
      method: SignInMethod;
      expiresAt: number;
      nextSequence: number;
      owner: boolean;
    }>("POST", "/v1/auth/verify", body);
    this.session = {
      token: verified.token,
      method: verified.method,
      expiresAt: verified.expiresAt,
      nextSequence: verified.nextSequence,
      owner: verified.owner,
      short: shortId(verified.identityId),
      username: null,
    };
    try {
      const info = await this.call<{ username: string | null }>("GET", "/v1/session", undefined, verified.token);
      this.session.username = info.username;
    } catch {
      this.session.username = null;
    }
    this.restartStream();
    return this.state();
  }

  private async signOut(): Promise<AgentState> {
    const session = this.session;
    this.session = null;
    this.restartStream();
    if (session && this.api) {
      try {
        await this.call("POST", "/v1/auth/logout", {}, session.token);
      } catch {
        return this.state();
      }
    }
    return this.state();
  }

  private async history(channel: unknown, limit: unknown): Promise<{ channel: ChannelName; messages: Message[] }> {
    if (!isChannel(channel)) throw new AgentError("invalid", "Unknown channel");
    const count = limit === undefined ? HISTORY_FETCH : limit;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 200) {
      throw new AgentError("invalid", "limit must be 1 to 200");
    }
    const result = await this.call<{ messages: WireMessage[] }>("GET", `/v1/channels/${channel}/messages?limit=${count}`);
    for (const message of result.messages) this.noteSeq(channel, message.seq);
    return { channel, messages: result.messages.map(strip) };
  }

  private noteSeq(channel: ChannelName, seq: number): void {
    if (seq > (this.lastSeq.get(channel) ?? 0)) this.lastSeq.set(channel, seq);
  }

  private async post(channel: unknown, body: unknown): Promise<{ message: Message }> {
    if (!isChannel(channel)) throw new AgentError("invalid", "Unknown channel");
    if (typeof body !== "string" || body.trim().length === 0) throw new AgentError("invalid", "Message is empty");
    if (byteLength(body) > MAX_BODY_BYTES) {
      throw new AgentError("invalid", `Message exceeds ${MAX_BODY_BYTES} bytes`);
    }
    this.requireApi();
    this.expireSession();
    if (!this.session || !this.wallet) {
      throw new AgentError("unauthenticated", "Sign in before posting");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = this.session;
      if (!session) throw new AgentError("unauthenticated", "Sign in before posting");
      const device = this.deviceKeys();
      const event = signEvent(
        {
          protocolVersion: 1,
          eventType: "channel.post",
          authorIdentityId: identityIdFromWallet(this.wallet.publicKey),
          authorDeviceId: device.deviceId,
          createdAt: this.platform.now(),
          sequence: session.nextSequence,
          parentIds: [],
          payload: cdeEncode({ channel, body }),
        },
        device.signingSecretKey
      );
      try {
        const result = await this.call<{ message: WireMessage }>(
          "POST",
          `/v1/channels/${channel}/messages`,
          { event: eventToJson(event) },
          session.token
        );
        session.nextSequence = event.sequence + 1;
        this.noteSeq(channel, result.message.seq);
        return { message: strip(result.message) };
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        if (error.code === "unauthenticated" || error.code === "revoked") {
          this.dropSession();
          throw error;
        }
        if (attempt === 0 && /sequence/i.test(error.message)) {
          const info = await this.call<{ nextSequence: number }>("GET", "/v1/session", undefined, session.token);
          session.nextSequence = info.nextSequence;
          continue;
        }
        throw error;
      }
    }
    throw new AgentError("internal", "Internal error");
  }

  private async subscribe(requested: unknown): Promise<{ channels: ChannelName[] }> {
    if (!Array.isArray(requested) || requested.length === 0 || !requested.every(isChannel)) {
      throw new AgentError("invalid", "channels must be a non-empty list of updates or public");
    }
    this.requireApi();
    this.channels = new Set(requested);
    this.restartStream();
    return { channels: [...this.channels] };
  }

  private stopStream(): void {
    this.streamGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close();
      } catch {
        return;
      }
    }
  }

  private restartStream(): void {
    this.stopStream();
    this.backoff = BACKOFF_START_MS;
    if (this.channels.size > 0 && !this.closed) this.connectStream();
  }

  private connectStream(): void {
    if (!this.api || this.closed) return;
    const generation = this.streamGeneration;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.api.streamUrl());
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.streamGeneration) return;
      socket.send(
        JSON.stringify({
          ...(this.session ? { token: this.session.token } : {}),
          channels: [...this.channels],
        })
      );
    };
    socket.onmessage = (event) => {
      if (generation !== this.streamGeneration) return;
      let frame: any;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.event === "ready") {
        this.backoff = BACKOFF_START_MS;
        this.mark("online");
        void this.fillGap(generation);
      } else if (frame.event === "message" && isChannel(frame.channel)) {
        const wire = frame.message as WireMessage;
        if (wire.seq <= (this.lastSeq.get(frame.channel) ?? 0)) return;
        this.noteSeq(frame.channel, wire.seq);
        this.emit({ event: "message", channel: frame.channel, message: strip(wire) });
      } else if (frame.event === "revoked") {
        this.session = null;
        this.emit({ event: "state", state: this.state() });
        this.emit({ event: "error", code: "revoked", message: "This session was revoked" });
      } else if (frame.event === "error" && frame.code === "unauthenticated" && this.session) {
        this.session = null;
        this.emit({ event: "state", state: this.state() });
      }
    };
    socket.onclose = () => {
      if (generation !== this.streamGeneration) return;
      this.socket = null;
      this.mark("offline");
      this.scheduleReconnect(generation);
    };
    socket.onerror = () => {
      return;
    };
  }

  private scheduleReconnect(generation: number): void {
    if (this.closed || generation !== this.streamGeneration) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation === this.streamGeneration && !this.closed) this.connectStream();
    }, delay);
  }

  private async fillGap(generation: number): Promise<void> {
    for (const channel of this.channels) {
      const known = this.lastSeq.get(channel);
      if (known === undefined) continue;
      try {
        const result = await this.call<{ messages: WireMessage[] }>(
          "GET",
          `/v1/channels/${channel}/messages?limit=${HISTORY_FETCH}`
        );
        if (generation !== this.streamGeneration) return;
        for (const wire of result.messages) {
          if (wire.seq <= (this.lastSeq.get(channel) ?? 0)) continue;
          this.noteSeq(channel, wire.seq);
          this.emit({ event: "message", channel, message: strip(wire) });
        }
      } catch {
        return;
      }
    }
  }
}
