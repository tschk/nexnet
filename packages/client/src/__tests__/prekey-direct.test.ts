import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import { NexnetClient } from "../client.js";
import { setupLocalPrekeys, clearPrekeyDirectory, fetchBundle, getLocalPrekeys } from "../prekeys.js";
import {
  publishBundleRemote,
  fetchBundleRemote,
  bundleToNetwork,
  bundleFromNetwork,
  publishLocalPrekeys,
} from "../prekey-network.js";
import { setDirectTransport, trySendDirect } from "../transport.js";
import { sendDirectMessage, onDirectMessage } from "../dm.js";
import { clearSessions } from "../double-ratchet.js";
import type { PeerManager } from "../webrtc.js";
import type { CborCdeCodec } from "@nexnet/types";

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };

describe("prekey network helpers", () => {
  beforeEach(() => clearPrekeyDirectory());
  afterEach(() => clearPrekeyDirectory());

  test("bundleToNetwork/fromNetwork roundtrip", () => {
    const kp = cryptoProvider.generateSigningKeyPair();
    const id = new Uint8Array(32).fill(1);
    const mat = setupLocalPrekeys(cryptoProvider, id, kp.secretKey, kp.publicKey, 2);
    const bundle = {
      identityDhPublic: mat.identityDh.publicKey,
      signedPrekeyPublic: mat.signedPrekey.publicKey,
      signedPrekeySig: mat.signedPrekeySig,
      identitySignPublic: kp.publicKey,
      oneTimePrekeyPublic: mat.oneTime.get(1)!.publicKey,
      oneTimePrekeyId: 1,
    };
    const net = bundleToNetwork(id, bundle);
    const back = bundleFromNetwork(net);
    expect(back.identityDhPublic).toEqual(bundle.identityDhPublic);
    expect(back.signedPrekeyPublic).toEqual(bundle.signedPrekeyPublic);
    expect(back.oneTimePrekeyId).toBe(1);
  });

  test("publishBundleRemote + fetchBundleRemote via mock fetch", async () => {
    const store = new Map<string, string>();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/prekeys/publish") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { identityId: string };
        store.set(body.identityId, String(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const m = url.match(/\/prekeys\/([0-9a-f]+)$/i);
      if (m && (!init || !init.method || init.method === "GET")) {
        const raw = store.get(m[1]!);
        if (!raw) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(raw, { status: 200 });
      }
      return new Response("no", { status: 404 });
    };

    const kp = cryptoProvider.generateSigningKeyPair();
    const id = identityIdFromWallet(kp.publicKey);
    const signer = { rootPublicKey: kp.publicKey, secretKey: kp.secretKey };
    const mat = setupLocalPrekeys(cryptoProvider, id, kp.secretKey, kp.publicKey, 1);
    const bundle = {
      identityDhPublic: mat.identityDh.publicKey,
      signedPrekeyPublic: mat.signedPrekey.publicKey,
      signedPrekeySig: mat.signedPrekeySig,
      identitySignPublic: kp.publicKey,
      oneTimePrekeyPublic: mat.oneTime.get(1)!.publicKey,
      oneTimePrekeyId: 1,
    };

    await publishBundleRemote("https://presence.example", id, bundle, signer, fetchImpl as typeof fetch);

    clearPrekeyDirectory();
    // re-setup empty local — fetch should re-cache
    const peer = id;
    const got = await fetchBundleRemote("https://presence.example", peer, fetchImpl as typeof fetch);
    expect(got).not.toBeNull();
    expect(got!.signedPrekeyPublic).toEqual(bundle.signedPrekeyPublic);
    // cached locally
    expect(fetchBundle(peer)?.oneTimePrekeyId).toBe(1);
  });

  test("fetchBundleRemote rejects a bundle the presence server swapped", async () => {
    const victim = cryptoProvider.generateSigningKeyPair();
    const victimId = identityIdFromWallet(victim.publicKey);
    const attacker = cryptoProvider.generateSigningKeyPair();
    const attackerId = identityIdFromWallet(attacker.publicKey);
    const mat = setupLocalPrekeys(cryptoProvider, attackerId, attacker.secretKey, attacker.publicKey, 0);
    const attackerBundle = {
      identityDhPublic: mat.identityDh.publicKey,
      signedPrekeyPublic: mat.signedPrekey.publicKey,
      signedPrekeySig: mat.signedPrekeySig,
      identitySignPublic: attacker.publicKey,
    };
    let published = "";
    const capture = async (_input: RequestInfo | URL, init?: RequestInit) => {
      published = String(init?.body);
      return new Response("{}", { status: 200 });
    };
    await publishBundleRemote(
      "https://presence.example",
      attackerId,
      attackerBundle,
      { rootPublicKey: attacker.publicKey, secretKey: attacker.secretKey },
      capture as typeof fetch,
    );
    clearPrekeyDirectory();

    // Served under the victim's id: relabelled, and with no proof at all.
    const relabelled = { ...JSON.parse(published), identityId: Buffer.from(victimId).toString("hex") };
    const { auth: _auth, ...unsigned } = relabelled;
    for (const body of [relabelled, unsigned]) {
      const serve = async () => new Response(JSON.stringify(body), { status: 200 });
      await expect(
        fetchBundleRemote("https://presence.example", victimId, serve as unknown as typeof fetch),
      ).rejects.toThrow();
      expect(fetchBundle(victimId)).toBeUndefined();
    }
  });
});

test("publishLocalPrekeys keeps the current keys when presence rejects the new bundle", async () => {
  clearPrekeyDirectory();
  const root = cryptoProvider.generateSigningKeyPair();
  const id = identityIdFromWallet(root.publicKey);
  const client = new NexnetClient({
    identityId: id,
    deviceId: new Uint8Array(32).fill(1),
    crypto: cryptoProvider,
    codec,
    relayUrl: "ws://relay.example",
    presenceUrl: "https://presence.example",
    storagePath: "",
    signingSecretKey: root.secretKey,
    rootPublicKey: root.publicKey,
  });
  const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  await publishLocalPrekeys(client, 1, ok);
  const before = getLocalPrekeys(id);
  await expect(publishLocalPrekeys(client, 1, down)).rejects.toThrow("503");
  expect(getLocalPrekeys(id)).toBe(before!);
  expect(fetchBundle(id)?.signedPrekeyPublic).toEqual(before!.signedPrekey.publicKey);
  clearPrekeyDirectory();
});

describe("direct transport DM path", () => {
  beforeEach(() => {
    clearSessions();
    clearPrekeyDirectory();
    setDirectTransport(null);
  });
  afterEach(() => {
    setDirectTransport(null);
    clearPrekeyDirectory();
    clearSessions();
  });

  test("trySendDirect uses open PeerManager", () => {
    const sent: Uint8Array[] = [];
    const pm = {
      isOpen: (hex: string) => hex === "aa",
      send: (_hex: string, data: Uint8Array) => {
        sent.push(data);
        return true;
      },
    } as unknown as PeerManager;
    setDirectTransport(pm);
    expect(trySendDirect("aa", new Uint8Array([1, 2]))).toBe(true);
    expect(trySendDirect("bb", new Uint8Array([3]))).toBe(false);
    expect(sent[0]).toEqual(new Uint8Array([1, 2]));
  });

  test("sendDirectMessage prefers direct over relay", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();
    const rootA = cryptoProvider.generateSigningKeyPair();
    const rootB = cryptoProvider.generateSigningKeyPair();
    const aliceId = new Uint8Array(32).fill(0xa1);
    const aliceDeviceId = new Uint8Array(32).fill(1);
    const alice = new NexnetClient({
      identityId: aliceId,
      deviceId: aliceDeviceId,
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/d-a",
      signingSecretKey: kpA.secretKey,
      deviceSigningSecretKey: kpA.secretKey,
      deviceSigningPublicKey: kpA.publicKey,
      deviceCertificate: issueDeviceCert(
        rootA.secretKey,
        kpA.publicKey,
        kpA.publicKey,
        aliceDeviceId,
        aliceId,
        Date.now(),
        Number.MAX_SAFE_INTEGER,
        1,
      ),
      rootPublicKey: rootA.publicKey,
    });
    const bobId = new Uint8Array(32).fill(0xb2);
    const bobHex = Buffer.from(bobId).toString("hex");
    setupLocalPrekeys(cryptoProvider, aliceId, kpA.secretKey, kpA.publicKey, 0);
    setupLocalPrekeys(cryptoProvider, bobId, kpB.secretKey, kpB.publicKey, 0);

    const directSent: Uint8Array[] = [];
    setDirectTransport({
      isOpen: (h: string) => h === bobHex,
      send: (_h: string, data: Uint8Array) => {
        directSent.push(new Uint8Array(data));
        return true;
      },
    } as unknown as PeerManager);

    // offline client — would fail without direct
    expect(alice.online).toBe(false);
    const mid = await sendDirectMessage(alice, bobId, "via p2p");
    expect(mid.length).toBe(32);
    expect(directSent.length).toBe(1);

    // Bob-side decrypt via onDirectMessage emit simulation
    const bob = new NexnetClient({
      identityId: bobId,
      deviceId: new Uint8Array(32).fill(2),
      crypto: cryptoProvider,
      codec,
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/d-b",
      signingSecretKey: kpB.secretKey,
      deviceSigningSecretKey: kpB.secretKey,
      deviceSigningPublicKey: kpB.publicKey,
      deviceCertificate: issueDeviceCert(
        rootB.secretKey,
        kpB.publicKey,
        kpB.publicKey,
        new Uint8Array(32).fill(2),
        bobId,
        Date.now(),
        Number.MAX_SAFE_INTEGER,
        1,
      ),
      rootPublicKey: rootB.publicKey,
    });
    const pubs = new Map([[Buffer.from(alice.identityId).toString("hex"), rootA.publicKey]]);
    const got: string[] = [];
    onDirectMessage(
      bob,
      (_e, p) => got.push(p.text),
      (id) => pubs.get(Buffer.from(id).toString("hex")),
    );
    bob.emit("dm", { envelope: Array.from(directSent[0]!) });
    expect(got).toEqual(["via p2p"]);
  });
});
