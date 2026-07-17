import { describe, test, expect } from "bun:test";
import { QueueManager } from "../queue-manager.js";
import { consumePresenceMessage } from "../presence.js";
import { cdeEncode } from "@nexnet/protocol";
import { cryptoProvider } from "@nexnet/crypto";
import type { OutboundQueueLike, OutboundQueueItem } from "@nexnet/types";

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
    pendingForRecipient(identityId: Uint8Array) {
      const hex = Buffer.from(identityId).toString("hex");
      return _items.filter(
        (i) =>
          i.deliveryState === "pending" &&
          Buffer.from(i.recipientIdentityId).toString("hex") === hex
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

  test("presence retries only the recipient and receipt marks delivered", () => {
    const queue = createMockQueue();
    const recipientKeys = cryptoProvider.generateSigningKeyPair();
    const manager = new QueueManager(queue, () => recipientKeys.publicKey);
    const handlers = new Map<string, (data: unknown) => void>();
    const sent: string[] = [];
    const client = {
      online: true,
      on(event: string, handler: (data: unknown) => void) {
        handlers.set(event, handler);
      },
      off(event: string) {
        handlers.delete(event);
      },
      emit(event: string, data: unknown) {
        handlers.get(event)?.(data);
      },
      crypto: cryptoProvider,
      codec: { encode: cdeEncode },
      sendDm(to: string) {
        sent.push(to);
        return true;
      },
    } as unknown as import("../client.js").NexnetClient;
    const recipient = new Uint8Array(32).fill(2);
    const otherRecipient = new Uint8Array(32).fill(3);
    const messageId = new Uint8Array(32).fill(1);

    manager.enqueue({
      messageId,
      recipientIdentityId: recipient,
      encryptedEnvelope: new Uint8Array([1]),
      createdAt: Date.now(),
      attemptCount: 0,
      deliveryState: "pending",
    });
    manager.enqueue({
      messageId: new Uint8Array(32).fill(4),
      recipientIdentityId: otherRecipient,
      encryptedEnvelope: new Uint8Array([2]),
      createdAt: Date.now(),
      attemptCount: 0,
      deliveryState: "pending",
    });

    manager.start(client);
    consumePresenceMessage(client, {
      type: "presence_snapshot",
      leases: {
        [Buffer.from(recipient).toString("hex")]: {
          status: "online",
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    expect(sent).toEqual([Buffer.from(recipient).toString("hex")]);
    expect(queue._items[0]?.deliveryState).toBe("pending");

    const storedAt = Date.now();
    const recipientDeviceId = new Uint8Array(32).fill(9);
    handlers.get("delivery_receipt")?.({
      from: Buffer.from(recipient).toString("hex"),
      messageId,
      recipientDeviceId,
      storedAt,
      signature: new Uint8Array(64),
    });
    expect(queue._items[0]?.deliveryState).toBe("pending");
    const signature = cryptoProvider.sign(
      recipientKeys.secretKey,
      cdeEncode({ messageId, recipientDeviceId, storedAt })
    );
    handlers.get("delivery_receipt")?.({
      from: Buffer.from(recipient).toString("hex"),
      messageId,
      recipientDeviceId,
      storedAt,
      signature,
    });
    expect(queue._items[0]?.deliveryState).toBe("delivered");
    manager.stop();
  });
});
