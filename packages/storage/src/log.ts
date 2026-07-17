/**
 * @nettle/storage — Encrypted append-only event log
 *
 * Per-row AEAD: nonce = blake3(key || event_id)[0:24].
 * Deterministic — same key+event_id always produces same nonce.
 * Event ciphertext stored; event_id = primary key; INSERT OR IGNORE for dedup.
 *
 * Uses bun:sqlite (built into Bun runtime).
 */

import { Database } from "bun:sqlite";
import type { CryptoProvider, EventId, ConversationId } from "@nettle/types";

export class EventLog {
  private db: Database;
  private key: Uint8Array;
  private crypto: CryptoProvider;

  private insertStmt: ReturnType<Database["query"]>;
  private getPlainStmt: ReturnType<Database["query"]>;
  private existsStmt: ReturnType<Database["query"]>;
  private countStmt: ReturnType<Database["query"]>;

  private constructor(db: Database, key: Uint8Array, crypto: CryptoProvider) {
    this.db = db;
    this.key = key;
    this.crypto = crypto;

    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO events (event_id, nonce, ciphertext) VALUES (?, ?, ?)"
    );
    this.getPlainStmt = this.db.prepare(
      "SELECT nonce, ciphertext FROM events WHERE event_id = ?"
    );
    this.existsStmt = this.db.prepare(
      "SELECT 1 FROM events WHERE event_id = ?"
    );
    this.countStmt = this.db.prepare("SELECT COUNT(*) as cnt FROM events");
  }

  static open(path: string, key: Uint8Array, crypto: CryptoProvider): EventLog {
    const db = new Database(path);

    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id    BLOB PRIMARY KEY,
        nonce       BLOB NOT NULL,
        ciphertext  BLOB NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    return new EventLog(db, key, crypto);
  }

  private deriveNonce(eventId: Uint8Array): Uint8Array {
    const data = new Uint8Array(this.key.length + eventId.length);
    data.set(this.key, 0);
    data.set(eventId, this.key.length);
    const hash = this.crypto.deriveId("nettle event nonce v1", data);
    return hash.slice(0, 24);
  }

  append(eventId: EventId, eventCde: Uint8Array): void {
    const nonce = this.deriveNonce(eventId);
    const ciphertext = this.crypto.encrypt(
      this.key,
      nonce,
      new Uint8Array(0),
      eventCde
    );
    this.insertStmt.run(eventId, nonce, ciphertext);
  }

  contains(eventId: EventId): boolean {
    return this.existsStmt.get(eventId) !== null;
  }

  get(eventId: EventId): Uint8Array | null {
    const row = this.getPlainStmt.get(eventId) as {
      nonce: Uint8Array;
      ciphertext: Uint8Array;
    } | null;
    if (!row) return null;
    return this.crypto.decrypt(
      this.key,
      new Uint8Array(row.nonce),
      new Uint8Array(0),
      new Uint8Array(row.ciphertext)
    );
  }

  listByConversation(conversationId: ConversationId): Uint8Array[] {
    const hex =
      "%" +
      Array.from(conversationId)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("") +
      "%";
    const stmt = this.db.prepare(
      "SELECT ciphertext FROM events WHERE hex(event_id) LIKE ? ORDER BY created_at"
    );
    const rows = stmt.all(hex) as { ciphertext: Uint8Array }[];
    return rows.map((r) => new Uint8Array(r.ciphertext));
  }

  count(): number {
    const row = this.countStmt.get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
