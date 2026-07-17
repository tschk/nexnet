import { describe, test, expect } from "bun:test";
import { deriveConversationId } from "../dm.js";
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
    sign(): Uint8Array {
      return new Uint8Array(64);
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

describe("deriveConversationId", () => {
  const crypto = createMockCrypto();

  test("deterministic — same inputs yield same result", () => {
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0xbb);

    const id1 = deriveConversationId(crypto, a, b);
    const id2 = deriveConversationId(crypto, a, b);
    expect(id1).toEqual(id2);
  });

  test("symmetric — order doesn't matter", () => {
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0xbb);

    const id1 = deriveConversationId(crypto, a, b);
    const id2 = deriveConversationId(crypto, b, a);
    expect(id1).toEqual(id2);
  });

  test("different pairs yield different ids", () => {
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0xbb);
    const c = new Uint8Array(32).fill(0xcc);

    const id1 = deriveConversationId(crypto, a, b);
    const id2 = deriveConversationId(crypto, a, c);
    expect(id1).not.toEqual(id2);
  });
});
