import { describe, test, expect, mock, beforeEach } from "bun:test";
import { fromHex, identityIdFromWallet, signIdentityAuthJson, toHex } from "@nexnet/protocol";
import worker, { DiscoveryIndex } from "./index.js";

interface TestIdentity {
  id: string;
  idBytes: Uint8Array;
  signer: { rootPublicKey: Uint8Array; secretKey: Uint8Array };
}

// Ed25519 keys via WebCrypto: @nexnet/crypto is not a dependency of this
// worker. The PKCS#8 encoding of an Ed25519 key ends with its 32-byte seed,
// which is the secret key format @nexnet/crypto signs with.
async function newIdentity(): Promise<TestIdentity> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const rootPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const secretKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32);
  const idBytes = identityIdFromWallet(rootPublicKey);
  return { id: toHex(idBytes), idBytes, signer: { rootPublicKey, secretKey } };
}

const identities = new Map<string, TestIdentity>();
async function who(name: string): Promise<TestIdentity> {
  let identity = identities.get(name);
  if (!identity) {
    identity = await newIdentity();
    identities.set(name, identity);
  }
  return identity;
}

let issuedAtCounter = 0;
/** Body signed by `signer` for `operation` on behalf of `fields.identityId`. */
function signed(signer: TestIdentity, operation: string, fields: Record<string, unknown>) {
  const body: Record<string, unknown> = { issuedAt: Date.now() + issuedAtCounter++, ...fields };
  const target = typeof body.identityId === "string" ? fromHex(body.identityId) : signer.idBytes;
  return signIdentityAuthJson(signer.signer, operation, target, body);
}

async function upsert(index: DiscoveryIndex, name: string, fields: Record<string, unknown> = {}) {
  const identity = await who(name);
  return index.fetch(
    jsonPost(
      "/do/profile/upsert",
      signed(identity, "discovery.profile.upsert", { identityId: identity.id, username: name, ...fields }),
    ),
  );
}

async function randomMatch(index: DiscoveryIndex, name: string, fields: Record<string, unknown>) {
  const identity = await who(name);
  return index.fetch(
    jsonPost("/do/random-match", signed(identity, "discovery.random-match", { identityId: identity.id, ...fields })),
  );
}

async function block(index: DiscoveryIndex, name: string, blockedName: string) {
  const identity = await who(name);
  return index.fetch(
    jsonPost(
      "/do/block",
      signed(identity, "discovery.block", { identityId: identity.id, blockedIdentityId: (await who(blockedName)).id }),
    ),
  );
}

function createMockState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => store.delete(key),
      list: async () => [...store.entries()],
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  } as unknown as DurableObjectState;
}

function createMockEnv() {
  return { DISCOVERY: {} as DurableObjectNamespace };
}

function jsonPost(path: string, body: unknown) {
  return new Request(`https://discovery${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonGet(path: string) {
  return new Request(`https://discovery${path}`);
}

async function deleteProfile(index: DiscoveryIndex, name: string) {
  const identity = await who(name);
  return index.fetch(
    jsonPost("/do/profile/delete", signed(identity, "discovery.profile.delete", { identityId: identity.id })),
  );
}

async function getProfile(index: DiscoveryIndex, name: string) {
  return index.fetch(jsonGet(`/do/profile/get?identityId=${(await who(name)).id}`));
}

describe("DiscoveryIndex", () => {
  let index: DiscoveryIndex;

  beforeEach(() => {
    index = new DiscoveryIndex(createMockState(), createMockEnv());
  });

  // ── Profile CRUD ─────────────────────────────────────────────────

  test("upsert profile stores and returns profile", async () => {
    const resp = await upsert(index, "alice", {
      username: "alice_dev",
      bio: "hello world",
      interests: ["software.rust", "music.jazz"],
      languages: ["en", "fr"],
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; profile: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.profile.username).toBe("alice_dev");
    expect(body.profile.auth).toBeUndefined();
    expect(body.profile.issuedAt).toBeUndefined();
  });

  test("get profile returns stored profile", async () => {
    await upsert(index, "bob", { username: "bob_test", interests: ["crypto"] });

    const resp = await getProfile(index, "bob");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { username: string; interests: string[] };
    expect(body.username).toBe("bob_test");
    expect(body.interests).toEqual(["crypto"]);
  });

  test("get unknown profile returns 404", async () => {
    const resp = await index.fetch(jsonGet("/do/profile/get?identityId=ghost"));
    expect(resp.status).toBe(404);
  });

  test("get profile requires identityId", async () => {
    const resp = await index.fetch(jsonGet("/do/profile/get"));
    expect(resp.status).toBe(400);
  });

  test("delete profile removes it", async () => {
    await upsert(index, "charlie");

    const delResp = await deleteProfile(index, "charlie");
    const delBody = (await delResp.json()) as { ok: boolean; removed: boolean };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toBe(true);

    expect((await getProfile(index, "charlie")).status).toBe(404);
  });

  test("bio truncated to 160 chars", async () => {
    const resp = await upsert(index, "verbose", { bio: "x".repeat(300) });
    const body = (await resp.json()) as { profile: { bio: string } };
    expect(body.profile.bio.length).toBe(160);
  });

  // ── Identity proof ───────────────────────────────────────────────

  test("rejects profile upsert for another identity signed with the wrong key", async () => {
    const mallory = await who("mallory");
    const victim = await who("victim");
    await upsert(index, "victim", { bio: "original" });

    const resp = await index.fetch(
      jsonPost(
        "/do/profile/upsert",
        signed(mallory, "discovery.profile.upsert", { identityId: victim.id, username: "pwned", bio: "pwned" }),
      ),
    );
    expect(resp.status).toBe(401);
    const profile = (await (await getProfile(index, "victim")).json()) as { username: string; bio: string };
    expect(profile).toMatchObject({ username: "victim", bio: "original" });
  });

  test("rejects unsigned profile upsert", async () => {
    const victim = await who("victim");
    const resp = await index.fetch(
      jsonPost("/do/profile/upsert", { identityId: victim.id, username: "pwned", issuedAt: Date.now() }),
    );
    expect(resp.status).toBe(401);
    expect((await getProfile(index, "victim")).status).toBe(404);
  });

  test("rejects malformed identity-scoped requests with 400", async () => {
    const alice = await who("alice");
    expect((await index.fetch(jsonPost("/do/profile/upsert", { identityId: "alice", username: "a" }))).status).toBe(
      400,
    );
    expect((await index.fetch(jsonPost("/do/profile/upsert", { identityId: alice.id, username: "a" }))).status).toBe(
      400,
    );
  });

  test("rejects unauthenticated profile delete and keeps the profile", async () => {
    const victim = await who("victim");
    await upsert(index, "victim");

    const unsigned = await index.fetch(jsonPost("/do/profile/delete", { identityId: victim.id, issuedAt: Date.now() }));
    expect(unsigned.status).toBe(401);
    const forged = await index.fetch(
      jsonPost(
        "/do/profile/delete",
        signed(await who("mallory"), "discovery.profile.delete", { identityId: victim.id }),
      ),
    );
    expect(forged.status).toBe(401);
    expect((await getProfile(index, "victim")).status).toBe(200);
  });

  test("rejects block on behalf of another identity", async () => {
    const mallory = await who("mallory");
    const victim = await who("victim");
    await upsert(index, "victim", { interests: ["shared"], languages: ["en"], online: true, reputationScore: 1 });
    await upsert(index, "friend", { interests: ["shared"], languages: ["en"], online: true, reputationScore: 1 });

    const resp = await index.fetch(
      jsonPost(
        "/do/block",
        signed(mallory, "discovery.block", { identityId: victim.id, blockedIdentityId: (await who("friend")).id }),
      ),
    );
    expect(resp.status).toBe(401);
    const match = (await (await randomMatch(index, "victim", { interests: ["shared"], languages: ["en"] })).json()) as {
      match: { identityId: string } | null;
    };
    expect(match.match?.identityId).toBe((await who("friend")).id);
  });

  test("rejects random match on behalf of another identity", async () => {
    const resp = await index.fetch(
      jsonPost(
        "/do/random-match",
        signed(await who("mallory"), "discovery.random-match", {
          identityId: (await who("victim")).id,
          interests: ["shared"],
          languages: ["en"],
        }),
      ),
    );
    expect(resp.status).toBe(401);
  });

  test("rejects a proof signed for a different operation", async () => {
    const alice = await who("alice");
    const resp = await index.fetch(
      jsonPost("/do/profile/delete", signed(alice, "discovery.profile.upsert", { identityId: alice.id })),
    );
    expect(resp.status).toBe(401);
  });

  test("rejects replayed request", async () => {
    const victim = await who("victim");
    await upsert(index, "victim");
    const request = signed(victim, "discovery.profile.delete", { identityId: victim.id });
    expect((await index.fetch(jsonPost("/do/profile/delete", request))).status).toBe(200);
    await upsert(index, "victim");

    const replay = await index.fetch(jsonPost("/do/profile/delete", request));
    expect(replay.status).toBe(409);
    expect((await getProfile(index, "victim")).status).toBe(200);
  });

  test("replay protection survives Durable Object recreation", async () => {
    const state = createMockState();
    const alice = await who("alice");
    const request = signed(alice, "discovery.profile.upsert", { identityId: alice.id, username: "alice" });
    expect(
      (await new DiscoveryIndex(state, createMockEnv()).fetch(jsonPost("/do/profile/upsert", request))).status,
    ).toBe(200);
    const recreated = new DiscoveryIndex(state, createMockEnv());
    expect((await recreated.fetch(jsonPost("/do/profile/upsert", request))).status).toBe(409);
  });

  test("rejects stale issuedAt", async () => {
    const alice = await who("alice");
    const resp = await index.fetch(
      jsonPost(
        "/do/profile/upsert",
        signed(alice, "discovery.profile.upsert", {
          identityId: alice.id,
          username: "alice",
          issuedAt: Date.now() - 10 * 60_000,
        }),
      ),
    );
    expect(resp.status).toBe(409);
  });

  // ── Interest search ──────────────────────────────────────────────

  test("search by interest finds matching profiles", async () => {
    await upsert(index, "a", { interests: ["music.jazz", "cooking"] });
    await upsert(index, "b", { interests: ["music.jazz"] });
    await upsert(index, "c", { interests: ["sports"] });

    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "music.jazz" }));
    const body = (await resp.json()) as { count: number; profiles: { identityId: string }[] };
    expect(body.count).toBe(2);
    expect(body.profiles.map((p) => p.identityId).sort()).toEqual([(await who("a")).id, (await who("b")).id].sort());
  });

  test("search interest is case-insensitive", async () => {
    await upsert(index, "x", { interests: ["Software.Rust"] });

    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "software.rust" }));
    const body = (await resp.json()) as { count: number };
    expect(body.count).toBe(1);
  });

  test("search with no matches returns empty", async () => {
    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "nonexistent" }));
    const body = (await resp.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  // ── Random match ─────────────────────────────────────────────────

  test("random match finds candidate with overlapping interests", async () => {
    await upsert(index, "alice", { interests: ["music.jazz"], languages: ["en"], online: true, reputationScore: 0.8 });
    await upsert(index, "bob", {
      interests: ["music.jazz", "cooking"],
      languages: ["en"],
      online: true,
      reputationScore: 0.9,
    });

    const resp = await randomMatch(index, "alice", { interests: ["music.jazz"], languages: ["en"] });
    const body = (await resp.json()) as { match: { identityId: string } | null };
    expect(body.match).not.toBeNull();
    expect(body.match!.identityId).toBe((await who("bob")).id);
  });

  test("random match excludes self", async () => {
    await upsert(index, "solo", { interests: ["solo"], languages: ["en"], online: true, reputationScore: 1.0 });

    const resp = await randomMatch(index, "solo", { interests: ["solo"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes offline users", async () => {
    await upsert(index, "offline-user", { interests: ["shared"], online: false, reputationScore: 1.0 });

    const resp = await randomMatch(index, "requester", { interests: ["shared"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes low reputation", async () => {
    await upsert(index, "lowrep", {
      interests: ["shared"],
      online: true,
      reputationScore: 0.01, // below DEFAULT_REPUTATION_THRESHOLD (0.25)
    });

    const resp = await randomMatch(index, "requester", { interests: ["shared"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match returns null when no overlap", async () => {
    await upsert(index, "alice", { interests: ["cooking"], languages: ["fr"], online: true, reputationScore: 0.8 });

    const resp = await randomMatch(index, "requester", { interests: ["music"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match with exclude list", async () => {
    await upsert(index, "bob", { interests: ["shared"], online: true, reputationScore: 0.9 });

    const resp = await randomMatch(index, "requester", {
      interests: ["shared"],
      languages: ["en"],
      exclude: [(await who("bob")).id],
    });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes identities blocked in either direction", async () => {
    for (const name of ["alice", "bob"]) {
      await upsert(index, name, { interests: ["shared"], languages: ["en"], online: true, reputationScore: 1 });
    }

    expect((await block(index, "alice", "bob")).status).toBe(200);
    const response = await randomMatch(index, "bob", { interests: ["shared"], languages: ["en"] });
    const body = (await response.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("blocks survive Durable Object recreation", async () => {
    const state = createMockState();
    const first = new DiscoveryIndex(state, createMockEnv());
    expect((await block(first, "alice", "bob")).status).toBe(200);
    const recreated = new DiscoveryIndex(state, createMockEnv());
    for (const name of ["alice", "bob"]) {
      await upsert(recreated, name, { interests: ["shared"], languages: ["en"], online: true, reputationScore: 1 });
    }

    const response = await randomMatch(recreated, "alice", { interests: ["shared"], languages: ["en"] });
    const body = (await response.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match throttles excessive requests per identity", async () => {
    const fields = { interests: ["shared"], languages: ["en"] };
    for (let request = 0; request < 5; request++) {
      expect((await randomMatch(index, "requester", fields)).status).toBe(200);
    }

    const response = await randomMatch(index, "requester", fields);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "random match rate limited" });
  });
});

function mockDiscoveryEnv(fetch: ReturnType<typeof mock>) {
  return {
    DISCOVERY: { idFromName: mock(() => "global"), get: mock(() => ({ fetch })) },
  } as unknown as { DISCOVERY: DurableObjectNamespace };
}

test("Hono profile route forwards to the discovery Durable Object", async () => {
  const fetch = mock(async () => new Response(JSON.stringify({ identityId: "alice", username: "alice" })));
  const response = await worker.fetch(
    new Request("https://discovery/discovery/profile/alice"),
    mockDiscoveryEnv(fetch),
    {} as ExecutionContext,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(fetch).toHaveBeenCalledWith("https://discovery/do/profile/get?identityId=alice");
});

test("Hono profile delete forwards the signed body and requires matching path id", async () => {
  const alice = await who("alice");
  const body = JSON.stringify(signed(alice, "discovery.profile.delete", { identityId: alice.id }));
  const fetch = mock(async () => new Response(JSON.stringify({ ok: true })));
  const env = mockDiscoveryEnv(fetch);

  const mismatched = await worker.fetch(
    new Request(`https://discovery/discovery/profile/${(await who("bob")).id}`, { method: "DELETE", body }),
    env,
    {} as ExecutionContext,
  );
  expect(mismatched.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();

  const response = await worker.fetch(
    new Request(`https://discovery/discovery/profile/${alice.id}`, { method: "DELETE", body }),
    env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith("https://discovery/do/profile/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
});

test("Hono profile delete through the real Durable Object rejects unsigned requests", async () => {
  const index = new DiscoveryIndex(createMockState(), createMockEnv());
  await upsert(index, "victim");
  const victim = await who("victim");
  const env = mockDiscoveryEnv(mock((url: string, init?: RequestInit) => index.fetch(new Request(url, init))));

  const response = await worker.fetch(
    new Request(`https://discovery/discovery/profile/${victim.id}`, {
      method: "DELETE",
      body: JSON.stringify({ identityId: victim.id, issuedAt: Date.now() }),
    }),
    env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(401);
  expect((await getProfile(index, "victim")).status).toBe(200);
});
