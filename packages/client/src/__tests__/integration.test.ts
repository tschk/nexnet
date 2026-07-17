import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode, issueDeviceCert } from "@nexnet/protocol";
import { NexnetClient } from "../client.js";
import {
  sendDirectMessage,
  onDirectMessage,
  deriveConversationId,
} from "../dm.js";
import { clearSessions as clearRatchetSessions } from "../double-ratchet.js";
import {
  createGroup,
  sendGroupMessage,
  onGroupMessage,
} from "../groups.js";
import {
  clearGroupSessions,
  initGroupSession,
  createEpoch,
} from "../group-crypto.js";
import {
  deriveRoomId,
  sendRoomMessage,
  startVotekick,
  voteKick,
  isBanned,
  joinRoom,
} from "../rooms.js";
import {
  prepareAttachment,
  AttachmentReceiver,
} from "../attachments.js";
import type { CborCdeCodec, MessagePayload } from "@nexnet/types";

// ── Shared mock WS relay ─────────────────────────────────────────────

type WsHandler = (event: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static autoConnect = true;

  url: string;
  readyState = 0;
  onopen: WsHandler | null = null;
  onclose: WsHandler | null = null;
  onerror: WsHandler | null = null;
  onmessage: WsHandler | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoConnect) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
  }

  send(data: string): void {
    this.sent.push(data);
    relayRoute(this, data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

function identityFromUrl(url: string): string | null {
  const m = url.match(/identity=([0-9a-f]+)/i);
  return m?.[1] ?? null;
}

function relayRoute(sender: MockWebSocket, data: string): void {
  let msg: { type?: string; to?: string; room_id?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  // Point-to-point: dm / group / signalling
  if (msg.to && typeof msg.to === "string") {
    for (const ws of MockWebSocket.instances) {
      if (ws === sender) continue;
      if (identityFromUrl(ws.url) === msg.to) {
        queueMicrotask(() => ws.simulateMessage(data));
      }
    }
    return;
  }

  // Room broadcast
  if (msg.type === "room_event" || msg.type === "room_message") {
    for (const ws of MockWebSocket.instances) {
      if (ws === sender) continue;
      queueMicrotask(() => ws.simulateMessage(data));
    }
  }

  // Group message broadcast (no `to`)
  if (msg.type === "group.message" || msg.type === "group_message") {
    for (const ws of MockWebSocket.instances) {
      if (ws === sender) continue;
      // Normalize to client event type
      const out = { ...msg, type: "group_message", groupId: groupIdHexFromMsg(msg) };
      queueMicrotask(() => ws.simulateMessage(JSON.stringify(out)));
    }
  }
}

function groupIdHexFromMsg(msg: Record<string, unknown>): string | undefined {
  if (typeof msg.groupId === "string") return msg.groupId;
  if (Array.isArray(msg.groupId)) {
    return Buffer.from(msg.groupId as number[]).toString("hex");
  }
  return undefined;
}

const codec: CborCdeCodec = {
  encode: cdeEncode,
  decode: cdeDecode,
};

function makeClient(fill: number, skFill: number): NexnetClient {
  const kp = cryptoProvider.generateSigningKeyPair();
  // deterministic-ish identity from fill for URL matching
  const identityId = new Uint8Array(32).fill(fill);
  return new NexnetClient({
    identityId,
    deviceId: new Uint8Array(32).fill(fill ^ 0xff),
    crypto: cryptoProvider,
    codec,
    relayUrl: "https://relay.example.com",
    storagePath: `/tmp/nexnet-int-${fill}`,
    signingSecretKey: kp.secretKey,
    // stash public on client via prototype field for tests
    ...({} as object),
  });
}

// Attach public keys for verify paths
const pubkeys = new Map<string, Uint8Array>();
const rootKeys = new Map<string, Uint8Array>();

function registerKey(client: NexnetClient, publicKey: Uint8Array): void {
  pubkeys.set(Buffer.from(client.identityId).toString("hex"), publicKey);
}

function deviceCertificate(
  rootSecretKey: Uint8Array,
  identityId: Uint8Array,
  deviceId: Uint8Array,
  devicePublicKey: Uint8Array
) {
  return issueDeviceCert(
    rootSecretKey,
    devicePublicKey,
    devicePublicKey,
    deviceId,
    identityId,
    Date.now(),
    Number.MAX_SAFE_INTEGER,
    1
  );
}

describe("integration", () => {
  let origWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    MockWebSocket.autoConnect = true;
    clearRatchetSessions();
    clearGroupSessions();
    pubkeys.clear();
    rootKeys.clear();
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
  });

  test("two clients exchange encrypted DMs through relay", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();
    const rootA = cryptoProvider.generateSigningKeyPair();
    const rootB = cryptoProvider.generateSigningKeyPair();
    const aliceIdentityId = new Uint8Array(32).fill(0xa1);
    const aliceDeviceId = new Uint8Array(32).fill(0x01);
    const bobIdentityId = new Uint8Array(32).fill(0xb2);
    const bobDeviceId = new Uint8Array(32).fill(0x02);

    const alice = new NexnetClient({
      identityId: aliceIdentityId,
      deviceId: aliceDeviceId,
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-int-a",
      signingSecretKey: kpA.secretKey,
      deviceSigningSecretKey: kpA.secretKey,
      deviceSigningPublicKey: kpA.publicKey,
      deviceCertificate: deviceCertificate(rootA.secretKey, aliceIdentityId, aliceDeviceId, kpA.publicKey),
      rootPublicKey: rootA.publicKey,
    });
    const bob = new NexnetClient({
      identityId: bobIdentityId,
      deviceId: bobDeviceId,
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-int-b",
      signingSecretKey: kpB.secretKey,
      deviceSigningSecretKey: kpB.secretKey,
      deviceSigningPublicKey: kpB.publicKey,
      deviceCertificate: deviceCertificate(rootB.secretKey, bobIdentityId, bobDeviceId, kpB.publicKey),
      rootPublicKey: rootB.publicKey,
    });

    registerKey(alice, kpA.publicKey);
    registerKey(bob, kpB.publicKey);
    rootKeys.set(alice.identityHex, rootA.publicKey);
    rootKeys.set(bob.identityHex, rootB.publicKey);

    await alice.connect();
    await bob.connect();

    const got: MessagePayload[] = [];
    const receipts: Array<{ messageId?: Uint8Array }> = [];
    alice.on("delivery_receipt", (receipt) => {
      receipts.push(receipt as { messageId?: Uint8Array });
    });
    onDirectMessage(
      bob,
      (_env, payload) => {
        got.push(payload);
      },
      (id) => rootKeys.get(Buffer.from(id).toString("hex"))
    );

    const msgId = await sendDirectMessage(alice, bob.identityId, "hello bob");
    expect(msgId.length).toBe(32);

    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe("hello bob");
    expect(bob.hasIncomingMessage(msgId)).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.messageId).toEqual(msgId);

    const aliceSocket = MockWebSocket.instances.find(
      (ws) => identityFromUrl(ws.url) === alice.identityHex
    )!;
    const bobSocket = MockWebSocket.instances.find(
      (ws) => identityFromUrl(ws.url) === bob.identityHex
    )!;
    const duplicate = aliceSocket.sent.find(
      (raw) => JSON.parse(raw).type === "dm"
    )!;
    bobSocket.simulateMessage(duplicate);
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toHaveLength(1);
    expect(receipts).toHaveLength(1);

    // reply
    const gotA: MessagePayload[] = [];
    onDirectMessage(
      alice,
      (_env, payload) => {
        gotA.push(payload);
      },
      (id) => rootKeys.get(Buffer.from(id).toString("hex"))
    );
    await sendDirectMessage(bob, alice.identityId, "hey alice");
    await new Promise((r) => setTimeout(r, 30));
    expect(gotA.length).toBe(1);
    expect(gotA[0]!.text).toBe("hey alice");

    // conversation id symmetric
    const c1 = deriveConversationId(cryptoProvider, alice.identityId, bob.identityId);
    const c2 = deriveConversationId(cryptoProvider, bob.identityId, alice.identityId);
    expect(c1).toEqual(c2);

    await alice.disconnect();
    await bob.disconnect();
  });

  test("DM sending rejects a device certificate not signed by its root", async () => {
    const device = cryptoProvider.generateSigningKeyPair();
    const root = cryptoProvider.generateSigningKeyPair();
    const otherRoot = cryptoProvider.generateSigningKeyPair();
    const identityId = new Uint8Array(32).fill(0xe1);
    const deviceId = new Uint8Array(32).fill(0x1e);
    const client = new NexnetClient({
      identityId,
      deviceId,
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-int-invalid-cert",
      signingSecretKey: device.secretKey,
      deviceSigningSecretKey: device.secretKey,
      deviceSigningPublicKey: device.publicKey,
      deviceCertificate: deviceCertificate(otherRoot.secretKey, identityId, deviceId, device.publicKey),
      rootPublicKey: root.publicKey,
    });

    await expect(
      sendDirectMessage(client, new Uint8Array(32).fill(0xe2), "reject")
    ).rejects.toThrow("Invalid device certificate");
  });

  test("group encryption across members with shared epoch", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();

    const alice = new NexnetClient({
      identityId: new Uint8Array(32).fill(0xc1),
      deviceId: new Uint8Array(32).fill(0x11),
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-g-a",
      signingSecretKey: kpA.secretKey,
    });
    const bob = new NexnetClient({
      identityId: new Uint8Array(32).fill(0xc2),
      deviceId: new Uint8Array(32).fill(0x12),
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-g-b",
      signingSecretKey: kpB.secretKey,
    });
    registerKey(alice, kpA.publicKey);
    registerKey(bob, kpB.publicKey);

    await alice.connect();
    await bob.connect();

    const groupId = await createGroup(alice, "crew", [bob.identityId]);
    // Share same epoch secret (simulates wrap delivery)
    const epoch = createEpoch(cryptoProvider);
    const sessA = initGroupSession(cryptoProvider, groupId, epoch);
    const sessB = initGroupSession(cryptoProvider, groupId, {
      epoch: epoch.epoch,
      secret: new Uint8Array(epoch.secret),
    });
    expect(sessA.secret).toEqual(sessB.secret);

    const received: string[] = [];
    onGroupMessage(
      bob,
      groupId,
      (data) => received.push(data.text),
      (id) => pubkeys.get(Buffer.from(id).toString("hex"))
    );

    await sendGroupMessage(alice, groupId, "group hi");
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toEqual(["group hi"]);

    await alice.disconnect();
    await bob.disconnect();
  });

  test("attachment prepare + receive transfer completes", () => {
    const data = new TextEncoder().encode("file-bytes-123");
    const prepared = prepareAttachment(
      cryptoProvider,
      codec,
      data,
      "note.txt",
      "text/plain"
    );
    expect(prepared.filename).toBe("note.txt");
    expect(prepared.size).toBe(data.length);
    expect(prepared.encryptedBlob.length).toBeGreaterThan(0);

    const receiver = new AttachmentReceiver(cryptoProvider);
    const chunkSize = 8;
    const total = Math.ceil(prepared.encryptedBlob.length / chunkSize);
    let reassembled: Uint8Array | null = null;
    for (let i = 0; i < total; i++) {
      const slice = prepared.encryptedBlob.slice(
        i * chunkSize,
        (i + 1) * chunkSize
      );
      reassembled = receiver.receiveChunk(
        prepared.attachmentId,
        i,
        total,
        slice,
        prepared.contentHash
      );
    }
    expect(reassembled).not.toBeNull();
    const out = receiver.decryptAttachment(reassembled!, prepared.key);
    expect(out).toEqual(data);
  });

  test("room moderation cooldown and votekick", async () => {
    const kp = cryptoProvider.generateSigningKeyPair();
    const client = new NexnetClient({
      identityId: new Uint8Array(32).fill(0xd1),
      deviceId: new Uint8Array(32).fill(0x21),
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nexnet-room",
      signingSecretKey: kp.secretKey,
    });
    await client.connect();

    const roomId = await joinRoom(client, "mod-test");

    // 5 msgs/min allowed
    for (let i = 0; i < 5; i++) {
      const r = await sendRoomMessage(client, roomId, `msg ${i}`);
      expect(r.sent).toBe(true);
    }
    const blocked = await sendRoomMessage(client, roomId, "too many");
    expect(blocked.sent).toBe(false);
    expect(blocked.reason).toMatch(/rate|cooldown|limit/i);

    // Votekick: need 2/3 of "active" — with one voter starting, may not kick yet
    const target = "ee".repeat(32);
    const starter = Buffer.from(client.identityId).toString("hex");
    const roomHex = Buffer.from(roomId).toString("hex");

    const vk = startVotekick(roomHex, target, starter);
    expect(vk.success).toBe(true);

    // Need 3 votes to kick (starter already counted)
    voteKick(roomHex, target, "11".repeat(32));
    const final = voteKick(roomHex, target, "22".repeat(32));
    expect(final.kicked).toBe(true);
    expect(isBanned(roomHex, target)).toBe(true);

    await client.disconnect();
  });
});
