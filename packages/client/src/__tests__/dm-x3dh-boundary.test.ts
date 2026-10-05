import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cryptoProvider as crypto } from "@nexnet/crypto";
import { cdeEncode, cdeDecode, issueDeviceCert } from "@nexnet/protocol";
import { DM_X3DH_QUEUE_FORMAT, PROTOCOL_VERSION } from "@nexnet/types";
import type { MessageEnvelope, OutboundQueueItem, OutboundQueueLike } from "@nexnet/types";
import type { NexnetClient } from "../client.js";
import type { PeerManager } from "../webrtc.js";
import { deriveConversationId, onDirectMessage, sendDirectMessage } from "../dm.js";
import {
  clearSessions,
  getSession,
  initInitiator,
  initResponder,
  open,
  seal,
  serializeState,
  sessionStoreKey,
  setSessionBackend,
  x3dhSessionStoreKey,
} from "../double-ratchet.js";
import { clearPrekeyDirectory, fetchBundle, setupLocalPrekeys } from "../prekeys.js";
import { setDirectTransport } from "../transport.js";

// All identities and keys are throwaway synthetic fixtures. The real noble
// crypto provider is used; transports and message/session storage are in-memory.
const codec = { encode: cdeEncode, decode: cdeDecode };
function peer(fill: number) {
  const keys = crypto.generateSigningKeyPair();
  const root = crypto.generateSigningKeyPair();
  const identityId = new Uint8Array(32).fill(fill);
  const deviceId = new Uint8Array(32).fill(fill ^ 0x55);
  const certificate = issueDeviceCert(
    root.secretKey,
    keys.publicKey,
    keys.publicKey,
    deviceId,
    identityId,
    Date.now(),
    Number.MAX_SAFE_INTEGER,
    1,
  );
  const handlers = new Map<string, (data: unknown) => void>();
  const sent: Uint8Array[] = [];
  const persisted: Uint8Array[] = [];
  const receipts: Uint8Array[] = [];
  const delivered: string[] = [];
  const client = {
    identityId,
    deviceId,
    crypto,
    codec,
    deviceCertificate: certificate,
    deviceSigningSecretKey: keys.secretKey,
    deviceSigningPublicKey: keys.publicKey,
    rootPublicKey: root.publicKey,
    online: true,
    on(event: string, handler: (data: unknown) => void) {
      handlers.set(event, handler);
    },
    hasIncomingMessage(id: Uint8Array) {
      return persisted.some((p) => Buffer.from(p).equals(Buffer.from(id)));
    },
    persistIncomingMessage(id: Uint8Array) {
      persisted.push(id.slice());
      return true;
    },
    sendDeliveryReceipt(_recipient: string, id: Uint8Array) {
      receipts.push(id.slice());
    },
    sendDm(_recipient: string, envelope: number[]) {
      sent.push(new Uint8Array(envelope));
      return true;
    },
  } as unknown as NexnetClient;
  return { client, keys, root, handlers, sent, persisted, receipts, delivered };
}
type Peer = ReturnType<typeof peer>;
function material(p: Peer, otps = 0) {
  return setupLocalPrekeys(crypto, p.client.identityId, p.keys.secretKey, p.keys.publicKey, otps);
}
function receive(recipient: Peer, sender: Peer) {
  onDirectMessage(
    recipient.client,
    (_envelope, payload) => recipient.delivered.push(payload.text),
    () => sender.root.publicKey,
  );
}
function deliver(recipient: Peer, bytes: Uint8Array) {
  recipient.handlers.get("dm")?.({ envelope: Array.from(bytes) });
}
function envelope(bytes: Uint8Array) {
  return codec.decode<MessageEnvelope>(bytes);
}
function aad(a: Peer, b: Peer) {
  return codec.encode({
    conversationId: deriveConversationId(crypto, a.client.identityId, b.client.identityId),
    senderIdentityId: a.client.identityId,
    recipientIdentityId: b.client.identityId,
  });
}
function signEnvelope(sender: Peer, fields: Omit<MessageEnvelope, "signature">): Uint8Array {
  return codec.encode({ ...fields, signature: crypto.sign(sender.keys.secretKey, codec.encode(fields)) });
}
function resign(sender: Peer, original: Uint8Array, change: (e: MessageEnvelope) => void): Uint8Array {
  const e = envelope(original.slice());
  change(e);
  const { signature: _, ...fields } = e;
  return signEnvelope(sender, fields);
}
// Historical vulnerable derivation exists only as an attack regression fixture.
function publicRoot(conversationId: Uint8Array) {
  return crypto.hkdf(conversationId, new Uint8Array(), new TextEncoder().encode("nexnet dm conversation key v1"), 32);
}
function legacyMessage(a: Peer, b: Peer) {
  const conversationId = deriveConversationId(crypto, a.client.identityId, b.client.identityId);
  const ciphertext = seal(
    crypto,
    initInitiator(publicRoot(conversationId), crypto),
    codec.encode({ contentType: "text", text: "public observer control" }),
    aad(a, b),
  );
  return signEnvelope(a, {
    protocolVersion: PROTOCOL_VERSION,
    conversationId,
    ciphertext,
    messageId: new Uint8Array(32).fill(0x91),
    senderIdentityId: a.client.identityId,
    senderDeviceId: a.client.deviceId,
    recipientIdentityId: b.client.identityId,
    senderCertificate: a.client.deviceCertificate!,
    senderSequence: 1,
    parentIds: [],
    createdAt: Date.now(),
  });
}
function queue() {
  const items: OutboundQueueItem[] = [];
  return {
    items,
    enqueue(item: OutboundQueueItem) {
      items.push(item);
    },
    pending: () => items,
    pendingForRecipient: () => items,
    markDelivered() {},
    markAttempt() {},
  } satisfies OutboundQueueLike & { items: OutboundQueueItem[] };
}

const blobs = new Map<string, Uint8Array>();
let writes = 0;
let directAttempts = 0;
const backend = {
  get: (key: string) => blobs.get(key) ?? null,
  put(key: string, blob: Uint8Array) {
    writes++;
    blobs.set(key, blob.slice());
  },
};
function reloadSessions() {
  setSessionBackend(null);
  clearSessions();
  setSessionBackend(backend);
}
beforeEach(() => {
  setSessionBackend(null);
  clearSessions();
  clearPrekeyDirectory();
  blobs.clear();
  writes = 0;
  directAttempts = 0;
  setSessionBackend(backend);
  setDirectTransport({
    isOpen() {
      directAttempts++;
      return false;
    },
  } as unknown as PeerManager);
});
afterEach(() => {
  setDirectTransport(null);
  setSessionBackend(null);
  clearSessions();
  clearPrekeyDirectory();
});

describe("DM X3DH trust boundary", () => {
  for (const [local, remote] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    test(`missing prekeys local=${local} remote=${remote}: no session, queue or transport writes`, async () => {
      const a = peer(1),
        b = peer(2),
        q = queue();
      if (local) material(a);
      if (remote) material(b);
      await expect(sendDirectMessage(a.client, b.client.identityId, "deny", q)).rejects.toThrow(
        "X3DH prekeys are required",
      );
      expect(writes).toBe(0);
      expect(blobs.size).toBe(0);
      expect(directAttempts).toBe(0);
      expect(a.sent).toEqual([]);
      expect(q.items).toEqual([]);
    });
  }

  test("invalid signed prekey still rejects before writes", async () => {
    const a = peer(1),
      b = peer(2),
      q = queue();
    material(a);
    material(b);
    fetchBundle(b.client.identityId)!.signedPrekeySig[0] ^= 1;
    await expect(sendDirectMessage(a.client, b.client.identityId, "deny", q)).rejects.toThrow(
      "x3dh: invalid signed prekey signature",
    );
    expect(writes).toBe(0);
    expect(directAttempts).toBe(0);
    expect(q.items).toEqual([]);
  });

  test("a public observer decrypts historical fallback, but signed legacy receive is denied", () => {
    const a = peer(1),
      b = peer(2);
    material(b);
    receive(b, a);
    const old = legacyMessage(a, b),
      e = envelope(old);
    const observer = initResponder(publicRoot(e.conversationId), crypto);
    expect(codec.decode<{ text: string }>(open(crypto, observer, e.ciphertext, aad(a, b))).text).toBe(
      "public observer control",
    );
    deliver(b, old);
    expect(b.delivered).toEqual([]);
    expect(b.persisted).toEqual([]);
    expect(b.receipts).toEqual([]);
    expect(writes).toBe(0);
    expect(blobs.size).toBe(0);
  });

  test("legacy persisted send/receive sessions are untouched and cannot authorize wire v1", async () => {
    const a = peer(1),
      b = peer(2),
      q = queue();
    receive(b, a);
    const old = legacyMessage(a, b),
      e = envelope(old),
      root = publicRoot(e.conversationId);
    const sendKey = sessionStoreKey(e.conversationId, b.client.identityId);
    const recvKey = sessionStoreKey(e.conversationId, a.client.identityId);
    blobs.set(sendKey, serializeState(initInitiator(root, crypto)));
    blobs.set(recvKey, serializeState(initResponder(root, crypto)));
    getSession(sendKey);
    getSession(recvKey); // Also prime the old in-memory cache.
    const before = [...blobs].map(([key, value]): [string, Uint8Array] => [key, value.slice()]);
    await expect(sendDirectMessage(a.client, b.client.identityId, "deny", q)).rejects.toThrow(
      "X3DH prekeys are required",
    );
    deliver(b, old);
    expect(b.delivered).toEqual([]);
    expect(b.persisted).toEqual([]);
    expect(q.items).toEqual([]);
    expect(writes).toBe(0);
    expect(directAttempts).toBe(0);
    expect([...blobs]).toEqual(before);
    // Rebootstrap is allowed when fresh material is available, without migrating
    // either old record (historical genuine-X3DH records follow the same rule).
    material(a);
    material(b);
    await sendDirectMessage(a.client, b.client.identityId, "fresh");
    expect(envelope(a.sent[0]!).ciphertext[0]).toBe(2);
    deliver(b, a.sent[0]!);
    expect(b.delivered).toEqual(["fresh"]);
    expect(blobs.get(sendKey)).toEqual(before[0]![1]);
    expect(blobs.get(recvKey)).toEqual(before[1]![1]);
  });

  test("historical genuine-X3DH state without provenance also requires rebootstrap", async () => {
    const a = peer(1),
      b = peer(2);
    material(a);
    material(b);
    receive(b, a);
    await sendDirectMessage(a.client, b.client.identityId, "historical first");
    deliver(b, a.sent[0]!);
    await sendDirectMessage(a.client, b.client.identityId, "historical continuation");
    const conversation = envelope(a.sent[0]!).conversationId;
    for (const id of [a.client.identityId, b.client.identityId]) {
      const currentKey = x3dhSessionStoreKey(conversation, id);
      blobs.set(sessionStoreKey(conversation, id), blobs.get(currentKey)!.slice());
      blobs.delete(currentKey);
    }
    reloadSessions();
    clearPrekeyDirectory();
    const before = structuredClone([...blobs]),
      priorWrites = writes;
    await expect(sendDirectMessage(a.client, b.client.identityId, "deny")).rejects.toThrow("X3DH prekeys are required");
    deliver(b, a.sent[1]!);
    expect(b.delivered).toEqual(["historical first"]);
    expect(b.persisted).toHaveLength(1);
    expect(writes).toBe(priorWrites);
    expect([...blobs]).toEqual(before);
  });

  for (const otps of [0, 1]) {
    test(`real X3DH with ${otps} OTP: public-root attack fails; persisted bidirectional continuation needs no prekeys`, async () => {
      const a = peer(1),
        b = peer(2);
      material(a);
      const bobKeys = material(b, otps);
      receive(b, a);
      receive(a, b);
      await sendDirectMessage(a.client, b.client.identityId, "secret first");
      const e = envelope(a.sent[0]!);
      expect(e.ciphertext[0]).toBe(2);
      expect(() =>
        open(crypto, initResponder(publicRoot(e.conversationId), crypto), e.ciphertext.subarray(69), aad(a, b)),
      ).toThrow();
      deliver(b, a.sent[0]!);
      expect(b.delivered).toEqual(["secret first"]);
      expect(bobKeys.oneTime.size).toBe(0);
      expect(getSession(x3dhSessionStoreKey(e.conversationId, a.client.identityId))).toBeDefined();
      clearPrekeyDirectory();
      reloadSessions();
      await sendDirectMessage(a.client, b.client.identityId, "secret second");
      expect(envelope(a.sent[1]!).ciphertext[0]).toBe(1);
      deliver(b, a.sent[1]!);
      expect(b.delivered).toEqual(["secret first", "secret second"]);
      await sendDirectMessage(b.client, a.client.identityId, "reply");
      expect(envelope(b.sent[0]!).ciphertext[0]).toBe(1);
      deliver(a, b.sent[0]!);
      expect(a.delivered).toEqual(["reply"]);
    });
  }

  test("X3DH first message without recipient local material fails without writes", async () => {
    const a = peer(1),
      b = peer(2);
    material(a);
    material(b);
    receive(b, a);
    await sendDirectMessage(a.client, b.client.identityId, "first");
    clearPrekeyDirectory();
    const before = writes;
    deliver(b, a.sent[0]!);
    expect(writes).toBe(before);
    expect(b.persisted).toEqual([]);
    expect(b.delivered).toEqual([]);
  });

  test("signed malformed, unknown-OTP and corrupt X3DH do not consume OTP or install a session", async () => {
    const a = peer(1),
      b = peer(2);
    material(a);
    const local = material(b, 1);
    receive(b, a);
    await sendDirectMessage(a.client, b.client.identityId, "valid after rejected traffic");
    const original = a.sent[0]!,
      before = writes;
    const invalid = [
      resign(a, original, (e) => {
        e.ciphertext = new Uint8Array([2, 1]);
      }),
      resign(a, original, (e) => {
        new DataView(e.ciphertext.buffer, e.ciphertext.byteOffset + 65, 4).setUint32(0, 999);
      }),
      resign(a, original, (e) => {
        e.ciphertext[e.ciphertext.length - 1] ^= 1;
      }),
    ];
    for (const bytes of invalid) {
      deliver(b, bytes);
      expect(writes).toBe(before);
      expect(local.oneTime.size).toBe(1);
      expect(b.persisted).toEqual([]);
      expect(b.receipts).toEqual([]);
    }
    deliver(b, original);
    expect(b.delivered).toEqual(["valid after rejected traffic"]);
    expect(local.oneTime.size).toBe(0);
  });

  test("new-session and continuation queue items carry trusted-local X3DH provenance", async () => {
    const a = peer(1),
      b = peer(2),
      q = queue();
    material(a);
    material(b);
    Object.assign(a.client, { online: false });
    await sendDirectMessage(a.client, b.client.identityId, "queued first", q);
    clearPrekeyDirectory();
    await sendDirectMessage(a.client, b.client.identityId, "queued next", q);
    expect(q.items.map((item) => item.encryptionFormat)).toEqual([DM_X3DH_QUEUE_FORMAT, DM_X3DH_QUEUE_FORMAT]);
    expect(q.items.map((item) => envelope(item.encryptedEnvelope).ciphertext[0])).toEqual([2, 1]);
    expect(a.sent).toEqual([]);
  });
});
