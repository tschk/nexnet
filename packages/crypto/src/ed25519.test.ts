import { describe, test, expect } from "bun:test";
import { generateSigningKeyPair, sign, verify } from "./ed25519.js";

describe("ed25519", () => {
  test("roundtrip: sign then verify succeeds", () => {
    const { secretKey, publicKey } = generateSigningKeyPair();
    const message = new TextEncoder().encode("test message");
    const sig = sign(secretKey, message);
    expect(verify(publicKey, message, sig)).toBe(true);
  });

  test("tampered message fails verification", () => {
    const { secretKey, publicKey } = generateSigningKeyPair();
    const message = new TextEncoder().encode("test message");
    const sig = sign(secretKey, message);
    const tampered = new TextEncoder().encode("test messagX");
    expect(verify(publicKey, tampered, sig)).toBe(false);
  });

  test("wrong public key fails verification", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const message = new TextEncoder().encode("test message");
    const sig = sign(kp1.secretKey, message);
    expect(verify(kp2.publicKey, message, sig)).toBe(false);
  });

  test("keypair lengths are correct", () => {
    const { secretKey, publicKey } = generateSigningKeyPair();
    expect(secretKey.length).toBe(32);
    expect(publicKey.length).toBe(32);
  });

  test("signature is 64 bytes", () => {
    const { secretKey } = generateSigningKeyPair();
    const sig = sign(secretKey, new Uint8Array(0));
    expect(sig.length).toBe(64);
  });
});
