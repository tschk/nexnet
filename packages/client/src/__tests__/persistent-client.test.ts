import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cryptoProvider as crypto } from "@nexnet/crypto";
import {
  cdeEncode,
  cdeDecode,
  identityIdFromWallet,
  issueDeviceCert,
  signDeliveryReceipt,
  signIdentityAuthJson,
} from "@nexnet/protocol";
import { createPersistentClient, openPersistentClient } from "../persistent-client.js";
import { sendDirectMessage, onDirectMessage } from "../dm.js";
import { clearPrekeyDirectory } from "../prekeys.js";
import { clearSessions } from "../double-ratchet.js";
import { exportBundle } from "../x3dh.js";
import { NexnetClient } from "../client.js";
import { AgentMailbox } from "../agent-mailbox.js";
import type { AgentRequest, AgentEvidence } from "../agent-envelope.js";
import { CapabilityIndex } from "../capability-index.js";

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

test("agent metadata failure rolls back ratchet/outbox and admission together across recovery", async () => {
  const alice = peer(),
    bob = peer();
  const aliceId = Buffer.from(alice.client.identityId).toString("hex"),
    bobId = Buffer.from(bob.client.identityId).toString("hex");
  const a = new AgentMailbox(alice.client, new Set([bobId]));
  const request: AgentRequest = {
    version: 1,
    kind: "request",
    correlationId: "crash",
    capability: "sum",
    acceptBefore: Date.now() + 60_000,
    input: [9, 2],
  };
  const store = alice.client.persistentState!.store;
  const put = store.put.bind(store);
  store.put = (name, value) => {
    if (name.startsWith("agent:v1:out:")) throw new Error("injected request write failure");
    put(name, value);
  };
  await expect(a.submit(bobId, request)).rejects.toThrow("injected request write failure");
  expect(store.keys("ratchet:")).toHaveLength(0);
  expect(store.keys("queue:")).toHaveLength(0);
  store.put = put;
  const sent = await a.submit(bobId, request);
  const item = alice.client.outboundQueue().pending()[0]!;
  onDirectMessage(
    bob.client,
    () => {},
    () => alice.root.publicKey,
  );
  bob.client.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  let b = new AgentMailbox(bob.client, new Set([aliceId]));
  const receiverStore = bob.client.persistentState!.store;
  const write = receiverStore.put.bind(receiverStore);
  receiverStore.put = (name, value) => {
    if (name.startsWith("agent:v1:seen:")) throw new Error("injected observation write failure");
    write(name, value);
  };
  expect(() => b.inbox()).toThrow("injected observation write failure");
  expect(receiverStore.keys("agent:v1:in:")).toHaveLength(0);
  expect(bob.client.inbox()).toHaveLength(1);
  receiverStore.put = write;
  expect(b.inbox()[0]).toMatchObject({ execution: { state: "awaiting_admission" } });
  const snapshot = () => receiverStore.keys("").map((name) => [name, receiverStore.get(name)]);
  const before = snapshot();
  receiverStore.put = (name, value) => {
    if (name.startsWith("agent:v1:in:")) throw new Error("injected admission write failure");
    write(name, value);
  };
  await expect(b.admit(aliceId, request.correlationId)).rejects.toThrow("injected admission write failure");
  expect(snapshot()).toEqual(before);
  receiverStore.put = write;
  await bob.client.close();
  const receiver = reopen(bob.config);
  b = new AgentMailbox(receiver, new Set([aliceId]));
  expect((await b.admit(aliceId, request.correlationId)).kind).toBe("new_admission");
  await receiver.close();
  const again = reopen(bob.config);
  expect((await new AgentMailbox(again, new Set([aliceId])).admit(aliceId, request.correlationId)).kind).toBe(
    "existing_decision",
  );
  expect(a.outgoing(bobId, request.correlationId).transport.messageId).toBe(sent.transport.messageId);
});

test("authenticated sender scopes correlation; conflicting requests/evidence are visible and never overwrite decisions", async () => {
  const alice = peer(),
    bob = peer(),
    charlie = peer();
  const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
  const aId = hex(alice.client.identityId),
    bId = hex(bob.client.identityId),
    cId = hex(charlie.client.identityId);
  const roots = new Map([
    [aId, alice.root.publicKey],
    [bId, bob.root.publicKey],
    [cId, charlie.root.publicKey],
  ]);
  onDirectMessage(
    bob.client,
    () => {},
    (id) => roots.get(hex(id)),
  );
  onDirectMessage(
    alice.client,
    () => {},
    (id) => roots.get(hex(id)),
  );
  const a = new AgentMailbox(alice.client, new Set([bId, cId]));
  const b = new AgentMailbox(bob.client, new Set([aId, cId]));
  const request: AgentRequest = {
    version: 1,
    kind: "request",
    correlationId: "same-id",
    capability: "sum",
    acceptBefore: Date.now() + 60_000,
    input: { x: 8, y: 1 },
  };
  await a.submit(bId, request);
  bob.client.emit("dm", { envelope: Array.from(alice.client.outboundQueue().pending()[0]!.encryptedEnvelope) });
  expect(b.inbox()).toHaveLength(1);
  async function deliver(sender: NexnetClient, receiver: NexnetClient, message: unknown) {
    const id = await sendDirectMessage(sender, receiver.identityId, {
      contentType: "agent",
      text: JSON.stringify(message),
    });
    const item = sender
      .outboundQueue()
      .pending()
      .find((entry) => hex(entry.messageId) === hex(id))!;
    receiver.emit("dm", { envelope: Array.from(item.encryptedEnvelope) });
  }
  await deliver(alice.client, bob.client, { ...request, input: { y: 1, x: 8 } });
  expect(b.inbox()).toHaveLength(1);
  await deliver(alice.client, bob.client, { ...request, input: { x: 1, y: 8 } });
  expect(b.inbox()).toContainEqual(
    expect.objectContaining({ kind: "rejected", peer: aId, code: "correlation_conflict" }),
  );
  await deliver(charlie.client, bob.client, request);
  expect(b.inbox().filter((entry) => entry.kind === "request")).toHaveLength(2);
  const result: AgentEvidence = {
    version: 1,
    kind: "result",
    correlationId: request.correlationId,
    status: "completed",
    value: 9,
  };
  await deliver(charlie.client, alice.client, result);
  expect(a.outgoing(bId, request.correlationId).execution.state).toBe("awaiting_evidence");
  expect(a.inbox()).toContainEqual(
    expect.objectContaining({ kind: "rejected", peer: cId, code: "unknown_correlation" }),
  );
  // Terminal evidence can precede the admission acknowledgement on the transport.
  await deliver(bob.client, alice.client, result);
  await deliver(bob.client, alice.client, {
    version: 1,
    kind: "result",
    correlationId: request.correlationId,
    status: "accepted",
  });
  expect(a.outgoing(bId, request.correlationId).execution).toEqual({ state: "completed", result: 9 });
  await deliver(bob.client, alice.client, { ...result, value: 10 });
  expect(a.outgoing(bId, request.correlationId).execution).toEqual({ state: "completed", result: 9 });
  expect(a.inbox()).toContainEqual(
    expect.objectContaining({ kind: "rejected", peer: bId, code: "conflicting_evidence" }),
  );
});

test("slow preparation crossing admission deadline rolls back acceptance and sends only expiry evidence", async () => {
  const alice = peer(),
    bob = peer();
  const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
  const aId = hex(alice.client.identityId),
    bId = hex(bob.client.identityId);
  const request: AgentRequest = {
    version: 1,
    kind: "request",
    correlationId: "slow",
    capability: "sum",
    acceptBefore: Date.now() + 1000,
    input: 3,
  };
  await new AgentMailbox(alice.client, new Set([bId])).submit(bId, request);
  onDirectMessage(
    bob.client,
    () => {},
    () => alice.root.publicKey,
  );
  bob.client.emit("dm", { envelope: Array.from(alice.client.outboundQueue().pending()[0]!.encryptedEnvelope) });
  const ensure = bob.client.ensureDeviceCertificate.bind(bob.client);
  bob.client.ensureDeviceCertificate = async () => {
    await ensure();
    setSystemTime(request.acceptBefore);
  };
  const decision = await new AgentMailbox(bob.client, new Set([aId])).admit(aId, request.correlationId);
  expect(decision).toMatchObject({
    kind: "existing_decision",
    entry: { execution: { state: "failed", error: { stage: "admission", code: "admission_expired" } } },
  });
  expect(bob.client.outboundQueue().pending()).toHaveLength(1);
});

test("capability claims isolate hostile/malformed advertisements and cached rows, preserve watermarks and expire without resurrection", async () => {
  const alice = peer(),
    bob = peer(),
    charlie = peer();
  const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
  const aId = hex(alice.client.identityId),
    cId = hex(charlie.client.identityId);
  const roots = new Map([
    [aId, alice.root.publicKey],
    [cId, charlie.root.publicKey],
  ]);
  onDirectMessage(
    bob.client,
    () => {},
    (id) => roots.get(hex(id)),
  );
  let index = new CapabilityIndex(bob.client, roots);
  const now = Date.now();
  const fields = {
    version: 1,
    kind: "capability_claims",
    identityId: aId,
    revision: 1,
    issuedAt: now,
    expiresAt: now + 5000,
    capabilities: [{ name: "sum", description: "Claimed sum service" }],
  };
  const signed = signIdentityAuthJson(
    alice.client.identitySigner(),
    "agent.capabilities.v1",
    alice.client.identityId,
    fields,
  );
  async function deliver(value: unknown, sender = alice.client, receiver = bob.client) {
    const id = await sendDirectMessage(sender, receiver.identityId, {
      contentType: "agent_capabilities",
      text: typeof value === "string" ? value : JSON.stringify(value),
    });
    receiver.emit("dm", {
      envelope: Array.from(
        sender
          .outboundQueue()
          .pending()
          .find((item) => hex(item.messageId) === hex(id))!.encryptedEnvelope,
      ),
    });
  }
  await deliver(signed);
  expect(index.search("sum")).toHaveLength(1);
  for (const hostile of [
    "{broken",
    { ...signed, revision: 999 },
    { ...signed, capabilities: [{ name: "evil", description: "" }] },
    signIdentityAuthJson(alice.client.identitySigner(), "wrong-domain", alice.client.identityId, {
      ...fields,
      revision: 99,
    }),
    signIdentityAuthJson(
      { rootPublicKey: alice.root.publicKey, secretKey: alice.root.secretKey },
      "agent.capabilities.v1",
      alice.client.identityId,
      { ...fields, revision: 100 },
    ),
    signIdentityAuthJson(alice.client.identitySigner(), "agent.capabilities.v1", alice.client.identityId, {
      ...fields,
      revision: 101,
      authority: true,
    }),
    signIdentityAuthJson(alice.client.identitySigner(), "agent.capabilities.v1", alice.client.identityId, {
      ...fields,
      revision: 102,
      capabilities: [{ name: "evil", description: "", authority: true }],
    }),
  ]) {
    await deliver(hostile);
    expect(index.search("sum")).toHaveLength(1);
    expect(index.search("sum")[0]!.advertisement.revision).toBe(1);
  }
  await deliver(signed, charlie.client);
  expect(index.search("sum")).toHaveLength(1);
  const store = bob.client.persistentState!.store;
  store.put("inbox:malformed-cbor", new Uint8Array([255]));
  store.put("capabilities:v1:index:malformed", cdeEncode({ garbage: true }));
  await deliver(
    signIdentityAuthJson(charlie.client.identitySigner(), "agent.capabilities.v1", charlie.client.identityId, {
      ...fields,
      identityId: cId,
    }),
    charlie.client,
  );
  expect(index.search("sum")).toHaveLength(2);
  const newer = signIdentityAuthJson(alice.client.identitySigner(), "agent.capabilities.v1", alice.client.identityId, {
    ...fields,
    revision: 2,
    expiresAt: now + 1000,
    capabilities: [{ name: "subtract", description: "Claim" }],
  });
  await deliver(newer);
  expect(index.search("subtract")[0]!.advertisement.revision).toBe(2);
  expect(index.search("sum").map((entry) => entry.advertisement.identityId)).toEqual([cId]);
  await bob.client.close();
  const recovered = reopen(bob.config);
  index = new CapabilityIndex(recovered, roots);
  expect(index.search("subtract")).toHaveLength(1);
  setSystemTime(now + 1001);
  onDirectMessage(
    recovered,
    () => {},
    (id) => roots.get(hex(id)),
  );
  await deliver(signed, alice.client, recovered);
  expect(index.search("subtract")).toEqual([]);
  expect(index.search("sum").map((entry) => entry.advertisement.identityId)).toEqual([cId]);
  expect(index.search()[0]!.evidence).toBe("signed_self_description");
});

test("capability publication counter and immutable outbox roll back together", async () => {
  const alice = peer(),
    bob = peer();
  const bId = Buffer.from(bob.client.identityId).toString("hex");
  const index = new CapabilityIndex(alice.client, new Map([[bId, bob.root.publicKey]]));
  const store = alice.client.persistentState!.store,
    put = store.put.bind(store);
  store.put = (name, value) => {
    if (name === "capabilities:v1:revision") throw new Error("injected revision write failure");
    put(name, value);
  };
  await expect(index.publish(bId, [{ name: "sum", description: "Claim" }], 1000)).rejects.toThrow(
    "injected revision write failure",
  );
  expect(store.keys("queue:")).toHaveLength(0);
  expect(store.keys("ratchet:")).toHaveLength(0);
  store.put = put;
  expect((await index.publish(bId, [{ name: "sum", description: "Claim" }], 1000)).revision).toBe(1);
});
