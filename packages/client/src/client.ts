/**
 * @nettle/client — NettleClient main class
 *
 * Dependency-injected crypto/codec. WebSocket connection to relay.
 * Event emitter for incoming messages.
 */

import type {
  IdentityId,
  DeviceId,
  CryptoProvider,
  CborCdeCodec,
} from "@nettle/types";

export type EventType =
  | "dm"
  | "room_message"
  | "group_message"
  | "presence"
  | "connected"
  | "disconnected";

export type EventHandler = (data: unknown) => void;

export interface NettleClientConfig {
  identityId: IdentityId;
  deviceId: DeviceId;
  crypto: CryptoProvider;
  codec: CborCdeCodec;
  relayUrl: string;
  storagePath: string;
  signingSecretKey: Uint8Array;
}

export class NettleClient {
  readonly identityId: IdentityId;
  readonly deviceId: DeviceId;
  readonly crypto: CryptoProvider;
  readonly codec: CborCdeCodec;
  readonly relayUrl: string;
  readonly storagePath: string;
  readonly signingSecretKey: Uint8Array;

  private _online = false;
  private _ws: WebSocket | null = null;
  private _listeners = new Map<EventType, Set<EventHandler>>();

  constructor(config: NettleClientConfig) {
    this.identityId = config.identityId;
    this.deviceId = config.deviceId;
    this.crypto = config.crypto;
    this.codec = config.codec;
    this.relayUrl = config.relayUrl;
    this.storagePath = config.storagePath;
    this.signingSecretKey = config.signingSecretKey;
  }

  get online(): boolean {
    return this._online;
  }

  async connect(): Promise<void> {
    if (this._online) return;

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.relayUrl);

        ws.onopen = () => {
          this._online = true;
          this._ws = ws;
          this.emit("connected", null);
          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data as string);
        };

        ws.onclose = () => {
          this._online = false;
          this._ws = null;
          this.emit("disconnected", null);
        };

        ws.onerror = (err: Event) => {
          if (!this._online) {
            reject(new Error("WebSocket connection failed"));
          }
          this._online = false;
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this._ws) return;
    this._ws.close();
    this._ws = null;
    this._online = false;
  }

  /** Send raw JSON message over WebSocket */
  sendWs(payload: Record<string, unknown>): void {
    if (!this._ws || !this._online) {
      throw new Error("Not connected");
    }
    this._ws.send(JSON.stringify(payload));
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

  private handleMessage(raw: string): void {
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
      case "room_message":
        this.emit("room_message", msg);
        break;
      case "group_message":
        this.emit("group_message", msg);
        break;
      case "presence":
        this.emit("presence", msg);
        break;
    }
  }
}
