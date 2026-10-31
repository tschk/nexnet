import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cryptoProvider, generateKeyPair, generateSigningKeyPair, randomBytes } from "@nexnet/crypto";
import { cdeDecode, cdeEncode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import { OutboundQueue } from "@nexnet/storage";
import { NexnetClient } from "../client.js";
import { onDirectMessage, sendDirectMessage } from "../dm.js";
import { publishLocalPrekeys } from "../prekey-network.js";

// Real relay + presence; no mock routing or fake success responses.
const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
const PRESENCE_MODULE = "../../../../workers/presence/src/index.ts";
const scratch = join(import.meta.dir, "../../../../../.amp/in");
mkdirSync(scratch, { recursive: true });
const clients: NexnetClient[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function stack() {
  const { createRelay } = await import(RELAY_MODULE);
  const { default: presenceWorker, PresenceTracker } = await import(PRESENCE_MODULE);
  const relay = createRelay().listen({ port: 0, hostname: "127.0.0.1" });
  cleanups.push(() => relay.stop(true));
  const store = new Map<string, unknown>();
  const tracker = new PresenceTracker(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => store.delete(key),
        list: async () => store,
      },
    },
    {},
  );
  const env = {
    PRESENCE: {
      idFromName: () => "global",
      get: () => ({ fetch: (input: RequestInfo, init?: RequestInit) => tracker.fetch(new Request(input, init)) }),
    },
  };
  const presence = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => presenceWorker.fetch(req, env) });
  cleanups.push(() => presence.stop(true));
  const relayUrl = `http://127.0.0.1:${relay.server!.port}`;
  const presenceUrl = `http://127.0.0.1:${presence.port}`;
  async function peer() {
    const root = generateSigningKeyPair();
    const device = generateSigningKeyPair();
    const identityId = identityIdFromWallet(root.publicKey);
    const deviceId = randomBytes(32);
    const storagePath = mkdtempSync(join(scratch, "offline-dm-"));
    cleanups.push(() => rmSync(storagePath, { force: true, recursive: true }));
    const config = {
      identityId,
      deviceId,
      crypto: cryptoProvider,
      codec: { encode: cdeEncode, decode: cdeDecode },
      relayUrl,
      presenceUrl,
      storagePath,
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
        Date.now() - 1000,
        Date.now() + 3_600_000,
        1,
      ),
    };
    const client = new NexnetClient(config);
    clients.push(client);
    await client.connect();
    await publishLocalPrekeys(client);
    return { client, config };
  }
  return { peer, relayUrl };
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for delivery");
    await Bun.sleep(10);
  }
}

test("a DM to an offline peer stays on the sender, survives reconnect, and delivers when the peer authenticates", async () => {
  const { peer, relayUrl } = await stack();
  const alice = await peer();
  const bob = await peer();
  await bob.client.disconnect();
  await until(
    async () =>
      !((await fetch(`${relayUrl}/online/${bob.client.identityHex}`).then((r) => r.json())) as { online: boolean })
        .online,
  );

  const id = await sendDirectMessage(alice.client, bob.client.identityId, "hold this for bob");
  // This is the externally visible sender-held retry obligation, not a socket write.
  const queue = OutboundQueue.open(join(alice.config.storagePath, "outbound.db"));
  cleanups.push(() => queue.close());
  expect(queue.pendingForRecipient(bob.client.identityId).map((item) => item.messageId)).toEqual([id]);
  await alice.client.disconnect();
  const restarted = new NexnetClient(alice.config);
  clients.push(restarted);
  await restarted.connect();

  const received: string[] = [];
  onDirectMessage(bob.client, (_envelope, payload) => received.push(payload.text!));
  await bob.client.connect();
  // The relay's authenticated online event triggers an immediate sender retry.
  await until(() => received.length === 1);
  expect(received).toEqual(["hold this for bob"]);
  await until(() => queue.pendingForRecipient(bob.client.identityId).length === 0);
});

test("a lost receipt is recovered by acknowledging a duplicate without displaying the DM again", async () => {
  const { peer } = await stack();
  const alice = await peer();
  const bob = await peer();
  const received: string[] = [];
  const receipt = bob.client.sendDeliveryReceipt.bind(bob.client);
  bob.client.sendDeliveryReceipt = () => false; // first receipt is lost
  onDirectMessage(bob.client, (_envelope, payload) => received.push(payload.text!));
  await sendDirectMessage(alice.client, bob.client.identityId, "only once");
  await until(() => received.length === 1);
  const queue = OutboundQueue.open(join(alice.config.storagePath, "outbound.db"));
  cleanups.push(() => queue.close());
  expect(queue.pendingForRecipient(bob.client.identityId)).toHaveLength(1);
  bob.client.sendDeliveryReceipt = receipt;

  await bob.client.disconnect();
  await bob.client.connect(); // triggers retransmit, now acknowledged
  await until(() => queue.pendingForRecipient(bob.client.identityId).length === 0);
  expect(received).toEqual(["only once"]);
});
