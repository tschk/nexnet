import { describe, test, expect } from "bun:test";
import { signEvent, verifyEvent, validateEventLimits } from "./event.js";
import { generateSigningKeyPair } from "@nexnet/crypto";
import type { NexnetEvent, Signature } from "@nexnet/types";
import { MAX_PAYLOAD_BYTES, MAX_PARENT_IDS, MAX_EVENT_TYPE_LEN } from "@nexnet/types";

describe("NexnetEvent signing", () => {
  const { secretKey, publicKey } = generateSigningKeyPair();

  const basePreimage = {
    protocolVersion: 1,
    eventType: "room.message",
    authorIdentityId: new Uint8Array(32).fill(1),
    authorDeviceId: new Uint8Array(32).fill(2),
    createdAt: Date.now(),
    sequence: 1,
    parentIds: [],
    payload: new TextEncoder().encode("hello"),
  };

  test("sign/verify roundtrip", () => {
    const event = signEvent(basePreimage, secretKey);
    expect(verifyEvent(event, publicKey)).toBe(true);
  });

  test("tampered payload fails verification", () => {
    const event = signEvent(basePreimage, secretKey);
    event.payload = new TextEncoder().encode("tampered");
    expect(verifyEvent(event, publicKey)).toBe(false);
  });

  test("wrong public key fails verification", () => {
    const other = generateSigningKeyPair();
    const event = signEvent(basePreimage, secretKey);
    expect(verifyEvent(event, other.publicKey)).toBe(false);
  });

  test("eventId is deterministic", () => {
    const a = signEvent(basePreimage, secretKey);
    const b = signEvent(basePreimage, secretKey);
    expect(a.eventId).toEqual(b.eventId);
  });

  test("eventId is 32 bytes", () => {
    const event = signEvent(basePreimage, secretKey);
    expect(event.eventId.length).toBe(32);
  });

  test("signature is 64 bytes", () => {
    const event = signEvent(basePreimage, secretKey);
    expect(event.signature.length).toBe(64);
  });
});

describe("validateEventLimits", () => {
  const okEvent: NexnetEvent = {
    protocolVersion: 1,
    eventType: "room.message",
    eventId: new Uint8Array(32),
    authorIdentityId: new Uint8Array(32),
    authorDeviceId: new Uint8Array(32),
    createdAt: Date.now(),
    sequence: 1,
    parentIds: [],
    payload: new Uint8Array(10),
    signature: new Uint8Array(64) as Signature,
  };

  test("valid event passes", () => {
    expect(() => validateEventLimits(okEvent)).not.toThrow();
  });

  test("oversized payload rejected", () => {
    expect(() =>
      validateEventLimits({
        ...okEvent,
        payload: new Uint8Array(MAX_PAYLOAD_BYTES + 1),
      })
    ).toThrow();
  });

  test("too many parentIds rejected", () => {
    expect(() =>
      validateEventLimits({
        ...okEvent,
        parentIds: Array.from({ length: MAX_PARENT_IDS + 1 }, () =>
          new Uint8Array(32)
        ),
      })
    ).toThrow();
  });

  test("oversized eventType rejected", () => {
    expect(() =>
      validateEventLimits({
        ...okEvent,
        eventType: "x".repeat(MAX_EVENT_TYPE_LEN + 1),
      })
    ).toThrow();
  });
});
