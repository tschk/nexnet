/**
 * @nexnet/worker-discovery — profiles + random matching
 *
 * Durable Object: DiscoveryIndex
 * - Stores discovery profiles (interests, languages, bio)
 * - Search by interest / language
 * - Random match with hard gates and partial reputation ranking (AD-18)
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
import { DEFAULT_REPUTATION_WEIGHTS, REPUTATION_AGE_CAP_MS } from "@nexnet/types";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ── Types ────────────────────────────────────────────────────────────

interface StoredProfile {
  identityId: string;
  username: string;
  bio?: string;
  interests: string[];
  languages: string[];
  firstSeenAt: number;
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

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 32;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every(isShortString);
}

function validProfileFields(body: Record<string, unknown>): body is Record<string, unknown> & {
  username: string;
  bio?: string;
  interests?: string[];
  languages?: string[];
} {
  return (
    isShortString(body.username) &&
    (body.bio === undefined || typeof body.bio === "string") &&
    (body.interests === undefined || isStringList(body.interests)) &&
    (body.languages === undefined || isStringList(body.languages))
  );
}

interface Env {
  DISCOVERY: DurableObjectNamespace;
  RELAY_SERVICE?: Fetcher;
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

  constructor(
    state: DurableObjectState,
    private env: Env,
  ) {
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
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const p = value as Record<string, unknown>;
        if (
          typeof p.identityId !== "string" ||
          !IDENTITY_HEX.test(p.identityId) ||
          key !== `profile:${p.identityId}` ||
          !validProfileFields(p)
        )
          continue;
        // Legacy createdAt/online/reputationScore were client assertions, not evidence.
        const firstSeenAt =
          typeof p.firstSeenAt === "number" &&
          Number.isFinite(p.firstSeenAt) &&
          p.firstSeenAt >= 0 &&
          p.firstSeenAt <= Date.now()
            ? p.firstSeenAt
            : Date.now();
        const profile: StoredProfile = {
          identityId: p.identityId,
          username: p.username,
          bio: p.bio?.slice(0, 160),
          interests: p.interests ?? [],
          languages: p.languages ?? [],
          firstSeenAt,
        };
        // Persist the migration so legacy profiles do not reset their age on reload.
        await this.state.storage.put(key, profile);
        this.profiles.set(profile.identityId, profile);
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
    const body = authorized;
    const allowed = new Set(["identityId", "issuedAt", "auth", "username", "bio", "interests", "languages"]);
    if (Object.keys(body).some((key) => !allowed.has(key)) || !validProfileFields(body)) {
      return jsonResponse({ error: "invalid profile fields" }, 400);
    }

    const profile: StoredProfile = {
      identityId: body.identityId,
      username: body.username,
      bio: body.bio?.slice(0, 160), // AD-24: max 160 graphemes
      interests: body.interests ?? [],
      languages: body.languages ?? [],
      // Server-observed verified publication is an age lower bound, not chain root age.
      // Deleting and recreating a profile may reset its age.
      firstSeenAt: this.profiles.get(body.identityId)?.firstSeenAt ?? Date.now(),
    };

    await this.state.storage.put(`profile:${profile.identityId}`, profile);
    this.profiles.set(profile.identityId, profile);

    return jsonResponse({ ok: true, profile: await this.publicProfile(profile) });
  }

  private async relayOnline(identityId: string): Promise<boolean | null> {
    if (!this.env.RELAY_SERVICE) return null;
    try {
      const response = await this.env.RELAY_SERVICE.fetch(new Request(`https://relay/online/${identityId}`));
      if (response.status !== 200) return null;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("identityId" in body) || !("online" in body)) return null;
      return body.identityId === identityId && typeof body.online === "boolean" ? body.online : null;
    } catch {
      return null;
    }
  }

  private async publicProfile(profile: StoredProfile) {
    return {
      identityId: profile.identityId,
      username: profile.username,
      bio: profile.bio,
      interests: profile.interests,
      languages: profile.languages,
      online: await this.relayOnline(profile.identityId),
      reputationEvidence: "insufficient",
    };
  }

  private async handleProfileGet(url: URL): Promise<Response> {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

    const profile = this.profiles.get(identityId);
    if (!profile) {
      return jsonResponse({ error: "profile not found" }, 404);
    }

    return jsonResponse(await this.publicProfile(profile));
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
    let body: { tag?: unknown } | null;
    try {
      body = (await request.json()) as { tag?: unknown } | null;
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (!body || typeof body.tag !== "string" || !body.tag) {
      return jsonResponse({ error: "tag required" }, 400);
    }

    const tag = body.tag.toLowerCase();
    const results: StoredProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.interests.some((i) => i.toLowerCase() === tag)) {
        results.push(profile);
      }
    }

    return jsonResponse({
      tag,
      count: results.length,
      profiles: await Promise.all(results.map((p) => this.publicProfile(p))),
    });
  }

  private async handleSearchLanguage(request: Request): Promise<Response> {
    let body: { language?: unknown } | null;
    try {
      body = (await request.json()) as { language?: unknown } | null;
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (!body || typeof body.language !== "string" || !body.language) {
      return jsonResponse({ error: "language required" }, 400);
    }

    const lang = body.language.toLowerCase();
    const results: StoredProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.languages.some((l) => l.toLowerCase() === lang)) {
        results.push(profile);
      }
    }

    return jsonResponse({
      language: body.language,
      count: results.length,
      profiles: await Promise.all(results.map((p) => this.publicProfile(p))),
    });
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

    if (
      !isStringList(body.interests) ||
      !isStringList(body.languages) ||
      (body.exclude !== undefined &&
        (!Array.isArray(body.exclude) || !body.exclude.every((id) => typeof id === "string")))
    ) {
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

    // Eligibility uses hard gates only while reputation evidence is incomplete (AD-18).
    const candidates: { profile: StoredProfile; score: number }[] = [];

    for (const profile of this.profiles.values()) {
      if ((await this.relayOnline(profile.identityId)) !== true) continue;
      if (excludeSet.has(profile.identityId)) continue;
      if (this.blocks.get(body.identityId)?.has(profile.identityId)) continue;
      if (this.blocks.get(profile.identityId)?.has(body.identityId)) continue;

      // Must have at least one interest or language overlap
      const interestOverlap = profile.interests.some((i) => requesterInterests.has(i.toLowerCase()));
      const langOverlap = profile.languages.some((l) => requesterLangs.has(l.toLowerCase()));
      if (!interestOverlap && !langOverlap) continue;

      let blocksReceived = 0;
      for (const blocked of this.blocks.values()) {
        if (blocked.has(profile.identityId)) blocksReceived++;
      }
      const age = Math.min(1, Math.max(0, now - profile.firstSeenAt) / REPUTATION_AGE_CAP_MS);
      const w = DEFAULT_REPUTATION_WEIGHTS;
      // Missing session history and absence of reports earn no credit. Centering
      // the inverse-block term at zero preserves ordering, but only observed
      // signed blocks lower rank. This partial score is never an eligibility gate.
      const score = w.age * age - w.blockInverse * (1 - 1 / (1 + blocksReceived));

      candidates.push({ profile, score });
    }

    if (candidates.length === 0) {
      return jsonResponse({ match: null, reason: "no candidates" });
    }

    // Published weights determine rank, not eligibility. Include ties at the
    // cutoff so every equally new profile can be found, even when all rank zero.
    candidates.sort((a, b) => b.score - a.score);

    const topN = Math.max(1, Math.ceil(candidates.length / 2));
    const cutoff = candidates[topN - 1].score;
    const top = candidates.filter((candidate) => candidate.score >= cutoff);
    const chosen = top[Math.floor(Math.random() * top.length)];

    return jsonResponse({
      match: {
        identityId: chosen.profile.identityId,
        username: chosen.profile.username,
        bio: chosen.profile.bio,
        interests: chosen.profile.interests,
        languages: chosen.profile.languages,
        reputationEvidence: "insufficient",
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
