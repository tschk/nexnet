import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DiscoveryIndex } from "./index.js";

function createMockState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => store.delete(key),
      list: async () => [...store.entries()],
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
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

describe("DiscoveryIndex", () => {
  let index: DiscoveryIndex;

  beforeEach(() => {
    index = new DiscoveryIndex(createMockState(), createMockEnv());
  });

  // ── Profile CRUD ─────────────────────────────────────────────────

  test("upsert profile stores and returns profile", async () => {
    const resp = await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "alice",
      username: "alice_dev",
      bio: "hello world",
      interests: ["software.rust", "music.jazz"],
      languages: ["en", "fr"],
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; profile: { username: string } };
    expect(body.ok).toBe(true);
    expect(body.profile.username).toBe("alice_dev");
  });

  test("get profile returns stored profile", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "bob",
      username: "bob_test",
      interests: ["crypto"],
    }));

    const resp = await index.fetch(jsonGet("/do/profile/get?identityId=bob"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { username: string; interests: string[] };
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
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "charlie",
      username: "charlie",
    }));

    const delResp = await index.fetch(jsonGet("/do/profile/delete?identityId=charlie"));
    const delBody = await delResp.json() as { ok: boolean; removed: boolean };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toBe(true);

    const getResp = await index.fetch(jsonGet("/do/profile/get?identityId=charlie"));
    expect(getResp.status).toBe(404);
  });

  test("bio truncated to 160 chars", async () => {
    const longBio = "x".repeat(300);
    const resp = await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "verbose",
      username: "verbose",
      bio: longBio,
    }));
    const body = await resp.json() as { profile: { bio: string } };
    expect(body.profile.bio.length).toBe(160);
  });

  // ── Interest search ──────────────────────────────────────────────

  test("search by interest finds matching profiles", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "a", username: "a", interests: ["music.jazz", "cooking"],
    }));
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "b", username: "b", interests: ["music.jazz"],
    }));
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "c", username: "c", interests: ["sports"],
    }));

    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "music.jazz" }));
    const body = await resp.json() as { count: number; profiles: { identityId: string }[] };
    expect(body.count).toBe(2);
    expect(body.profiles.map(p => p.identityId).sort()).toEqual(["a", "b"]);
  });

  test("search interest is case-insensitive", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "x", username: "x", interests: ["Software.Rust"],
    }));

    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "software.rust" }));
    const body = await resp.json() as { count: number };
    expect(body.count).toBe(1);
  });

  test("search with no matches returns empty", async () => {
    const resp = await index.fetch(jsonPost("/do/search/interest", { tag: "nonexistent" }));
    const body = await resp.json() as { count: number };
    expect(body.count).toBe(0);
  });

  // ── Random match ─────────────────────────────────────────────────

  test("random match finds candidate with overlapping interests", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "alice",
      username: "alice",
      interests: ["music.jazz"],
      languages: ["en"],
      online: true,
      reputationScore: 0.8,
    }));
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "bob",
      username: "bob",
      interests: ["music.jazz", "cooking"],
      languages: ["en"],
      online: true,
      reputationScore: 0.9,
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "alice",
      interests: ["music.jazz"],
      languages: ["en"],
    }));
    const body = await resp.json() as { match: { identityId: string } | null };
    expect(body.match).not.toBeNull();
    expect(body.match!.identityId).toBe("bob");
  });

  test("random match excludes self", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "solo",
      username: "solo",
      interests: ["solo"],
      languages: ["en"],
      online: true,
      reputationScore: 1.0,
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "solo",
      interests: ["solo"],
      languages: ["en"],
    }));
    const body = await resp.json() as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes offline users", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "offline-user",
      username: "offline",
      interests: ["shared"],
      online: false,
      reputationScore: 1.0,
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "requester",
      interests: ["shared"],
      languages: ["en"],
    }));
    const body = await resp.json() as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match excludes low reputation", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "lowrep",
      username: "lowrep",
      interests: ["shared"],
      online: true,
      reputationScore: 0.01, // below DEFAULT_REPUTATION_THRESHOLD (0.25)
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "requester",
      interests: ["shared"],
      languages: ["en"],
    }));
    const body = await resp.json() as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match returns null when no overlap", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "alice",
      username: "alice",
      interests: ["cooking"],
      languages: ["fr"],
      online: true,
      reputationScore: 0.8,
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "requester",
      interests: ["music"],
      languages: ["en"],
    }));
    const body = await resp.json() as { match: unknown };
    expect(body.match).toBeNull();
  });

  test("random match with exclude list", async () => {
    await index.fetch(jsonPost("/do/profile/upsert", {
      identityId: "bob",
      username: "bob",
      interests: ["shared"],
      online: true,
      reputationScore: 0.9,
    }));

    const resp = await index.fetch(jsonPost("/do/random-match", {
      identityId: "requester",
      interests: ["shared"],
      languages: ["en"],
      exclude: ["bob"],
    }));
    const body = await resp.json() as { match: unknown };
    expect(body.match).toBeNull();
  });
});
