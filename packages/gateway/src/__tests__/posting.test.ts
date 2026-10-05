import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signEvent, cdeEncode } from "@nexnet/protocol";
import { api, createIdentity, makeDevice, makeWallet, post, postEvent, signInWallet, startHarness } from "./testkit.js";
import type { Harness } from "./testkit.js";
import { eventToJson } from "../wire.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

async function member() {
  const wallet = makeWallet();
  await createIdentity(h.url, wallet);
  return signInWallet(h, wallet);
}

describe("reading", () => {
  test("history is public without signing in", async () => {
    const session = await member();
    await post(h, session, "public", "hello world");
    const read = await api(h.url, "GET", "/v1/channels/public/messages?limit=10");
    expect(read.status).toBe(200);
    expect(read.body.messages).toHaveLength(1);
    expect(read.body.messages[0].body).toBe("hello world");
    expect(read.body.messages[0].author.id).toBe(session.identityId);
    expect(read.body.messages[0].author.username).toBeNull();
  });

  test("unknown channels and bad limits are refused", async () => {
    expect((await api(h.url, "GET", "/v1/channels/secret/messages")).status).toBe(404);
    expect((await api(h.url, "GET", "/v1/channels/public/messages?limit=0")).status).toBe(400);
    expect((await api(h.url, "GET", "/v1/channels/public/messages?limit=1000")).status).toBe(400);
    expect((await api(h.url, "GET", "/v1/channels/public/messages?before=-1")).status).toBe(400);
  });

  test("history pages backwards with before", async () => {
    const session = await member();
    for (const text of ["one", "two", "three"]) {
      expect((await post(h, session, "public", text)).status).toBe(201);
    }
    const all = await api(h.url, "GET", "/v1/channels/public/messages");
    expect(all.body.messages.map((m: { body: string }) => m.body)).toEqual(["one", "two", "three"]);
    const older = await api(h.url, "GET", `/v1/channels/public/messages?before=${all.body.messages[2].seq}&limit=1`);
    expect(older.body.messages.map((m: { body: string }) => m.body)).toEqual(["two"]);
  });
});

describe("posting permissions", () => {
  test("posting without a token is refused", async () => {
    const session = await member();
    const event = postEvent(session, "public", "anonymous");
    const result = await api(h.url, "POST", "/v1/channels/public/messages", { event: eventToJson(event) });
    expect(result.status).toBe(401);
    expect((await api(h.url, "GET", "/v1/channels/public/messages")).body.messages).toHaveLength(0);
  });

  test("a registered identity posts to public", async () => {
    const session = await member();
    const result = await post(h, session, "public", "first");
    expect(result.status).toBe(201);
    expect(result.body.message.channel).toBe("public");
  });

  test("a non-owner cannot post to updates", async () => {
    const session = await member();
    const result = await post(h, session, "updates", "not allowed");
    expect(result.status).toBe(403);
    expect((await api(h.url, "GET", "/v1/channels/updates/messages")).body.messages).toHaveLength(0);
  });

  test("the configured owner posts to updates and the session reports owner", async () => {
    await createIdentity(h.url, h.owner);
    const session = await signInWallet(h, h.owner);
    const info = await api(h.url, "GET", "/v1/session", undefined, session.token);
    expect(info.body.owner).toBe(true);
    expect((await post(h, session, "updates", "shipping")).status).toBe(201);
    const read = await api(h.url, "GET", "/v1/channels/updates/messages");
    expect(read.body.messages[0].body).toBe("shipping");
  });

  test("with no owner configured nobody can post to updates", async () => {
    const closed = await startHarness({ withOwner: false });
    try {
      const wallet = makeWallet();
      await createIdentity(closed.url, wallet);
      const session = await signInWallet(closed, wallet);
      expect((await post(closed, session, "updates", "hello")).status).toBe(403);
      expect((await api(closed.url, "GET", "/v1/info")).body.ownerConfigured).toBe(false);
    } finally {
      await closed.close();
    }
  });

  test("an identity that merely resembles the owner cannot post to updates", async () => {
    const impostor = makeWallet();
    await createIdentity(h.url, impostor);
    const session = await signInWallet(h, impostor);
    expect((await post(h, session, "updates", "I am the owner")).status).toBe(403);
  });
});

describe("wrong identities and forged events", () => {
  test("an event authored as another identity is refused", async () => {
    const alice = await member();
    const bob = await member();
    const forged = signEvent(
      {
        protocolVersion: 1,
        eventType: "channel.post",
        authorIdentityId: bob.wallet.identityId,
        authorDeviceId: new Uint8Array(bob.device.deviceId),
        createdAt: Date.now(),
        sequence: 1,
        parentIds: [],
        payload: cdeEncode({ channel: "public", body: "as bob" }),
      },
      alice.device.signingSecretKey,
    );
    const result = await api(
      h.url,
      "POST",
      "/v1/channels/public/messages",
      { event: eventToJson(forged) },
      alice.token,
    );
    expect(result.status).toBe(403);
  });

  test("an event signed by a different key than the session device is refused", async () => {
    const alice = await member();
    const result = await post(h, alice, "public", "forged", { signWith: makeDevice().signingSecretKey });
    expect(result.status).toBe(401);
  });

  test("one session's token cannot post another session's event", async () => {
    const alice = await member();
    const bob = await member();
    const event = postEvent(bob, "public", "bob wrote this");
    const result = await api(h.url, "POST", "/v1/channels/public/messages", { event: eventToJson(event) }, alice.token);
    expect(result.status).toBe(403);
  });

  test("a tampered body invalidates the signature", async () => {
    const alice = await member();
    const event = postEvent(alice, "public", "original");
    const tampered = { ...event, payload: cdeEncode({ channel: "public", body: "tampered" }) };
    const result = await api(
      h.url,
      "POST",
      "/v1/channels/public/messages",
      { event: eventToJson(tampered) },
      alice.token,
    );
    expect(result.status).toBe(401);
  });

  test("an event with a forged event id is refused", async () => {
    const alice = await member();
    const event = postEvent(alice, "public", "ids");
    const forged = { ...event, eventId: new Uint8Array(32).fill(7) };
    const result = await api(
      h.url,
      "POST",
      "/v1/channels/public/messages",
      { event: eventToJson(forged) },
      alice.token,
    );
    expect(result.status).toBe(401);
  });

  test("malformed events are refused with 400", async () => {
    const alice = await member();
    for (const event of [null, {}, "x", { eventType: 1 }]) {
      const result = await api(h.url, "POST", "/v1/channels/public/messages", { event }, alice.token);
      expect(result.status).toBe(400);
    }
    const wrongType = signEvent(
      {
        protocolVersion: 1,
        eventType: "dm.message",
        authorIdentityId: alice.wallet.identityId,
        authorDeviceId: new Uint8Array(alice.device.deviceId),
        createdAt: Date.now(),
        sequence: 1,
        parentIds: [],
        payload: cdeEncode({ channel: "public", body: "x" }),
      },
      alice.device.signingSecretKey,
    );
    expect(
      (await api(h.url, "POST", "/v1/channels/public/messages", { event: eventToJson(wrongType) }, alice.token)).status,
    ).toBe(400);
  });
});

describe("replays", () => {
  test("resubmitting an accepted event is rejected as a duplicate", async () => {
    const alice = await member();
    const event = postEvent(alice, "public", "once");
    const body = { event: eventToJson(event) };
    expect((await api(h.url, "POST", "/v1/channels/public/messages", body, alice.token)).status).toBe(201);
    const replay = await api(h.url, "POST", "/v1/channels/public/messages", body, alice.token);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("duplicate");
    expect((await api(h.url, "GET", "/v1/channels/public/messages")).body.messages).toHaveLength(1);
  });

  test("a replay from a fresh session of the same device is still a duplicate", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const first = await signInWallet(h, wallet, device);
    const event = postEvent(first, "public", "replay me");
    const body = { event: eventToJson(event) };
    expect((await api(h.url, "POST", "/v1/channels/public/messages", body, first.token)).status).toBe(201);
    const second = await signInWallet(h, wallet, device);
    expect((await api(h.url, "POST", "/v1/channels/public/messages", body, second.token)).status).toBe(409);
  });

  test("an old sequence number is rejected even with a new event", async () => {
    const alice = await member();
    expect((await post(h, alice, "public", "a")).status).toBe(201);
    expect((await post(h, alice, "public", "b")).status).toBe(201);
    const stale = await post(h, alice, "public", "c", { sequence: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("stale_sequence");
  });

  test("a post signed for public cannot be replayed into updates by the owner", async () => {
    await createIdentity(h.url, h.owner);
    const owner = await signInWallet(h, h.owner);
    const event = postEvent(owner, "public", "public only");
    const result = await api(
      h.url,
      "POST",
      "/v1/channels/updates/messages",
      { event: eventToJson(event) },
      owner.token,
    );
    expect(result.status).toBe(400);
  });

  test("events outside the clock window are rejected", async () => {
    const alice = await member();
    expect((await post(h, alice, "public", "old", { createdAt: Date.now() - 10 * 60_000 })).status).toBe(400);
    expect((await post(h, alice, "public", "future", { createdAt: Date.now() + 10 * 60_000 })).status).toBe(400);
  });
});

describe("content and rate limits", () => {
  test("terminal control sequences, bidi controls, empties and oversize bodies are refused", async () => {
    const alice = await member();
    const cases = ["\u001b[31mred", "line\nbreak", "tab\there", "   ", "", "x".repeat(2001), "a‮b", "nul\u0000"];
    for (const body of cases) {
      const result = await post(h, alice, "public", body);
      expect(result.status).toBe(400);
    }
    expect((await post(h, alice, "public", "x".repeat(2000))).status).toBe(201);
    expect((await post(h, alice, "public", "multi-byte 世界 🙂")).status).toBe(201);
  });

  test("the public channel allows five posts a minute per identity", async () => {
    const alice = await member();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post(h, alice, "public", `message ${i}`)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429]);
    h.clock.offset += 61_000;
    expect((await post(h, alice, "public", "after the window")).status).toBe(201);
  });

  test("one identity's burst does not rate limit another", async () => {
    const alice = await member();
    const bob = await member();
    for (let i = 0; i < 6; i++) await post(h, alice, "public", `a${i}`);
    expect((await post(h, bob, "public", "still fine")).status).toBe(201);
  });

  test("repeating the same text is blocked as spam", async () => {
    const alice = await member();
    expect((await post(h, alice, "public", "buy now")).status).toBe(201);
    expect((await post(h, alice, "public", "buy now")).status).toBe(201);
    expect((await post(h, alice, "public", "buy now")).status).toBe(429);
  });

  test("public history lapses after the retention window of inactivity", async () => {
    const short = await startHarness({ publicRetentionMs: 60_000 });
    try {
      const wallet = makeWallet();
      await createIdentity(short.url, wallet);
      const session = await signInWallet(short, wallet);
      await post(short, session, "public", "ephemeral");
      expect((await api(short.url, "GET", "/v1/channels/public/messages")).body.messages).toHaveLength(1);
      short.clock.offset += 61_000;
      expect((await api(short.url, "GET", "/v1/channels/public/messages")).body.messages).toHaveLength(0);
    } finally {
      await short.close();
    }
  });

  test("oversized request bodies are refused", async () => {
    const response = await fetch(`${h.url}/v1/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "x".repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("browser access", () => {
  test("only configured origins receive CORS headers", async () => {
    const allowed = await fetch(`${h.url}/v1/info`, { headers: { origin: "https://nexnet.test" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://nexnet.test");
    const denied = await fetch(`${h.url}/v1/info`, { headers: { origin: "https://evil.test" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${h.url}/v1/channels/public/messages`, {
      method: "OPTIONS",
      headers: { origin: "https://nexnet.test", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
