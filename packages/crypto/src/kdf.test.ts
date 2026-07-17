import { describe, test, expect } from "bun:test";
import { deriveKey } from "./kdf.js";

describe("hkdf-sha256", () => {
  test("produces deterministic output", () => {
    const ikm = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(32).fill(2);
    const info = new TextEncoder().encode("test info");
    const a = deriveKey(ikm, salt, info, 32);
    const b = deriveKey(ikm, salt, info, 32);
    expect(a).toEqual(b);
  });

  test("different info produces different keys", () => {
    const ikm = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(32).fill(2);
    const a = deriveKey(ikm, salt, new TextEncoder().encode("info-a"), 32);
    const b = deriveKey(ikm, salt, new TextEncoder().encode("info-b"), 32);
    expect(a).not.toEqual(b);
  });

  test("respects requested length", () => {
    const ikm = new Uint8Array(32).fill(1);
    const out = deriveKey(ikm, new Uint8Array(0), new Uint8Array(0), 64);
    expect(out.length).toBe(64);
  });
});
