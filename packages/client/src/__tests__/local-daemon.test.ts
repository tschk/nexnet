import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cryptoProvider as crypto } from "@nexnet/crypto";
import {
  cdeEncode,
  cdeDecode,
  identityIdFromWallet,
  issueDeviceCert,
  signIdentityAuthJson,
  toHex,
} from "@nexnet/protocol";
import { createPersistentClient, openPersistentClient } from "../persistent-client.js";
import { readOsSecret32, startLocalDaemon } from "../local-daemon.js";
import { LocalNexnet } from "../local-sdk.js";
import { clearPrekeyDirectory, fetchBundle, unpublishBundle } from "../prekeys.js";
import { bundleToNetwork, fetchBundleRemote } from "../prekey-network.js";
import { sendDirectMessage } from "../dm.js";

const scratch = `${import.meta.dir}/../../../../.amp/in/`;
mkdirSync(scratch, { recursive: true });
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  setSystemTime();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  clearPrekeyDirectory();
});

async function setup() {
  const relayModule = "../../../relay-standalone/src/index.ts";
  const { createRelay } = await import(relayModule);
  const relay = createRelay().listen({ port: 0, hostname: "127.0.0.1" });
  cleanups.push(() => (relay.server ? relay.stop(true) : undefined));
  const relayUrl = `http://127.0.0.1:${relay.server!.port}`;
  async function peer() {
    const directory = mkdtempSync(`${scratch}local-daemon-`);
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const root = crypto.generateSigningKeyPair();
    const device = crypto.generateSigningKeyPair();
    const identityId = identityIdFromWallet(root.publicKey);
    const deviceId = crypto.randomBytes(32);
    const credentials = {
      identityId,
      deviceId,
      rootPublicKey: root.publicKey,
      deviceSigningSecretKey: device.secretKey,
      deviceSigningPublicKey: device.publicKey,
      deviceCertificate: issueDeviceCert(
        root.secretKey,
        device.publicKey,
        crypto.randomBytes(32),
        deviceId,
        identityId,
        Date.now() - 1000,
        Date.now() + 11 * 3600_000,
        1,
      ),
    };
    const config = {
      storagePath: directory,
      unlockKey: crypto.randomBytes(32),
      crypto,
      codec: { encode: cdeEncode, decode: cdeDecode },
      relayUrl: relayUrl.replace(/^http/, "ws"),
      renewDeviceCertificate: async (previous: typeof credentials.deviceCertificate, now: number) =>
        issueDeviceCert(
          root.secretKey,
          previous.deviceSigningPublicKey,
          previous.deviceEncryptionPublicKey,
          deviceId,
          identityId,
          now,
          now + 11 * 3600_000,
          previous.capabilities,
        ),
    };
    const initial = createPersistentClient(config, credentials);
    await initial.close();
    const token = toHex(crypto.randomBytes(32));
    return {
      config,
      id: toHex(identityId),
      root: root.publicKey,
      token,
      async start(roots: Uint8Array[]) {
        const options = {
          loadDevice: async () => ({ mode: "open" as const, config }),
          loadControlToken: async () => token,
          trustedPeerRoots: roots,
        };
        const daemon = await startLocalDaemon(options);
        cleanups.push(() => daemon.close());
        return { ...daemon, sdk: new LocalNexnet(daemon.url, token), options };
      },
    };
  }
  return { peer, relay };
}

async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for daemon transport");
    await Bun.sleep(10);
  }
}

test("local SDK sends through real relay, distinguishes queued/delivered and recovers inbox and receipts", async () => {
  const { peer, relay } = await setup();
  const alice = await peer();
  const bob = await peer();
  let a = await alice.start([bob.root]);
  expect((await a.sdk.status()).identityId).toBe(alice.id);
  expect(await a.sdk.presence(bob.id)).toEqual({ peer: bob.id, online: false });
  const sent = await a.sdk.send(bob.id, "durable local control");
  expect(sent.state).toBe("queued");
  expect((await a.sdk.delivery(sent.messageId)).state).toBe("queued");
  await a.close();
  const b = await bob.start([alice.root]);
  a = await alice.start([bob.root]);
  await until(async () => (await a.sdk.delivery(sent.messageId)).state === "delivered");
  expect(await b.sdk.inbox()).toEqual([
    { messageId: sent.messageId, peer: alice.id, text: "durable local control", createdAt: expect.any(Number) },
  ]);
  expect(await a.sdk.presence(bob.id)).toEqual({ peer: bob.id, online: true });
  await b.close();
  const restarted = await bob.start([alice.root]);
  expect((await restarted.sdk.inbox()).map((item) => item.messageId)).toEqual([sent.messageId]);
  // This separate SDK process receives only URL/token, never device/unlock/root keys.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { LocalNexnet } from './packages/client/src/local-sdk.ts'; const config = await Bun.stdin.json(); console.log(JSON.stringify(await new LocalNexnet(config.url, config.token).inbox()));`,
    ],
    { cwd: `${import.meta.dir}/../../../..`, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(JSON.stringify({ url: restarted.url, token: bob.token }));
  child.stdin.end();
  const output = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  expect(output).toEqual(await restarted.sdk.inbox());
  await relay.stop(true);
  expect(await a.sdk.presence(bob.id)).toEqual({ peer: bob.id, online: null });
});

test("authentication, origin/host checks, peer policy and strict message input guard the local API", async () => {
  const { peer } = await setup();
  const alice = await peer();
  const bob = await peer();
  const daemon = await alice.start([bob.root]);
  const auth = { authorization: `Bearer ${alice.token}` };
  expect((await fetch(`${daemon.url}/v1/status`)).status).toBe(401);
  expect((await fetch(`${daemon.url}/v1/status?token=${alice.token}`)).status).toBe(401);
  await expect(new LocalNexnet(daemon.url, "0".repeat(64)).status()).rejects.toMatchObject({
    code: "unauthorized",
    status: 401,
  });
  expect((await fetch(`${daemon.url}/v1/status`, { headers: { ...auth, origin: "http://evil.invalid" } })).status).toBe(
    403,
  );
  expect((await fetch(`${daemon.url}/v1/status`, { headers: { ...auth, host: "evil.invalid" } })).status).toBe(403);
  await expect(daemon.sdk.send("1".repeat(64), "blocked")).rejects.toMatchObject({
    code: "peer_not_allowed",
    status: 403,
  });
  await expect(daemon.sdk.presence("1".repeat(64))).rejects.toMatchObject({ code: "peer_not_allowed", status: 403 });
  for (const body of [
    { peer: bob.id, text: "x", rootSecretKey: "no" },
    { peer: bob.id, text: "" },
    { peer: bob.id, text: "😃".repeat(1025) },
  ]) {
    const response = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  expect((await fetch(`${daemon.url}/v1/status`, { headers: auth })).headers.get("cache-control")).toBe("no-store");
  expect((await daemon.sdk.status()).transportError).toBe(false);
  unpublishBundle(Buffer.from(bob.id, "hex"));
  await expect(daemon.sdk.send(bob.id, "no prekeys available")).rejects.toMatchObject({
    code: "transport_failed",
    status: 503,
  });
  expect((await daemon.sdk.status()).transportError).toBe(true);
  await expect(startLocalDaemon(daemon.options)).rejects.toThrow("already owned");
  await daemon.close();
  await expect(
    startLocalDaemon({ ...daemon.options, loadControlToken: async () => toHex(alice.config.unlockKey) }),
  ).rejects.toThrow("must not reuse");
});

test("a cryptographically valid non-allowlisted sender is not stored or acknowledged", async () => {
  const { peer } = await setup();
  const alice = await peer();
  const bob = await peer();
  const outsider = await peer();
  const daemon = await alice.start([bob.root]);
  const attacker = openPersistentClient(outsider.config);
  cleanups.push(() => attacker.close());
  // A previously learned identity remains cryptographically valid after policy excludes it.
  const signed = signIdentityAuthJson(attacker.identitySigner(), "prekeys.publish", attacker.identityId, {
    ...bundleToNetwork(attacker.identityId, fetchBundle(attacker.identityId)!),
    issuedAt: Date.now(),
  });
  const directory = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(signed) });
  cleanups.push(() => directory.stop(true));
  await fetchBundleRemote(`http://127.0.0.1:${directory.port}`, attacker.identityId);
  await attacker.connect();
  const envelope = await sendDirectMessage(attacker, Buffer.from(alice.id, "hex"), "valid signature, forbidden peer");
  const following = await bob.start([alice.root]);
  const legitimate = await following.sdk.send(alice.id, "allowed control");
  await until(async () => (await following.sdk.delivery(legitimate.messageId)).state === "delivered");
  expect((await daemon.sdk.inbox()).map((item) => item.text)).toEqual(["allowed control"]);
  expect(
    attacker
      .outboundQueue()
      .pendingForRecipient(Buffer.from(alice.id, "hex"))
      .map((item) => toHex(item.messageId)),
  ).toContain(toHex(envelope));
  await daemon.close();
  const recovered = openPersistentClient(alice.config);
  cleanups.push(() => recovered.close());
  expect(recovered.inbox().map((item) => item.payload.text)).toEqual(["allowed control"]);
});

test("narrowing an allowlist cannot replay a backoff-delayed stored outbox obligation", async () => {
  const { peer } = await setup();
  const alice = await peer();
  const bob = await peer();
  const daemon = await alice.start([bob.root]);
  const sent = await daemon.sdk.send(bob.id, "pending before narrowing");
  await daemon.close();
  const previous = openPersistentClient(alice.config);
  cleanups.push(() => previous.close());
  previous.outboundQueue().markAttempt(Buffer.from(sent.messageId, "hex"));
  expect(previous.outboundQueue().pending()).toHaveLength(0);
  await previous.close();
  await expect(alice.start([])).rejects.toThrow("outside the trusted allowlist");
  const reopened = openPersistentClient(alice.config);
  cleanups.push(() => reopened.close());
  expect(
    reopened
      .outboundQueue()
      .pendingForRecipient(Buffer.from(bob.id, "hex"))
      .map((item) => toHex(item.messageId)),
  ).toEqual([sent.messageId]);
});

test("shutdown drains an in-flight send before releasing single-writer ownership", async () => {
  const { peer } = await setup();
  const alice = await peer();
  const bob = await peer();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const renew = alice.config.renewDeviceCertificate;
  alice.config.renewDeviceCertificate = async (certificate, now) => {
    entered.resolve();
    await gate.promise;
    return renew(certificate, now);
  };
  const daemon = await alice.start([bob.root]);
  try {
    setSystemTime(Date.now() + 10 * 3600_000);
    const send = daemon.sdk.send(bob.id, "finish before releasing ownership");
    await entered.promise;
    const close = daemon.close();
    expect(() => openPersistentClient(alice.config)).toThrow("already owned");
    gate.resolve();
    const result = await send;
    await close;
    const recovered = openPersistentClient(alice.config);
    cleanups.push(() => recovered.close());
    expect(
      recovered
        .outboundQueue()
        .pendingForRecipient(Buffer.from(bob.id, "hex"))
        .map((item) => toHex(item.messageId)),
    ).toEqual([result.messageId]);
  } finally {
    gate.resolve();
    setSystemTime();
  }
});

test("SDK refuses nonlocal URLs, redirects and execution states masquerading as delivery", async () => {
  const token = "a".repeat(64);
  for (const url of [
    "http://example.com:1234",
    "http://localhost:1234",
    "https://127.0.0.1:1234",
    "http://127.0.0.1:1234/?token=secret",
  ])
    expect(() => new LocalNexnet(url, token)).toThrow();
  let requests = 0;
  const destination = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      requests++;
      return Response.json({});
    },
  });
  cleanups.push(() => destination.stop(true));
  const redirect = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}`),
  });
  cleanups.push(() => redirect.stop(true));
  await expect(new LocalNexnet(`http://127.0.0.1:${redirect.port}`, token).status()).rejects.toThrow();
  expect(requests).toBe(0);
  const invalid = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ version: 1, data: { messageId: "b".repeat(64), state: "completed" } }),
  });
  cleanups.push(() => invalid.stop(true));
  await expect(new LocalNexnet(`http://127.0.0.1:${invalid.port}`, token).delivery("b".repeat(64))).rejects.toThrow(
    "Invalid local daemon response",
  );
});

test("native OS secret reader rejects missing, malformed and unavailable secrets without fallback", async () => {
  const reader = spyOn(Bun.secrets, "get").mockResolvedValue("ab".repeat(32));
  try {
    expect(await readOsSecret32({ service: "nexnet-test", name: "unlock" })).toEqual(new Uint8Array(32).fill(171));
    for (const value of [null, "", "not-a-key", "ab".repeat(31)]) {
      reader.mockResolvedValue(value);
      await expect(readOsSecret32({ service: "nexnet-test", name: "unlock" })).rejects.toThrow("OS secret is missing");
    }
    reader.mockRejectedValue(new Error("OS secret service unavailable"));
    await expect(readOsSecret32({ service: "nexnet-test", name: "unlock" })).rejects.toThrow(
      "OS secret service unavailable",
    );
  } finally {
    reader.mockRestore();
  }
});

test("agent delivery is not admission; concurrent replay and restart cannot re-admit, and late evidence completes", async () => {
  const { peer } = await setup();
  const alice = await peer(),
    bob = await peer();
  let a = await alice.start([bob.root]),
    b = await bob.start([alice.root]);
  const request = {
    version: 1,
    kind: "request",
    correlationId: "late-1",
    capability: "sum",
    acceptBefore: Date.now() + 60_000,
    input: { a: 8, b: 3 },
  } as const;
  const sent = await Promise.all([a.sdk.submit(bob.id, request), a.sdk.submit(bob.id, request)]);
  expect(sent[0]!.transport.messageId).toBe(sent[1]!.transport.messageId);
  await until(async () => (await a.sdk.execution(bob.id, request.correlationId)).transport.state === "delivered");
  expect((await a.sdk.execution(bob.id, request.correlationId)).execution).toEqual({ state: "awaiting_evidence" });
  expect((await b.sdk.agentInbox()).filter((entry) => entry.kind === "request")).toHaveLength(1);
  await expect(a.sdk.submit(bob.id, { ...request, input: { a: 3, b: 8 } })).rejects.toMatchObject({
    code: "correlation_conflict",
    status: 409,
  });
  await expect(
    b.sdk.respond(alice.id, {
      version: 1,
      kind: "result",
      correlationId: request.correlationId,
      status: "completed",
      value: 11,
    }),
  ).rejects.toMatchObject({ code: "not_accepted" });
  const admissions = await Promise.all([
    b.sdk.admit(alice.id, request.correlationId),
    b.sdk.admit(alice.id, request.correlationId),
  ]);
  expect(admissions.map((entry) => entry.kind).sort()).toEqual(["existing_decision", "new_admission"]);
  await until(async () => (await a.sdk.execution(bob.id, request.correlationId)).execution.state === "accepted");
  await a.close();
  await b.close();
  a = await alice.start([bob.root]);
  b = await bob.start([alice.root]);
  setSystemTime(request.acceptBefore + 1);
  expect((await b.sdk.admit(alice.id, request.correlationId)).kind).toBe("existing_decision");
  expect((await a.sdk.submit(bob.id, request)).transport.messageId).toBe(sent[0]!.transport.messageId);
  expect((await a.sdk.execution(bob.id, request.correlationId)).execution).toEqual({
    state: "accepted",
    outcome: "not_reported",
  });
  const result = {
    version: 1,
    kind: "result",
    correlationId: request.correlationId,
    status: "completed",
    value: { total: 11 },
  } as const;
  await b.sdk.respond(alice.id, result);
  await b.sdk.respond(alice.id, result);
  await until(async () => (await a.sdk.execution(bob.id, request.correlationId)).execution.state === "completed");
  expect((await a.sdk.execution(bob.id, request.correlationId)).execution).toEqual({
    state: "completed",
    result: { total: 11 },
  });
  await expect(b.sdk.respond(alice.id, { ...result, value: { total: 12 } })).rejects.toMatchObject({
    code: "conflicting_evidence",
  });
  setSystemTime();
});

test("admission deadline boundary rejects new work but not replayed decisions; explicit execution errors survive restart", async () => {
  const { peer } = await setup();
  const alice = await peer(),
    bob = await peer();
  const a = await alice.start([bob.root]);
  let b = await bob.start([alice.root]);
  const deadline = Date.now() + 30_000;
  for (const correlationId of ["at-boundary", "before-boundary"]) {
    await a.sdk.submit(bob.id, {
      version: 1,
      kind: "request",
      correlationId,
      capability: "sum",
      acceptBefore: deadline,
      input: 5,
    });
  }
  await until(async () => (await b.sdk.agentInbox()).length === 2);
  setSystemTime(deadline - 1);
  expect((await b.sdk.admit(alice.id, "before-boundary")).kind).toBe("new_admission");
  setSystemTime(deadline);
  expect((await a.sdk.execution(bob.id, "at-boundary")).execution.state).toBe("awaiting_evidence");
  const expired = await b.sdk.admit(alice.id, "at-boundary");
  expect(expired.entry.execution).toMatchObject({
    state: "failed",
    error: { stage: "admission", code: "admission_expired" },
  });
  expect((await b.sdk.admit(alice.id, "before-boundary")).entry.execution.state).toBe("accepted");
  await b.sdk.respond(alice.id, {
    version: 1,
    kind: "error",
    correlationId: "before-boundary",
    stage: "execution",
    code: "executor_error",
    message: "Explicit executor report",
  });
  await until(async () => (await a.sdk.execution(bob.id, "before-boundary")).execution.state === "failed");
  await until(async () => (await a.sdk.execution(bob.id, "at-boundary")).execution.state === "failed");
  await b.close();
  b = await bob.start([alice.root]);
  expect((await b.sdk.admit(alice.id, "before-boundary")).entry.execution).toMatchObject({
    state: "failed",
    error: { stage: "execution", code: "executor_error" },
  });
  await a.sdk.submit(bob.id, {
    version: 1,
    kind: "request",
    correlationId: "unsupported",
    capability: "missing",
    acceptBefore: deadline + 1000,
    input: null,
  });
  await until(async () =>
    (await b.sdk.agentInbox()).some(
      (entry) => entry.kind === "request" && entry.request.correlationId === "unsupported",
    ),
  );
  const rejection = {
    version: 1,
    kind: "error",
    correlationId: "unsupported",
    stage: "admission",
    code: "unsupported_capability",
    message: "Not supported",
  } as const;
  await b.sdk.respond(alice.id, rejection);
  await b.sdk.respond(alice.id, rejection);
  await until(async () => (await a.sdk.execution(bob.id, "unsupported")).execution.state === "failed");
  expect((await b.sdk.admit(alice.id, "unsupported")).kind).toBe("existing_decision");
  setSystemTime();
});

test("agent API rejects malformed versions and forbidden peers before queueing", async () => {
  const { peer } = await setup();
  const alice = await peer(),
    bob = await peer();
  const a = await alice.start([]);
  const request = {
    version: 1,
    kind: "request",
    correlationId: "guard",
    capability: "sum",
    acceptBefore: Date.now() + 60_000,
    input: 4,
  } as const;
  await expect(a.sdk.submit(bob.id, request)).rejects.toMatchObject({ code: "peer_not_allowed", status: 403 });
  const response = await fetch(`${a.url}/v1/agent/requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
    body: JSON.stringify({ peer: alice.id, envelope: { ...request, version: 2 } }),
  });
  expect(response.status).toBe(403);
  await a.close();
  const allowed = await alice.start([bob.root]);
  const invalid = await fetch(`${allowed.url}/v1/agent/requests`, {
    method: "POST",
    headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
    body: JSON.stringify({ peer: bob.id, envelope: { ...request, version: 2 } }),
  });
  expect(invalid.status).toBe(400);
  expect(await allowed.sdk.agentInbox()).toEqual([]);
});

test("signed capabilities cross real relay, remain claims, recover revisions and permit signed withdrawal", async () => {
  const { peer } = await setup();
  const alice = await peer(),
    bob = await peer();
  let a = await alice.start([bob.root]);
  let b = await bob.start([alice.root]);
  expect(await b.sdk.capabilities()).toEqual([]);
  const sent = await a.sdk.advertise(bob.id, [{ name: "sum", description: "I claim to add integers" }]);
  await until(async () => (await b.sdk.capabilities("sum")).length === 1);
  expect((await b.sdk.capabilities("sum"))[0]).toMatchObject({
    evidence: "signed_self_description",
    advertisement: { identityId: alice.id, revision: sent.revision },
  });
  expect(await b.sdk.capabilities("unknown")).toEqual([]);
  await expect(a.sdk.advertise("0".repeat(64), [])).rejects.toMatchObject({ code: "peer_not_allowed", status: 403 });
  await expect(
    a.sdk.advertise(bob.id, [
      { name: "sum", description: "" },
      { name: "sum", description: "duplicate" },
    ]),
  ).rejects.toThrow("invalid_capabilities");
  await a.close();
  await b.close();
  a = await alice.start([bob.root]);
  b = await bob.start([alice.root]);
  expect(await b.sdk.capabilities("sum")).toHaveLength(1);
  const withdrawal = await a.sdk.advertise(bob.id, []);
  expect(withdrawal.revision).toBe(sent.revision + 1);
  await until(async () => (await b.sdk.capabilities("sum")).length === 0);
  expect((await b.sdk.capabilities())[0]!.advertisement.capabilities).toEqual([]);
});
