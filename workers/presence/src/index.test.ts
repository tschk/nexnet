import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { PresenceTracker } from "./index.js";

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

describe("PresenceTracker", () => {
  let tracker: PresenceTracker;

  beforeEach(() => {
    Date.now = _realDateNow;
    tracker = new PresenceTracker(createMockState(), createMockEnv());
  });

  afterEach(() => {
    Date.now = _realDateNow;
  });

  test("publish lease returns ok with capped expiry", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 60_000,
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; expiresAt: number };
    expect(body.ok).toBe(true);
    expect(body.expiresAt).toBe(now + 60_000);
  });

  test("publish lease caps to max TTL", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 999_999_999, // way over 90s
    }));
    const body = await resp.json() as { expiresAt: number };
    const maxExpiry = now + 90_000;
    expect(body.expiresAt).toBeLessThanOrEqual(maxExpiry + 100); // 100ms tolerance
  });

  test("publish rejects already-expired lease", async () => {
    const now = Date.now();
    const resp = await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now - 1000,
      expiresAt: now - 500,
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("expired");
  });

  test("publish rejects missing required fields", async () => {
    const resp = await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
    }));
    expect(resp.status).toBe(400);
  });

  test("query returns online for valid lease", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 60_000,
    }));

    const resp = await tracker.fetch(makeRequest("/do/query?identityId=alice"));
    const body = await resp.json() as { status: string; expiresAt: number };
    expect(body.status).toBe("online");
    expect(body.expiresAt).toBeGreaterThan(now);
  });

  test("query returns offline for unknown identity", async () => {
    const resp = await tracker.fetch(makeRequest("/do/query?identityId=unknown"));
    const body = await resp.json() as { status: string };
    expect(body.status).toBe("offline");
  });

  test("query requires identityId param", async () => {
    const resp = await tracker.fetch(makeRequest("/do/query"));
    expect(resp.status).toBe(400);
  });

  test("lease expires after TTL (mocked time)", async () => {
    const fakeNow = 1_000_000_000_000;
    Date.now = () => fakeNow;

    await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: fakeNow,
      expiresAt: fakeNow + 60_000,
    }));

    // Query before expiry
    let resp = await tracker.fetch(makeRequest("/do/query?identityId=alice"));
    let body = await resp.json() as { status: string };
    expect(body.status).toBe("online");

    // Advance time past expiry
    Date.now = () => fakeNow + 61_000;

    resp = await tracker.fetch(makeRequest("/do/query?identityId=alice"));
    body = await resp.json() as { status: string };
    expect(body.status).toBe("offline");
  });

  test("remove identity returns removed=true", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 60_000,
    }));

    const resp = await tracker.fetch(makeRequest("/do/remove?identityId=alice"));
    const body = await resp.json() as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);

    // Verify gone
    const qResp = await tracker.fetch(makeRequest("/do/query?identityId=alice"));
    const qBody = await qResp.json() as { status: string };
    expect(qBody.status).toBe("offline");
  });

  test("remove non-existent returns removed=false", async () => {
    const resp = await tracker.fetch(makeRequest("/do/remove?identityId=ghost"));
    const body = await resp.json() as { removed: boolean };
    expect(body.removed).toBe(false);
  });

  test("status endpoint shows lease and subscriber counts", async () => {
    const now = Date.now();
    await tracker.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 60_000,
    }));

    const resp = await tracker.fetch(makeRequest("/do/status"));
    const body = await resp.json() as { leases: number; subscribers: number; prekeys?: number };
    expect(body.leases).toBe(1);
    expect(body.subscribers).toBe(0);
    expect(body.prekeys ?? 0).toBe(0);
  });
});

describe("PresenceTracker prekeys", () => {
  let tracker: PresenceTracker;

  beforeEach(() => {
    tracker = new PresenceTracker(createMockState(), createMockEnv());
  });

  async function validBundle(identityId = "aa".repeat(32)) {
    const { ed25519 } = await import("@noble/curves/ed25519");
    const sk = ed25519.utils.randomPrivateKey();
    const pk = ed25519.getPublicKey(sk);
    const spk = new Uint8Array(32).fill(7);
    const sig = ed25519.sign(spk, sk);
    const ik = new Uint8Array(32).fill(3);
    return {
      identityId,
      identityDhPublic: Buffer.from(ik).toString("hex"),
      signedPrekeyPublic: Buffer.from(spk).toString("hex"),
      signedPrekeySig: Buffer.from(sig).toString("hex"),
      identitySignPublic: Buffer.from(pk).toString("hex"),
      oneTimePrekeyPublic: Buffer.from(new Uint8Array(32).fill(9)).toString("hex"),
      oneTimePrekeyId: 1,
    };
  }

  test("publish and get prekey bundle", async () => {
    const bundle = await validBundle();
    const pub = await tracker.fetch(jsonPost("/do/prekeys/publish", bundle));
    expect(pub.status).toBe(200);
    const body = await pub.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const get = await tracker.fetch(
      makeRequest(`/do/prekeys/get?identityId=${bundle.identityId}`)
    );
    expect(get.status).toBe(200);
    const got = await get.json() as { identityDhPublic: string; oneTimePrekeyId: number };
    expect(got.identityDhPublic).toBe(bundle.identityDhPublic);
    expect(got.oneTimePrekeyId).toBe(1);
  });

  test("reject bad signature", async () => {
    const bundle = await validBundle();
    bundle.signedPrekeySig = "00".repeat(64);
    const pub = await tracker.fetch(jsonPost("/do/prekeys/publish", bundle));
    expect(pub.status).toBe(403);
  });

  test("get missing returns 404", async () => {
    const get = await tracker.fetch(
      makeRequest("/do/prekeys/get?identityId=missing")
    );
    expect(get.status).toBe(404);
  });

  test("remove prekey", async () => {
    const bundle = await validBundle();
    await tracker.fetch(jsonPost("/do/prekeys/publish", bundle));
    const del = await tracker.fetch(
      makeRequest(`/do/prekeys/remove?identityId=${bundle.identityId}`)
    );
    const body = await del.json() as { removed: boolean };
    expect(body.removed).toBe(true);
    const get = await tracker.fetch(
      makeRequest(`/do/prekeys/get?identityId=${bundle.identityId}`)
    );
    expect(get.status).toBe(404);
  });

  test("prekeys and leases survive DO reload from storage", async () => {
    const state = createMockState() as DurableObjectState & {
      _store: Map<string, unknown>;
    };
    const t1 = new PresenceTracker(state, createMockEnv());
    const now = Date.now();
    await t1.fetch(jsonPost("/do/publish", {
      identityId: "alice",
      deviceId: "d1",
      issuedAt: now,
      expiresAt: now + 60_000,
    }));
    const bundle = await validBundle("bb".repeat(32));
    await t1.fetch(jsonPost("/do/prekeys/publish", bundle));

    // New isolate, same storage map
    const t2 = new PresenceTracker(state, createMockEnv());
    const q = await t2.fetch(makeRequest("/do/query?identityId=alice"));
    const qBody = await q.json() as { status: string };
    expect(qBody.status).toBe("online");

    const pk = await t2.fetch(
      makeRequest(`/do/prekeys/get?identityId=${bundle.identityId}`)
    );
    expect(pk.status).toBe(200);
    const status = await t2.fetch(makeRequest("/do/status"));
    const sBody = await status.json() as { leases: number; prekeys: number };
    expect(sBody.leases).toBe(1);
    expect(sBody.prekeys).toBe(1);
  });
});
