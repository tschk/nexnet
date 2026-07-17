/**
 * @nexnet/storage — persisted Double Ratchet sessions
 *
 * Opaque blob per session key. Client owns serialize format.
 */

import { Database } from "bun:sqlite";

export class SessionStore {
  private db: Database;
  private getStmt: ReturnType<Database["query"]>;
  private putStmt: ReturnType<Database["query"]>;
  private delStmt: ReturnType<Database["query"]>;
  private clearStmt: ReturnType<Database["query"]>;
  private keysStmt: ReturnType<Database["query"]>;

  private constructor(db: Database) {
    this.db = db;
    this.getStmt = this.db.prepare(
      "SELECT blob FROM ratchet_sessions WHERE session_key = ?"
    );
    this.putStmt = this.db.prepare(
      `INSERT OR REPLACE INTO ratchet_sessions (session_key, blob, updated_at)
       VALUES (?, ?, ?)`
    );
    this.delStmt = this.db.prepare(
      "DELETE FROM ratchet_sessions WHERE session_key = ?"
    );
    this.clearStmt = this.db.prepare("DELETE FROM ratchet_sessions");
    this.keysStmt = this.db.prepare(
      "SELECT session_key FROM ratchet_sessions"
    );
  }

  static open(path: string): SessionStore {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ratchet_sessions (
        session_key TEXT PRIMARY KEY,
        blob        BLOB NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);
    return new SessionStore(db);
  }

  get(sessionKey: string): Uint8Array | null {
    const row = this.getStmt.get(sessionKey) as { blob: Uint8Array } | null;
    if (!row) return null;
    return new Uint8Array(row.blob);
  }

  put(sessionKey: string, blob: Uint8Array): void {
    this.putStmt.run(sessionKey, blob, Date.now());
  }

  delete(sessionKey: string): void {
    this.delStmt.run(sessionKey);
  }

  clear(): void {
    this.clearStmt.run();
  }

  keys(): string[] {
    const rows = this.keysStmt.all() as { session_key: string }[];
    return rows.map((r) => r.session_key);
  }

  close(): void {
    this.db.close();
  }
}
