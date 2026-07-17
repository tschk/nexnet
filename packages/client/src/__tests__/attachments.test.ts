import { afterEach, describe, test, expect } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import {
  prepareAttachment,
  sendAttachment,
  AttachmentReceiver,
  type DirectAttachmentChunk,
} from "../attachments.js";
import { NexnetClient } from "../client.js";
import { onDirectMessage } from "../dm.js";
import { setDirectTransport } from "../transport.js";
import type { PeerManager } from "../webrtc.js";

describe("Attachments", () => {
  const crypto = cryptoProvider;
  const codec = { encode: cdeEncode, decode: cdeDecode };

  afterEach(() => setDirectTransport(null));

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

  test("sendAttachment uses the direct session for its offer and chunks", async () => {
    const recipientId = new Uint8Array(32).fill(2);
    const recipientHex = Buffer.from(recipientId).toString("hex");
    const sent: Uint8Array[] = [];
    setDirectTransport({
      isOpen: (peer: string) => peer === recipientHex,
      send: (_peer: string, data: Uint8Array) => {
        sent.push(new Uint8Array(data));
        return true;
      },
    } as unknown as PeerManager);
    const senderKeys = crypto.generateSigningKeyPair();
    const client = new NexnetClient({
      identityId: new Uint8Array(32).fill(1),
      deviceId: new Uint8Array(32).fill(3),
      crypto,
      codec,
      relayUrl: "ws://relay.example",
      storagePath: "/tmp/attachments",
      signingSecretKey: senderKeys.secretKey,
    });
    const recipient = new NexnetClient({
      identityId: recipientId,
      deviceId: new Uint8Array(32).fill(4),
      crypto,
      codec,
      relayUrl: "ws://relay.example",
      storagePath: "/tmp/attachments-recipient",
      signingSecretKey: crypto.generateSigningKeyPair().secretKey,
    });
    const file = new Uint8Array([1, 2, 3, 4, 5]);
    let attachmentKey: Uint8Array | undefined;
    onDirectMessage(
      recipient,
      (_envelope, payload) => {
        attachmentKey = new Uint8Array(payload.clientMetadata?.attachmentKey as number[]);
      },
      () => senderKeys.publicKey
    );

    await sendAttachment(client, recipientId, file, "a.bin", "application/octet-stream", 2);

    expect(sent.length).toBeGreaterThan(1);
    const receiver = new AttachmentReceiver(crypto);
    let blob: Uint8Array | null = null;
    for (const bytes of sent.slice(1)) {
      const chunk = codec.decode<DirectAttachmentChunk>(bytes);
      blob = receiver.receiveChunk(
        chunk.attachmentId,
        chunk.chunkIndex,
        chunk.totalChunks,
        chunk.data
      );
    }
    expect(blob).not.toBeNull();
    recipient.emit("dm", { envelope: Array.from(sent[0]!) });
    expect(attachmentKey).toBeDefined();
    expect(receiver.decryptAttachment(blob!, attachmentKey!)).toEqual(file);
  });

  test("sendAttachment rejects without an open direct session", async () => {
    const recipientId = new Uint8Array(32).fill(2);
    const client = new NexnetClient({
      identityId: new Uint8Array(32).fill(1),
      deviceId: new Uint8Array(32).fill(3),
      crypto,
      codec,
      relayUrl: "ws://relay.example",
      storagePath: "/tmp/attachments",
      signingSecretKey: crypto.generateSigningKeyPair().secretKey,
    });

    await expect(
      sendAttachment(client, recipientId, new Uint8Array([1]), "a.bin", "application/octet-stream")
    ).rejects.toThrow("Direct session is required");
  });
});
