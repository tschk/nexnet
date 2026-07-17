import { describe, test, expect } from "bun:test";
import { OutboundQueue } from "../queue.js";
import type { OutboundQueueItem } from "../queue.js";

function makeItem(overrides: Partial<OutboundQueueItem> = {}): OutboundQueueItem {
  const msgId = new Uint8Array(32);
  crypto.getRandomValues(msgId);
  return {
    messageId: msgId,
    recipientIdentityId: new Uint8Array(32).fill(0x01),
    encryptedEnvelope: new Uint8Array([10, 20, 30]),
    createdAt: Date.now(),
    attemptCount: 0,
    deliveryState: "pending",
    ...overrides,
  };
}

describe("OutboundQueue", () => {
  test("enqueue and pending", () => {
    const q = OutboundQueue.open(":memory:");
    expect(q.pending()).toEqual([]);

    const item = makeItem();
    q.enqueue(item);
    const pending = q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].messageId).toEqual(item.messageId);
    expect(pending[0].deliveryState).toBe("pending");

    q.close();
  });

  test("markDelivered removes from pending", () => {
    const q = OutboundQueue.open(":memory:");
    const item = makeItem();
    q.enqueue(item);
    expect(q.pending()).toHaveLength(1);

    q.markDelivered(item.messageId);
    expect(q.pending()).toHaveLength(0);

    q.close();
  });

  test("markAttempt increments count and sets backoff", () => {
    const q = OutboundQueue.open(":memory:");
    const item = makeItem();
    q.enqueue(item);

    q.markAttempt(item.messageId);

    const pending = q.pending();
    expect(pending).toHaveLength(0); // backoff set — not ready yet

    q.close();
  });

  test("pending respects next_attempt_at", () => {
    const q = OutboundQueue.open(":memory:");
    const now = Date.now();

    const future = makeItem({ nextAttemptAt: now + 60_000 });
    const past = makeItem({ nextAttemptAt: now - 1_000 });
    const noBackoff = makeItem({});

    q.enqueue(future);
    q.enqueue(past);
    q.enqueue(noBackoff);

    const pending = q.pending();
    expect(pending.length).toBeGreaterThanOrEqual(2);

    const ids = pending.map((p) => Buffer.from(p.messageId).toString("hex"));
    expect(ids).toContain(Buffer.from(past.messageId).toString("hex"));
    expect(ids).toContain(Buffer.from(noBackoff.messageId).toString("hex"));

    q.close();
  });

  test("enqueue replaces on duplicate message_id", () => {
    const q = OutboundQueue.open(":memory:");
    const msgId = new Uint8Array(32).fill(0xab);
    const item1 = makeItem({ messageId: msgId, encryptedEnvelope: new Uint8Array([1]) });
    const item2 = makeItem({ messageId: msgId, encryptedEnvelope: new Uint8Array([2]) });

    q.enqueue(item1);
    q.enqueue(item2);

    const pending = q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].encryptedEnvelope).toEqual(new Uint8Array([2]));

    q.close();
  });

  test("multiple items ordered by created_at", () => {
    const q = OutboundQueue.open(":memory:");
    const later = makeItem({ createdAt: 200 });
    const earlier = makeItem({ createdAt: 100 });

    q.enqueue(later);
    q.enqueue(earlier);

    const pending = q.pending();
    expect(pending[0].createdAt).toBe(100);
    expect(pending[1].createdAt).toBe(200);

    q.close();
  });
});
