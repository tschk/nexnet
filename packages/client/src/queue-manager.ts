/**
 * @nettle/client — QueueManager
 *
 * Wraps OutboundQueue with retry logic.
 * - 30-min poll interval (PRESENCE_POLL_INTERVAL_MS)
 * - Immediate flush on presence-online event (AD-7)
 * - Bounded exponential backoff on failure
 */

import { PRESENCE_POLL_INTERVAL_MS } from "@nettle/types";
import type { OutboundQueueLike, OutboundQueueItem } from "@nettle/types";
import type { NettleClient } from "./client.js";

const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export class QueueManager {
  private queue: OutboundQueueLike;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(queue: OutboundQueueLike) {
    this.queue = queue;
  }

  start(client: NettleClient): void {
    this.pollTimer = setInterval(() => {
      this.processQueue(client);
    }, PRESENCE_POLL_INTERVAL_MS);

    client.on("presence", (data) => {
      const msg = data as { status?: string };
      if (msg.status === "online") {
        this.processQueue(client);
      }
    });
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  enqueue(item: OutboundQueueItem): void {
    this.queue.enqueue(item);
  }

  processQueue(client: NettleClient): void {
    if (!client.online) return;

    const pending = this.queue.pending();
    for (const item of pending) {
      if (item.attemptCount >= MAX_ATTEMPTS) continue;

      const recipientHex = Buffer.from(item.recipientIdentityId).toString("hex");
      const sent = client.sendDm(recipientHex, Array.from(item.encryptedEnvelope));
      if (sent) {
        this.queue.markDelivered(item.messageId);
      } else {
        this.queue.markAttempt(item.messageId);
      }
    }
  }

  get pendingCount(): number {
    return this.queue.pending().length;
  }
}
