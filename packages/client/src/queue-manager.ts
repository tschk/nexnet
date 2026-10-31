/**
 * @nexnet/client — QueueManager
 *
 * Wraps OutboundQueue with retry logic.
 * - 30-min poll interval (PRESENCE_POLL_INTERVAL_MS)
 * - Immediate flush on presence-online event (AD-7)
 * - Bounded exponential backoff on failure
 */

import { PRESENCE_POLL_INTERVAL_MS, DM_X3DH_QUEUE_FORMAT } from "@nexnet/types";
import type { OutboundQueueLike, OutboundQueueItem } from "@nexnet/types";
import { verifyDeliveryReceipt } from "@nexnet/protocol";
import type { NexnetClient } from "./client.js";

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
    this.pollTimer.unref?.();

    this.presenceHandler = (data) => {
      const msg = data as { status?: string; identityId?: string };
      if (msg.status === "online" && typeof msg.identityId === "string" && /^[0-9a-f]{64}$/i.test(msg.identityId)) {
        this.processQueue(client, msg.identityId);
      }
    };
    this.receiptHandler = (data) => {
      if (typeof data !== "object" || data === null || !("receipt" in data)) return;
      const receipt = verifyDeliveryReceipt(data.receipt, client.identityId);
      if (!receipt) return;
      const item = this.queue
        .pendingForRecipient(receipt.recipientIdentityId)
        .find((pending) => Buffer.from(pending.messageId).equals(Buffer.from(receipt.messageId)));
      if (this.client !== client || item?.encryptionFormat !== DM_X3DH_QUEUE_FORMAT) return;
      this.queue.markDelivered(receipt.messageId);
      client.emit("verified_delivery_receipt", {
        ...receipt,
        from: Buffer.from(receipt.recipientIdentityId).toString("hex"),
      });
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
    if (item.encryptionFormat !== DM_X3DH_QUEUE_FORMAT) throw new Error("Queue item lacks X3DH provenance");
    this.queue.enqueue(item);
  }

  processQueue(client: NexnetClient, recipientHex?: string): void {
    if (!client.online) return;

    const pending = recipientHex
      ? this.queue.pendingForRecipient(Buffer.from(recipientHex, "hex"))
      : this.queue.pending();
    for (const item of pending) {
      if (item.encryptionFormat !== DM_X3DH_QUEUE_FORMAT) continue;

      const recipientHex = Buffer.from(item.recipientIdentityId).toString("hex");
      if (client.sendDm(recipientHex, Array.from(item.encryptedEnvelope))) {
        this.queue.markAttempt(item.messageId);
      }
    }
  }

  get pendingCount(): number {
    return this.queue.pending().filter((item) => item.encryptionFormat === DM_X3DH_QUEUE_FORMAT).length;
  }
}
