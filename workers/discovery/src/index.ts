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
 */

import {
  DEFAULT_REPUTATION_THRESHOLD,
  DEFAULT_REPUTATION_WEIGHTS,
} from "@nexnet/types";

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

interface Env {
  DISCOVERY: DurableObjectNamespace;
}

type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

// ── Durable Object: DiscoveryIndex ───────────────────────────────────

export class DiscoveryIndex {
  private state: DurableObjectState;
  private profiles = new Map<string, StoredProfile>();
  private groups = new Map<string, StoredGroup>();
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
        return this.handleProfileDelete(url);
      case "/do/search/interest":
        return this.handleSearchInterest(request);
      case "/do/search/language":
        return this.handleSearchLanguage(request);
      case "/do/random-match":
        return this.handleRandomMatch(request);
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
      }
    }
    this.loaded = true;
  }

  // ── Profile CRUD ───────────────────────────────────────────────────

  private async handleProfileUpsert(request: Request): Promise<Response> {
    let body: StoredProfile;
    try {
      body = (await request.json()) as StoredProfile;
      if (!body.identityId || !body.username) {
        return jsonResponse({ error: "identityId and username required" }, 400);
      }
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
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

  private async handleProfileDelete(url: URL): Promise<Response> {
    const identityId = url.searchParams.get("identityId");
    if (!identityId) {
      return jsonResponse({ error: "identityId param required" }, 400);
    }

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

  private async handleRandomMatch(request: Request): Promise<Response> {
    let body: {
      identityId?: string;
      interests?: string[];
      languages?: string[];
      exclude?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (!body.identityId || !body.interests || !body.languages) {
      return jsonResponse({ error: "identityId, interests, languages required" }, 400);
    }

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

      // Must have at least one interest or language overlap
      const interestOverlap = profile.interests.some((i) =>
        requesterInterests.has(i.toLowerCase())
      );
      const langOverlap = profile.languages.some((l) =>
        requesterLangs.has(l.toLowerCase())
      );
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

const routes: Record<string, RouteHandler> = {
  "POST /discovery/profile": handleProfileUpsert,
  "POST /discovery/search/interest": handleSearchInterest,
  "POST /discovery/search/language": handleSearchLanguage,
  "POST /discovery/random-match": handleRandomMatch,
  "GET /discovery/groups": handleGroupsList,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const url = new URL(request.url);
      const routeKey = `${request.method} ${url.pathname}`;

      // Check static routes
      const handler = routes[routeKey];
      if (handler) {
        return addCorsHeaders(await handler(request, env, ctx));
      }

      // /discovery/profile/:identityId (GET or DELETE)
      const profileMatch = url.pathname.match(/^\/discovery\/profile\/([^/]+)$/);
      if (profileMatch) {
        const identityId = profileMatch[1];
        if (request.method === "GET") {
          return addCorsHeaders(await handleProfileGet(identityId, env));
        }
        if (request.method === "DELETE") {
          return addCorsHeaders(await handleProfileDelete(identityId, env));
        }
      }

      return addCorsHeaders(jsonResponse({ error: "not found" }, 404));
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return addCorsHeaders(jsonResponse({ error: message }, 500));
    }
  },
};

async function handleProfileUpsert(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/profile/upsert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleProfileGet(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getDiscoveryStub(env);
  return stub.fetch(`https://discovery/do/profile/get?identityId=${encodeURIComponent(identityId)}`);
}

async function handleProfileDelete(
  identityId: string,
  env: Env
): Promise<Response> {
  const stub = getDiscoveryStub(env);
  return stub.fetch(`https://discovery/do/profile/delete?identityId=${encodeURIComponent(identityId)}`);
}

async function handleSearchInterest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/search/interest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleSearchLanguage(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/search/language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleRandomMatch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/random-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function handleGroupsList(
  _request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const stub = getDiscoveryStub(env);
  return stub.fetch("https://discovery/do/groups/list");
}

function getDiscoveryStub(env: Env): DurableObjectStub {
  const id = env.DISCOVERY.idFromName("global");
  return env.DISCOVERY.get(id);
}

// ── Helpers ──────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
