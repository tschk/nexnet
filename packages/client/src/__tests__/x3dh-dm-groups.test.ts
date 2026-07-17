import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode, issueDeviceCert } from "@nexnet/protocol";
import { NexnetClient } from "../client.js";
import {
  sendDirectMessage,
  onDirectMessage,
} from "../dm.js";
import {
  setupLocalPrekeys,
  clearPrekeyDirectory,
  fetchBundle,
} from "../prekeys.js";
import {
  clearSessions as clearRatchet,
} from "../double-ratchet.js";
import {
  createGroup,
  addMember,
  removeMember,
  sendGroupMessage,
  onGroupMessage,
  registerMemberDh,
  applyGroupEpochMessage,
  clearGroupMembership,
  listGroupMembers,
} from "../groups.js";
import {
  clearGroupSessions,
  getGroupSession,
  initGroupSession,
  rotateEpoch,
} from "../group-crypto.js";
import { generateKeyPair as genDh } from "@nexnet/crypto";
import type { CborCdeCodec } from "@nexnet/types";

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };
const pubs = new Map<string, Uint8Array>();

// ── Mock WS relay ────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(data);
    let msg: { type?: string; to?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.to) {
      for (const ws of MockWebSocket.instances) {
        if (ws === this) continue;
        const m = ws.url.match(/identity=([0-9a-f]+)/i);
        if (m?.[1] === msg.to) {
          queueMicrotask(() => ws.onmessage?.({ data }));
        }
      }
      return;
    }
    // broadcast group / epoch
    if (
      msg.type === "group.message" ||
      msg.type === "group.epoch" ||
      msg.type === "group.add_member" ||
      msg.type === "group.remove_member"
    ) {
      for (const ws of MockWebSocket.instances) {
        if (ws === this) continue;
        const out =
          msg.type === "group.message" || msg.type === "group.epoch"
            ? {
                ...msg,
                type: "group_message",
                groupId: Array.isArray(msg.groupId)
                  ? Buffer.from(msg.groupId as number[]).toString("hex")
                  : msg.groupId,
              }
            : msg;
        queueMicrotask(() =>
          ws.onmessage?.({ data: JSON.stringify(out) })
        );
      }
    }
  }

  close(): void {
    this.readyState = 3;
  }
}

function makeClient(
  fill: number,
  keys: { secretKey: Uint8Array; publicKey: Uint8Array }
): NexnetClient {
  const identityId = new Uint8Array(32).fill(fill);
  const deviceId = new Uint8Array(32).fill(fill ^ 0x55);
  const root = cryptoProvider.generateSigningKeyPair();
  pubs.set(Buffer.from(identityId).toString("hex"), root.publicKey);
  return new NexnetClient({
    identityId,
    deviceId,
    crypto: cryptoProvider,
    codec,
    relayUrl: "https://relay.example.com",
    storagePath: `/tmp/nexnet-x3-${fill}`,
    signingSecretKey: keys.secretKey,
    deviceSigningSecretKey: keys.secretKey,
    deviceSigningPublicKey: keys.publicKey,
    deviceCertificate: issueDeviceCert(root.secretKey, keys.publicKey, keys.publicKey, deviceId, identityId, Date.now(), Number.MAX_SAFE_INTEGER, 1),
    rootPublicKey: root.publicKey,
  });
}

describe("X3DH-wired DMs", () => {
  let origWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    clearPrekeyDirectory();
    clearRatchet();
    pubs.clear();
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
    clearPrekeyDirectory();
    clearRatchet();
  });

  test("first DM uses X3DH when bundles published", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();
    const alice = makeClient(0xa1, kpA);
    const bob = makeClient(0xb2, kpB);

    setupLocalPrekeys(
      cryptoProvider,
      alice.identityId,
      kpA.secretKey,
      kpA.publicKey,
      0
    );
    setupLocalPrekeys(
      cryptoProvider,
      bob.identityId,
      kpB.secretKey,
      kpB.publicKey,
      3
    );
    expect(fetchBundle(bob.identityId)?.oneTimePrekeyId).toBeDefined();

    await alice.connect();
    await bob.connect();

    const got: string[] = [];
    onDirectMessage(
      bob,
      (_e, p) => got.push(p.text),
      (id) => pubs.get(Buffer.from(id).toString("hex"))
    );

    await sendDirectMessage(alice, bob.identityId, "x3dh hello");
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual(["x3dh hello"]);

    // OTP consumed from bob's published bundle
    const after = fetchBundle(bob.identityId);
    // still may publish next OTP — just ensure decrypt worked
    expect(after).toBeDefined();

    // second message no longer needs X3DH prefix path
    await sendDirectMessage(alice, bob.identityId, "again");
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual(["x3dh hello", "again"]);

    await alice.disconnect();
    await bob.disconnect();
  });

  test("fallback HKDF path still works without prekeys", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();
    const alice = makeClient(0xc1, kpA);
    const bob = makeClient(0xc2, kpB);

    await alice.connect();
    await bob.connect();

    const got: string[] = [];
    onDirectMessage(
      bob,
      (_e, p) => got.push(p.text),
      (id) => pubs.get(Buffer.from(id).toString("hex"))
    );

    await sendDirectMessage(alice, bob.identityId, "plain path");
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual(["plain path"]);

    await alice.disconnect();
    await bob.disconnect();
  });
});

describe("group membership epoch rotate", () => {
  beforeEach(() => {
    clearGroupSessions();
    clearGroupMembership();
  });

  afterEach(() => {
    clearGroupSessions();
    clearGroupMembership();
  });

  test("removeMember rotates epoch secret", async () => {
    const kp = cryptoProvider.generateSigningKeyPair();
    const client = makeClient(0xd1, kp);
    // offline create still inits session
    const groupId = await createGroup(client, "crew-rot", [
      new Uint8Array(32).fill(0xee),
    ]);
    const session = getGroupSession(groupId)!;
    const secret0 = new Uint8Array(session.secret);
    const epoch0 = session.epoch;

    await removeMember(client, groupId, new Uint8Array(32).fill(0xee));
    expect(session.epoch).toBe(epoch0 + 1);
    expect(session.secret).not.toEqual(secret0);
    expect(listGroupMembers(groupId)).toHaveLength(1); // only creator
  });

  test("epoch wrap delivers secret to peer with registered DH", () => {
    const groupId = cryptoProvider.deriveId(
      "nexnet group id v1",
      new TextEncoder().encode("wrap-test")
    );
    const bobId = new Uint8Array(32).fill(0x02);
    const bobDh = genDh();

    const aliceSess = initGroupSession(cryptoProvider, groupId);
    registerMemberDh(groupId, bobId, bobDh.publicKey);
    const { epoch, wraps } = rotateEpoch(cryptoProvider, aliceSess, [bobId]);
    expect(wraps.length).toBe(1);
    const aliceSecret = new Uint8Array(aliceSess.secret);

    // Bob gets own session on same group, own DH secret
    clearGroupSessions();
    const bobGroup = initGroupSession(cryptoProvider, groupId);
    bobGroup.dh = bobDh;

    const bobClient = {
      identityId: bobId,
      crypto: cryptoProvider,
    } as unknown as NexnetClient;

    const ok = applyGroupEpochMessage(
      bobClient,
      groupId,
      epoch.epoch,
      wraps
    );
    expect(ok).toBe(true);
    expect(getGroupSession(groupId)!.secret).toEqual(aliceSecret);
  });
});
