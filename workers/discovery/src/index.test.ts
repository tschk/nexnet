import { describe, test, expect, mock, spyOn, beforeEach, afterEach, setSystemTime } from "bun:test";
import { fromHex, identityIdFromWallet, signIdentityAuthJson, toHex } from "@nexnet/protocol";
import { REPUTATION_AGE_CAP_MS } from "@nexnet/types";
import worker, { DiscoveryIndex } from "./index.js";

const onlineIdentities = new Set<string>();
afterEach(() => setSystemTime());

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

function createMockState(store = new Map<string, unknown>()) {
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
  return {
    DISCOVERY: {} as DurableObjectNamespace,
    RELAY_SERVICE: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        expect(url.origin).toBe("https://relay");
        expect(url.pathname).toMatch(/^\/online\/[0-9a-f]{64}$/);
        const identityId = url.pathname.slice("/online/".length);
        return Response.json({ identityId, online: onlineIdentities.has(identityId) });
      },
    } as Fetcher,
  };
}

async function matureCandidates(...names: string[]) {
  setSystemTime(Date.now() + REPUTATION_AGE_CAP_MS + 1);
  for (const name of names) onlineIdentities.add((await who(name)).id);
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
    setSystemTime(new Date("2026-10-29T12:00:00Z"));
    issuedAtCounter = 0;
    onlineIdentities.clear();
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

  test("rejects string interests without breaking interest search", async () => {
    expect((await upsert(index, "good", { interests: ["music"] })).status).toBe(200);
    expect((await upsert(index, "bad", { interests: "music" })).status).toBe(400);
    const response = await index.fetch(jsonPost("/do/search/interest", { tag: "music" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 1, profiles: [{ username: "good" }] });
  });

  test("rejects invalid profile shapes and unknown fields", async () => {
    for (const fields of [
      { username: 5 },
      { username: "" },
      { username: " " },
      { username: "x".repeat(33) },
      { bio: 5 },
      { bio: null },
      { interests: [1] },
      { interests: [""] },
      { interests: ["x".repeat(33)] },
      { interests: Array(17).fill("music") },
      { languages: "en" },
      { languages: null },
      { languages: [1] },
      { languages: [""] },
      { languages: ["x".repeat(33)] },
      { languages: Array(17).fill("en") },
      { createdAt: 0 },
      { firstSeenAt: 0 },
      { lastSeenAt: 0 },
      { extra: "field" },
    ]) {
      expect((await upsert(index, "invalid", fields)).status).toBe(400);
    }
    expect(
      (
        await upsert(index, "valid", {
          username: "x".repeat(32),
          interests: Array(16).fill("x".repeat(32)),
          languages: ["en"],
        })
      ).status,
    ).toBe(200);
  });

  test("malformed stored profiles cannot break interest, language or random search", async () => {
    const bad = await who("legacy-bad");
    const store = new Map<string, unknown>([
      [
        `profile:${bad.id}`,
        {
          identityId: bad.id,
          username: "x",
          interests: "music",
          languages: null,
          online: true,
          reputationScore: 1,
        },
      ],
    ]);
    const recreated = new DiscoveryIndex(createMockState(store), createMockEnv());
    onlineIdentities.add(bad.id);
    await upsert(recreated, "good", { interests: ["music"], languages: ["en"] });
    for (const [path, fields] of [
      ["/do/search/interest", { tag: "music" }],
      ["/do/search/language", { language: "en" }],
    ] as const) {
      const response = await recreated.fetch(jsonPost(path, fields));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ count: 1, profiles: [{ username: "good" }] });
    }
    expect((await randomMatch(recreated, "requester", { interests: ["music"], languages: ["en"] })).status).toBe(200);
  });

  test("rejects non-string search tags and languages", async () => {
    for (const value of [5, true, ["music"], {}, null]) {
      expect((await index.fetch(jsonPost("/do/search/interest", { tag: value }))).status).toBe(400);
      expect((await index.fetch(jsonPost("/do/search/language", { language: value }))).status).toBe(400);
    }
    expect((await index.fetch(jsonPost("/do/search/interest", null))).status).toBe(400);
    expect((await index.fetch(jsonPost("/do/search/language", null))).status).toBe(400);
  });

  test("rejects self-asserted reputation and online fields", async () => {
    expect((await upsert(index, "claim", { reputationScore: 1 })).status).toBe(400);
    expect((await upsert(index, "claim", { online: true })).status).toBe(400);
  });

  test("relay observations alone decide public online state", async () => {
    const identity = await who("alice");
    const response = await upsert(index, "alice", { interests: ["music"], languages: ["en"] });
    expect(await response.json()).toMatchObject({ profile: { online: false } });
    onlineIdentities.add(identity.id);
    expect(await (await getProfile(index, "alice")).json()).toMatchObject({ online: true });
    setSystemTime(Date.now() + 90_001);
    expect(await (await getProfile(index, "alice")).json()).toMatchObject({ online: true });
    onlineIdentities.delete(identity.id);
    for (const [path, fields] of [
      ["/do/search/interest", { tag: "music" }],
      ["/do/search/language", { language: "en" }],
    ] as const) {
      expect(await (await index.fetch(jsonPost(path, fields))).json()).toMatchObject({ profiles: [{ online: false }] });
    }
    expect(await (await getProfile(index, "alice")).json()).toMatchObject({ online: false });
  });

  test("missing, failed or invalid relay observations are unknown and cannot match", async () => {
    const state = createMockState();
    const first = new DiscoveryIndex(state, createMockEnv());
    await upsert(first, "candidate", { interests: ["music"], languages: ["en"] });
    await matureCandidates("candidate");
    const failures = [
      undefined,
      async () => {
        throw new Error("unavailable");
      },
      async () => new Response("unavailable", { status: 503 }),
      async () => new Response("not JSON"),
      async () => Response.json(null),
      async () => Response.json({ identityId: (await who("candidate")).id, online: "true" }),
      async () => Response.json({ identityId: (await who("other")).id, online: true }),
    ];
    for (const fetch of failures) {
      const recreated = new DiscoveryIndex(state, {
        DISCOVERY: {} as DurableObjectNamespace,
        // These failure stubs exercise fetch only, not Fetcher's connect API.
        ...(fetch ? { RELAY_SERVICE: { fetch } as unknown as Fetcher } : {}),
      });
      expect(await (await getProfile(recreated, "candidate")).json()).toMatchObject({ online: null });
      for (const [path, fields] of [
        ["/do/search/interest", { tag: "music" }],
        ["/do/search/language", { language: "en" }],
      ] as const) {
        expect(await (await recreated.fetch(jsonPost(path, fields))).json()).toMatchObject({
          profiles: [{ online: null }],
        });
      }
      const response = await randomMatch(recreated, `requester-${failures.indexOf(fetch)}`, {
        interests: ["music"],
        languages: ["en"],
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ match: null });
    }
  });

  test("an all-new network can random-match without invented reputation credit", async () => {
    const fields = { interests: ["music"], languages: ["en"] };
    await upsert(index, "candidate", fields);
    onlineIdentities.add((await who("candidate")).id);
    expect(await (await randomMatch(index, "requester", fields)).json()).toMatchObject({
      match: { identityId: (await who("candidate")).id, reputationEvidence: "insufficient" },
    });
    await matureCandidates("candidate");
    expect((await upsert(index, "candidate", fields)).status).toBe(200);
    expect(await (await randomMatch(index, "requester", fields)).json()).toMatchObject({
      match: { identityId: (await who("candidate")).id },
    });
  });

  test("observed negative signals lower rank but incomplete evidence never excludes a lone candidate", async () => {
    const fields = { interests: ["music"], languages: ["en"] };
    await upsert(index, "candidate", fields);
    onlineIdentities.add((await who("candidate")).id);
    await block(index, "blocker-a", "candidate");
    await block(index, "blocker-a", "candidate"); // duplicate is not another identity
    await block(index, "blocker-b", "candidate");
    // Negative partial rank is not an eligibility failure or a public rating.
    expect(await (await randomMatch(index, "requester", fields)).json()).toMatchObject({
      match: { username: "candidate", reputationEvidence: "insufficient" },
    });
    await upsert(index, "other", fields);
    onlineIdentities.add((await who("other")).id);
    // Same observed age, but only candidate has signed negative feedback.
    expect(await (await randomMatch(index, "requester", fields)).json()).toMatchObject({
      match: { username: "other", reputationEvidence: "insufficient" },
      candidatesConsidered: 2,
    });
  });

  test("all equally new candidates remain selectable at the ranking cutoff", async () => {
    const fields = { interests: ["music"], languages: ["en"] };
    for (const name of ["first", "second"]) {
      await upsert(index, name, fields);
      onlineIdentities.add((await who(name)).id);
    }
    const random = spyOn(Math, "random");
    try {
      for (const [roll, name] of [
        [0, "first"],
        [0.999, "second"],
      ] as const) {
        random.mockReturnValue(roll);
        expect(await (await randomMatch(index, "requester", fields)).json()).toMatchObject({
          match: { username: name, reputationEvidence: "insufficient" },
          candidatesConsidered: 2,
        });
      }
    } finally {
      random.mockRestore();
    }
  });

  test("legacy self-asserted scores and creation dates grant no matching reputation", async () => {
    const candidate = await who("candidate");
    const fields = { interests: ["music"], languages: ["en"] };
    const store = new Map<string, unknown>([
      [
        `profile:${candidate.id}`,
        {
          identityId: candidate.id,
          username: "candidate",
          ...fields,
          online: true,
          reputationScore: 1,
          createdAt: Date.now() - REPUTATION_AGE_CAP_MS * 2,
        },
      ],
    ]);
    const established = await who("established");
    store.set(`profile:${established.id}`, {
      identityId: established.id,
      username: "established",
      ...fields,
      firstSeenAt: Date.now() - REPUTATION_AGE_CAP_MS / 2,
    });
    onlineIdentities.add(candidate.id);
    onlineIdentities.add(established.id);
    const recreated = new DiscoveryIndex(createMockState(store), createMockEnv());
    expect(await (await getProfile(recreated, "candidate")).json()).toMatchObject({
      reputationEvidence: "insufficient",
    });
    // The forged old creation date must not outrank a genuinely observed older profile.
    expect(await (await randomMatch(recreated, "requester", fields)).json()).toMatchObject({
      match: { username: "established" },
    });
  });

  test("observed publication age survives upserts and Durable Object recreation", async () => {
    const state = createMockState();
    const first = new DiscoveryIndex(state, createMockEnv());
    const fields = { interests: ["music"], languages: ["en"] };
    await upsert(first, "candidate", fields);
    await matureCandidates("candidate");
    const recreated = new DiscoveryIndex(state, createMockEnv());
    expect((await upsert(recreated, "candidate", fields)).status).toBe(200);
    expect(await (await randomMatch(recreated, "requester", fields)).json()).toMatchObject({
      match: { username: "candidate" },
    });
  });

  test("public upsert, get and search profiles expose no internal reputation or timestamps", async () => {
    await block(index, "blocker", "alice");
    const response = await upsert(index, "alice", { bio: "hello", interests: ["music"], languages: ["en"] });
    const { profile } = (await response.json()) as { profile: Record<string, unknown> };
    const profiles = [profile, await (await getProfile(index, "alice")).json()];
    for (const [path, fields] of [
      ["/do/search/interest", { tag: "music" }],
      ["/do/search/language", { language: "en" }],
    ] as const) {
      const body = (await (await index.fetch(jsonPost(path, fields))).json()) as {
        profiles: Record<string, unknown>[];
      };
      profiles.push(...body.profiles);
    }
    for (const publicProfile of profiles) {
      expect(Object.keys(publicProfile as object).sort()).toEqual(
        ["identityId", "username", "bio", "interests", "languages", "online", "reputationEvidence"].sort(),
      );
      expect(publicProfile).toMatchObject({ reputationEvidence: "insufficient" });
    }
  });

  test("malformed random-match lists return 400 rather than throwing", async () => {
    for (const fields of [
      { interests: [1], languages: ["en"] },
      { interests: ["music"], languages: [1] },
      { interests: ["music"], languages: ["en"], exclude: 5 },
    ]) {
      expect((await randomMatch(index, "requester", fields)).status).toBe(400);
    }
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
    await upsert(index, "victim", { interests: ["shared"], languages: ["en"] });
    await upsert(index, "friend", { interests: ["shared"], languages: ["en"] });
    await matureCandidates("friend");

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
    await upsert(index, "alice", { interests: ["music.jazz"], languages: ["en"] });
    await upsert(index, "bob", {
      interests: ["music.jazz", "cooking"],
      languages: ["en"],
    });
    await matureCandidates("alice", "bob");

    const resp = await randomMatch(index, "alice", { interests: ["music.jazz"], languages: ["en"] });
    const body = (await resp.json()) as { match: { identityId: string } | null };
    expect(body.match).not.toBeNull();
    expect(body.match!.identityId).toBe((await who("bob")).id);
  });

  test("random match excludes self", async () => {
    await upsert(index, "solo", { interests: ["solo"], languages: ["en"] });
    await matureCandidates("solo");

    const resp = await randomMatch(index, "solo", { interests: ["solo"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes offline users", async () => {
    await upsert(index, "offline-user", { interests: ["shared"] });
    await matureCandidates();

    const resp = await randomMatch(index, "requester", { interests: ["shared"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("a new profile remains discoverable with insufficient evidence", async () => {
    await upsert(index, "lowrep", {
      interests: ["shared"],
    });
    onlineIdentities.add((await who("lowrep")).id);

    const resp = await randomMatch(index, "requester", { interests: ["shared"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toMatchObject({ username: "lowrep", reputationEvidence: "insufficient" });
  });

  test("random match returns null when no overlap", async () => {
    await upsert(index, "alice", { interests: ["cooking"], languages: ["fr"] });
    await matureCandidates("alice");

    const resp = await randomMatch(index, "requester", { interests: ["music"], languages: ["en"] });
    const body = (await resp.json()) as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match with exclude list", async () => {
    await upsert(index, "bob", { interests: ["shared"] });
    await matureCandidates("bob");

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
      await upsert(index, name, { interests: ["shared"], languages: ["en"] });
    }
    await matureCandidates("alice", "bob");

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
      await upsert(recreated, name, { interests: ["shared"], languages: ["en"] });
    }
    await matureCandidates("alice", "bob");

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
