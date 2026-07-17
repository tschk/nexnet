import { describe, test, expect } from "bun:test";
import { randomBytes } from "./random.js";

describe("randomBytes", () => {
  test("returns correct length", () => {
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(64).length).toBe(64);
  });

  test("two calls produce different output", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).not.toEqual(b);
  });
});
