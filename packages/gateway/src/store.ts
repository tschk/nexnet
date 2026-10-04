import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredMessage {
  seq: number;
  channel: string;
  eventId: string;
  identity: string;
  device: string;
  createdAt: number;
  receivedAt: number;
  body: string;
}

export interface StoredSession {
  tokenHash: string;
  identity: string;
  device: string;
  method: string;
  expiresAt: number;
}

export type InsertResult = "duplicate" | "stale_sequence";

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        identity TEXT NOT NULL,
        device TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        device_sequence INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages (channel, seq);
      CREATE TABLE IF NOT EXISTS device_sequences (
        device TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        device TEXT NOT NULL,
        method TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_identity ON sessions (identity);
    `);
  }

  lastSequence(device: string): number {
    const row = this.db
      .query("SELECT last_sequence AS value FROM device_sequences WHERE device = ?")
      .get(device) as { value: number } | null;
    return row?.value ?? 0;
  }

  hasEvent(eventId: string): boolean {
    return this.db.query("SELECT 1 AS one FROM messages WHERE event_id = ?").get(eventId) !== null;
  }

  insertMessage(message: Omit<StoredMessage, "seq">, deviceSequence: number): InsertResult | StoredMessage {
    const run = this.db.transaction((): InsertResult | StoredMessage => {
      if (this.hasEvent(message.eventId)) return "duplicate";
      if (deviceSequence <= this.lastSequence(message.device)) return "stale_sequence";
      const result = this.db
        .query(
          `INSERT INTO messages (channel, event_id, identity, device, created_at, received_at, device_sequence, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          message.channel,
          message.eventId,
          message.identity,
          message.device,
          message.createdAt,
          message.receivedAt,
          deviceSequence,
          message.body
        );
      this.db
        .query(
          `INSERT INTO device_sequences (device, last_sequence) VALUES (?, ?)
           ON CONFLICT(device) DO UPDATE SET last_sequence = excluded.last_sequence`
        )
        .run(message.device, deviceSequence);
      return { ...message, seq: Number(result.lastInsertRowid) };
    });
    return run();
  }

  messages(channel: string, limit: number, beforeSeq: number | null): StoredMessage[] {
    const rows = this.db
      .query(
        `SELECT seq, channel, event_id AS eventId, identity, device, created_at AS createdAt,
                received_at AS receivedAt, body
         FROM messages WHERE channel = ? AND (? IS NULL OR seq < ?)
         ORDER BY seq DESC LIMIT ?`
      )
      .all(channel, beforeSeq, beforeSeq, limit) as StoredMessage[];
    return rows.reverse();
  }

  lastMessageAt(channel: string): number | null {
    const row = this.db
      .query("SELECT MAX(received_at) AS value FROM messages WHERE channel = ?")
      .get(channel) as { value: number | null } | null;
    return row?.value ?? null;
  }

  purgeChannel(channel: string): void {
    this.db.query("DELETE FROM messages WHERE channel = ?").run(channel);
  }

  createSession(session: StoredSession): void {
    this.db
      .query("INSERT INTO sessions (token_hash, identity, device, method, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(session.tokenHash, session.identity, session.device, session.method, session.expiresAt);
  }

  getSession(tokenHash: string): StoredSession | null {
    const row = this.db
      .query(
        "SELECT token_hash AS tokenHash, identity, device, method, expires_at AS expiresAt FROM sessions WHERE token_hash = ?"
      )
      .get(tokenHash) as StoredSession | null;
    return row;
  }

  deleteSession(tokenHash: string): void {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  sessionsForIdentity(identity: string): StoredSession[] {
    return this.db
      .query(
        "SELECT token_hash AS tokenHash, identity, device, method, expires_at AS expiresAt FROM sessions WHERE identity = ?"
      )
      .all(identity) as StoredSession[];
  }

  deleteExpiredSessions(now: number): void {
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}
