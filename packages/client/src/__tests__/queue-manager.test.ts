import { DM_X3DH_QUEUE_FORMAT } from "@nexnet/types";
import { describe, test, expect } from "bun:test";
import { QueueManager } from "../queue-manager.js";
import { consumePresenceMessage } from "../presence.js";
import { cdeEncode, identityIdFromWallet, issueDeviceCert, signDeliveryReceipt } from "@nexnet/protocol";
import { cryptoProvider } from "@nexnet/crypto";
import type { OutboundQueueLike, OutboundQueueItem } from "@nexnet/types";

const senderIdentityId = new Uint8Array(32).fill(7);

function recipientFixture() {
  const root = cryptoProvider.generateSigningKeyPair();
  const device = cryptoProvider.generateSigningKeyPair();
  const identityId = identityIdFromWallet(root.publicKey);
  const deviceId = new Uint8Array(32).fill(9);
  const certificate = issueDeviceCert(
    root.secretKey,
    device.publicKey,
    new Uint8Array(32).fill(8),
    deviceId,
    identityId,
    Date.now() - 1000,
    Date.now() + 60_000,
    1,
  );
  return {
    identityId,
    receipt(messageId: Uint8Array, sender = senderIdentityId) {
      return signDeliveryReceipt(
        { rootPublicKey: root.publicKey, secretKey: device.secretKey, certificate },
        {
          version: 2,
          senderIdentityId: sender,
          recipientIdentityId: identityId,
          recipientDeviceId: deviceId,
          messageId,
          storedAt: Date.now(),
        },
      );
    },
  };
}

function createMockQueue(): OutboundQueueLike & { _items: OutboundQueueItem[] } {
  const _items: OutboundQueueItem[] = [];
  return {
    _items,
    enqueue(item: OutboundQueueItem) {
      _items.push(item);
    },
    pending() {
      const now = Date.now();
      return _items.filter((i) => i.deliveryState === "pending" && (!i.nextAttemptAt || i.nextAttemptAt <= now));
    },
    pendingForRecipient(identityId: Uint8Array) {
      const hex = Buffer.from(identityId).toString("hex");
      return _items.filter(
        (i) => i.deliveryState === "pending" && Buffer.from(i.recipientIdentityId).toString("hex") === hex,
      );
    },
    markDelivered(messageId: Uint8Array) {
      const hex = Buffer.from(messageId).toString("hex");
      const item = _items.find((i) => Buffer.from(i.messageId).toString("hex") === hex);
      if (item) item.deliveryState = "delivered";
    },
    markAttempt(messageId: Uint8Array) {
      const hex = Buffer.from(messageId).toString("hex");
      const item = _items.find((i) => Buffer.from(i.messageId).toString("hex") === hex);
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
      encryptionFormat: DM_X3DH_QUEUE_FORMAT,
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
    const peer = recipientFixture();
    const manager = new QueueManager(queue);
    const handlers = new Map<string, (data: unknown) => void>();
    const sent: string[] = [];
    const client = {
      identityId: senderIdentityId,
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
    const recipient = peer.identityId;
    const otherRecipient = new Uint8Array(32).fill(3);
    const messageId = new Uint8Array(32).fill(1);

    manager.enqueue({
      messageId,
      recipientIdentityId: recipient,
      encryptedEnvelope: new Uint8Array([1]),
      createdAt: Date.now(),
      attemptCount: 0,
      deliveryState: "pending",
      encryptionFormat: DM_X3DH_QUEUE_FORMAT,
    });
    manager.enqueue({
      messageId: new Uint8Array(32).fill(4),
      recipientIdentityId: otherRecipient,
      encryptedEnvelope: new Uint8Array([2]),
      createdAt: Date.now(),
      attemptCount: 0,
      deliveryState: "pending",
      encryptionFormat: DM_X3DH_QUEUE_FORMAT,
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
    for (const receipt of [
      peer.receipt(messageId, otherRecipient),
      peer.receipt(new Uint8Array(32).fill(6)),
      { ...peer.receipt(messageId), recipientDeviceId: Array.from({ length: 32 }, () => 4) },
      recipientFixture().receipt(messageId),
    ]) {
      handlers.get("delivery_receipt")?.({ receipt });
      expect(queue._items[0]?.deliveryState).toBe("pending");
    }
    handlers.get("delivery_receipt")?.({ receipt: peer.receipt(messageId) });
    expect(queue._items[0]?.deliveryState).toBe("delivered");
    manager.stop();
  });
});

test("legacy custom-queue envelopes never retry or mutate, even with a valid receipt", () => {
  const queue = createMockQueue();
  const peer = recipientFixture();
  const recipient = peer.identityId;
  const handlers = new Map<string, (data: unknown) => void>();
  let sends = 0;
  const client = {
    identityId: senderIdentityId,
    online: true,
    crypto: cryptoProvider,
    codec: { encode: cdeEncode },
    on(event: string, handler: (data: unknown) => void) {
      handlers.set(event, handler);
    },
    off(event: string) {
      handlers.delete(event);
    },
    sendDm() {
      sends++;
      return true;
    },
  } as unknown as import("../client.js").NexnetClient;
  const manager = new QueueManager(queue);
  for (const marker of [undefined, null, "unknown-format"]) {
    queue.enqueue({
      messageId: new Uint8Array(32).fill(queue._items.length + 1),
      recipientIdentityId: recipient,
      encryptedEnvelope: new Uint8Array([2, 1, 3]),
      createdAt: 123,
      attemptCount: 0,
      deliveryState: "pending",
      encryptionFormat: marker as OutboundQueueItem["encryptionFormat"],
    });
  }
  const before = structuredClone(queue._items);
  manager.start(client);
  try {
    manager.processQueue(client);
    handlers.get("presence")?.({ status: "online", identityId: Buffer.from(recipient).toString("hex") });
    for (const item of queue._items) {
      handlers.get("delivery_receipt")?.({
        receipt: peer.receipt(item.messageId),
      });
      expect(() => manager.enqueue(item)).toThrow("Queue item lacks X3DH provenance");
    }
    expect(manager.pendingCount).toBe(0);
    expect(sends).toBe(0);
    expect(queue._items).toEqual(before);
  } finally {
    manager.stop();
  }
});
