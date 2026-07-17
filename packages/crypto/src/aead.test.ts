import { describe, test, expect } from "bun:test";
import { encrypt, decrypt } from "./aead.js";
import { randomBytes } from "./random.js";

describe("xchacha20-poly1305", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const aad = new TextEncoder().encode("metadata");
  const plaintext = new TextEncoder().encode("hello nettle");

  test("roundtrip: encrypt then decrypt succeeds", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    const pt = decrypt(key, nonce, aad, ct);
    expect(pt).toEqual(plaintext);
  });

  test("tampered ciphertext fails decryption", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    ct[0] ^= 0xff;
    expect(() => decrypt(key, nonce, aad, ct)).toThrow();
  });

  test("wrong key fails decryption", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(wrongKey, nonce, aad, ct)).toThrow();
  });

  test("wrong nonce fails decryption", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    const wrongNonce = randomBytes(24);
    expect(() => decrypt(key, wrongNonce, aad, ct)).toThrow();
  });

  test("wrong aad fails decryption", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    const wrongAad = new TextEncoder().encode("wrong");
    expect(() => decrypt(key, nonce, wrongAad, ct)).toThrow();
  });

  test("ciphertext is longer than plaintext (auth tag)", () => {
    const ct = encrypt(key, nonce, aad, plaintext);
    expect(ct.length).toBe(plaintext.length + 16);
  });
});
