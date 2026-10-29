/**
 * @nexnet/worker-discovery — profiles + random matching
 *
 * Durable Object: DiscoveryIndex
 * - Stores discovery profiles (interests, languages, bio)
 * - Search by interest / language
 * - Random match with reputation gating (AD-18)
 * - Group discovery
 *
 * AD-24: profile = username + bio, no avatar.
 *
 * Identity-scoped operations (profile upsert/delete, block, random match)
 * require a signed body `{ ...fields, identityId, issuedAt, auth }` proving
 * possession of the identity's root key (or a root-certified device key).
 * `issuedAt` must be fresh and strictly increasing per identity, so a
 * captured request cannot be replayed. 400 malformed, 401 missing/invalid
 * proof, 409 stale/replayed.
 */

import { isFreshIssuedAt, verifyIdentityAuthJson } from "@nexnet/protocol";
import { DEFAULT_REPUTATION_THRESHOLD, DEFAULT_REPUTATION_WEIGHTS } from "@nexnet/types";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ── Types ────────────────────────────────────────────────────────────

interface StoredProfile {
  identityId: string;
  username: string;
  bio?: string;
  interests: string[];
  languages: string[];
  reputationScore: number;
  online: boolean;
  createdAt: number;
}

interface StoredGroup {
  groupId: string;
  name: string;
  creator: string;
  discoverable: boolean;
  createdAt: number;
}

const OP_PROFILE_UPSERT = "discovery.profile.upsert";
const OP_PROFILE_DELETE = "discovery.profile.delete";
const OP_BLOCK = "discovery.block";
const OP_RANDOM_MATCH = "discovery.random-match";
const IDENTITY_HEX = /^[0-9a-f]{64}$/;

type AuthorizedBody = Record<string, unknown> & { identityId: string; issuedAt: number };

const MATCH_RATE_LIMIT = 5;
const MATCH_RATE_WINDOW_MS = 60_000;

interface Env {
  DISCOVERY: DurableObjectNamespace;
}

// ── Durable Object: DiscoveryIndex ───────────────────────────────────

export class DiscoveryIndex {
  private state: DurableObjectState;
  private profiles = new Map<string, StoredProfile>();
  private groups = new Map<string, StoredGroup>();
  private blocks = new Map<string, Set<string>>();
  private matchRequests = new Map<string, number[]>();
  private lastIssuedAt = new Map<string, number>();
  private loaded = false;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/do/profile/upsert":
        return this.handleProfileUpsert(request);
      case "/do/profile/get":
        return this.handleProfileGet(url);
      case "/do/profile/delete":
        return this.handleProfileDelete(request);
      case "/do/search/interest":
        return this.handleSearchInterest(request);
      case "/do/search/language":
        return this.handleSearchLanguage(request);
      case "/do/random-match":
        return this.handleRandomMatch(request);
      case "/do/block":
        return this.handleBlock(request);
      case "/do/groups/list":
        return this.handleGroupsList();
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  }

  // ── Load from durable storage ──────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const allKeys = await this.state.storage.list();
    for (const [key, value] of allKeys) {
      if (key.startsWith("profile:")) {
        const p = value as StoredProfile;
        this.profiles.set(p.identityId, p);
      } else if (key.startsWith("group:")) {
        const g = value as StoredGroup;
        this.groups.set(g.groupId, g);
      } else if (key.startsWith("blocks:")) {
        this.blocks.set(key.slice("blocks:".length), new Set(value as string[]));
      } else if (key.startsWith("match-requests:")) {
        this.matchRequests.set(key.slice("match-requests:".length), value as number[]);
      } else if (key.startsWith("auth-issued-at:")) {
        this.lastIssuedAt.set(key.slice("auth-issued-at:".length), value as number);
      }
    }
    this.loaded = true;
  }

  // ── Identity proof ─────────────────────────────────────────────────

  /**
   * Parse and authorize an identity-scoped request body. Returns the body or
   * an error response. On success the body's `issuedAt` becomes the newest
   * accepted for that identity, so the same signed request cannot be reused.
   */
  private async authorize(request: Request, operation: string): Promise<AuthorizedBody | Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ error: "JSON object body required" }, 400);
    }
    const fields = body as Record<string, unknown>;
    if (typeof fields.identityId !== "string" || !IDENTITY_HEX.test(fields.identityId)) {
      return jsonResponse({ error: "identityId must be 64 lowercase hex characters" }, 400);
    }
    if (typeof fields.issuedAt !== "number" || !Number.isSafeInteger(fields.issuedAt)) {
      return jsonResponse({ error: "issuedAt integer timestamp required" }, 400);
    }
    if (fields.auth === undefined) {
      return jsonResponse({ error: "identity proof required" }, 401);
    }
    const now = Date.now();
    if (!verifyIdentityAuthJson(fields, operation, fields.identityId, now)) {
      return jsonResponse({ error: "invalid identity proof" }, 401);
    }
    const identityId = fields.identityId;
    const issuedAt = fields.issuedAt;
    if (!isFreshIssuedAt(issuedAt, now)) {
      return jsonResponse({ error: "stale request" }, 409);
    }
    if (issuedAt <= (this.lastIssuedAt.get(identityId) ?? Number.NEGATIVE_INFINITY)) {
      return jsonResponse({ error: "replayed request" }, 409);
    }
    this.lastIssuedAt.set(identityId, issuedAt);
    await this.state.storage.put(`auth-issued-at:${identityId}`, issuedAt);
    return { ...fields, identityId, issuedAt };
  }

  // ── Profile CRUD ───────────────────────────────────────────────────

  private async handleProfileUpsert(request: Request): Promise<Response> {
    const authorized = await this.authorize(request, OP_PROFILE_UPSERT);
    if (authorized instanceof Response) return authorized;
    const body = authorized as unknown as StoredProfile;
    if (!body.username) {
      return jsonResponse({ error: "username required" }, 400);
    }

    const profile: StoredProfile = {
      identityId: body.identityId,
      username: body.username,
      bio: body.bio?.slice(0, 160), // AD-24: max 160 graphemes
      interests: body.interests ?? [],
      languages: body.languages ?? [],
      reputationScore: body.reputationScore ?? 0,
      online: body.online ?? false,
      createdAt: body.createdAt ?? Date.now(),
    };

    this.profiles.set(profile.identityId, profile);
    await this.state.storage.put(`profile:${profile.identityId}`, profile);

    return jsonResponse({ ok: true, profile });
  }

  private handleProfileGet(url: URL): Response {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const profile = this.profiles.get(identityId);
    if (!profile) {
      return jsonResponse({ error: "profile not found" }, 404);
    }

    return jsonResponse(profile);
  }

  private async handleProfileDelete(request: Request): Promise<Response> {
    const authorized = await this.authorize(request, OP_PROFILE_DELETE);
    if (authorized instanceof Response) return authorized;
    const identityId = authorized.identityId;

    const existed = this.profiles.delete(identityId);
    if (existed) {
      await this.state.storage.delete(`profile:${identityId}`);
    }

    return jsonResponse({ ok: true, removed: existed });
  }

  // ── Search ─────────────────────────────────────────────────────────

  private async handleSearchInterest(request: Request): Promise<Response> {
    let body: { tag?: string };
    try {
      body = (await request.json()) as { tag?: string };
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (!body.tag) {
      return jsonResponse({ error: "tag required" }, 400);
    }

    const tag = body.tag.toLowerCase();
    const results: StoredProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.interests.some((i) => i.toLowerCase() === tag)) {
        results.push(profile);
      }
    }

    return jsonResponse({ tag, count: results.length, profiles: results });
  }

  private async handleSearchLanguage(request: Request): Promise<Response> {
    let body: { language?: string };
    try {
      body = (await request.json()) as { language?: string };
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (!body.language) {
      return jsonResponse({ error: "language required" }, 400);
    }

    const lang = body.language.toLowerCase();
    const results: StoredProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.languages.some((l) => l.toLowerCase() === lang)) {
        results.push(profile);
      }
    }

    return jsonResponse({ language: body.language, count: results.length, profiles: results });
  }

  // ── Random match (AD-18) ───────────────────────────────────────────

  private async handleBlock(request: Request): Promise<Response> {
    const authorized = await this.authorize(request, OP_BLOCK);
    if (authorized instanceof Response) return authorized;
    const body = authorized as { identityId: string; blockedIdentityId?: string };

    if (
      typeof body.blockedIdentityId !== "string" ||
      !body.blockedIdentityId ||
      body.identityId === body.blockedIdentityId
    ) {
      return jsonResponse({ error: "distinct identityId and blockedIdentityId required" }, 400);
    }

    const blocked = this.blocks.get(body.identityId) ?? new Set<string>();
    blocked.add(body.blockedIdentityId);
    this.blocks.set(body.identityId, blocked);
    await this.state.storage.put(`blocks:${body.identityId}`, [...blocked]);

    return jsonResponse({ ok: true });
  }

  private async handleRandomMatch(request: Request): Promise<Response> {
    const authorized = await this.authorize(request, OP_RANDOM_MATCH);
    if (authorized instanceof Response) return authorized;
    const body = authorized as {
      identityId: string;
      interests?: string[];
      languages?: string[];
      exclude?: string[];
    };

    if (!Array.isArray(body.interests) || !Array.isArray(body.languages)) {
      return jsonResponse({ error: "interests, languages required" }, 400);
    }

    const now = Date.now();
    const requests = (this.matchRequests.get(body.identityId) ?? []).filter(
      (requestedAt) => requestedAt > now - MATCH_RATE_WINDOW_MS,
    );
    if (requests.length >= MATCH_RATE_LIMIT) {
      return jsonResponse(
        { error: "random match rate limited", retryAfterMs: requests[0] + MATCH_RATE_WINDOW_MS - now },
        429,
      );
    }
    requests.push(now);
    this.matchRequests.set(body.identityId, requests);
    await this.state.storage.put(`match-requests:${body.identityId}`, requests);

    const excludeSet = new Set(body.exclude ?? []);
    excludeSet.add(body.identityId); // never match self

    const requesterInterests = new Set(body.interests.map((i) => i.toLowerCase()));
    const requesterLangs = new Set(body.languages.map((l) => l.toLowerCase()));

    // Filter candidates: online + reputation + not excluded + overlap
    const candidates: { profile: StoredProfile; score: number }[] = [];

    for (const profile of this.profiles.values()) {
      if (!profile.online) continue;
      if (profile.reputationScore < DEFAULT_REPUTATION_THRESHOLD) continue;
      if (excludeSet.has(profile.identityId)) continue;
      if (this.blocks.get(body.identityId)?.has(profile.identityId)) continue;
      if (this.blocks.get(profile.identityId)?.has(body.identityId)) continue;

      // Must have at least one interest or language overlap
      const interestOverlap = profile.interests.some((i) => requesterInterests.has(i.toLowerCase()));
      const langOverlap = profile.languages.some((l) => requesterLangs.has(l.toLowerCase()));
      if (!interestOverlap && !langOverlap) continue;

      // Score: age(0.35) + completed(0.35) + continuity(0.15) + blockInverse(0.15)
      // ponytail: age/continuity/completed proxied by reputation for now;
      // blockInverse = 1.0 (no block list integration yet)
      const w = DEFAULT_REPUTATION_WEIGHTS;
      const score =
        w.age * profile.reputationScore +
        w.completed * profile.reputationScore +
        w.continuity * profile.reputationScore +
        w.blockInverse * 1.0;

      candidates.push({ profile, score });
    }

    if (candidates.length === 0) {
      return jsonResponse({ match: null, reason: "no candidates" });
    }

    // Weighted random selection from top candidates
    candidates.sort((a, b) => b.score - a.score);

    // Simple weighted pick from top half
    const topN = Math.max(1, Math.ceil(candidates.length / 2));
    const top = candidates.slice(0, topN);
    const totalScore = top.reduce((sum, c) => sum + c.score, 0);
    let roll = Math.random() * totalScore;
    let chosen = top[0];

    for (const c of top) {
      roll -= c.score;
      if (roll <= 0) {
        chosen = c;
        break;
      }
    }

    return jsonResponse({
      match: {
        identityId: chosen.profile.identityId,
        username: chosen.profile.username,
        bio: chosen.profile.bio,
        interests: chosen.profile.interests,
        languages: chosen.profile.languages,
      },
      candidatesConsidered: candidates.length,
    });
  }

  // ── Groups ─────────────────────────────────────────────────────────

  private handleGroupsList(): Response {
    const discoverable = [...this.groups.values()].filter((g) => g.discoverable);
    return jsonResponse({ count: discoverable.length, groups: discoverable });
  }
}

// ── Fetch handler ────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.post("/discovery/profile", (c) => handleProfileUpsert(c.req.raw, c.env));
app.get("/discovery/profile/:identityId", (c) => handleProfileGet(c.req.param("identityId"), c.env));
app.delete("/discovery/profile/:identityId", (c) => handleProfileDelete(c.req.param("identityId"), c.req.raw, c.env));
app.post("/discovery/search/interest", (c) => handleSearchInterest(c.req.raw, c.env));
app.post("/discovery/search/language", (c) => handleSearchLanguage(c.req.raw, c.env));
app.post("/discovery/random-match", (c) => handleRandomMatch(c.req.raw, c.env));
app.post("/discovery/block", (c) => handleBlock(c.req.raw, c.env));
app.get("/discovery/groups", (c) => handleGroupsList(c.req.raw, c.env));
app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : "internal error" }, 500));

export default app;

async function handleProfileUpsert(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/profile/upsert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleProfileGet(identityId: string, env: Env): Promise<Response> {
  const stub = getDiscoveryStub(env);
  return stub.fetch(`https://discovery/do/profile/get?identityId=${encodeURIComponent(identityId)}`);
}

async function handleProfileDelete(identityId: string, request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { identityId?: unknown }).identityId !== identityId) {
    return jsonResponse({ error: "body identityId must match path" }, 400);
  }
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/profile/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleSearchInterest(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/search/interest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleSearchLanguage(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/search/language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleRandomMatch(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/random-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleBlock(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleGroupsList(_request: Request, env: Env): Promise<Response> {
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/groups/list");
}

function getDiscoveryStub(env: Env): DurableObjectStub {
  const id = env.DISCOVERY.idFromName("global");
  return env.DISCOVERY.get(id);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
