import { DeviceStore, DeviceCapacityError } from "@nexnet/storage";
import {
  DM_X3DH_QUEUE_FORMAT,
  type OutboundQueueLike,
  type OutboundQueueItem,
  type MessageEnvelope,
  type MessagePayload,
} from "@nexnet/types";
import { identityIdFromWallet, verifyDeviceCert, verifyDeliveryReceipt } from "@nexnet/protocol";
import { publicKeyFromSecret } from "@nexnet/crypto";
import { NexnetClient, type NexnetClientConfig } from "./client.js";
import { createLocalPrekeys, exportBundle, type LocalPrekeyMaterial } from "./x3dh.js";
import { serializeState, deserializeState, type RatchetState } from "./double-ratchet.js";
import { publishBundle } from "./prekeys.js";

export interface DeviceCredentials {
  identityId: Uint8Array;
  deviceId: Uint8Array;
  rootPublicKey: Uint8Array;
  deviceSigningSecretKey: Uint8Array;
  deviceSigningPublicKey: Uint8Array;
  deviceCertificate: NonNullable<NexnetClientConfig["deviceCertificate"]>;
}

export interface StoredInboxMessage {
  envelope: MessageEnvelope;
  payload: MessagePayload;
  receivedAt?: number;
  contentExpired?: true;
}

export interface DeviceResourceLimits {
  bytes: number;
  records: number;
  pending: number;
  pendingPerPeer: number;
  inbox: number;
  inboxPerPeer: number;
  retentionMs: number;
}
export const DEFAULT_DEVICE_LIMITS: Readonly<DeviceResourceLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  records: 20_000,
  pending: 256,
  pendingPerPeer: 64,
  inbox: 1024,
  inboxPerPeer: 256,
  retentionMs: 24 * 3600_000,
});

export type PersistentClientConfig = Pick<
  NexnetClientConfig,
  "crypto" | "codec" | "storagePath" | "relayUrl" | "presenceUrl" | "renewDeviceCertificate"
> & {
  /** Obtain from host secret storage. Never write beside device.db. */
  unlockKey: Uint8Array;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

/** Private state is always read afresh, so a rolled-back transaction cannot leak cached key advances. */
export class PersistentDmState implements OutboundQueueLike {
  private limits: DeviceResourceLimits | undefined;
  configureLimits(limits: DeviceResourceLimits): void {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid device resource limits");
    this.limits = { ...limits };
    this.store.setLimits(limits);
  }

  /** Retain deduplication evidence and uncompleted work. Only disposable transport bodies are compacted. */
  retain(now = Date.now()): void {
    if (!this.limits) return;
    const cutoff = now - this.limits.retentionMs;
    this.store.transaction(() => {
      for (const name of this.store.keys("queue:")) {
        const item = this.read<OutboundQueueItem>(name);
        const receipt = this.store.get(`receipt:${hex(item.messageId)}`);
        if (
          item.deliveryState === "delivered" &&
          item.encryptedEnvelope.length &&
          receipt &&
          this.config.codec.decode<{ verifiedAt: number }>(receipt).verifiedAt <= cutoff
        )
          this.write(name, { ...item, encryptedEnvelope: new Uint8Array() });
      }
      for (const name of this.store.keys("inbox:")) {
        const item = this.read<StoredInboxMessage>(name);
        if (
          !item.contentExpired &&
          item.receivedAt !== undefined &&
          item.receivedAt <= cutoff &&
          (item.payload.contentType === "text" ||
            (item.payload.contentType === "agent_capabilities" && this.store.get(`capabilities:v1:seen:${name}`)))
        )
          this.write(name, {
            envelope: { ...item.envelope, ciphertext: new Uint8Array() },
            payload: { contentType: "text", text: "" },
            receivedAt: item.receivedAt,
            contentExpired: true,
          });
      }
    });
  }
  constructor(
    readonly store: DeviceStore,
    private readonly config: PersistentClientConfig,
  ) {}

  read<T>(name: string): T {
    const blob = this.store.get(name);
    if (!blob) throw new Error(`Incomplete device state: missing ${name}`);
    return this.config.codec.decode<T>(blob);
  }

  write(name: string, value: unknown): void {
    this.store.put(name, this.config.codec.encode(value));
  }

  credentials(): DeviceCredentials {
    return this.read("credentials:v1");
  }

  prekeys(): LocalPrekeyMaterial {
    return this.read("prekeys:v1");
  }

  session(key: string): RatchetState | undefined {
    const blob = this.store.get(`ratchet:${key}`);
    return blob ? deserializeState(blob) : undefined;
  }

  saveSession(key: string, state: RatchetState): void {
    this.store.put(`ratchet:${key}`, serializeState(state));
  }

  enqueue(item: OutboundQueueItem): void {
    if (item.encryptionFormat !== DM_X3DH_QUEUE_FORMAT) throw new Error("Queue item lacks X3DH provenance");
    if (this.store.get(`queue:${hex(item.messageId)}`)) throw new Error("Message already queued");
    if (
      this.limits &&
      (this.items().length >= this.limits.pending ||
        this.pendingForRecipient(item.recipientIdentityId).length >= this.limits.pendingPerPeer)
    )
      throw new DeviceCapacityError();
    this.write(`queue:${hex(item.messageId)}`, item);
  }

  pending(): OutboundQueueItem[] {
    return this.items().filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= Date.now());
  }

  pendingForRecipient(identity: Uint8Array): OutboundQueueItem[] {
    return this.items().filter((item) => same(item.recipientIdentityId, identity));
  }

  private items(): OutboundQueueItem[] {
    return this.store
      .keys("queue:")
      .map((key) => this.read<OutboundQueueItem>(key))
      .filter((item) => item.deliveryState === "pending");
  }

  markAttempt(id: Uint8Array): void {
    const name = `queue:${hex(id)}`;
    const item = this.read<OutboundQueueItem>(name);
    if (item.deliveryState !== "pending") return;
    const now = Date.now();
    this.write(name, {
      ...item,
      attemptCount: item.attemptCount + 1,
      lastAttemptAt: now,
      nextAttemptAt: now + Math.min(30_000 * 2 ** item.attemptCount, 30 * 60_000),
    });
  }

  markDelivered(id: Uint8Array, proof?: unknown): void {
    const verifiedAt = Date.now();
    const receipt = verifyDeliveryReceipt(proof, this.credentials().identityId, verifiedAt);
    const name = `queue:${hex(id)}`;
    const item = this.read<OutboundQueueItem>(name);
    if (!receipt || !same(receipt.messageId, id) || !same(receipt.recipientIdentityId, item.recipientIdentityId))
      throw new Error("A verified device receipt v2 is required");
    this.store.transaction(() => {
      this.write(`receipt:${hex(id)}`, { version: 2, proof, verifiedAt });
      this.write(name, { ...item, deliveryState: "delivered" });
    });
  }

  hasIncoming(id: Uint8Array): boolean {
    return this.store.get(`inbox:${hex(id)}`) !== null;
  }

  inbox(): StoredInboxMessage[] {
    return this.store.keys("inbox:").map((key) => this.read<StoredInboxMessage>(key));
  }

  commitReceive(
    sessionKey: string,
    state: RatchetState,
    prekeys: LocalPrekeyMaterial | undefined,
    message: StoredInboxMessage,
  ): boolean {
    return this.store.transaction(() => {
      if (this.hasIncoming(message.envelope.messageId)) return false;
      if (this.limits) {
        const live = this.inbox().filter((item) => !item.contentExpired);
        if (
          live.length >= this.limits.inbox ||
          live.filter((item) => same(item.envelope.senderIdentityId, message.envelope.senderIdentityId)).length >=
            this.limits.inboxPerPeer
        )
          throw new DeviceCapacityError();
      }
      this.saveSession(sessionKey, state);
      if (prekeys) this.write("prekeys:v1", prekeys);
      this.write(`inbox:${hex(message.envelope.messageId)}`, { ...message, receivedAt: Date.now() });
      return true;
    });
  }

  commitSend(
    sessionKey: string,
    state: RatchetState,
    item: OutboundQueueItem,
    commitMetadata?: (messageId: Uint8Array) => void,
  ): void {
    this.store.transaction(() => {
      this.saveSession(sessionKey, state);
      this.enqueue(item);
      commitMetadata?.(item.messageId);
    });
  }
}

/** Explicit creation never replaces an existing database. Bootstrap contains device authority only. */
export function createPersistentClient(config: PersistentClientConfig, credentials: DeviceCredentials): NexnetClient {
  return recover(config, credentials);
}

/** Missing database, missing key, wrong key or incomplete state are errors, never fresh identities. */
export function openPersistentClient(config: PersistentClientConfig): NexnetClient {
  return recover(config);
}

function validateCredentials(credentials: DeviceCredentials): void {
  const {
    deviceCertificate: cert,
    rootPublicKey,
    deviceSigningSecretKey,
    deviceSigningPublicKey,
    identityId,
    deviceId,
  } = credentials;
  if (
    !same(identityIdFromWallet(rootPublicKey), identityId) ||
    !same(cert.accountId, identityId) ||
    !same(cert.deviceId, deviceId) ||
    !same(cert.deviceSigningPublicKey, deviceSigningPublicKey) ||
    !same(publicKeyFromSecret(deviceSigningSecretKey), deviceSigningPublicKey) ||
    !verifyDeviceCert(cert, rootPublicKey)
  )
    throw new Error("Invalid recovered device credentials");
}

function recover(config: PersistentClientConfig, initial?: DeviceCredentials): NexnetClient {
  const store = DeviceStore.open(config.storagePath, config.unlockKey, config.crypto, !!initial);
  try {
    const state = new PersistentDmState(store, config);
    if (initial) {
      validateCredentials(initial);
      store.transaction(() => {
        // Select fields rather than serializing a caller's configuration (which may hold a root signer).
        state.write("credentials:v1", {
          identityId: initial.identityId,
          deviceId: initial.deviceId,
          rootPublicKey: initial.rootPublicKey,
          deviceSigningSecretKey: initial.deviceSigningSecretKey,
          deviceSigningPublicKey: initial.deviceSigningPublicKey,
          deviceCertificate: initial.deviceCertificate,
        });
        state.write("prekeys:v1", createLocalPrekeys(config.crypto, initial.deviceSigningSecretKey));
      });
    }
    const credentials = state.credentials();
    validateCredentials(credentials);
    publishBundle(credentials.identityId, exportBundle(state.prekeys(), credentials.deviceSigningPublicKey));
    return new NexnetClient({
      ...config,
      ...credentials,
      signingSecretKey: credentials.deviceSigningSecretKey,
      persistentState: state,
    });
  } catch (error) {
    store.close();
    const detail = error instanceof Error ? error.message : "unknown recovery error";
    throw new Error(`Cannot recover device state: ${detail}`, { cause: error });
  }
}
