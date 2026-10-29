import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { identityIdFromWallet, issueDeviceCert, signIdentityAuthJson, toHex } from "@nexnet/protocol";
import type { IdentitySigner } from "@nexnet/protocol";
import { ed25519 } from "@noble/curves/ed25519";
import worker, { PresenceTracker } from "./index.js";

const _realDateNow = Date.now.bind(Date);

function createMockState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => store,
    },
    acceptWebSocket: mock(() => {}),
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
    // test helper: shared store for reload simulation
    _store: store,
  } as unknown as DurableObjectState & { _store: Map<string, unknown> };
}

function createMockEnv() {
  return { PRESENCE: {} as DurableObjectNamespace };
}

function makeRequest(path: string, init?: RequestInit) {
  return new Request(`https://presence${path}`, init);
}

function jsonPost(path: string, body: unknown) {
  return makeRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Identity proof helpers ───────────────────────────────────────────

interface TestIdentity {
  signer: IdentitySigner;
  idBytes: Uint8Array;
  id: string;
}

function makeIdentity(): TestIdentity {
  const secretKey = ed25519.utils.randomPrivateKey();
  const rootPublicKey = ed25519.getPublicKey(secretKey);
  const idBytes = identityIdFromWallet(rootPublicKey);
  return { signer: { rootPublicKey, secretKey }, idBytes, id: toHex(idBytes) };
}

/** Sign `fields` as `signer` for the identity `target` (defaults to signer's own). */
function signed<T extends Record<string, unknown>>(
  signer: TestIdentity,
  operation: string,
  fields: T,
  target = signer,
) {
  return signIdentityAuthJson(signer.signer, operation, target.idBytes, fields);
}

const DEVICE = "d1".repeat(32);

function leaseFields(who: TestIdentity, issuedAt: number, expiresAt = issuedAt + 60_000) {
  return { identityId: who.id, deviceId: DEVICE, issuedAt, expiresAt };
}

function signedLease(who: TestIdentity, issuedAt: number, expiresAt?: number) {
  return signed(who, "presence.publish", leaseFields(who, issuedAt, expiresAt));
}

function signedRemove(who: TestIdentity, operation: string, issuedAt: number) {
  return signed(who, operation, { identityId: who.id, issuedAt });
}

function removeRequest(doPath: string, identityId: string, body: unknown) {
  return jsonPost(`${doPath}?identityId=${identityId}`, body);
}

function bundleFields(who: TestIdentity, issuedAt: number, fill = 7) {
  const sk = ed25519.utils.randomPrivateKey();
  const pk = ed25519.getPublicKey(sk);
  const spk = new Uint8Array(32).fill(fill);
  return {
    identityId: who.id,
    identityDhPublic: toHex(new Uint8Array(32).fill(3)),
    signedPrekeyPublic: toHex(spk),
    signedPrekeySig: toHex(ed25519.sign(spk, sk)),
    identitySignPublic: toHex(pk),
    oneTimePrekeyPublic: toHex(new Uint8Array(32).fill(9)),
    oneTimePrekeyId: 1,
    issuedAt,
  };
}

function signedBundle(who: TestIdentity, issuedAt: number, fill = 7) {
  return signed(who, "prekeys.publish", bundleFields(who, issuedAt, fill));
}

async function getBundle(tracker: PresenceTracker, id: string) {
  return tracker.fetch(makeRequest(`/do/prekeys/get?identityId=${id}`));
}

async function queryStatus(tracker: PresenceTracker, id: string) {
  const resp = await tracker.fetch(makeRequest(`/do/query?identityId=${id}`));
  return ((await resp.json()) as { status: string }).status;
}

describe("PresenceTracker", () => {
  let tracker: PresenceTracker;
  let alice: TestIdentity;

  beforeEach(() => {
    Date.now = _realDateNow;
    tracker = new PresenceTracker(createMockState(), createMockEnv());
    alice = makeIdentity();
  });

  afterEach(() => {
    Date.now = _realDateNow;
  });

  test("publish lease returns ok with capped expiry", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now)));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; expiresAt: number };
    expect(body.ok).toBe(true);
    expect(body.expiresAt).toBe(now + 60_000);
  });

  test("publish lease caps to max TTL", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now, now + 999_999_999)));
    const body = (await resp.json()) as { expiresAt: number };
    const maxExpiry = now + 90_000;
    expect(body.expiresAt).toBeLessThanOrEqual(maxExpiry + 100); // 100ms tolerance
  });

  test("publish rejects already-expired lease", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now - 1000, now - 500)));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("expired");
  });

  test("publish rejects missing required fields", async () => {
    const resp = await tracker.fetch(
      jsonPost("/do/publish", signed(alice, "presence.publish", { identityId: alice.id })),
    );
    expect(resp.status).toBe(400);
  });

  test("publish rejects legacy publicKey/signature lease fields", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(
      jsonPost("/do/publish", { ...leaseFields(alice, now), publicKey: "00".repeat(32), signature: "00".repeat(64) }),
    );
    expect(resp.status).toBe(400);
  });

  test("unsigned lease is rejected", async () => {
    const resp = await tracker.fetch(jsonPost("/do/publish", leaseFields(alice, Date.now())));
    expect(resp.status).toBe(401);
    expect(await queryStatus(tracker, alice.id)).toBe("offline");
  });

  test("presence lease for another identity is rejected", async () => {
    const mallory = makeIdentity();
    const forged = signed(mallory, "presence.publish", leaseFields(alice, Date.now()), alice);
    const resp = await tracker.fetch(jsonPost("/do/publish", forged));
    expect(resp.status).toBe(401);
    expect(await queryStatus(tracker, alice.id)).toBe("offline");
  });

  test("lease signed by a device must name that device", async () => {
    const now = Date.now();
    const deviceSk = ed25519.utils.randomPrivateKey();
    const deviceId = new Uint8Array(32).fill(5);
    const certificate = issueDeviceCert(
      alice.signer.secretKey,
      ed25519.getPublicKey(deviceSk),
      new Uint8Array(32).fill(6),
      deviceId,
      alice.idBytes,
      now - 1000,
      now + 3_600_000,
      0,
    );
    const device = {
      ...alice,
      signer: { rootPublicKey: alice.signer.rootPublicKey, secretKey: deviceSk, certificate },
    };
    const wrong = signed(device, "presence.publish", leaseFields(alice, now));
    expect((await tracker.fetch(jsonPost("/do/publish", wrong))).status).toBe(401);
    const right = signed(device, "presence.publish", { ...leaseFields(alice, now + 1), deviceId: toHex(deviceId) });
    expect((await tracker.fetch(jsonPost("/do/publish", right))).status).toBe(200);
  });

  test("replayed or stale lease issuedAt is rejected", async () => {
    const now = Date.now();
    const first = signedLease(alice, now);
    expect((await tracker.fetch(jsonPost("/do/publish", first))).status).toBe(200);
    expect((await tracker.fetch(jsonPost("/do/publish", first))).status).toBe(409);
    const old = signedLease(alice, now - 10 * 60_000, now + 60_000);
    expect((await tracker.fetch(jsonPost("/do/publish", old))).status).toBe(409);
  });

  test("query returns online for valid lease", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now)));

    const resp = await tracker.fetch(makeRequest(`/do/query?identityId=${alice.id}`));
    const body = (await resp.json()) as { status: string; expiresAt: number };
    expect(body.status).toBe("online");
    expect(body.expiresAt).toBeGreaterThan(now);
  });

  test("query returns offline for unknown identity", async () => {
    expect(await queryStatus(tracker, "unknown")).toBe("offline");
  });

  test("query requires identityId param", async () => {
    const resp = await tracker.fetch(makeRequest("/do/query"));
    expect(resp.status).toBe(400);
  });

  test("lease expires after TTL (mocked time)", async () => {
    const fakeNow = 1_000_000_000_000;
    Date.now = () => fakeNow;

    await tracker.fetch(jsonPost("/do/publish", signedLease(alice, fakeNow)));
    expect(await queryStatus(tracker, alice.id)).toBe("online");

    // Advance time past expiry
    Date.now = () => fakeNow + 61_000;
    expect(await queryStatus(tracker, alice.id)).toBe("offline");
  });

  test("remove identity returns removed=true", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now)));

    const resp = await tracker.fetch(
      removeRequest("/do/remove", alice.id, signedRemove(alice, "presence.remove", now + 1)),
    );
    const body = (await resp.json()) as { ok: boolean; removed: boolean };
    expect(resp.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(await queryStatus(tracker, alice.id)).toBe("offline");
  });

  test("remove non-existent returns removed=false", async () => {
    const ghost = makeIdentity();
    const resp = await tracker.fetch(
      removeRequest("/do/remove", ghost.id, signedRemove(ghost, "presence.remove", Date.now())),
    );
    const body = (await resp.json()) as { removed: boolean };
    expect(body.removed).toBe(false);
  });

  test("unauthenticated presence delete is rejected", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", signedLease(alice, now)));
    const mallory = makeIdentity();

    const unsigned = await tracker.fetch(
      removeRequest("/do/remove", alice.id, { identityId: alice.id, issuedAt: now + 1 }),
    );
    expect(unsigned.status).toBe(401);
    const forged = signed(mallory, "presence.remove", { identityId: alice.id, issuedAt: now + 1 }, alice);
    expect((await tracker.fetch(removeRequest("/do/remove", alice.id, forged))).status).toBe(401);
    // Body for one identity cannot be pointed at another path id.
    const own = signedRemove(mallory, "presence.remove", now + 1);
    expect((await tracker.fetch(removeRequest("/do/remove", alice.id, own))).status).toBe(400);
    // Wrong operation (a prekey removal proof) does not authorize a lease removal.
    const crossOp = signedRemove(alice, "prekeys.remove", now + 1);
    expect((await tracker.fetch(removeRequest("/do/remove", alice.id, crossOp))).status).toBe(401);

    expect(await queryStatus(tracker, alice.id)).toBe("online");
  });

  test("status endpoint shows lease and subscriber counts", async () => {
    await tracker.fetch(jsonPost("/do/publish", signedLease(alice, Date.now())));

    const resp = await tracker.fetch(makeRequest("/do/status"));
    const body = (await resp.json()) as { leases: number; subscribers: number; prekeys?: number };
    expect(body.leases).toBe(1);
    expect(body.subscribers).toBe(0);
    expect(body.prekeys ?? 0).toBe(0);
  });
});

describe("PresenceTracker prekeys", () => {
  let tracker: PresenceTracker;
  let alice: TestIdentity;

  beforeEach(() => {
    tracker = new PresenceTracker(createMockState(), createMockEnv());
    alice = makeIdentity();
  });

  test("publish and get prekey bundle returns signed fields verbatim with auth", async () => {
    const bundle = signedBundle(alice, Date.now());
    const pub = await tracker.fetch(jsonPost("/do/prekeys/publish", bundle));
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as { ok: boolean; updatedAt: number };
    expect(body.ok).toBe(true);

    const get = await getBundle(tracker, alice.id);
    expect(get.status).toBe(200);
    const got = (await get.json()) as Record<string, unknown>;
    expect(got).toEqual({ ...bundle, updatedAt: body.updatedAt });
  });

  test("reject bad signature", async () => {
    const fields = bundleFields(alice, Date.now());
    fields.signedPrekeySig = "00".repeat(64);
    const pub = await tracker.fetch(jsonPost("/do/prekeys/publish", signed(alice, "prekeys.publish", fields)));
    expect(pub.status).toBe(403);
  });

  test("reject unknown bundle fields", async () => {
    const pub = await tracker.fetch(
      jsonPost(
        "/do/prekeys/publish",
        signed(alice, "prekeys.publish", { ...bundleFields(alice, Date.now()), extra: 1 }),
      ),
    );
    expect(pub.status).toBe(400);
  });

  test("unsigned prekey publish is rejected", async () => {
    const pub = await tracker.fetch(jsonPost("/do/prekeys/publish", bundleFields(alice, Date.now())));
    expect(pub.status).toBe(401);
    expect((await getBundle(tracker, alice.id)).status).toBe(404);
  });

  test("bundle for identity B signed with identity A's key is rejected and B unchanged", async () => {
    const bob = makeIdentity();
    const now = Date.now();
    const bobBundle = signedBundle(bob, now);
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", bobBundle))).status).toBe(200);
    const before = (await (await getBundle(tracker, bob.id)).json()) as Record<string, unknown>;

    const forged = signed(alice, "prekeys.publish", bundleFields(bob, now + 1, 8), bob);
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", forged))).status).toBe(401);
    // Alice's valid proof for her own identity relabelled as Bob's also fails.
    const relabelled = { ...signedBundle(alice, now + 2, 8), identityId: bob.id };
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", relabelled))).status).toBe(401);

    const after = (await (await getBundle(tracker, bob.id)).json()) as Record<string, unknown>;
    expect(after).toEqual(before);
  });

  test("replay of an old publish after a newer one is rejected", async () => {
    const now = Date.now();
    const older = signedBundle(alice, now, 7);
    const newer = signedBundle(alice, now + 1, 8);
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", older))).status).toBe(200);
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", newer))).status).toBe(200);
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", older))).status).toBe(409);
    const got = (await (await getBundle(tracker, alice.id)).json()) as { signedPrekeyPublic: string };
    expect(got.signedPrekeyPublic).toBe(newer.signedPrekeyPublic);
  });

  test("get missing returns 404", async () => {
    const get = await getBundle(tracker, "missing");
    expect(get.status).toBe(404);
  });

  test("remove prekey", async () => {
    const now = Date.now();
    const bundle = signedBundle(alice, now);
    await tracker.fetch(jsonPost("/do/prekeys/publish", bundle));
    const del = await tracker.fetch(
      removeRequest("/do/prekeys/remove", alice.id, signedRemove(alice, "prekeys.remove", now + 1)),
    );
    expect(del.status).toBe(200);
    const body = (await del.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
    expect((await getBundle(tracker, alice.id)).status).toBe(404);

    // The pre-removal publish cannot be replayed to resurrect the bundle.
    expect((await tracker.fetch(jsonPost("/do/prekeys/publish", bundle))).status).toBe(409);
    expect((await getBundle(tracker, alice.id)).status).toBe(404);
  });

  test("unsigned or forged prekey delete is rejected", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/prekeys/publish", signedBundle(alice, now)));
    const mallory = makeIdentity();

    const unsigned = await tracker.fetch(
      removeRequest("/do/prekeys/remove", alice.id, { identityId: alice.id, issuedAt: now + 1 }),
    );
    expect(unsigned.status).toBe(401);
    const forged = signed(mallory, "prekeys.remove", { identityId: alice.id, issuedAt: now + 1 }, alice);
    expect((await tracker.fetch(removeRequest("/do/prekeys/remove", alice.id, forged))).status).toBe(401);
    const noBody = await tracker.fetch(makeRequest(`/do/prekeys/remove?identityId=${alice.id}`));
    expect(noBody.status).toBe(400);

    expect((await getBundle(tracker, alice.id)).status).toBe(200);
  });

  test("prekeys and leases survive DO reload from storage", async () => {
    const state = createMockState() as DurableObjectState & {
      _store: Map<string, unknown>;
    };
    const t1 = new PresenceTracker(state, createMockEnv());
    const now = Date.now();
    await t1.fetch(jsonPost("/do/publish", signedLease(alice, now)));
    const bob = makeIdentity();
    const bundle = signedBundle(bob, now);
    await t1.fetch(jsonPost("/do/prekeys/publish", bundle));

    // New isolate, same storage map
    const t2 = new PresenceTracker(state, createMockEnv());
    expect(await queryStatus(t2, alice.id)).toBe("online");

    const pk = await getBundle(t2, bob.id);
    expect(pk.status).toBe(200);
    const status = await t2.fetch(makeRequest("/do/status"));
    const sBody = (await status.json()) as { leases: number; prekeys: number };
    expect(sBody.leases).toBe(1);
    expect(sBody.prekeys).toBe(1);

    // Replay protection also survives reload.
    expect((await t2.fetch(jsonPost("/do/prekeys/publish", bundle))).status).toBe(409);
  });
});

function mockEnv(response: unknown) {
  const fetch = mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(response)));
  const env = {
    PRESENCE: { idFromName: mock(() => "global"), get: mock(() => ({ fetch })) },
  } as unknown as { PRESENCE: DurableObjectNamespace };
  return { fetch, env };
}

test("Hono presence route forwards to the presence Durable Object", async () => {
  const { fetch, env } = mockEnv({ identityId: "alice", status: "offline" });
  const response = await worker.fetch(new Request("https://presence/presence/alice"), env, {} as ExecutionContext);

  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(fetch).toHaveBeenCalledWith("https://presence/do/query?identityId=alice");
});

test("Hono DELETE routes forward the signed body to the Durable Object", async () => {
  const alice = makeIdentity();
  for (const [path, doPath, operation] of [
    ["/prekeys/", "/do/prekeys/remove", "prekeys.remove"],
    ["/presence/", "/do/remove", "presence.remove"],
  ] as const) {
    const { fetch, env } = mockEnv({ ok: true });
    const body = JSON.stringify(signedRemove(alice, operation, Date.now()));
    await worker.fetch(
      new Request(`https://presence${path}${alice.id}`, { method: "DELETE", body }),
      env,
      {} as ExecutionContext,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://presence${doPath}?identityId=${alice.id}`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(body);
  }
});
