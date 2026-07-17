import { describe, test, expect } from "bun:test";
import { deriveRoomId, onRoomMessage } from "../rooms.js";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import type { CborCdeCodec, CryptoProvider, NexnetEvent } from "@nexnet/types";
import type { NexnetClient } from "../client.js";

function createMockCrypto(): CryptoProvider {
  return {
    deriveId(_context: string, data: Uint8Array): Uint8Array {
      const out = new Uint8Array(32);
      for (let i = 0; i < data.length; i++) {
        out[i % 32] ^= data[i];
        out[(i + 7) % 32] ^= (data[i] * 31) & 0xff;
      }
      return out;
    },
    sign(): Uint8Array {
      return new Uint8Array(64);
    },
    verify(): boolean {
      return true;
    },
    generateSigningKeyPair() {
      return { secretKey: new Uint8Array(64), publicKey: new Uint8Array(32) };
    },
    encrypt(): Uint8Array {
      return new Uint8Array(0);
    },
    decrypt(): Uint8Array {
      return new Uint8Array(0);
    },
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(n);
    },
    hkdf(): Uint8Array {
      return new Uint8Array(32);
    },
  };
}

describe("deriveRoomId", () => {
  const crypto = createMockCrypto();

  test("deterministic", () => {
    const id1 = deriveRoomId(crypto, "general");
    const id2 = deriveRoomId(crypto, "general");
    expect(id1).toEqual(id2);
  });

  test("case-insensitive", () => {
    const lower = deriveRoomId(crypto, "general");
    const upper = deriveRoomId(crypto, "GENERAL");
    const mixed = deriveRoomId(crypto, "General");
    expect(lower).toEqual(upper);
    expect(lower).toEqual(mixed);
  });

  test("trims whitespace", () => {
    const id1 = deriveRoomId(crypto, "general");
    const id2 = deriveRoomId(crypto, "  general  ");
    expect(id1).toEqual(id2);
  });

  test("different names yield different ids", () => {
    const id1 = deriveRoomId(crypto, "general");
    const id2 = deriveRoomId(crypto, "random");
    expect(id1).not.toEqual(id2);
  });
});

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };

function createRoomClient(identityId: Uint8Array): NexnetClient & {
  emitRoomEvent(data: unknown): void;
} {
  const handlers = new Set<(data: unknown) => void>();
  return {
    crypto: cryptoProvider,
    codec,
    on(event: string, handler: (data: unknown) => void) {
      if (event === "room_event") handlers.add(handler);
    },
    emitRoomEvent(data: unknown) {
      for (const handler of handlers) handler(data);
    },
  } as NexnetClient & { emitRoomEvent(data: unknown): void };
}

function signedRoomEvent(identityId: Uint8Array, secretKey: Uint8Array) {
  const event = {
    protocolVersion: 1,
    eventType: "room.message",
    authorIdentityId: identityId,
    authorDeviceId: new Uint8Array(32).fill(2),
    createdAt: 1,
    sequence: 1,
    parentIds: [],
    payload: codec.encode({ text: "hello room" }),
  };
  const bytes = codec.encode(event);
  return { event: Array.from(bytes), signature: Array.from(cryptoProvider.sign(secretKey, bytes)) };
}

describe("onRoomMessage", () => {
  const roomId = new Uint8Array(32).fill(7);
  const roomIdHex = Buffer.from(roomId).toString("hex");

  test("rejects an event with an invalid signature", () => {
    const author = cryptoProvider.generateSigningKeyPair();
    const receiver = createRoomClient(new Uint8Array(32).fill(3));
    const received: NexnetEvent[] = [];
    onRoomMessage(receiver, roomId, (event) => received.push(event), () => author.publicKey);

    const signed = signedRoomEvent(new Uint8Array(32).fill(1), author.secretKey);
    signed.signature[0]! ^= 1;
    receiver.emitRoomEvent({ room_id: roomIdHex, event: signed });

    expect(received).toEqual([]);
  });

  test("delivers the same valid signed room event to every subscribed client", () => {
    const author = cryptoProvider.generateSigningKeyPair();
    const authorId = new Uint8Array(32).fill(1);
    const alice = createRoomClient(new Uint8Array(32).fill(3));
    const bob = createRoomClient(new Uint8Array(32).fill(4));
    const aliceEvents: NexnetEvent[] = [];
    const bobEvents: NexnetEvent[] = [];
    const getAuthorKey = (identityId: Uint8Array) =>
      Buffer.from(identityId).equals(Buffer.from(authorId)) ? author.publicKey : undefined;

    onRoomMessage(alice, roomId, (event) => aliceEvents.push(event), getAuthorKey);
    onRoomMessage(bob, roomId, (event) => bobEvents.push(event), getAuthorKey);

    const signed = signedRoomEvent(authorId, author.secretKey);
    const inbound = { room_id: roomIdHex, event: signed };
    alice.emitRoomEvent(inbound);
    bob.emitRoomEvent(inbound);

    expect(aliceEvents).toEqual(bobEvents);
    expect(codec.decode<{ text: string }>(aliceEvents[0]!.payload)).toEqual({ text: "hello room" });
  });
});
