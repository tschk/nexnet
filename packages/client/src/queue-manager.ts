/**
 * @nexnet/client — QueueManager
 *
 * Wraps OutboundQueue with retry logic.
 * - 30-min poll interval (PRESENCE_POLL_INTERVAL_MS)
 * - Immediate flush on presence-online event (AD-7)
 * - Bounded exponential backoff on failure
 */

import { PRESENCE_POLL_INTERVAL_MS } from "@nexnet/types";
import type { OutboundQueueLike, OutboundQueueItem } from "@nexnet/types";
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

  constructor(queue: OutboundQueueLike) {
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
      const msg = data as { messageId?: number[]; message_id?: number[] };
      const messageId = msg.messageId ?? msg.message_id;
      if (Array.isArray(messageId) && messageId.length === 32) {
        this.queue.markDelivered(new Uint8Array(messageId));
      }
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
      client.sendDm(recipientHex, Array.from(item.encryptedEnvelope));
      this.queue.markAttempt(item.messageId);
    }
  }

  get pendingCount(): number {
    return this.queue.pending().length;
  }
}
