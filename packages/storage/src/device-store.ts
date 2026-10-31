import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CryptoProvider } from "@nexnet/types";

const CHECK = new TextEncoder().encode("nexnet encrypted device store v1");
export class DeviceCapacityError extends Error {
  constructor() {
    super("Device capacity exhausted; existing obligations retained");
  }
}

/** One process owns this device directory until close or process death. */
export class DeviceStore {
  private limits: { bytes: number; records: number } | undefined;
  private constructor(
    private readonly db: Database,
    private readonly lock: Database,
    private readonly key: Uint8Array,
    private readonly crypto: CryptoProvider,
  ) {}

  static open(directory: string, unlockKey: Uint8Array, crypto: CryptoProvider, create = false): DeviceStore {
    if (!(unlockKey instanceof Uint8Array) || unlockKey.length !== 32) {
      throw new Error("Device store requires a host-supplied 32-byte unlock key");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(directory);
    const lock = new Database(join(canonical, "device.lock"));
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      lock.close();
      throw new Error("Device state is already owned by another writer");
    }
    let db: Database | undefined;
    try {
      const path = join(canonical, "device.db");
      const existing = existsSync(path);
      if (create === existing)
        throw new Error(
          create ? "Device store already exists" : "Device store is missing; explicit creation is required",
        );
      db = new Database(path);
      db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
      const store = new DeviceStore(db, lock, new Uint8Array(unlockKey), crypto);
      if (!existing) {
        db.transaction(() => {
          db!.exec("CREATE TABLE device_state (name TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL)");
          store.put("format", CHECK);
        })();
      }
      const check = store.get("format");
      if (!check || !Buffer.from(check).equals(Buffer.from(CHECK))) throw new Error("invalid device store format");
      // Authenticate every row before exposing any recovered state.
      for (const name of store.keys("")) store.get(name);
      chmodSync(path, 0o600);
      chmodSync(join(canonical, "device.lock"), 0o600);
      return store;
    } catch (error) {
      db?.close();
      lock.close();
      const detail = error instanceof Error ? error.message : "unknown storage error";
      throw new Error(`Cannot unlock device store: wrong key, damaged or unsupported database (${detail})`, {
        cause: error,
      });
    }
  }

  get(name: string): Uint8Array | null {
    const row = this.db.query("SELECT nonce, ciphertext FROM device_state WHERE name = ?").get(name) as {
      nonce: Uint8Array;
      ciphertext: Uint8Array;
    } | null;
    if (!row) return null;
    return this.crypto.decrypt(this.key, row.nonce, new TextEncoder().encode(name), row.ciphertext);
  }

  put(name: string, value: Uint8Array): void {
    if (this.limits) {
      const previous = this.db
        .query(
          "SELECT length(CAST(name AS BLOB)) + length(nonce) + length(ciphertext) AS bytes FROM device_state WHERE name = ?",
        )
        .get(name) as { bytes: number } | null;
      const usage = this.usage();
      const next = new TextEncoder().encode(name).length + 24 + value.length + 16;
      if (
        (!previous && usage.records >= this.limits.records) ||
        (next > (previous?.bytes ?? 0) && usage.bytes - (previous?.bytes ?? 0) + next > this.limits.bytes)
      )
        throw new DeviceCapacityError();
    }
    const nonce = this.crypto.randomBytes(24);
    const ciphertext = this.crypto.encrypt(this.key, nonce, new TextEncoder().encode(name), value);
    this.db.query("INSERT OR REPLACE INTO device_state VALUES (?, ?, ?)").run(name, nonce, ciphertext);
  }

  /** Logical encrypted-data budget, not an OS disk reservation or SQLite file-size promise. */
  setLimits(limits: { bytes: number; records: number }): void {
    if (
      !Number.isSafeInteger(limits.bytes) ||
      limits.bytes < 1 ||
      !Number.isSafeInteger(limits.records) ||
      limits.records < 1
    )
      throw new Error("Invalid device capacity limits");
    this.limits = { ...limits };
  }

  usage(): { bytes: number; records: number } {
    return this.db
      .query(
        "SELECT coalesce(sum(length(CAST(name AS BLOB)) + length(nonce) + length(ciphertext)), 0) AS bytes, count(*) AS records FROM device_state",
      )
      .get() as { bytes: number; records: number };
  }

  keys(prefix: string): string[] {
    return (
      this.db
        .query("SELECT name FROM device_state WHERE substr(name, 1, ?) = ? ORDER BY name")
        .all(prefix.length, prefix) as { name: string }[]
    ).map((row) => row.name);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  close(): void {
    this.db.close();
    this.lock.close();
    this.key.fill(0);
  }
}
