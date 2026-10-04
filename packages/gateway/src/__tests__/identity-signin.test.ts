import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "@nexnet/crypto";
import { signIdentityProof } from "@nexnet/protocol";
import {
  api,
  createIdentity,
  issueCertificate,
  linkSshKey,
  makeAuthenticator,
  makeDevice,
  makeSshKey,
  makeWallet,
  preimageFor,
  registerPasskey,
  requestChallenge,
  signInPasskey,
  signInSsh,
  signInWallet,
  startHarness,
  unsignedCertificate,
} from "./testkit.js";
import type { Harness } from "./testkit.js";
import { toBase64Url, toHex } from "../wire.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("identity creation", () => {
  test("a wallet proof creates an identity and repeating it is idempotent", async () => {
    const wallet = makeWallet();
    const first = await createIdentity(h.url, wallet);
    expect(first.status).toBe(201);
    expect(first.body.identityId).toBe(wallet.identityHex);
    const second = await createIdentity(h.url, wallet);
    expect(second.status).toBe(200);
    expect(second.body.existed).toBe(true);
  });

  test("a proof signed by a different key is rejected", async () => {
    const wallet = makeWallet();
    const other = makeWallet();
    const result = await api(h.url, "POST", "/v1/identity", {
      wallet: toHex(wallet.publicKey),
      proof: toBase64Url(signIdentityProof(other.secretKey, other.publicKey)),
    });
    expect(result.status).toBe(401);
    expect(await h.chain.getIdentity(wallet.identityId)).toBeNull();
  });

  test("malformed wallet or proof fields are rejected", async () => {
    expect((await api(h.url, "POST", "/v1/identity", { wallet: "zz", proof: "AA" })).status).toBe(400);
    expect((await api(h.url, "POST", "/v1/identity", {})).status).toBe(400);
    expect((await api(h.url, "POST", "/v1/identity", [])).status).toBe(400);
  });

  test("identity creation is rate limited per source", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await createIdentity(h.url, makeWallet())).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("wallet sign-in", () => {
  test("a root-signed device certificate signs in and the session describes the identity", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    const info = await api(h.url, "GET", "/v1/session", undefined, session.token);
    expect(info.status).toBe(200);
    expect(info.body.identityId).toBe(wallet.identityHex);
    expect(info.body.method).toBe("wallet");
    expect(info.body.owner).toBe(false);
    expect(info.body.nextSequence).toBe(1);
    expect(info.body.short).toMatch(/^nx1[0-9a-f]{4}…[0-9a-f]{4}$/);
  });

  test("an unregistered identity cannot request a challenge", async () => {
    const wallet = makeWallet();
    const certificate = issueCertificate(wallet, makeDevice(), h.clock);
    const result = await requestChallenge(h.url, "wallet", certificate);
    expect(result.status).toBe(404);
  });

  test("a certificate signed by someone else's wallet is refused even when it names the victim", async () => {
    const victim = makeWallet();
    const attacker = makeWallet();
    await createIdentity(h.url, victim);
    await createIdentity(h.url, attacker);
    const device = makeDevice();
    const forged = { ...issueCertificate(attacker, device, h.clock), accountId: victim.identityId };
    const challenge = await requestChallenge(h.url, "wallet", forged);
    expect(challenge.status).toBe(200);
    const preimage = preimageFor("wallet", challenge.body, forged);
    const verified = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
    });
    expect(verified.status).toBe(401);
  });

  test("the device must prove possession of its signing key", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const stranger = makeDevice();
    const certificate = issueCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "wallet", certificate);
    const preimage = preimageFor("wallet", challenge.body, certificate);
    const verified = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(stranger.signingSecretKey, preimage)),
    });
    expect(verified.status).toBe(401);
  });

  test("a challenge is single use", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const certificate = issueCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "wallet", certificate);
    const body = {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimageFor("wallet", challenge.body, certificate))),
    };
    expect((await api(h.url, "POST", "/v1/auth/verify", body)).status).toBe(201);
    expect((await api(h.url, "POST", "/v1/auth/verify", body)).status).toBe(401);
  });

  test("an expired challenge is refused", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const certificate = issueCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "wallet", certificate);
    h.clock.offset += 121_000;
    const verified = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(sign(device.signingSecretKey, preimageFor("wallet", challenge.body, certificate))),
    });
    expect(verified.status).toBe(401);
  });

  test("a signature made for a different method or challenge does not verify", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const device = makeDevice();
    const certificate = issueCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "wallet", certificate);
    const other = await requestChallenge(h.url, "wallet", certificate);
    const wrongMethod = preimageFor("ssh", challenge.body, certificate);
    const wrongChallenge = preimageFor("wallet", other.body, certificate);
    for (const preimage of [wrongMethod, wrongChallenge]) {
      const verified = await api(h.url, "POST", "/v1/auth/verify", {
        challengeId: challenge.body.challengeId,
        deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
      });
      expect(verified.status).toBe(401);
      const retry = await requestChallenge(h.url, "wallet", certificate);
      challenge.body = retry.body;
    }
  });

  test("certificates beyond the session lifetime or with extra capabilities are refused", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const tooLong = issueCertificate(wallet, makeDevice(), h.clock, 13 * 60 * 60 * 1000);
    expect((await requestChallenge(h.url, "wallet", tooLong)).status).toBe(400);
    const expired = issueCertificate(wallet, makeDevice(), h.clock, -1000);
    expect((await requestChallenge(h.url, "wallet", expired)).status).toBe(400);
    const greedy = { ...issueCertificate(wallet, makeDevice(), h.clock), capabilities: 255 };
    expect((await requestChallenge(h.url, "wallet", greedy)).status).toBe(400);
  });

  test("the bearer token is required and unknown tokens are refused", async () => {
    expect((await api(h.url, "GET", "/v1/session")).status).toBe(401);
    expect((await api(h.url, "GET", "/v1/session", undefined, "A".repeat(43))).status).toBe(401);
  });

  test("logout ends the session", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    expect((await api(h.url, "POST", "/v1/auth/logout", {}, session.token)).status).toBe(200);
    expect((await api(h.url, "GET", "/v1/session", undefined, session.token)).status).toBe(401);
  });

  test("sessions expire", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const session = await signInWallet(h, wallet);
    h.clock.offset += 61 * 60 * 1000;
    expect((await api(h.url, "GET", "/v1/session", undefined, session.token)).status).toBe(401);
  });
});

describe("ssh sign-in", () => {
  test("a wallet-linked ssh key signs in through real ssh-keygen signatures", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      expect((await linkSshKey(h.url, wallet, key)).status).toBe(201);
      const { result, session } = await signInSsh(h, wallet, key);
      expect(result.status).toBe(201);
      expect(result.body.method).toBe("ssh");
      expect((await api(h.url, "GET", "/v1/session", undefined, session!.token)).status).toBe(200);
    } finally {
      key.cleanup();
    }
  });

  test("an ssh key the wallet never linked cannot sign in", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      const { result } = await signInSsh(h, wallet, key);
      expect(result.status).toBe(401);
    } finally {
      key.cleanup();
    }
  });

  test("a key linked to one identity cannot sign in as another", async () => {
    const owner = makeWallet();
    const victim = makeWallet();
    await createIdentity(h.url, owner);
    await createIdentity(h.url, victim);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, owner, key);
      const { result } = await signInSsh(h, victim, key);
      expect(result.status).toBe(401);
    } finally {
      key.cleanup();
    }
  });

  test("linking requires the wallet's signature over that exact key", async () => {
    const wallet = makeWallet();
    const attacker = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    const attackerKey = await makeSshKey();
    try {
      const forged = await linkSshKey(h.url, attacker, key);
      expect(forged.status).toBe(404);
      const { signSshCommitment } = await import("@nexnet/protocol");
      const mismatched = await api(h.url, "POST", "/v1/credentials/ssh", {
        identityId: wallet.identityHex,
        publicKey: attackerKey.publicKeyLine,
        rootSignature: toBase64Url(
          signSshCommitment(wallet.secretKey, wallet.identityId, { algorithm: "ssh-ed25519", publicKey: key.publicKey })
        ),
      });
      expect(mismatched.status).toBe(403);
      expect((await api(h.url, "POST", "/v1/credentials/ssh", { identityId: wallet.identityHex, publicKey: "ssh-rsa AAAA", rootSignature: "AA" })).status).toBe(400);
    } finally {
      key.cleanup();
      attackerKey.cleanup();
    }
  });

  test("a signature for another namespace or another challenge is refused", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const key = await makeSshKey();
    try {
      await linkSshKey(h.url, wallet, key);
      const device = makeDevice();
      const certificate = unsignedCertificate(wallet, device, h.clock);
      const challenge = await requestChallenge(h.url, "ssh", certificate);
      const { sshSignAsync } = await import("./testkit.js");
      const preimage = preimageFor("ssh", challenge.body, certificate);
      const wrongNamespace = await sshSignAsync(key, preimage, "other-namespace");
      const verified = await api(h.url, "POST", "/v1/auth/verify", {
        challengeId: challenge.body.challengeId,
        deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
        ssh: { publicKey: key.publicKeyLine, signature: wrongNamespace },
      });
      expect(verified.status).toBe(401);

      const replayedFrom = await signInSsh(h, wallet, key, device);
      expect(replayedFrom.result.status).toBe(201);
      const secondChallenge = await requestChallenge(h.url, "ssh", certificate);
      const stale = await sshSignAsync(key, preimageFor("ssh", replayedFrom.challenge, certificate));
      const replay = await api(h.url, "POST", "/v1/auth/verify", {
        challengeId: secondChallenge.body.challengeId,
        deviceSignature: toBase64Url(
          sign(device.signingSecretKey, preimageFor("ssh", secondChallenge.body, certificate))
        ),
        ssh: { publicKey: key.publicKeyLine, signature: stale },
      });
      expect(replay.status).toBe(401);
    } finally {
      key.cleanup();
    }
  });
});

describe("passkey sign-in", () => {
  test("a wallet-registered passkey signs in with a real WebAuthn assertion", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    expect((await registerPasskey(h.url, wallet, authenticator)).status).toBe(201);
    const { result, session } = await signInPasskey(h, wallet, authenticator);
    expect(result.status).toBe(201);
    expect(result.body.method).toBe("passkey");
    expect((await api(h.url, "GET", "/v1/session", undefined, session!.token)).status).toBe(200);
  });

  test("an unregistered authenticator cannot sign in", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    await registerPasskey(h.url, wallet, makeAuthenticator());
    const { result } = await signInPasskey(h, wallet, makeAuthenticator());
    expect(result.status).toBe(401);
  });

  test("an assertion for the wrong origin is refused", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    await registerPasskey(h.url, wallet, authenticator);
    const { result } = await signInPasskey(h, wallet, authenticator, makeDevice(), { origin: "https://evil.test" });
    expect(result.status).toBe(401);
  });

  test("a replayed assertion cannot be used again", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    await registerPasskey(h.url, wallet, authenticator);
    const device = makeDevice();
    const first = await signInPasskey(h, wallet, authenticator, device);
    expect(first.result.status).toBe(201);
    const certificate = unsignedCertificate(wallet, device, h.clock);
    const challenge = await requestChallenge(h.url, "passkey", certificate);
    const stale = (await import("./testkit.js")).assertion(authenticator, first.challenge.passkeyChallenge!);
    const replay = await api(h.url, "POST", "/v1/auth/verify", {
      challengeId: challenge.body.challengeId,
      deviceSignature: toBase64Url(
        sign(device.signingSecretKey, preimageFor("passkey", challenge.body, certificate))
      ),
      passkey: stale,
    });
    expect(replay.status).toBe(401);
  });

  test("passkey registration is limited to the configured relying party and origins", async () => {
    const wallet = makeWallet();
    await createIdentity(h.url, wallet);
    const authenticator = makeAuthenticator();
    const { authorizePasskeyCredential } = await import("@nexnet/protocol");
    const credential = { credentialId: authenticator.credentialId, publicKey: authenticator.coseKey, counter: 0, rpId: "evil.test", origin: "https://evil.test" };
    const result = await api(h.url, "POST", "/v1/credentials/passkey", {
      identityId: wallet.identityHex,
      credential: { ...credential, publicKey: toBase64Url(credential.publicKey) },
      rootSignature: toBase64Url(authorizePasskeyCredential(wallet.secretKey, wallet.identityId, credential)),
    });
    expect(result.status).toBe(400);
  });
});

describe("passkeys disabled", () => {
  test("without an RP id the gateway refuses passkeys", async () => {
    const plain = await startHarness({ rpId: null });
    try {
      const wallet = makeWallet();
      await createIdentity(plain.url, wallet);
      const certificate = unsignedCertificate(wallet, makeDevice(), plain.clock);
      expect((await requestChallenge(plain.url, "passkey", certificate)).status).toBe(503);
      expect((await api(plain.url, "GET", "/v1/info")).body.methods).toEqual(["wallet", "ssh"]);
    } finally {
      await plain.close();
    }
  });
});
