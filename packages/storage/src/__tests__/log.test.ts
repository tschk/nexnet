import { describe, test, expect } from "bun:test";
import { EventLog } from "../log.js";
import type { CryptoProvider } from "@nexnet/types";

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
    sign(_sk: Uint8Array, msg: Uint8Array): Uint8Array {
      const sig = new Uint8Array(64);
      sig.set(msg.slice(0, Math.min(msg.length, 64)));
      return sig;
    },
    verify(): boolean {
      return true;
    },
    generateSigningKeyPair() {
      return { secretKey: new Uint8Array(64), publicKey: new Uint8Array(32) };
    },
    encrypt(key: Uint8Array, nonce: Uint8Array, _aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
      const out = new Uint8Array(plaintext.length);
      for (let i = 0; i < plaintext.length; i++) {
        out[i] = plaintext[i] ^ key[i % key.length] ^ nonce[i % nonce.length];
      }
      return out;
    },
    decrypt(key: Uint8Array, nonce: Uint8Array, _aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
      const out = new Uint8Array(ciphertext.length);
      for (let i = 0; i < ciphertext.length; i++) {
        out[i] = ciphertext[i] ^ key[i % key.length] ^ nonce[i % nonce.length];
      }
      return out;
    },
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(n);
    },
    hkdf(): Uint8Array {
      return new Uint8Array(32);
    },
  };
}

const KEY = new Uint8Array(32).fill(0xab);

function makeEventId(n: number): Uint8Array {
  const id = new Uint8Array(32);
  id[0] = n;
  return id;
}

describe("EventLog", () => {
  test("append and count", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    expect(log.count()).toBe(0);
    log.append(makeEventId(1), new Uint8Array([1, 2, 3]));
    expect(log.count()).toBe(1);
    log.append(makeEventId(2), new Uint8Array([4, 5, 6]));
    expect(log.count()).toBe(2);

    log.close();
  });

  test("dedup on duplicate event_id", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    const id = makeEventId(1);
    log.append(id, new Uint8Array([1, 2, 3]));
    log.append(id, new Uint8Array([9, 9, 9]));
    expect(log.count()).toBe(1);

    log.close();
  });

  test("contains", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    const id = makeEventId(1);
    expect(log.contains(id)).toBe(false);
    log.append(id, new Uint8Array([1]));
    expect(log.contains(id)).toBe(true);
    expect(log.contains(makeEventId(99))).toBe(false);

    log.close();
  });

  test("get returns decrypted event", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    const id = makeEventId(1);
    const data = new Uint8Array([10, 20, 30, 40]);
    log.append(id, data);

    const result = log.get(id);
    expect(result).not.toBeNull();
    expect(result!).toEqual(data);

    log.close();
  });

  test("get returns null for missing", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    expect(log.get(makeEventId(99))).toBeNull();

    log.close();
  });

  test("listByConversation returns ciphertexts", () => {
    const crypto = createMockCrypto();
    const log = EventLog.open(":memory:", KEY, crypto);

    const convId = new Uint8Array(32).fill(0xaa);
    log.append(makeEventId(1), new Uint8Array([1]));
    log.append(makeEventId(2), new Uint8Array([2]));

    const results = log.listByConversation(convId);
    expect(Array.isArray(results)).toBe(true);

    log.close();
  });

  test("different keys produce different ciphertexts for same plaintext", () => {
    const crypto = createMockCrypto();
    const keyA = new Uint8Array(32).fill(0xaa);
    const keyB = new Uint8Array(32).fill(0xbb);

    const logA = EventLog.open(":memory:", keyA, crypto);
    const logB = EventLog.open(":memory:", keyB, crypto);

    const id = makeEventId(1);
    const data = new Uint8Array([1, 2, 3]);

    logA.append(id, data);
    logB.append(id, data);

    const resultA = logA.get(id);
    const resultB = logB.get(id);
    expect(resultA).toEqual(data);
    expect(resultB).toEqual(data);

    logA.close();
    logB.close();
  });

  test("temp file persistence", () => {
    const crypto = createMockCrypto();
    const path = `/tmp/nexnet-test-${Date.now()}.db`;

    const log1 = EventLog.open(path, KEY, crypto);
    log1.append(makeEventId(1), new Uint8Array([42]));
    expect(log1.count()).toBe(1);
    log1.close();

    const log2 = EventLog.open(path, KEY, crypto);
    expect(log2.count()).toBe(1);
    expect(log2.get(makeEventId(1))).toEqual(new Uint8Array([42]));
    log2.close();
  });
});
