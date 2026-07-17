import { describe, test, expect } from "bun:test";
import { cryptoProvider } from "@nettle/crypto";
import {
  deriveGroupKey,
  deriveEpoch,
  encryptGroupMessage,
  decryptGroupMessage,
} from "../group-crypto.js";

describe("Group encryption", () => {
  const crypto = cryptoProvider;
  const groupId = crypto.deriveId(
    "nettle group id v1",
    new TextEncoder().encode("test-group")
  );

  test("deriveGroupKey produces 32 bytes", () => {
    const key = deriveGroupKey(crypto, groupId, 0);
    expect(key.length).toBe(32);
  });

  test("different epochs produce different keys", () => {
    const key0 = deriveGroupKey(crypto, groupId, 0);
    const key1 = deriveGroupKey(crypto, groupId, 1);
    expect(key0).not.toEqual(key1);
  });

  test("same group + epoch produces same key", () => {
    const key1 = deriveGroupKey(crypto, groupId, 0);
    const key2 = deriveGroupKey(crypto, groupId, 0);
    expect(key1).toEqual(key2);
  });

  test("different groups produce different keys", () => {
    const groupId2 = crypto.deriveId(
      "nettle group id v1",
      new TextEncoder().encode("other-group")
    );
    const key1 = deriveGroupKey(crypto, groupId, 0);
    const key2 = deriveGroupKey(crypto, groupId2, 0);
    expect(key1).not.toEqual(key2);
  });

  test("encrypt/decrypt roundtrip", () => {
    const kp = crypto.generateSigningKeyPair();
    const payload = new TextEncoder().encode("Hello group!");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      0,
      payload,
      kp.secretKey
    );

    expect(encrypted.epoch).toBe(0);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.nonce.length).toBe(24);

    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      encrypted,
      kp.publicKey
    );

    expect(decrypted).not.toBeNull();
    expect(new TextDecoder().decode(decrypted!)).toBe("Hello group!");
  });

  test("wrong epoch fails to decrypt", () => {
    const kp = crypto.generateSigningKeyPair();
    const payload = new TextEncoder().encode("secret");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      0,
      payload,
      kp.secretKey
    );

    // Try decrypting with epoch 1 key (wrong epoch)
    const wrongEpoch = { ...encrypted, epoch: 1 };
    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      wrongEpoch,
      kp.publicKey
    );

    expect(decrypted).toBeNull();
  });

  test("wrong signature fails", () => {
    const kp = crypto.generateSigningKeyPair();
    const kp2 = crypto.generateSigningKeyPair();
    const payload = new TextEncoder().encode("signed");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      0,
      payload,
      kp.secretKey
    );

    // Verify with wrong public key
    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      encrypted,
      kp2.publicKey
    );

    expect(decrypted).toBeNull();
  });

  test("deriveEpoch from membership changes", () => {
    expect(deriveEpoch(0)).toBe(0);
    expect(deriveEpoch(1)).toBe(1);
    expect(deriveEpoch(5)).toBe(5);
  });

  test("removed member can't decrypt new epoch", () => {
    const kp = crypto.generateSigningKeyPair();
    const payload = new TextEncoder().encode("epoch 1 message");

    // Encrypt at epoch 1 (after one membership change)
    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      1,
      payload,
      kp.secretKey
    );

    // Member who only has epoch 0 key can't decrypt
    const epoch0Key = deriveGroupKey(crypto, groupId, 0);
    const epoch1Key = deriveGroupKey(crypto, groupId, 1);
    expect(epoch0Key).not.toEqual(epoch1Key);

    // But epoch 1 key works
    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      encrypted,
      kp.publicKey
    );
    expect(decrypted).not.toBeNull();
  });
});
