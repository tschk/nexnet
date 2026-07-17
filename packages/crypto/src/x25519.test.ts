import { describe, test, expect } from "bun:test";
import { generateKeyPair, getSharedSecret } from "./x25519.js";

describe("x25519", () => {
  test("shared secret matches from both sides", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secretA = getSharedSecret(alice.secretKey, bob.publicKey);
    const secretB = getSharedSecret(bob.secretKey, alice.publicKey);
    expect(secretA).toEqual(secretB);
  });

  test("shared secret is 32 bytes", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const secret = getSharedSecret(alice.secretKey, bob.publicKey);
    expect(secret.length).toBe(32);
  });

  test("keypair lengths are correct", () => {
    const { secretKey, publicKey } = generateKeyPair();
    expect(secretKey.length).toBe(32);
    expect(publicKey.length).toBe(32);
  });

  test("different peers produce different shared secrets", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const ab = getSharedSecret(alice.secretKey, bob.publicKey);
    const ac = getSharedSecret(alice.secretKey, carol.publicKey);
    expect(ab).not.toEqual(ac);
  });
});
