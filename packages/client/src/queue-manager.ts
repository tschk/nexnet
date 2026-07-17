/**
 * @nexnet/client — QueueManager
 *
 * Wraps OutboundQueue with retry logic.
 * - 30-min poll interval (PRESENCE_POLL_INTERVAL_MS)
 * - Immediate flush on presence-online event (AD-7)
 * - Bounded exponential backoff on failure
 */

import { PRESENCE_POLL_INTERVAL_MS } from "@nexnet/types";
import type { IdentityId, OutboundQueueLike, OutboundQueueItem, PublicKey } from "@nexnet/types";
import type { NexnetClient } from "./client.js";

const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export class QueueManager {
  private queue: OutboundQueueLike;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private client: NexnetClient | null = null;
  private presenceHandler: ((data: unknown) => void) | null = null;
  private receiptHandler: ((data: unknown) => void) | null = null;

  constructor(
    queue: OutboundQueueLike,
    private readonly getReceiptPublicKey?: (identityId: IdentityId) => PublicKey | undefined
  ) {
    this.queue = queue;
  }

  start(client: NexnetClient): void {
    this.stop();
    this.client = client;
    this.pollTimer = setInterval(() => {
      this.processQueue(client);
    }, PRESENCE_POLL_INTERVAL_MS);

    this.presenceHandler = (data) => {
      const msg = data as { status?: string; identityId?: string };
      if (
        msg.status === "online" &&
        typeof msg.identityId === "string" &&
        /^[0-9a-f]{64}$/i.test(msg.identityId)
      ) {
        this.processQueue(client, msg.identityId);
      }
    };
    this.receiptHandler = (data) => {
      const msg = data as {
        from?: string;
        messageId?: Uint8Array | number[];
        recipientDeviceId?: Uint8Array | number[];
        storedAt?: number;
        signature?: Uint8Array | number[];
      };
      const messageId = toBytes(msg.messageId, 32);
      const recipientDeviceId = toBytes(msg.recipientDeviceId, 32);
      const signature = toBytes(msg.signature, 64);
      if (!messageId || !recipientDeviceId || !signature || typeof msg.storedAt !== "number" ||
        typeof msg.from !== "string" || !/^[0-9a-f]{64}$/i.test(msg.from)) return;
      const identityId = new Uint8Array(Buffer.from(msg.from, "hex"));
      const item = this.queue.pendingForRecipient(identityId).find((pending) =>
        Buffer.from(pending.messageId).equals(Buffer.from(messageId))
      );
      const publicKey = this.getReceiptPublicKey?.(identityId);
      if (!item || !publicKey || !this.client?.crypto.verify(
        publicKey,
        this.client.codec.encode({ messageId, recipientDeviceId, storedAt: msg.storedAt }),
        signature
      )) return;
      this.queue.markDelivered(messageId);
    };
    client.on("presence", this.presenceHandler);
    client.on("delivery_receipt", this.receiptHandler);
  }

  stop(): void {
    if (this.client && this.presenceHandler) {
      this.client.off("presence", this.presenceHandler);
    }
    if (this.client && this.receiptHandler) {
      this.client.off("delivery_receipt", this.receiptHandler);
    }
    this.client = null;
    this.presenceHandler = null;
    this.receiptHandler = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  enqueue(item: OutboundQueueItem): void {
    this.queue.enqueue(item);
  }

  processQueue(client: NexnetClient, recipientHex?: string): void {
    if (!client.online) return;

    const pending = recipientHex
      ? this.queue.pendingForRecipient(Buffer.from(recipientHex, "hex"))
      : this.queue.pending();
    for (const item of pending) {
      if (item.attemptCount >= MAX_ATTEMPTS) continue;

      const recipientHex = Buffer.from(item.recipientIdentityId).toString("hex");
      if (client.sendDm(recipientHex, Array.from(item.encryptedEnvelope))) {
        this.queue.markAttempt(item.messageId);
      }
    }
  }

  get pendingCount(): number {
    return this.queue.pending().length;
  }
}

function toBytes(value: Uint8Array | number[] | undefined, length: number): Uint8Array | null {
  const bytes = value instanceof Uint8Array
    ? value
    : Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ? new Uint8Array(value)
      : null;
  return bytes?.length === length ? bytes : null;
}
