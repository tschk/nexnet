import { describe, test, expect, afterEach } from "bun:test";
import { SessionStore } from "../sessions.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("put/get roundtrip", () => {
    dir = mkdtempSync(join(tmpdir(), "nexnet-sess-"));
    store = SessionStore.open(join(dir, "s.db"));
    const blob = new Uint8Array([1, 2, 3, 4]);
    store.put("alice:bob", blob);
    expect(store.get("alice:bob")).toEqual(blob);
  });

  test("missing key returns null", () => {
    dir = mkdtempSync(join(tmpdir(), "nexnet-sess-"));
    store = SessionStore.open(join(dir, "s.db"));
    expect(store.get("nope")).toBeNull();
  });

  test("overwrite and delete", () => {
    dir = mkdtempSync(join(tmpdir(), "nexnet-sess-"));
    store = SessionStore.open(join(dir, "s.db"));
    store.put("k", new Uint8Array([1]));
    store.put("k", new Uint8Array([9]));
    expect(store.get("k")).toEqual(new Uint8Array([9]));
    store.delete("k");
    expect(store.get("k")).toBeNull();
  });

  test("keys and clear", () => {
    dir = mkdtempSync(join(tmpdir(), "nexnet-sess-"));
    store = SessionStore.open(join(dir, "s.db"));
    store.put("a", new Uint8Array([1]));
    store.put("b", new Uint8Array([2]));
    expect(store.keys().sort()).toEqual(["a", "b"]);
    store.clear();
    expect(store.keys()).toEqual([]);
  });

  test("survives reopen", () => {
    dir = mkdtempSync(join(tmpdir(), "nexnet-sess-"));
    const path = join(dir, "s.db");
    store = SessionStore.open(path);
    store.put("persist", new Uint8Array([7, 7]));
    store.close();
    store = SessionStore.open(path);
    expect(store.get("persist")).toEqual(new Uint8Array([7, 7]));
  });
});
