import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  requestChallenge,
  revocation,
  revoke,
  signInSsh,
  signInWallet,
  startHarness,
  unsignedCertificate,
  preimageFor,
  assertion,
} from "./testkit.js";
import type { Harness } from "./testkit.js";
import { sign } from "@nexnet/crypto";
import { toBase64Url } from "../wire.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("request size", () => {
  test("a chunked body over the limit is refused by the server", async () => {
    const chunk = new Uint8Array(32 * 1024).fill(97);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    let status = 0;
    try {
      const response = await fetch(`${h.url}/v1/identity`, {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "content-type": "application/json" },
      } as RequestInit);
      status = response.status;
    } catch {
      status = 413;
    }
    expect(status).toBe(413);
  });
});

describe("sequence isolation", () => {
  test("another identity reusing a device id cannot burn this identity's sequence", async () => {
    const alice = makeWallet();
    const mallory = makeWallet();
    await createIdentity(h.url, alice);
    await createIdentity(h.url, mallory);
    const device = makeDevice();
    const a = await signInWallet(h, alice, device);
    const m = await signInWallet(h, mallory, { ...makeDevice(), deviceId: device.deviceId });
    expect((await post(h, m, "public", "m1", { sequence: 50 })).status).toBe(201);
    expect((await post(h, a, "public", "a1")).status).toBe(201);
  });
});

describe("pending passkey challenges", () => {
  test("a stranger requesting a challenge for another device does not break an in-flight sign-in", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    await registerPasskey(h.url, wallet, authenticator);
    const device = makeDevice();
    const certificate = unsignedCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "passkey", certificate);
    const intruder = unsignedCertificate(wallet, makeDevice(), h.clock);
    expect((await requestChallenge(h.url, "passkey", intruder)).status).toBe(200);
    const verified = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimageFor("passkey", challenge.body, certificate))),
      passkey: assertion(authenticator, challenge.body.passkeyChallenge),
    });
    expect(verified.status).toBe(201);
  });
});

describe("pending passkey capacity", () => {
  test("a flood of new devices is refused with 429 and an in-flight sign-in survives", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    await registerPasskey(h.url, wallet, authenticator);
    const device = makeDevice();
    const certificate = unsignedCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "passkey", certificate);
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push(
        (await requestChallenge(h.url, "passkey", unsignedCertificate(wallet, makeDevice(), h.clock))).status,
      );
    }
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(15).every((s) => s === 429)).toBe(true);
    const verified = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimageFor("passkey", challenge.body, certificate))),
      passkey: assertion(authenticator, challenge.body.passkeyChallenge),
    });
    expect(verified.status).toBe(201);
  });
});

describe("device authorisation conflicts", () => {
  test("a different credential cannot take over an existing device id", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, wallet, key);
      const device = makeDevice();
      await signInWallet(h, wallet, device);
      const takeover = await signInSsh(h, wallet, key, device);
      expect(takeover.result.status).toBe(401);
      const fresh = await signInSsh(h, wallet, key);
      expect(fresh.result.status).toBe(201);
    } finally {
      key.cleanup();
    }
  });
});

describe("revocation input", () => {
  test("malformed credential ids and far-future sequences are refused", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    expect((await revoke(h.url, revocation(wallet, "device", session.deviceId.toUpperCase(), 1))).status).toBe(403);
    expect((await revoke(h.url, revocation(wallet, "device", "short", 1))).status).toBe(403);
    expect((await revoke(h.url, revocation(wallet, "ssh", "SHA256:nope", 1))).status).toBe(403);
    expect(
      (await revoke(h.url, revocation(wallet, "device", session.deviceId, Date.now() + 10 * 86_400_000))).status,
    ).toBe(403);
    expect((await post(h, session, "public", "still alive")).status).toBe(201);
  });
});

describe("invisible characters", () => {
  test("tag characters, zero-width spaces and combining floods are refused; ZWJ emoji are fine", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    for (const body of ["hi\u{e0041}there", "zero​width", "a" + "́".repeat(20), "soft­hyphen"]) {
      expect((await post(h, session, "public", body)).status).toBe(400);
    }
    expect((await post(h, session, "public", "family 👨‍👩‍👧 ok")).status).toBe(201);
  });
});

describe("proxy trust", () => {
  test("forwarded addresses are ignored unless trusted", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await fetch(`${h.url}/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` },
        body: "{}",
      });
      statuses.push(response.status);
    }
    expect(statuses.every((s) => s === 400)).toBe(true);
    const limited = await startHarness({ trustProxy: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 40; i++) {
        const response = await fetch(`${limited.url}/v1/auth/challenge`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
          body: "{}",
        });
        codes.push(response.status);
      }
      expect(codes).toContain(429);
      const other = await fetch(`${limited.url}/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.1.1.1" },
        body: "{}",
      });
      expect(other.status).toBe(400);
    } finally {
      await limited.close();
    }
  });
});
