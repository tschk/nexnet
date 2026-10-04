import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  api,
  createIdentity,
  linkSshKey,
  makeAuthenticator,
  makeDevice,
  makeSshKey,
  makeWallet,
  post,
  registerPasskey,
  revocation,
  revoke,
  signInPasskey,
  signInSsh,
  signInWallet,
  startHarness,
} from "./testkit.js";
import type { Harness } from "./testkit.js";
import { DevChainClient } from "@nexnet/client/chain-stub";
import { Gateway } from "../gateway.js";
import { toHex } from "../wire.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("revoked device certificates", () => {
  test("revoking a device ends its session and blocks posting", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    expect((await post(h, session, "public", "before")).status).toBe(201);
    const result = await revoke(h.url, revocation(wallet, "device", session.deviceId, 1));
    expect(result.status).toBe(200);
    const after = await post(h, session, "public", "after");
    expect(after.status).toBe(401);
    expect((await api(h.url, "GET", "/v1/session", undefined, session.token)).status).toBe(401);
  });

  test("a revoked device cannot sign in again", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const session = await signInWallet(h, wallet, device);
    await revoke(h.url, revocation(wallet, "device", session.deviceId, 1));
    await expect(signInWallet(h, wallet, device)).rejects.toThrow(/revoked/i);
  });

  test("revoking one device leaves the others signed in", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const laptop = await signInWallet(h, wallet);
    const phone = await signInWallet(h, wallet);
    await revoke(h.url, revocation(wallet, "device", laptop.deviceId, 1));
    expect((await post(h, phone, "public", "still here")).status).toBe(201);
    expect((await post(h, laptop, "public", "gone")).status).toBe(401);
  });
});

describe("revoked ssh keys", () => {
  test("revoking the key kills sessions it authorised and blocks new sign-ins", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, wallet, key);
      const first = await signInSsh(h, wallet, key);
      expect(first.result.status).toBe(201);
      expect((await post(h, first.session!, "public", "via ssh")).status).toBe(201);
      expect((await revoke(h.url, revocation(wallet, "ssh", key.fingerprint, 1))).status).toBe(200);
      expect((await post(h, first.session!, "public", "after revoke")).status).toBe(401);
      const again = await signInSsh(h, wallet, key);
      expect(again.result.status).toBe(403);
    } finally {
      key.cleanup();
    }
  });

  test("revoking an ssh key does not end wallet sessions", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, wallet, key);
      const walletSession = await signInWallet(h, wallet);
      await revoke(h.url, revocation(wallet, "ssh", key.fingerprint, 1));
      expect((await post(h, walletSession, "public", "wallet unaffected")).status).toBe(201);
    } finally {
      key.cleanup();
    }
  });

  test("a revoked key cannot be linked again", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, wallet, key);
      await revoke(h.url, revocation(wallet, "ssh", key.fingerprint, 1));
      expect((await linkSshKey(h.url, wallet, key)).status).toBe(403);
    } finally {
      key.cleanup();
    }
  });
});

describe("revoked passkeys", () => {
  test("revoking the credential ends sessions and blocks sign-in", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    await registerPasskey(h.url, wallet, authenticator);
    const first = await signInPasskey(h, wallet, authenticator);
    expect(first.result.status).toBe(201);
    expect((await post(h, first.session!, "public", "via passkey")).status).toBe(201);
    await revoke(h.url, revocation(wallet, "passkey", authenticator.credentialId, 1));
    expect((await post(h, first.session!, "public", "after revoke")).status).toBe(401);
    await expect(signInPasskey(h, wallet, authenticator)).rejects.toThrow(/passkey/i);
  });
});

describe("revocation authority", () => {
  test("only the identity's own wallet can revoke", async () => {
    const victim = makeWallet();
    const attacker = makeWallet();
    await createIdentity(h.url, victim);
    const session = await signInWallet(h, victim);
    const forged = revocation(attacker, "device", session.deviceId, 1);
    const result = await revoke(h.url, { ...forged, accountId: victim.identityId });
    expect(result.status).toBe(403);
    expect((await post(h, session, "public", "still works")).status).toBe(201);
  });

  test("stale or replayed revocation sequences are rejected", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const a = await signInWallet(h, wallet);
    const b = await signInWallet(h, wallet);
    expect((await revoke(h.url, revocation(wallet, "device", a.deviceId, 5))).status).toBe(200);
    expect((await revoke(h.url, revocation(wallet, "device", b.deviceId, 5))).status).toBe(403);
    expect((await revoke(h.url, revocation(wallet, "device", b.deviceId, 4))).status).toBe(403);
    expect((await revoke(h.url, revocation(wallet, "device", b.deviceId, 6))).status).toBe(200);
  });

  test("revoking for an unknown identity is a 404", async () => {
    const stranger = makeWallet();
    const result = await revoke(h.url, revocation(stranger, "device", "00".repeat(32), 1));
    expect(result.status).toBe(404);
  });
});

describe("streaming and reconnects", () => {
  function open(url: string): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace("http", "ws") + "/v1/stream", { headers: { origin: "https://nexnet.test" } } as never);
      const frames: any[] = [];
      let closeResolve: (code: number) => void = () => {};
      const closed = new Promise<number>((r) => (closeResolve = r));
      ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      ws.onclose = (event) => closeResolve(event.code);
      ws.onopen = () => resolve({ ws, frames, closed });
      ws.onerror = () => reject(new Error("socket error"));
    });
  }

  async function until(predicate: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error("timed out");
      await Bun.sleep(10);
    }
  }

  test("an anonymous stream receives public posts live", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    const { ws, frames } = await open(h.url);
    ws.send(JSON.stringify({}));
    await until(() => frames.some((f) => f.event === "ready"));
    expect(frames[0].authenticated).toBe(false);
    await post(h, session, "public", "live message");
    await until(() => frames.some((f) => f.event === "message"));
    expect(frames.find((f) => f.event === "message").message.body).toBe("live message");
    ws.close();
  });

  test("a stream with a bad token is refused and closed", async () => {
    const { ws, frames, closed } = await open(h.url);
    ws.send(JSON.stringify({ token: "B".repeat(43) }));
    expect(await closed).toBe(4400);
    expect(frames[0].event).toBe("error");
    expect(frames[0].code).toBe("unauthenticated");
  });

  test("a stream that never authenticates is closed", async () => {
    const { closed } = await open(h.url);
    expect(await closed).toBe(4408);
  });

  test("a stream can subscribe to one channel only", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    const { ws, frames } = await open(h.url);
    ws.send(JSON.stringify({ channels: ["updates"] }));
    await until(() => frames.some((f) => f.event === "ready"));
    await post(h, session, "public", "not for you");
    await Bun.sleep(100);
    expect(frames.some((f) => f.event === "message")).toBe(false);
    ws.close();
  });

  test("revoking a credential closes its authenticated stream", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    const { ws, frames, closed } = await open(h.url);
    ws.send(JSON.stringify({ token: session.token }));
    await until(() => frames.some((f) => f.event === "ready"));
    expect(frames[0].authenticated).toBe(true);
    await revoke(h.url, revocation(wallet, "device", session.deviceId, 1));
    expect(await closed).toBe(4401);
    expect(frames.some((f) => f.event === "revoked")).toBe(true);
  });

  test("reconnecting with the same token resumes the session and sequence", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    expect((await post(h, session, "public", "one")).status).toBe(201);
    expect((await post(h, session, "public", "two")).status).toBe(201);
    const first = await open(h.url);
    first.ws.send(JSON.stringify({ token: session.token }));
    await until(() => first.frames.some((f) => f.event === "ready"));
    first.ws.close();
    const second = await open(h.url);
    second.ws.send(JSON.stringify({ token: session.token }));
    await until(() => second.frames.some((f) => f.event === "ready"));
    expect(second.frames[0].authenticated).toBe(true);
    const info = await api(h.url, "GET", "/v1/session", undefined, session.token);
    expect(info.body.nextSequence).toBe(3);
    session.sequence = info.body.nextSequence;
    expect((await post(h, session, "public", "three")).status).toBe(201);
    second.ws.close();
  });

  test("a gateway restart keeps sessions, sequences, history and revocations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexnet-restart-"));
    const first = await startHarness({ stateDir: dir });
    try {
      const wallet = makeWallet();
      await createIdentity(first.url, wallet);
      const kept = await signInWallet(first, wallet);
      const doomed = await signInWallet(first, wallet);
      expect((await post(first, kept, "public", "before restart")).status).toBe(201);
      await revoke(first.url, revocation(wallet, "device", doomed.deviceId, 1));
      await first.handle.close();

      const chain = new DevChainClient(join(dir, "chain.json"));
      const gateway = new Gateway(
        {
          audience: "nexnet:test",
          ownerIdentity: null,
          stateDir: dir,
          rpId: null,
          origins: [],
          now: () => first.clock.now(),
          publicRetentionMs: 86_400_000,
          sessionMaxMs: 43_200_000,
        },
        chain
      );
      const second = gateway.listen(0);
      try {
        const info = await api(second.url, "GET", "/v1/session", undefined, kept.token);
        expect(info.status).toBe(200);
        expect(info.body.nextSequence).toBe(2);
        kept.sequence = info.body.nextSequence;
        expect((await post({ url: second.url }, kept, "public", "after restart")).status).toBe(201);
        const replay = await post({ url: second.url }, kept, "public", "replay", { sequence: 1 });
        expect(replay.status).toBe(409);
        expect((await post({ url: second.url }, doomed, "public", "revoked still revoked")).status).toBe(401);
        const history = await api(second.url, "GET", "/v1/channels/public/messages");
        expect(history.body.messages.map((m: { body: string }) => m.body)).toEqual(["before restart", "after restart"]);
        expect(toHex(wallet.identityId)).toBe(kept.identityId);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
