/**
 * @nexnet/client — Encrypted attachment transfer
 *
 * AD-20: direct only, no relay storage.
 * Chunks sent via relay forwarding to recipient.
 */

import type {
  CryptoProvider,
  CborCdeCodec,
  AttachmentOffer,
  IdentityId,
  MessagePayload,
  MessageId,
} from "@nexnet/types";
import {
  DOMAIN_ATTACHMENT_ID,
  PROTOCOL_VERSION,
} from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import { sendDirectMessage } from "./dm.js";
import { trySendDirect } from "./transport.js";

/** Default chunk size: 64 KB */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

export interface AttachmentTransfer {
  attachmentId: Uint8Array;
  filename: string;
  mimeType: string;
  size: number;
  encryptedBlob: Uint8Array;
  key: Uint8Array; // 32-byte XChaCha key
  contentHash: Uint8Array; // BLAKE3-256 of encrypted blob
}

export interface DirectAttachmentChunk {
  type: "attachment_chunk";
  attachmentId: Uint8Array;
  chunkIndex: number;
  totalChunks: number;
  data: Uint8Array;
}

/**
 * Prepare an attachment for sending.
 * Encrypts the file blob and computes content hash.
 */
export function prepareAttachment(
  crypto: CryptoProvider,
  codec: CborCdeCodec,
  file: Uint8Array,
  filename: string,
  mimeType: string
): AttachmentTransfer {
  // Random 32-byte key for this attachment
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(24);

  // Encrypt blob
  const ciphertext = crypto.encrypt(key, nonce, new Uint8Array(0), file);

  // Prepend nonce to ciphertext: nonce (24) ‖ ciphertext
  const encryptedBlob = new Uint8Array(24 + ciphertext.length);
  encryptedBlob.set(nonce, 0);
  encryptedBlob.set(ciphertext, 24);

  // Content hash = BLAKE3-256 of encrypted blob
  const contentHash = crypto.deriveId(DOMAIN_ATTACHMENT_ID, encryptedBlob);

  // Attachment ID = BLAKE3-256 of content hash (unique per blob)
  const attachmentId = crypto.deriveId(
    DOMAIN_ATTACHMENT_ID,
    contentHash
  );

  return {
    attachmentId,
    filename,
    mimeType,
    size: file.length,
    encryptedBlob,
    key,
    contentHash,
  };
}

/**
 * Send an attachment offer via DM, then transfer the blob in chunks.
 */
export async function sendAttachment(
  client: NexnetClient,
  recipientId: IdentityId,
  file: Uint8Array,
  filename: string,
  mimeType: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<MessageId> {
  const transfer = prepareAttachment(
    client.crypto,
    client.codec,
    file,
    filename,
    mimeType
  );

  // Create attachment offer
  const offer: AttachmentOffer = {
    attachmentId: transfer.attachmentId,
    filename: transfer.filename,
    mimeType: transfer.mimeType,
    size: transfer.size,
    encryptedContentHash: transfer.contentHash,
    transferCapabilities: ["chunked", "direct"],
  };

  // Send DM with attachment offer (key embedded in encrypted payload)
  const payload: MessagePayload = {
    contentType: "attachment_offer",
    text: `[attachment: ${filename} (${formatSize(file.length)})]`,
    attachmentOffer: offer,
    clientMetadata: {
      attachmentKey: Array.from(transfer.key),
    },
  };

  const messageId = await sendDirectMessage(
    client,
    recipientId,
    payload,
    undefined,
    { directOnly: true }
  );

  // Transfer blob in chunks via relay
  const recipientHex = Buffer.from(recipientId).toString("hex");
  await transferBlob(client, recipientHex, transfer, chunkSize);

  return messageId;
}

/**
 * Transfer encrypted blob in chunks.
 */
async function transferBlob(
  client: NexnetClient,
  recipientHex: string,
  transfer: AttachmentTransfer,
  chunkSize: number
): Promise<void> {
  const totalChunks = Math.ceil(transfer.encryptedBlob.length / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * chunkSize;
    const end = Math.min(offset + chunkSize, transfer.encryptedBlob.length);
    const chunk = transfer.encryptedBlob.slice(offset, end);

    // Send chunk via relay
    const message: DirectAttachmentChunk = {
      type: "attachment_chunk",
      attachmentId: transfer.attachmentId,
      chunkIndex: i,
      totalChunks,
      data: chunk,
    };

    // Use WebSocket if available
    if (!trySendDirect(recipientHex, client.codec.encode(message))) {
      throw new Error("Direct session closed during attachment transfer");
    }
    // Small delay between chunks to avoid flooding
  }
}

/**
 * Handle incoming attachment chunks.
 * Reassembles chunks and calls callback with complete attachment.
 */
export class AttachmentReceiver {
  private transfers = new Map<
    string,
    {
      chunks: Map<number, Uint8Array>;
      totalChunks: number;
      receivedAt: number;
      contentHash: Uint8Array;
    }
  >;

  constructor(private crypto: CryptoProvider) {}

  /**
   * Process an incoming chunk.
   * Returns the complete blob when all chunks received, or null if more needed.
   */
  receiveChunk(
    attachmentId: Uint8Array,
    chunkIndex: number,
    totalChunks: number,
    data: Uint8Array,
    contentHash: Uint8Array
): Uint8Array | null {
    if (
      attachmentId.length !== 32 ||
      contentHash.length !== 32 ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      chunkIndex < 0 ||
      totalChunks <= 0 ||
      chunkIndex >= totalChunks
    ) {
      throw new Error("Invalid attachment chunk");
    }

    const expectedAttachmentId = this.crypto.deriveId(
      DOMAIN_ATTACHMENT_ID,
      contentHash
    );
    if (!equalBytes(attachmentId, expectedAttachmentId)) {
      throw new Error("Attachment offer does not match content hash");
    }

    const idHex = Buffer.from(attachmentId).toString("hex");

    if (!this.transfers.has(idHex)) {
      this.transfers.set(idHex, {
        chunks: new Map(),
        totalChunks,
        receivedAt: Date.now(),
        contentHash: new Uint8Array(contentHash),
      });
    }

    const transfer = this.transfers.get(idHex)!;
    if (
      transfer.totalChunks !== totalChunks ||
      !equalBytes(transfer.contentHash, contentHash)
    ) {
      throw new Error("Attachment chunk metadata changed during transfer");
    }

    const existing = transfer.chunks.get(chunkIndex);
    if (existing && !equalBytes(existing, data)) {
      throw new Error("Attachment chunk conflicts with received data");
    }
    transfer.chunks.set(chunkIndex, data);

    // Check if complete
    if (transfer.chunks.size === transfer.totalChunks) {
      // Reassemble
      const sorted = Array.from(transfer.chunks.entries()).sort(
        (a, b) => a[0] - b[0]
      );
      const totalSize = sorted.reduce((sum, [, chunk]) => sum + chunk.length, 0);
      const blob = new Uint8Array(totalSize);
      let offset = 0;
      for (const [, chunk] of sorted) {
        blob.set(chunk, offset);
        offset += chunk.length;
      }

      this.transfers.delete(idHex);
      const actualHash = this.crypto.deriveId(DOMAIN_ATTACHMENT_ID, blob);
      if (!equalBytes(actualHash, transfer.contentHash)) {
        throw new Error("Attachment integrity verification failed");
      }
      return blob;
    }

    return null;
  }

  /**
   * Decrypt a reassembled attachment blob.
   */
  decryptAttachment(
    encryptedBlob: Uint8Array,
    key: Uint8Array
  ): Uint8Array {
    // Extract nonce (first 24 bytes)
    const nonce = encryptedBlob.slice(0, 24);
    const ciphertext = encryptedBlob.slice(24);
    return this.crypto.decrypt(key, nonce, new Uint8Array(0), ciphertext);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
