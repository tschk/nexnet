import { describe, test, expect } from "bun:test";
import { QueueManager } from "../queue-manager.js";
import type { OutboundQueueLike, OutboundQueueItem } from "@nettle/types";

function createMockQueue(): OutboundQueueLike & { _items: OutboundQueueItem[] } {
  const _items: OutboundQueueItem[] = [];
  return {
    _items,
    enqueue(item: OutboundQueueItem) {
      _items.push(item);
    },
    pending() {
      const now = Date.now();
      return _items.filter(
        (i) =>
          i.deliveryState === "pending" &&
          (!i.nextAttemptAt || i.nextAttemptAt <= now)
      );
    },
    markDelivered(messageId: Uint8Array) {
      const hex = Buffer.from(messageId).toString("hex");
      const item = _items.find(
        (i) => Buffer.from(i.messageId).toString("hex") === hex
      );
      if (item) item.deliveryState = "delivered";
    },
    markAttempt(messageId: Uint8Array) {
      const hex = Buffer.from(messageId).toString("hex");
      const item = _items.find(
        (i) => Buffer.from(i.messageId).toString("hex") === hex
      );
      if (item) {
        item.attemptCount++;
        item.lastAttemptAt = Date.now();
        item.nextAttemptAt = Date.now() + 30_000 * Math.pow(2, item.attemptCount);
      }
    },
  };
}

describe("QueueManager", () => {
  test("enqueue and pendingCount", () => {
    const queue = createMockQueue();
    const manager = new QueueManager(queue);

    expect(manager.pendingCount).toBe(0);

    manager.enqueue({
      messageId: new Uint8Array(32).fill(1),
      recipientIdentityId: new Uint8Array(32).fill(2),
      encryptedEnvelope: new Uint8Array([1, 2, 3]),
      createdAt: Date.now(),
      attemptCount: 0,
      deliveryState: "pending",
    });

    expect(manager.pendingCount).toBe(1);
  });

  test("start/stop without errors", () => {
    const queue = createMockQueue();
    const manager = new QueueManager(queue);

    expect(() => manager.stop()).not.toThrow();
  });
});
