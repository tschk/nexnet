/**
 * @nexnet/client — NexnetClient main class
 *
 * Dependency-injected crypto/codec. WebSocket connection to relay.
 * Event emitter for incoming messages.
 * Exponential backoff reconnection.
 */

import type {
  IdentityId,
  DeviceId,
  CryptoProvider,
  CborCdeCodec,
  DeviceCertificate,
  DeviceCertificateResolver,
  OutboundQueueLike,
} from "@nexnet/types";
import { EventLog, OutboundQueue } from "@nexnet/storage";
import { publicKeyFromSecret } from "@nexnet/crypto";
import { signDeliveryReceipt, signIdentityAuthJson, type IdentitySigner } from "@nexnet/protocol";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { consumePresenceMessage } from "./presence.js";
import { QueueManager } from "./queue-manager.js";
import { DeviceCertificateLifecycle, type DeviceCertificateRenewer } from "./device-lifecycle.js";
import type { PersistentDmState, StoredInboxMessage } from "./persistent-client.js";
import { publishLocalPrekeys } from "./prekey-network.js";

export type EventType =
  | "dm"
  | "room_message"
  | "room_event"
  | "group_message"
  | "session_offer"
  | "session_answer"
  | "candidate"
  | "presence"
  | "delivery_receipt"
  | "verified_delivery_receipt"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "auth_failed"
  | "error";

export type EventHandler = (data: unknown) => void;

export interface NexnetClientConfig {
  identityId: IdentityId;
  deviceId: DeviceId;
  crypto: CryptoProvider;
  codec: CborCdeCodec;
  relayUrl: string;
  /** Presence service base URL; used to publish and fetch X3DH prekey bundles. */
  presenceUrl?: string;
  storagePath: string;
  /** Local-storage key material; certified auth, receipts and DMs use deviceSigningSecretKey. */
  signingSecretKey: Uint8Array;
  deviceSigningSecretKey?: Uint8Array;
  deviceSigningPublicKey?: Uint8Array;
  deviceCertificate?: DeviceCertificate;
  deviceCertificateResolver?: DeviceCertificateResolver;
  rootPublicKey?: Uint8Array;
  /** Obtain a root-signed renewal from the principal's signer; never return root key material. */
  renewDeviceCertificate?: DeviceCertificateRenewer;
  /** Max reconnect attempts before giving up. 0 = infinite. Default: 0 */
  maxReconnectAttempts?: number;
  /** Base backoff delay in ms. Default: 1000 */
  reconnectBaseMs?: number;
  /** Max backoff delay in ms. Default: 30000 */
  reconnectMaxMs?: number;
  /** Close the socket if the relay has not authenticated it within this many ms. Default: 15000 */
  handshakeTimeoutMs?: number;
  /** Created by createPersistentClient/openPersistentClient, not by a second backend. */
  persistentState?: PersistentDmState;
}

export class NexnetClient {
  readonly identityId: IdentityId;
  readonly deviceId: DeviceId;
  readonly crypto: CryptoProvider;
  readonly codec: CborCdeCodec;
  readonly relayUrl: string;
  readonly presenceUrl?: string;
  readonly storagePath: string;
  readonly signingSecretKey: Uint8Array;
  // Replaceable via setDeviceCredentials so a long-running client can renew its certificate.
  deviceSigningSecretKey?: Uint8Array;
  deviceSigningPublicKey?: Uint8Array;
  deviceCertificate?: DeviceCertificate;
  readonly deviceCertificateResolver?: DeviceCertificateResolver;
  readonly rootPublicKey?: Uint8Array;
  readonly persistentState?: PersistentDmState;
  private _closed = false;

  private _online = false;
  private _ws: WebSocket | null = null;
  private _listeners = new Map<EventType, Set<EventHandler>>();
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalClose = false;
  private _connectionGeneration = 0;
  private _eventLog: EventLog | null = null;
  private _outboundQueue: OutboundQueue | null = null;
  private _queueManager: QueueManager | null = null;
  private _maxReconnectAttempts: number;
  private _reconnectBaseMs: number;
  private _reconnectMaxMs: number;
  private _handshakeTimeoutMs: number;
  private readonly _deviceLifecycle: DeviceCertificateLifecycle | null;

  private readonly _identityHex: string;
  private readonly _deviceHex: string;

  constructor(config: NexnetClientConfig) {
    if (!config.persistentState && config.storagePath && existsSync(join(config.storagePath, "device.db"))) {
      throw new Error("Encrypted device state requires openPersistentClient and its unlock key");
    }
    this.identityId = config.identityId;
    this.deviceId = config.deviceId;
    this.crypto = config.crypto;
    this.codec = config.codec;
    this.relayUrl = config.relayUrl;
    this.presenceUrl = config.presenceUrl;
    this.storagePath = config.storagePath;
    this.signingSecretKey = config.signingSecretKey;
    this.deviceSigningSecretKey = config.deviceSigningSecretKey;
    this.deviceSigningPublicKey = config.deviceSigningPublicKey;
    this.deviceCertificate = config.deviceCertificate;
    this.deviceCertificateResolver = config.deviceCertificateResolver;
    this.rootPublicKey = config.rootPublicKey;
    this.persistentState = config.persistentState;
    this._maxReconnectAttempts = config.maxReconnectAttempts ?? 0;
    this._reconnectBaseMs = config.reconnectBaseMs ?? 1_000;
    this._reconnectMaxMs = config.reconnectMaxMs ?? 30_000;
    this._handshakeTimeoutMs = config.handshakeTimeoutMs ?? 15_000;
    this._deviceLifecycle = config.renewDeviceCertificate
      ? new DeviceCertificateLifecycle(this, config.renewDeviceCertificate)
      : null;

    this._identityHex = Buffer.from(config.identityId).toString("hex");
    this._deviceHex = Buffer.from(config.deviceId).toString("hex");
  }

  get online(): boolean {
    return this._online;
  }

  /** Hex-encoded identity ID for relay protocol */
  get identityHex(): string {
    return this._identityHex;
  }

  /** Hex-encoded device ID for relay protocol */
  get deviceHex(): string {
    return this._deviceHex;
  }

  /**
   * Key material that proves possession of this identity to relays and
   * services: the device key under its root-signed certificate when present,
   * otherwise the root key itself.
   */
  identitySigner(): IdentitySigner {
    if (this.deviceCertificate && this.deviceSigningSecretKey && this.rootPublicKey) {
      return {
        rootPublicKey: this.rootPublicKey,
        secretKey: this.deviceSigningSecretKey,
        certificate: this.deviceCertificate,
      };
    }
    return {
      rootPublicKey: this.rootPublicKey ?? publicKeyFromSecret(this.signingSecretKey),
      secretKey: this.signingSecretKey,
    };
  }

  /**
   * Replace this device's certificate and signing key, e.g. to renew before
   * expiry. Later relay auth, DMs and prekey publishes use the new credentials.
   */
  setDeviceCredentials(
    certificate: DeviceCertificate,
    signingSecretKey: Uint8Array,
    signingPublicKey: Uint8Array,
  ): void {
    if (!sameId(certificate.accountId, this.identityId) || !sameId(certificate.deviceId, this.deviceId)) {
      throw new Error("certificate is for a different identity or device");
    }
    if (this.persistentState) {
      if (
        !this.deviceSigningSecretKey ||
        !this.deviceSigningPublicKey ||
        !sameId(signingSecretKey, this.deviceSigningSecretKey) ||
        !sameId(signingPublicKey, this.deviceSigningPublicKey)
      ) {
        throw new Error("Persistent device key rotation requires explicit provisioning of a new device");
      }
      this.persistentState.write("credentials:v1", {
        ...this.persistentState.credentials(),
        deviceCertificate: certificate,
        deviceSigningSecretKey: signingSecretKey,
        deviceSigningPublicKey: signingPublicKey,
      });
    }
    this.deviceCertificate = certificate;
    this.deviceSigningSecretKey = signingSecretKey;
    this.deviceSigningPublicKey = signingPublicKey;
  }

  /** True when this client signs with a device certificate that is no longer valid. */
  deviceCertificateExpired(now = Date.now()): boolean {
    return !!this.deviceCertificate && this.deviceCertificate.expiresAt <= now;
  }

  /** Renew if due and retry any failed prekey publication. Errors are emitted and rethrown. */
  async ensureDeviceCertificate(now = Date.now()): Promise<void> {
    if (this._closed) throw new Error("Client is closed");
    await this._deviceLifecycle?.ensure(now);
  }

  /**
   * Connect to relay via WebSocket and authenticate.
   * URL: ws[s]://relayUrl/ws?identity=<hex>&device=<hex>
   * The relay replies with `auth_challenge`; the client signs the relay's
   * host, the nonce and its device id. Resolves once the relay confirms.
   */
  async connect(): Promise<void> {
    if (this._closed) throw new Error("Client is closed");
    if (this._online) return;
    this._intentionalClose = false;

    return this._connect();
  }

  async disconnect(): Promise<void> {
    this._intentionalClose = true;
    this._connectionGeneration++;
    this._deviceLifecycle?.stop();
    this._clearReconnectTimer();
    this._queueManager?.stop();
    this._queueManager = null;
    this._outboundQueue?.close();
    this._outboundQueue = null;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._online = false;
    this._reconnectAttempts = 0;
  }

  /** Disconnect keeps ownership for reconnect. close permanently releases device state. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.disconnect();
    this._eventLog?.close();
    this.persistentState?.store.close();
  }

  /** Durable transport inbox, not accepted/completed execution. Re-read after restart. */
  inbox(): StoredInboxMessage[] {
    if (!this.persistentState) throw new Error("A persistent client is required for inbox recovery");
    return this.persistentState.inbox();
  }
  /** Sender-held encrypted envelopes, retained until a verified receipt arrives. */
  outboundQueue(): OutboundQueueLike {
    if (this.persistentState) {
      if (!this._queueManager) {
        this._queueManager = new QueueManager(this.persistentState);
        this._queueManager.start(this);
      }
      return this.persistentState;
    }
    if (!this.storagePath) throw new Error("storagePath is required for the sender's offline DM queue");
    if (!this._outboundQueue) {
      mkdirSync(this.storagePath, { recursive: true });
      this._outboundQueue = OutboundQueue.open(join(this.storagePath, "outbound.db"));
      this._queueManager = new QueueManager(this._outboundQueue);
      this._queueManager.start(this);
    }
    return this._outboundQueue;
  }

  /**
   * Send a JSON message over the WebSocket.
   * Throws if not connected.
   */
  sendWs(payload: Record<string, unknown>): void {
    if (!this._ws || !this._online) {
      throw new Error("Not connected");
    }
    this._ws.send(JSON.stringify(payload));
  }

  /**
   * Send a signaling message (session_offer, session_answer, candidate)
   * to a specific peer via the relay.
   */
  sendSignaling(
    type: "session_offer" | "session_answer" | "candidate",
    toIdentityHex: string,
    data: Record<string, unknown>,
  ): void {
    this.sendWs({ type, to: toIdentityHex, ...data });
  }

  /**
   * Subscribe to a room on the relay.
   */
  subscribeRoom(roomIdHex: string): void {
    this.sendWs({ type: "room_subscribe", room_id: roomIdHex });
  }

  /**
   * Unsubscribe from a room on the relay.
   */
  unsubscribeRoom(roomIdHex: string): void {
    this.sendWs({ type: "room_unsubscribe", room_id: roomIdHex });
  }

  /**
   * Send a room event via the relay.
   */
  sendRoomEvent(roomIdHex: string, event: Record<string, unknown>): void {
    this.sendWs({ type: "room_event", room_id: roomIdHex, event });
  }

  /**
   * Forward a DM envelope to a recipient via the relay.
   * Returns true if sent, false if not connected.
   */
  sendDm(toIdentityHex: string, envelope: number[]): boolean {
    if (!this._online) return false;
    try {
      this.sendWs({ type: "dm", to: toIdentityHex, envelope });
      return true;
    } catch {
      return false;
    }
  }

  persistIncomingMessage(messageId: Uint8Array, envelope: Uint8Array): boolean {
    if (this.persistentState) throw new Error("Persistent inbox writes must commit with ratchet and prekey state");
    const log = this._incomingEventLog();
    if (log.contains(messageId)) return false;
    log.append(messageId, envelope);
    return true;
  }

  hasIncomingMessage(messageId: Uint8Array): boolean {
    if (this.persistentState) return this.persistentState.hasIncoming(messageId);
    return this._incomingEventLog().contains(messageId);
  }

  sendDeliveryReceipt(toIdentityHex: string, messageId: Uint8Array): boolean {
    if (!this._online) return false;
    try {
      if (!/^[0-9a-f]{64}$/.test(toIdentityHex)) throw new Error("invalid receipt destination");
      const receipt = signDeliveryReceipt(this.identitySigner(), {
        version: 2,
        senderIdentityId: new Uint8Array(Buffer.from(toIdentityHex, "hex")),
        recipientIdentityId: this.identityId,
        messageId,
        recipientDeviceId: this.deviceId,
        storedAt: Date.now(),
      });
      this.sendWs({
        type: "delivery_receipt",
        to: toIdentityHex,
        receipt,
      });
      return true;
    } catch (error) {
      this.emit("error", { code: "delivery_receipt_failed", error: String(error) });
      return false;
    }
  }

  on(event: EventType, handler: EventHandler): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: EventType, handler: EventHandler): void {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event: EventType, data: unknown): void {
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // swallow listener errors
        }
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    const generation = ++this._connectionGeneration;
    if (this._closed) throw new Error("Client is closed");
    if (this._deviceLifecycle) {
      try {
        await this.ensureDeviceCertificate();
      } catch (error) {
        // No socket was opened, so onclose cannot report or stop this attempt.
        // Expired credentials already disconnected and emitted auth_failed.
        if (generation === this._connectionGeneration && !this.deviceCertificateExpired()) {
          void this.disconnect();
          this.emit("auth_failed", {
            message: error instanceof Error ? error.message : "device credentials unavailable",
          });
        }
        throw error;
      }
      if (generation !== this._connectionGeneration) throw new Error("connection superseded during renewal");
    }
    if (this.persistentState && this.presenceUrl) {
      await publishLocalPrekeys(this);
      if (generation !== this._connectionGeneration) throw new Error("connection superseded during prekey publication");
    }
    return new Promise((resolve, reject) => {
      // Retrying with an expired certificate can never succeed: stop and say why.
      if (this.deviceCertificateExpired()) {
        const error = new Error("device certificate expired; renew it before reconnecting");
        this.emit("auth_failed", { message: error.message });
        reject(error);
        return;
      }
      const wsUrl = this._buildWsUrl();

      let settled = false;
      let ws: WebSocket;

      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err);
        return;
      }

      let authenticated = false;
      // A relay that never challenges (or confirms) would otherwise hang connect();
      // closing triggers onclose, which rejects and schedules a reconnect.
      const handshakeTimer = setTimeout(() => ws.close(), this._handshakeTimeoutMs);
      // Own the pending socket immediately: an older socket can finish closing
      // after disconnect() has returned and a replacement has started opening.
      this._ws = ws;

      ws.onmessage = (event: MessageEvent) => {
        if (this._ws !== ws) return;
        if (authenticated) {
          this._handleMessage(event.data as string);
          return;
        }
        let msg: { type?: string; nonce?: unknown; message?: unknown };
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (msg.type === "auth_challenge" && typeof msg.nonce === "string") {
          try {
            ws.send(JSON.stringify({ type: "auth", auth: this._relayAuth(msg.nonce).auth }));
          } catch {
            ws.close();
          }
        } else if (msg.type === "authenticated") {
          clearTimeout(handshakeTimer);
          authenticated = true;
          this._online = true;
          this._reconnectAttempts = 0;
          this._deviceLifecycle?.start();
          // Resume persisted retry obligations, including after restarting the sender.
          if (this.persistentState || (this.storagePath && existsSync(join(this.storagePath, "outbound.db"))))
            this.outboundQueue();
          this._queueManager?.start(this);
          this._queueManager?.processQueue(this);
          this.emit("connected", null);
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.type === "error") {
          this.emit("error", msg);
        }
      };

      ws.onclose = (event: CloseEvent) => {
        clearTimeout(handshakeTimer);
        if (this._ws !== ws) {
          if (!settled) {
            settled = true;
            reject(new Error("WebSocket connection superseded"));
          }
          return;
        }
        this._online = false;
        this._ws = null;
        this.emit("disconnected", null);
        // 4401 during the handshake means the relay rejected our proof; the same
        // credentials will be rejected again, so do not loop. (A 4401 after
        // authenticating, e.g. relay hibernation, still reconnects.)
        const rejected = !authenticated && event?.code === 4401;
        if (rejected) this.emit("auth_failed", { message: "relay rejected this device's identity proof" });
        if (!settled) {
          settled = true;
          reject(
            new Error(rejected ? "relay rejected authentication" : "WebSocket closed before relay authentication"),
          );
        }
        if (!this._intentionalClose && !rejected) {
          this._scheduleReconnect();
        }
      };

      ws.onerror = (_err: Event) => {
        clearTimeout(handshakeTimer);
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket connection failed"));
        }
      };
    });
  }

  /** Relay URL normalised to ws:/wss:; accepts http(s) and ws(s) inputs. */
  private _relayEndpoint(): URL {
    return new URL(this.relayUrl.replace(/^http/, "ws"));
  }

  private _relayAuth(nonce: string) {
    return signIdentityAuthJson(this.identitySigner(), "relay.connect", this.identityId, {
      audience: this._relayEndpoint().host,
      nonce,
      deviceId: this._deviceHex,
    });
  }

  private _buildWsUrl(): string {
    const { protocol, host } = this._relayEndpoint();
    return `${protocol}//${host}/ws?identity=${this._identityHex}&device=${this._deviceHex}`;
  }

  private _scheduleReconnect(): void {
    if (this._intentionalClose) return;
    if (this._maxReconnectAttempts > 0 && this._reconnectAttempts >= this._maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(this._reconnectBaseMs * Math.pow(2, this._reconnectAttempts), this._reconnectMaxMs);
    this._reconnectAttempts++;

    this.emit("reconnecting", {
      attempt: this._reconnectAttempts,
      delayMs: delay,
    });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch(() => {
        // onclose will schedule next attempt
      });
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _handleMessage(raw: string): void {
    let msg: { type?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "dm":
        this.emit("dm", msg);
        break;
      case "session_offer":
        this.emit("session_offer", msg);
        break;
      case "session_answer":
        this.emit("session_answer", msg);
        break;
      case "candidate":
        this.emit("candidate", msg);
        break;
      case "room_event":
        this.emit("room_event", msg);
        break;
      case "room_message":
        this.emit("room_message", msg);
        break;
      case "group_message":
      case "group.message":
      case "group.membership":
        this.emit("group_message", msg);
        break;
      case "presence":
      case "presence_update":
      case "presence_snapshot":
        consumePresenceMessage(this, msg);
        break;
      case "delivery_receipt":
        this.emit("delivery_receipt", msg);
        break;
      case "error":
        this.emit("error", msg);
        break;
    }
  }

  private _incomingEventLog(): EventLog {
    if (this._eventLog) return this._eventLog;
    if (!this.storagePath) throw new Error("storagePath is required for direct messages");
    mkdirSync(this.storagePath, { recursive: true });
    const context = new Uint8Array(this.identityId.length + this.deviceId.length);
    context.set(this.identityId);
    context.set(this.deviceId, this.identityId.length);
    const key = this.crypto.hkdf(
      this.signingSecretKey,
      context,
      new TextEncoder().encode("nexnet local event log key v1"),
      32,
    );
    this._eventLog = EventLog.open(join(this.storagePath, "events.db"), key, this.crypto);
    return this._eventLog;
  }
}

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
