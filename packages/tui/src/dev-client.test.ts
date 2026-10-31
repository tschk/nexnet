import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cryptoProvider, generateKeyPair, generateSigningKeyPair, randomBytes } from "@nexnet/crypto";
import { NexnetClient, onDirectMessage, publishLocalPrekeys, sendDirectMessage } from "@nexnet/client";
import { cdeDecode, cdeEncode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import {
  connectDev,
  disconnectDev,
  generateIdentity,
  renewDeviceCertificateIfNeeded,
  sendDevMessage,
} from "./dev-client";
import { connProblem, connStatus, conversations, identity } from "./state";

// Real relay and presence service, loaded by path so the typecheck stays local.
const RELAY_MODULE = "../../relay-standalone/src/index.ts";
const PRESENCE_MODULE = "../../../workers/presence/src/index.ts";
let relay: { server: { port: number } | null; stop(closeActiveConnections?: boolean): unknown };
let presence: ReturnType<typeof Bun.serve>;
let relayUrl = "";
let createRelay: (() => { listen(options: unknown): typeof relay }) | null = null;
/** When set, presence answers every request with this status (simulates an outage or rejection). */
let presenceFailure: number | null = null;
let presenceUrl = "";

beforeAll(async () => {
  ({ createRelay } = await import(RELAY_MODULE));
  const { default: presenceWorker, PresenceTracker } = await import(PRESENCE_MODULE);
  relay = createRelay!().listen({ port: 0, hostname: "127.0.0.1" });
  const store = new Map<string, unknown>();
  const tracker = new PresenceTracker(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => store.delete(key),
        list: async () => store,
      },
      acceptWebSocket: () => {},
    },
    {},
  );
  const env = {
    PRESENCE: {
      idFromName: () => "global",
      get: () => ({ fetch: (input: RequestInfo, init?: RequestInit) => tracker.fetch(new Request(input, init)) }),
    },
  };
  presence = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      presenceFailure
        ? new Response(JSON.stringify({ error: "missing or invalid identity proof" }), { status: presenceFailure })
        : presenceWorker.fetch(req, env),
  });
  relayUrl = `ws://127.0.0.1:${relay.server!.port}`;
  presenceUrl = `http://127.0.0.1:${presence.port}`;
  generateIdentity();
  await connectDev(relayUrl, presenceUrl);
});

afterEach(() => {
  setSystemTime();
  presenceFailure = null;
});

afterAll(() => {
  disconnectDev();
  relay.stop();
  presence.stop(true);
});

async function peer(certLifetimeMs = 60_000): Promise<NexnetClient> {
  const root = generateSigningKeyPair();
  const device = generateSigningKeyPair();
  const identityId = identityIdFromWallet(root.publicKey);
  const deviceId = randomBytes(32);
  const now = Date.now();
  const client = new NexnetClient({
    identityId,
    deviceId,
    crypto: cryptoProvider,
    codec: { encode: cdeEncode, decode: cdeDecode },
    relayUrl,
    presenceUrl,
    storagePath: mkdtempSync(join(tmpdir(), "nexnet-tui-peer-")),
    signingSecretKey: root.secretKey,
    rootPublicKey: root.publicKey,
    deviceSigningSecretKey: device.secretKey,
    deviceSigningPublicKey: device.publicKey,
    deviceCertificate: issueDeviceCert(
      root.secretKey,
      device.publicKey,
      generateKeyPair().publicKey,
      deviceId,
      identityId,
      now - 1000,
      now + certLifetimeMs,
      1,
    ),
  });
  await client.connect();
  await publishLocalPrekeys(client);
  return client;
}

function messagesWith(peerHex: string) {
  return conversations().find((c) => c.peerHex === peerHex)?.messages ?? [];
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("a DM that cannot be sent is shown as failed, never as delivered", async () => {
  const nobody = "ab".repeat(32); // no published prekeys, never online
  const result = await sendDevMessage(nobody, "anyone there?");
  expect(result.error).toBeTruthy();
  const [shown] = messagesWith(nobody);
  expect(shown).toMatchObject({ text: "anyone there?", delivered: false });
  expect(shown!.error).toBeTruthy();
});

test("an own DM is marked delivered only after the recipient's receipt", async () => {
  const bob = await peer();
  const received: unknown[] = [];
  onDirectMessage(bob, (_envelope, payload) => received.push(payload.text));

  const pending = sendDevMessage(bob.identityHex, "hi bob");
  expect(messagesWith(bob.identityHex)[0]?.delivered).toBe(false);
  await pending;
  await until(() => messagesWith(bob.identityHex)[0]?.delivered === true);
  expect(received).toEqual(["hi bob"]);
  bob.disconnect();
});

test("an offline DM is shown as queued until the returning recipient acknowledges it", async () => {
  const dave = await peer();
  const daveHex = dave.identityHex;
  await dave.disconnect(); // bundle stays published; dave is offline
  const result = await sendDevMessage(daveHex, "you there?");
  expect(result.error).toBeUndefined();
  expect(messagesWith(daveHex)[0]).toMatchObject({ delivered: false, queued: true });
  expect(messagesWith(daveHex)[0]!.error).toBeUndefined();
  const received: string[] = [];
  onDirectMessage(dave, (_envelope, payload) => received.push(payload.text!));
  await dave.connect();
  await until(() => messagesWith(daveHex)[0]?.delivered === true);
  expect(messagesWith(daveHex)[0]).toMatchObject({ delivered: true, queued: false });
  expect(received).toEqual(["you there?"]);
  await dave.disconnect();
});

test("an inbound DM from a peer the TUI has never seen is shown", async () => {
  const carol = await peer();
  await sendDirectMessage(carol, new Uint8Array(Buffer.from(identity()!.publicKeyHex, "hex")), "hello tui");
  await until(() => messagesWith(carol.identityHex).some((m) => m.text === "hello tui" && !m.own));
  carol.disconnect();
});

test("without NEXNET_PRESENCE_URL a failed DM says so instead of a bare failure", async () => {
  disconnectDev();
  generateIdentity();
  await connectDev(relayUrl, "");
  const peerHex = "cd".repeat(32);
  const result = await sendDevMessage(peerHex, "hi");
  expect(result.error).toContain("NEXNET_PRESENCE_URL is not set");
  expect(messagesWith(peerHex)[0]?.error).toContain("NEXNET_PRESENCE_URL is not set");
});

const HOUR = 60 * 60 * 1000;

test("past the device certificate's 11h expiry, DMs and reconnects still work and status is honest", async () => {
  disconnectDev();
  generateIdentity();
  await connectDev(relayUrl, presenceUrl);
  const bob = await peer(48 * HOUR);
  onDirectMessage(bob, () => {});

  setSystemTime(new Date(Date.now() + 12 * HOUR));

  // Sending renews the certificate first instead of failing with an expired one.
  const sent = await sendDevMessage(bob.identityHex, "still here");
  expect(sent.error).toBeUndefined();
  await until(() => messagesWith(bob.identityHex).at(-1)?.delivered === true);

  // Drop the relay: status must stop claiming "connected", then recover with a valid proof.
  const port = relay.server!.port;
  await relay.stop(true);
  await until(() => connStatus() !== "connected");
  expect(connStatus()).toBe("reconnecting");
  relay = createRelay!().listen({ port, hostname: "127.0.0.1" });
  await until(() => connStatus() === "connected", 10_000);
  expect(connProblem()).toBeNull();
  await until(() => bob.online, 10_000);

  const again = await sendDevMessage(bob.identityHex, "after reconnect");
  expect(again.error).toBeUndefined();
  await until(() => messagesWith(bob.identityHex).at(-1)?.delivered === true);
  bob.disconnect();
}, 20_000);

test("a rejected prekey republish during renewal is shown, not swallowed", async () => {
  disconnectDev();
  generateIdentity();
  await connectDev(relayUrl, presenceUrl);
  expect(connProblem()).toBeNull();

  presenceFailure = 401;
  setSystemTime(new Date(Date.now() + 10 * HOUR));
  await renewDeviceCertificateIfNeeded();
  expect(connProblem()).toContain("prekey republish failed");
  expect(connProblem()).toContain("401");
});
