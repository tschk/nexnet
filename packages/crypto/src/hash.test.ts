import { describe, test, expect } from "bun:test";
import { deriveId } from "./hash.js";

describe("deriveId", () => {
  const data = new TextEncoder().encode("hello world");

  test("same inputs produce same output", () => {
    const a = deriveId("nettle event id v1", data);
    const b = deriveId("nettle event id v1", data);
    expect(a).toEqual(b);
  });

  test("different context produces different output", () => {
    const a = deriveId("nettle event id v1", data);
    const b = deriveId("nettle room id v1", data);
    expect(a).not.toEqual(b);
  });

  test("different data produces different output", () => {
    const a = deriveId("nettle event id v1", data);
    const b = deriveId("nettle event id v1", new TextEncoder().encode("other"));
    expect(a).not.toEqual(b);
  });

  test("output is 32 bytes", () => {
    const id = deriveId("nettle event id v1", data);
    expect(id.length).toBe(32);
  });

  test("empty data works", () => {
    const id = deriveId("nettle event id v1", new Uint8Array(0));
    expect(id.length).toBe(32);
  });
});
