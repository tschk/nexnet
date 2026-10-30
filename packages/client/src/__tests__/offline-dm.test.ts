import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cryptoProvider, generateKeyPair, generateSigningKeyPair, randomBytes } from "@nexnet/crypto";
import { cdeDecode, cdeEncode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import { OutboundQueue } from "@nexnet/storage";
import type { DeviceCertificate } from "@nexnet/types";
import { NexnetClient } from "../client.js";
import { onDirectMessage, sendDirectMessage } from "../dm.js";
import { publishLocalPrekeys } from "../prekey-network.js";
import { createPersistentClient, openPersistentClient } from "../persistent-client.js";

// Real relay + presence; no mock routing or fake success responses.
const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
const PRESENCE_MODULE = "../../../../workers/presence/src/index.ts";
const scratch = join(import.meta.dir, "../../../../.amp/in");
mkdirSync(scratch, { recursive: true });
const clients: NexnetClient[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  setSystemTime();
  for (const client of clients.splice(0)) await client.close();
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
  async function peer(renew = false, persistent = false) {
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
      signingSecretKey: renew ? device.secretKey : root.secretKey,
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
      // Stand-in for the later identity daemon: only this callback has root authority.
      ...(renew
        ? {
            renewDeviceCertificate: async (certificate: DeviceCertificate, now: number) =>
              issueDeviceCert(
                root.secretKey,
                certificate.deviceSigningPublicKey,
                certificate.deviceEncryptionPublicKey,
                certificate.deviceId,
                certificate.accountId,
                now,
                now + 11 * 3_600_000,
                certificate.capabilities,
              ),
          }
        : {}),
    };
    const client = persistent
      ? createPersistentClient({ ...config, unlockKey: new Uint8Array(32).fill(77) }, config)
      : new NexnetClient(config);
    clients.push(client);
    await client.connect();
    await publishLocalPrekeys(client);
    return { client, config };
  }
  return { peer, relayUrl };
}

test("persistent clients recover prekeys, offline queue, inbox and verified receipts through the real relay", async () => {
  const { peer } = await stack();
  const alice = await peer(true, true);
  const bob = await peer(true, true);
  const originalPrekeys = bob.client.persistentState!.prekeys();
  await bob.client.close();
  const id = await sendDirectMessage(alice.client, bob.client.identityId, "recover end to end");
  await alice.client.close();
  const sender = openPersistentClient({ ...alice.config, unlockKey: new Uint8Array(32).fill(77) });
  const receiver = openPersistentClient({ ...bob.config, unlockKey: new Uint8Array(32).fill(77) });
  clients.push(sender, receiver);
  expect(receiver.persistentState!.prekeys()).toEqual(originalPrekeys);
  const visible: string[] = [];
  onDirectMessage(receiver, (_envelope, payload) => visible.push(payload.text!));
  await sender.connect();
  await receiver.connect();
  await until(() => receiver.inbox().length === 1);
  await until(() => sender.outboundQueue().pendingForRecipient(receiver.identityId).length === 0);
  expect(visible).toEqual(["recover end to end"]);
  await sender.close();
  await receiver.close();
  const recoveredSender = openPersistentClient({ ...alice.config, unlockKey: new Uint8Array(32).fill(77) });
  const recoveredReceiver = openPersistentClient({ ...bob.config, unlockKey: new Uint8Array(32).fill(77) });
  clients.push(recoveredSender, recoveredReceiver);
  expect(recoveredSender.outboundQueue().pending()).toHaveLength(0);
  expect(recoveredReceiver.inbox().map((message) => message.envelope.messageId)).toEqual([id]);
});

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("timed out waiting for delivery");
    await Bun.sleep(10);
  }
}

test("device-only clients renew, receive and clear the queue only after a verified device receipt", async () => {
  const { peer } = await stack();
  const alice = await peer(true);
  await alice.client.disconnect();
  const originalExpiry = alice.client.deviceCertificate!.expiresAt;
  setSystemTime(new Date(originalExpiry + 1000));
  // No TUI adapter and no principal root secret in the client configuration.
  await alice.client.connect();
  expect(alice.client.online).toBe(true);
  expect(alice.client.deviceCertificate!.expiresAt).toBeGreaterThan(originalExpiry);
  const bob = await peer(true);
  const received: string[] = [];
  const receipt = bob.client.sendDeliveryReceipt.bind(bob.client);
  bob.client.sendDeliveryReceipt = () => false;
  onDirectMessage(bob.client, (_envelope, payload) => received.push(payload.text!));
  const messageId = await sendDirectMessage(alice.client, bob.client.identityId, "headless after expiry");
  await until(() => received.length === 1);
  expect(received).toEqual(["headless after expiry"]);
  const queue = alice.client.outboundQueue();
  const verified: unknown[] = [];
  alice.client.on("verified_delivery_receipt", (event) => verified.push(event));
  const unverified = Promise.withResolvers<void>();
  alice.client.on("delivery_receipt", () => unverified.resolve());
  bob.client.sendWs({
    type: "delivery_receipt",
    to: alice.client.identityHex,
    receipt: {
      messageId: Array.from(messageId),
      recipientDeviceId: Array.from(bob.client.deviceId),
      storedAt: Date.now(),
      signature: Array.from(new Uint8Array(64)),
    },
  });
  await unverified.promise;
  expect(queue.pendingForRecipient(bob.client.identityId)).toHaveLength(1);
  expect(verified).toHaveLength(0);
  expect(receipt(alice.client.identityHex, messageId)).toBe(true);
  await until(() => queue.pendingForRecipient(bob.client.identityId).length === 0);
  expect(verified).toHaveLength(1);
});

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
