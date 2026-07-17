import { describe, test, expect } from "bun:test";
import { deriveRoomId } from "../rooms.js";
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
