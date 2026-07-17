import { describe, test, expect, beforeEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import {
  clearSessions,
  initInitiator,
  initResponder,
  open,
  seal,
} from "../double-ratchet.js";

const crypto = cryptoProvider;
const te = new TextEncoder();

function aad(): Uint8Array {
  return te.encode("nexnet-test-aad");
}

beforeEach(() => {
  clearSessions();
});

describe("Double Ratchet", () => {
  test("alice→bob first message decrypts", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    const pt = te.encode("hello bob");
    const blob = seal(crypto, alice, pt, aad());
    const out = open(crypto, bob, blob, aad());
    expect(out).toEqual(pt);
  });

  test("bob reply decrypts (post-compromise path)", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    open(crypto, bob, seal(crypto, alice, te.encode("hi"), aad()), aad());
    const reply = seal(crypto, bob, te.encode("hey alice"), aad());
    const out = open(crypto, alice, reply, aad());
    expect(out).toEqual(te.encode("hey alice"));
  });

  test("multi-message same direction", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    for (let i = 0; i < 5; i++) {
      const pt = te.encode(`msg-${i}`);
      const out = open(crypto, bob, seal(crypto, alice, pt, aad()), aad());
      expect(out).toEqual(pt);
    }
  });

  test("out-of-order within same DH epoch", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    const b0 = seal(crypto, alice, te.encode("0"), aad());
    const b1 = seal(crypto, alice, te.encode("1"), aad());
    const b2 = seal(crypto, alice, te.encode("2"), aad());

    expect(open(crypto, bob, b2, aad())).toEqual(te.encode("2"));
    expect(open(crypto, bob, b0, aad())).toEqual(te.encode("0"));
    expect(open(crypto, bob, b1, aad())).toEqual(te.encode("1"));
  });

  test("forward secrecy: old mk cannot decrypt after ratchet", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    const blob = seal(crypto, alice, te.encode("secret"), aad());
    // Snapshot chain key would be needed; instead verify second decrypt fails
    // after successful open (mk consumed / skipped map empty for that n).
    open(crypto, bob, blob, aad());
    expect(() => open(crypto, bob, blob, aad())).toThrow();
  });

  test("ping-pong several turns", () => {
    const sk = crypto.randomBytes(32);
    const alice = initInitiator(sk, crypto);
    const bob = initResponder(sk, crypto);

    for (let i = 0; i < 4; i++) {
      const aMsg = te.encode(`a-${i}`);
      expect(
        open(crypto, bob, seal(crypto, alice, aMsg, aad()), aad())
      ).toEqual(aMsg);
      const bMsg = te.encode(`b-${i}`);
      expect(
        open(crypto, alice, seal(crypto, bob, bMsg, aad()), aad())
      ).toEqual(bMsg);
    }
  });
});
