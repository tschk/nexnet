/**
 * @nettle/storage — Outbound message queue
 *
 * SQLite-backed queue for messages waiting to be delivered.
 * Supports retry with attempt tracking and exponential backoff hints.
 *
 * Uses bun:sqlite (built into Bun runtime).
 */

import { Database } from "bun:sqlite";
import type {
  MessageId,
  IdentityId,
  OutboundQueueItem,
  OutboundQueueLike,
  DeliveryState,
} from "@nettle/types";

export type { DeliveryState, OutboundQueueItem } from "@nettle/types";

export class OutboundQueue implements OutboundQueueLike {
  private db: Database;

  private enqueueStmt: ReturnType<Database["query"]>;
  private pendingStmt: ReturnType<Database["query"]>;
  private markDeliveredStmt: ReturnType<Database["query"]>;
  private markAttemptStmt: ReturnType<Database["query"]>;
  private getByIdStmt: ReturnType<Database["query"]>;

  private constructor(db: Database) {
    this.db = db;

    this.enqueueStmt = this.db.prepare(
      `INSERT OR REPLACE INTO outbound
       (message_id, recipient_identity, encrypted_envelope, created_at,
        last_attempt_at, next_attempt_at, attempt_count, delivery_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.pendingStmt = this.db.prepare(
      `SELECT * FROM outbound
       WHERE delivery_state = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC`
    );
    this.markDeliveredStmt = this.db.prepare(
      "UPDATE outbound SET delivery_state = 'delivered' WHERE message_id = ?"
    );
    this.markAttemptStmt = this.db.prepare(
      `UPDATE outbound
       SET attempt_count = attempt_count + 1,
           last_attempt_at = ?,
           next_attempt_at = ?,
           delivery_state = CASE WHEN attempt_count + 1 >= 10 THEN 'failed' ELSE 'pending' END
       WHERE message_id = ?`
    );
    this.getByIdStmt = this.db.prepare(
      "SELECT * FROM outbound WHERE message_id = ?"
    );
  }

  static open(path: string): OutboundQueue {
    const db = new Database(path);

    db.exec(`
      CREATE TABLE IF NOT EXISTS outbound (
        message_id         BLOB PRIMARY KEY,
        recipient_identity BLOB NOT NULL,
        encrypted_envelope BLOB NOT NULL,
        created_at         INTEGER NOT NULL,
        last_attempt_at    INTEGER,
        next_attempt_at    INTEGER,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        delivery_state     TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    return new OutboundQueue(db);
  }

  enqueue(item: OutboundQueueItem): void {
    this.enqueueStmt.run(
      item.messageId,
      item.recipientIdentityId,
      item.encryptedEnvelope,
      item.createdAt,
      item.lastAttemptAt ?? null,
      item.nextAttemptAt ?? null,
      item.attemptCount,
      item.deliveryState
    );
  }

  pending(): OutboundQueueItem[] {
    const now = Date.now();
    const rows = this.pendingStmt.all(now) as Array<{
      message_id: Uint8Array;
      recipient_identity: Uint8Array;
      encrypted_envelope: Uint8Array;
      created_at: number;
      last_attempt_at: number | null;
      next_attempt_at: number | null;
      attempt_count: number;
      delivery_state: string;
    }>;
    return rows.map((row) => ({
      messageId: new Uint8Array(row.message_id),
      recipientIdentityId: new Uint8Array(row.recipient_identity),
      encryptedEnvelope: new Uint8Array(row.encrypted_envelope),
      createdAt: row.created_at,
      lastAttemptAt: row.last_attempt_at ?? undefined,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      attemptCount: row.attempt_count,
      deliveryState: row.delivery_state as DeliveryState,
    }));
  }

  markDelivered(messageId: MessageId): void {
    this.markDeliveredStmt.run(messageId);
  }

  markAttempt(messageId: MessageId): void {
    const now = Date.now();
    const row = this.getByIdStmt.get(messageId) as
      | { attempt_count: number }
      | undefined;
    if (!row) return;

    const backoffMs = Math.min(
      30_000 * Math.pow(2, row.attempt_count),
      30 * 60 * 1000
    );
    this.markAttemptStmt.run(now, now + backoffMs, messageId);
  }

  close(): void {
    this.db.close();
  }
}
