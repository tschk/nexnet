import { describe, test, expect } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import {
  prepareAttachment,
  AttachmentReceiver,
} from "../attachments.js";

describe("Attachments", () => {
  const crypto = cryptoProvider;
  const codec = { encode: cdeEncode, decode: cdeDecode };

  test("prepareAttachment encrypts and hashes", () => {
    const file = new TextEncoder().encode("Hello, this is a test file!");
    const transfer = prepareAttachment(
      crypto,
      codec,
      file,
      "test.txt",
      "text/plain"
    );

    expect(transfer.attachmentId.length).toBe(32);
    expect(transfer.contentHash.length).toBe(32);
    expect(transfer.key.length).toBe(32);
    expect(transfer.encryptedBlob.length).toBeGreaterThan(0);
    expect(transfer.filename).toBe("test.txt");
    expect(transfer.mimeType).toBe("text/plain");
    expect(transfer.size).toBe(file.length);
  });

  test("same file produces different encrypted blobs (random key/nonce)", () => {
    const file = new TextEncoder().encode("same content");
    const t1 = prepareAttachment(crypto, codec, file, "a.txt", "text/plain");
    const t2 = prepareAttachment(crypto, codec, file, "a.txt", "text/plain");

    // Different encryption (random key/nonce)
    expect(t1.encryptedBlob).not.toEqual(t2.encryptedBlob);
    // Different attachment ID (hash of encrypted blob)
    expect(t1.attachmentId).not.toEqual(t2.attachmentId);
    // Different key
    expect(t1.key).not.toEqual(t2.key);
  });

  test("AttachmentReceiver reassembles chunks", () => {
    const receiver = new AttachmentReceiver(crypto);
    const attachmentId = new Uint8Array(32);
    attachmentId[0] = 1;

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunk1 = data.slice(0, 4);
    const chunk2 = data.slice(4, 8);

    // First chunk — not complete
    const result1 = receiver.receiveChunk(attachmentId, 0, 2, chunk1);
    expect(result1).toBeNull();

    // Second chunk — complete
    const result2 = receiver.receiveChunk(attachmentId, 1, 2, chunk2);
    expect(result2).not.toBeNull();
    expect(result2).toEqual(data);
  });

  test("AttachmentReceiver handles out-of-order chunks", () => {
    const receiver = new AttachmentReceiver(crypto);
    const attachmentId = new Uint8Array(32);
    attachmentId[0] = 2;

    const data = new Uint8Array([10, 20, 30, 40]);

    // Send chunks in reverse order
    receiver.receiveChunk(attachmentId, 1, 2, data.slice(2, 4));
    const result = receiver.receiveChunk(attachmentId, 0, 2, data.slice(0, 2));

    expect(result).not.toBeNull();
    expect(result).toEqual(data);
  });

  test("decrypt attachment after reassembly", () => {
    const file = new TextEncoder().encode("secret document");
    const transfer = prepareAttachment(
      crypto,
      codec,
      file,
      "secret.txt",
      "text/plain"
    );

    const receiver = new AttachmentReceiver(crypto);

    // Simulate single-chunk transfer
    const reassembled = receiver.receiveChunk(
      transfer.attachmentId,
      0,
      1,
      transfer.encryptedBlob
    );
    expect(reassembled).not.toBeNull();

    // Decrypt
    const decrypted = receiver.decryptAttachment(reassembled!, transfer.key);
    expect(new TextDecoder().decode(decrypted)).toBe("secret document");
  });
});
