import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cryptoProvider as crypto } from "@nexnet/crypto";
import { cdeEncode, cdeDecode, identityIdFromWallet, issueDeviceCert, signDeliveryReceipt } from "@nexnet/protocol";
import { createPersistentClient, openPersistentClient } from "../persistent-client.js";
import { sendDirectMessage, onDirectMessage } from "../dm.js";
import { clearPrekeyDirectory } from "../prekeys.js";
import { clearSessions } from "../double-ratchet.js";
import { exportBundle } from "../x3dh.js";
import { NexnetClient } from "../client.js";

const scratch = `${import.meta.dir}/../../../../.amp/in/`;
mkdirSync(scratch, { recursive: true });
const dirs: string[] = [];
const clients: NexnetClient[] = [];
afterEach(async () => {
  setSystemTime();
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearPrekeyDirectory();
  clearSessions();
});

function peer() {
  const storagePath = mkdtempSync(`${scratch}persistent-peer-`);
  dirs.push(storagePath);
  const root = crypto.generateSigningKeyPair();
  const device = crypto.generateSigningKeyPair();
  const identityId = identityIdFromWallet(root.publicKey);
  const deviceId = crypto.randomBytes(32);
  const deviceCertificate = issueDeviceCert(
    root.secretKey,
    device.publicKey,
    crypto.randomBytes(32),
    deviceId,
    identityId,
    Date.now() - 1000,
    Date.now() + 11 * 3600_000,
    1,
  );
  const config = {
    storagePath,
    unlockKey: new Uint8Array(32).fill(77),
    crypto,
    codec: { encode: cdeEncode, decode: cdeDecode },
    relayUrl: "http://unused",
  };
  const credentials = {
    identityId,
    deviceId,
    rootPublicKey: root.publicKey,
    deviceSigningSecretKey: device.secretKey,
    deviceSigningPublicKey: device.publicKey,
    deviceCertificate,
  };
  const bootstrap = { ...credentials, rootSecretKey: root.secretKey };
  const client = createPersistentClient(config, bootstrap);
  clients.push(client);
  return { client, config, credentials, root };
}

function reopen(config: Parameters<typeof openPersistentClient>[0]) {
  const client = openPersistentClient(config);
  clients.push(client);
  return client;
}

test("identity, prekeys and renewed certificates recover without root secrets or plaintext fallback", async () => {
  const { client, config, credentials, root } = peer();
  const prekeys = client.persistentState!.prekeys();
  expect(prekeys.oneTime).toBeInstanceOf(Map);
  await client.disconnect();
  expect(() => openPersistentClient(config)).toThrow("already owned");
  const renewed = issueDeviceCert(
    root.secretKey,
    credentials.deviceSigningPublicKey,
    credentials.deviceCertificate.deviceEncryptionPublicKey,
    client.deviceId,
    client.identityId,
    Date.now(),
    Date.now() + 11 * 3600_000,
    1,
  );
  client.setDeviceCredentials(renewed, credentials.deviceSigningSecretKey, credentials.deviceSigningPublicKey);
  await client.close();
  expect(
    () => new NexnetClient({ ...config, ...credentials, signingSecretKey: credentials.deviceSigningSecretKey }),
  ).toThrow("openPersistentClient");
  expect(() => openPersistentClient({ ...config, unlockKey: new Uint8Array(32).fill(78) })).toThrow("Cannot unlock");
  expect(() => Reflect.apply(openPersistentClient, null, [{ ...config, unlockKey: undefined }])).toThrow(
    "32-byte unlock key",
  );
  expect(() => createPersistentClient(config, credentials)).toThrow("Cannot unlock");
  const recovered = reopen(config);
  expect(recovered.identityId).toEqual(credentials.identityId);
  expect(recovered.deviceCertificate).toEqual(renewed);
  expect(recovered.persistentState!.prekeys()).toEqual(prekeys);
  expect(Object.keys(recovered.persistentState!.credentials()).sort()).toEqual(Object.keys(credentials).sort());
});

test("inbox-write failure rolls back ratchet and consumed prekey; identical envelope decrypts after recovery", async () => {
  const alice = peer();
  const bob = peer();
  const id = await sendDirectMessage(alice.client, bob.client.identityId, "recover this exact envelope");
  const item = alice.client.outboundQueue().pendingForRecipient(bob.client.identityId)[0]!;
  const state = bob.client.persistentState!;
  const before = state.prekeys();
  const put = state.store.put.bind(state.store);
  state.store.put = (name, value) => {
    if (name.startsWith("inbox:")) throw new Error("injected inbox write failure");
    put(name, value);
  };
  const errors: unknown[] = [];
  const visible: string[] = [];
  bob.client.on("error", (event) => errors.push(event));
  onDirectMessage(
    bob.client,
    (_envelope, payload) => visible.push(payload.text!),
    () => alice.root.publicKey,
  );
  bob.client.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  expect(errors).toContainEqual({ type: "dm_receive_failed", message: "injected inbox write failure" });
  expect(visible).toEqual([]);
  expect(state.store.keys("ratchet:")).toHaveLength(0);
  expect(state.prekeys()).toEqual(before);
  expect(bob.client.inbox()).toEqual([]);
  state.store.put = put;
  await bob.client.close();
  const recovered = reopen(bob.config);
  onDirectMessage(
    recovered,
    (_envelope, payload) => visible.push(payload.text!),
    () => alice.root.publicKey,
  );
  recovered.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  expect(visible).toEqual(["recover this exact envelope"]);
  expect(recovered.inbox().map((message) => message.envelope.messageId)).toEqual([id]);
  expect(recovered.persistentState!.prekeys().oneTime.size).toBe(before.oneTime.size - 1);
  recovered.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  expect(visible).toHaveLength(1);
});

test("outbox-write failure cannot advance the send ratchet; delivery and receipt v2 survive reopen", async () => {
  const alice = peer();
  const bob = peer();
  const state = alice.client.persistentState!;
  const put = state.store.put.bind(state.store);
  state.store.put = (name, value) => {
    if (name.startsWith("queue:")) throw new Error("injected outbox write failure");
    put(name, value);
  };
  await expect(sendDirectMessage(alice.client, bob.client.identityId, "not committed")).rejects.toThrow(
    "injected outbox",
  );
  expect(state.store.keys("ratchet:")).toHaveLength(0);
  expect(alice.client.outboundQueue().pending()).toHaveLength(0);
  state.store.put = put;
  await alice.client.close();
  const sender = reopen(alice.config);
  const id = await sendDirectMessage(sender, bob.client.identityId, "committed once");
  const proof = signDeliveryReceipt(bob.client.identitySigner(), {
    version: 2,
    senderIdentityId: sender.identityId,
    recipientIdentityId: bob.client.identityId,
    recipientDeviceId: bob.client.deviceId,
    messageId: id,
    storedAt: Date.now(),
  });
  sender.emit("delivery_receipt", { receipt: { ...proof, messageId: Array.from(new Uint8Array(32)) } });
  expect(sender.outboundQueue().pending()).toHaveLength(1);
  setSystemTime(bob.credentials.deviceCertificate.expiresAt + 1);
  sender.emit("delivery_receipt", { receipt: proof });
  expect(sender.outboundQueue().pendingForRecipient(bob.client.identityId)).toHaveLength(1);
  setSystemTime();
  const senderState = sender.persistentState!;
  const write = senderState.store.put.bind(senderState.store);
  senderState.store.put = (name, value) => {
    if (name.startsWith("queue:")) throw new Error("injected delivered-state write failure");
    write(name, value);
  };
  const errors: unknown[] = [];
  sender.on("error", (event) => errors.push(event));
  sender.emit("delivery_receipt", { receipt: proof });
  expect(errors).toContainEqual({
    type: "delivery_receipt_store_failed",
    message: "injected delivered-state write failure",
  });
  expect(senderState.store.keys("receipt:")).toHaveLength(0);
  expect(sender.outboundQueue().pending()).toHaveLength(1);
  senderState.store.put = write;
  sender.emit("delivery_receipt", { receipt: proof });
  expect(sender.outboundQueue().pending()).toHaveLength(0);
  await sender.close();
  setSystemTime(bob.credentials.deviceCertificate.expiresAt + 1);
  const recovered = reopen(alice.config);
  expect(recovered.outboundQueue().pending()).toHaveLength(0);
  expect(
    recovered.persistentState!.read<{ version: number; proof: unknown }>(`receipt:${Buffer.from(id).toString("hex")}`),
  ).toMatchObject({ version: 2, proof });
});

test("application-handler failure cannot erase a stored inbox or turn delivery into execution", async () => {
  const alice = peer();
  const bob = peer();
  const id = await sendDirectMessage(alice.client, bob.client.identityId, "stored before handler");
  const item = alice.client.outboundQueue().pending()[0]!;
  const errors: unknown[] = [];
  bob.client.on("error", (event) => errors.push(event));
  onDirectMessage(
    bob.client,
    () => {
      throw new Error("application failed");
    },
    () => alice.root.publicKey,
  );
  bob.client.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  expect(errors).toContainEqual({ type: "dm_handler_failed", message: "application failed" });
  await bob.client.close();
  const recovered = reopen(bob.config);
  expect(recovered.inbox().map((message) => message.envelope.messageId)).toEqual([id]);
  let calls = 0;
  onDirectMessage(
    recovered,
    () => calls++,
    () => alice.root.publicKey,
  );
  recovered.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  expect(calls).toBe(0);
});

test("separate processes recover both sides of an established ratchet and their durable inboxes", async () => {
  const alice = peer();
  const bob = peer();
  const infoA = {
    identityId: alice.client.identityId,
    rootPublicKey: alice.root.publicKey,
    bundle: exportBundle(alice.client.persistentState!.prekeys(), alice.credentials.deviceSigningPublicKey),
  };
  const infoB = {
    identityId: bob.client.identityId,
    rootPublicKey: bob.root.publicKey,
    bundle: exportBundle(bob.client.persistentState!.prekeys(), bob.credentials.deviceSigningPublicKey),
  };
  await alice.client.close();
  await bob.client.close();
  const fixture = `${import.meta.dir}/fixtures/persistent-peer.ts`;
  async function run(mode: string, directory: string, input: unknown) {
    const path = `${directory}/test-input.cbor`;
    writeFileSync(path, cdeEncode(input));
    const child = Bun.spawn([process.execPath, fixture, mode, directory, path], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`peer failed: ${error}`);
    return JSON.parse(output);
  }
  const first = await run("send", alice.config.storagePath, { ...infoB, text: "first" });
  expect((await run("receive", bob.config.storagePath, { ...infoA, envelope: first.envelope })).messages).toEqual([
    "first",
  ]);
  const reply = await run("send", bob.config.storagePath, { ...infoA, text: "reply" });
  expect((await run("receive", alice.config.storagePath, { ...infoB, envelope: reply.envelope })).messages).toEqual([
    "reply",
  ]);
  const followup = await run("send", alice.config.storagePath, { ...infoB, text: "after both restarted" });
  const received = await run("receive", bob.config.storagePath, { ...infoA, envelope: followup.envelope });
  expect(received.messages.sort()).toEqual(["after both restarted", "first"]);
  const duplicate = await run("receive", bob.config.storagePath, { ...infoA, envelope: first.envelope });
  expect(duplicate.messages.sort()).toEqual(["after both restarted", "first"]);
});
