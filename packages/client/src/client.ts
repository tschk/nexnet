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
} from "@nexnet/types";
import { EventLog } from "@nexnet/storage";
import { publicKeyFromSecret } from "@nexnet/crypto";
import { signIdentityAuthJson, type IdentitySigner } from "@nexnet/protocol";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { consumePresenceMessage } from "./presence.js";

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
  | "connected"
  | "disconnected"
  | "reconnecting"
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
  /** Root identity secret key (identityId = identityIdFromWallet(its public key)). */
  signingSecretKey: Uint8Array;
  deviceSigningSecretKey?: Uint8Array;
  deviceSigningPublicKey?: Uint8Array;
  deviceCertificate?: DeviceCertificate;
  deviceCertificateResolver?: DeviceCertificateResolver;
  rootPublicKey?: Uint8Array;
  /** Max reconnect attempts before giving up. 0 = infinite. Default: 0 */
  maxReconnectAttempts?: number;
  /** Base backoff delay in ms. Default: 1000 */
  reconnectBaseMs?: number;
  /** Max backoff delay in ms. Default: 30000 */
  reconnectMaxMs?: number;
  /** Close the socket if the relay has not authenticated it within this many ms. Default: 15000 */
  handshakeTimeoutMs?: number;
}

// ponytail: single-class client, no abstraction layers. Upgrade if state grows.

export class NexnetClient {
  readonly identityId: IdentityId;
  readonly deviceId: DeviceId;
  readonly crypto: CryptoProvider;
  readonly codec: CborCdeCodec;
  readonly relayUrl: string;
  readonly presenceUrl?: string;
  readonly storagePath: string;
  readonly signingSecretKey: Uint8Array;
  readonly deviceSigningSecretKey?: Uint8Array;
  readonly deviceSigningPublicKey?: Uint8Array;
  readonly deviceCertificate?: DeviceCertificate;
  readonly deviceCertificateResolver?: DeviceCertificateResolver;
  readonly rootPublicKey?: Uint8Array;

  private _online = false;
  private _ws: WebSocket | null = null;
  private _listeners = new Map<EventType, Set<EventHandler>>();
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalClose = false;
  private _eventLog: EventLog | null = null;
  private _maxReconnectAttempts: number;
  private _reconnectBaseMs: number;
  private _reconnectMaxMs: number;
  private _handshakeTimeoutMs: number;

  private readonly _identityHex: string;
  private readonly _deviceHex: string;

  constructor(config: NexnetClientConfig) {
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
    this._maxReconnectAttempts = config.maxReconnectAttempts ?? 0;
    this._reconnectBaseMs = config.reconnectBaseMs ?? 1_000;
    this._reconnectMaxMs = config.reconnectMaxMs ?? 30_000;
    this._handshakeTimeoutMs = config.handshakeTimeoutMs ?? 15_000;

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
   * Connect to relay via WebSocket and authenticate.
   * URL: ws[s]://relayUrl/ws?identity=<hex>&device=<hex>
   * The relay replies with `auth_challenge`; the client signs the relay's
   * host, the nonce and its device id. Resolves once the relay confirms.
   */
  async connect(): Promise<void> {
    if (this._online) return;
    this._intentionalClose = false;

    return this._connect();
  }

  async disconnect(): Promise<void> {
    this._intentionalClose = true;
    this._clearReconnectTimer();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._online = false;
    this._reconnectAttempts = 0;
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
    const log = this._incomingEventLog();
    if (log.contains(messageId)) return false;
    log.append(messageId, envelope);
    return true;
  }

  hasIncomingMessage(messageId: Uint8Array): boolean {
    return this._incomingEventLog().contains(messageId);
  }

  sendDeliveryReceipt(toIdentityHex: string, messageId: Uint8Array): boolean {
    if (!this._online) return false;
    const storedAt = Date.now();
    const receipt = {
      messageId,
      recipientDeviceId: this.deviceId,
      storedAt,
    };
    const signature = this.crypto.sign(this.signingSecretKey, this.codec.encode(receipt));
    try {
      this.sendWs({
        type: "delivery_receipt",
        to: toIdentityHex,
        receipt: {
          ...receipt,
          messageId: Array.from(messageId),
          recipientDeviceId: Array.from(this.deviceId),
          signature: Array.from(signature),
        },
      });
      return true;
    } catch {
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

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
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
      ws.onopen = () => {
        this._ws = ws;
      };

      ws.onmessage = (event: MessageEvent) => {
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
          this.emit("connected", null);
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.type === "error") {
          this.emit("error", msg);
        }
      };

      ws.onclose = () => {
        clearTimeout(handshakeTimer);
        this._online = false;
        this._ws = null;
        this.emit("disconnected", null);
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket closed before relay authentication"));
        }
        if (!this._intentionalClose) {
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
        this.emit("delivery_receipt", normalizeDeliveryReceipt(msg));
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

function normalizeDeliveryReceipt(msg: Record<string, unknown>): Record<string, unknown> {
  if (typeof msg.receipt !== "object" || msg.receipt === null) return msg;
  const receipt = msg.receipt as Record<string, unknown>;
  return {
    ...msg,
    ...receipt,
    messageId: bytes(receipt.messageId),
    recipientDeviceId: bytes(receipt.recipientDeviceId),
    signature: bytes(receipt.signature),
  };
}

function bytes(value: unknown): Uint8Array | null {
  if (!Array.isArray(value) || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    return null;
  }
  return new Uint8Array(value);
}
