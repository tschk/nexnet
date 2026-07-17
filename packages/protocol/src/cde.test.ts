import { describe, test, expect } from "bun:test";
import { cdeEncode, cdeDecode } from "./cde.js";

describe("CBOR CDE", () => {
  test("roundtrip: encode then decode", () => {
    const obj = { foo: "bar", num: 42 };
    const bytes = cdeEncode(obj);
    const decoded = cdeDecode<Record<string, unknown>>(bytes);
    expect(decoded.foo).toBe("bar");
    expect(decoded.num).toBe(42);
  });

  test("same map with different insertion order → same bytes", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    const bytesA = cdeEncode(a);
    const bytesB = cdeEncode(b);
    expect(bytesA).toEqual(bytesB);
  });

  test("handles Uint8Array values", () => {
    const data = { key: new Uint8Array([1, 2, 3]) };
    const bytes = cdeEncode(data);
    const decoded = cdeDecode<{ key: Uint8Array }>(bytes);
    expect(decoded.key).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("handles nested objects", () => {
    const obj = { outer: { inner: { deep: true } } };
    const bytes = cdeEncode(obj);
    const decoded = cdeDecode<typeof obj>(bytes);
    expect(decoded.outer.inner.deep).toBe(true);
  });

  test("handles arrays", () => {
    const arr = [1, "two", new Uint8Array([3])];
    const bytes = cdeEncode(arr);
    const decoded = cdeDecode<unknown[]>(bytes);
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe("two");
    expect(decoded[2]).toEqual(new Uint8Array([3]));
  });
});
