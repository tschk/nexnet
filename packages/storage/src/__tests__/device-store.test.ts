import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DeviceStore } from "../device-store.js";
import { cryptoProvider } from "@nexnet/crypto";

const key = new Uint8Array(32).fill(77);
const fixture = `${import.meta.dir}/fixtures/device-owner.ts`;
const scratch = `${import.meta.dir}/../../../../.amp/in/`;
mkdirSync(scratch, { recursive: true });

test("unlock is mandatory, authenticated, and never reinitializes an existing store", () => {
  const dir = mkdtempSync(`${scratch}device-store-`);
  try {
    expect(() => Reflect.apply(DeviceStore.open, DeviceStore, [dir, undefined, cryptoProvider])).toThrow(
      "32-byte unlock key",
    );
    expect(() => DeviceStore.open(dir, key, cryptoProvider)).toThrow("Cannot unlock");
    let store = DeviceStore.open(dir, key, cryptoProvider, true);
    const secret = new TextEncoder().encode("private-ratchet-secret-that-must-not-be-plaintext");
    store.put("secret", secret);
    store.close();
    expect(readFileSync(`${dir}/device.db`).includes(secret)).toBe(false);
    expect(readFileSync(`${dir}/device.db`).includes(key)).toBe(false);
    expect(() => DeviceStore.open(dir, new Uint8Array(32).fill(78), cryptoProvider)).toThrow("wrong key");
    expect(() => DeviceStore.open(dir, key, cryptoProvider, true)).toThrow("Cannot unlock");
    store = DeviceStore.open(dir, key, cryptoProvider);
    expect(store.get("secret")).toEqual(secret);
    store.close();
    rmSync(`${dir}/device.db`);
    writeFileSync(`${dir}/device.db`, "");
    expect(() => DeviceStore.open(dir, key, cryptoProvider)).toThrow("damaged or unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one damaged encrypted row prevents exposing any recovered state", () => {
  const dir = mkdtempSync(`${scratch}device-store-`);
  try {
    const store = DeviceStore.open(dir, key, cryptoProvider, true);
    store.put("secret", new Uint8Array([1, 2, 3]));
    store.close();
    const db = new Database(`${dir}/device.db`);
    db.query("UPDATE device_state SET ciphertext = ? WHERE name = 'secret'").run(new Uint8Array(64));
    db.close();
    expect(() => DeviceStore.open(dir, key, cryptoProvider)).toThrow("Cannot unlock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["owner", "transaction"])("OS ownership survives contention and releases after killed %s", async (mode) => {
  const dir = mkdtempSync(`${scratch}device-store-`);
  const store = DeviceStore.open(dir, key, cryptoProvider, true);
  store.put("committed", new Uint8Array([3]));
  expect(() => DeviceStore.open(dir, key, cryptoProvider)).toThrow("already owned");
  store.close();
  const child = Bun.spawn([process.execPath, fixture, mode, dir], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    expect(() => DeviceStore.open(dir, key, cryptoProvider)).toThrow("already owned");
    child.kill("SIGKILL");
    await child.exited;
    const recovered = DeviceStore.open(dir, key, cryptoProvider);
    try {
      expect(recovered.get("committed")).toEqual(new Uint8Array([mode === "owner" ? 4 : 3]));
      expect(recovered.get("uncommitted")).toBeNull();
    } finally {
      recovered.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
