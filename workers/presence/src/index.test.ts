import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { PresenceTracker } from "./index.js";

const _realDateNow = Date.now.bind(Date);

function createMockState() {
  return {
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      list: async () => [],
    },
    acceptWebSocket: mock(() => {}),
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
  } as unknown as DurableObjectState;
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
    const body = await resp.json() as { leases: number; subscribers: number };
    expect(body.leases).toBe(1);
    expect(body.subscribers).toBe(0);
  });
});
