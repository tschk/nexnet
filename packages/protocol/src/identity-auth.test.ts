import { describe, expect, test } from "bun:test";
import { generateKeyPair, generateSigningKeyPair } from "@nexnet/crypto";
import { identityIdFromWallet } from "./credentials.js";
import { issueDeviceCert } from "./device-cert.js";
import { signIdentityAuthJson, verifyIdentityAuthJson } from "./identity-auth.js";
import { toHex } from "./wire.js";

function account() {
  const root = generateSigningKeyPair();
  return { root, id: identityIdFromWallet(root.publicKey) };
}

describe("identity auth", () => {
  test("root-signed request verifies only for the root's own identity", () => {
    const alice = account();
    const bob = account();
    const body = signIdentityAuthJson(
      { rootPublicKey: alice.root.publicKey, secretKey: alice.root.secretKey },
      "op",
      alice.id,
      { x: 1, issuedAt: 5 },
    );
    expect(verifyIdentityAuthJson(body, "op", toHex(alice.id))).toEqual({ deviceId: null });
    // Claiming another identity with your own valid key fails.
    expect(verifyIdentityAuthJson(body, "op", toHex(bob.id))).toBeNull();
    // Signature is bound to the operation and to every field.
    expect(verifyIdentityAuthJson(body, "other", toHex(alice.id))).toBeNull();
    expect(verifyIdentityAuthJson({ ...body, x: 2 }, "op", toHex(alice.id))).toBeNull();
    expect(verifyIdentityAuthJson({ ...body, extra: true }, "op", toHex(alice.id))).toBeNull();
  });

  test("device-signed request needs a current certificate from the identity's root", () => {
    const alice = account();
    const mallory = account();
    const device = generateSigningKeyPair();
    const deviceId = new Uint8Array(32).fill(4);
    const now = Date.now();
    const cert = (rootSk: Uint8Array, accountId: Uint8Array, expiresAt = now + 60_000) =>
      issueDeviceCert(
        rootSk,
        device.publicKey,
        generateKeyPair().publicKey,
        deviceId,
        accountId,
        now - 1,
        expiresAt,
        1,
      );

    const ok = signIdentityAuthJson(
      {
        rootPublicKey: alice.root.publicKey,
        secretKey: device.secretKey,
        certificate: cert(alice.root.secretKey, alice.id),
      },
      "op",
      alice.id,
      { issuedAt: now },
    );
    expect(verifyIdentityAuthJson(ok, "op", toHex(alice.id), now)?.deviceId).toEqual(deviceId);

    // Certificate signed by a different root for alice's account id.
    const forged = signIdentityAuthJson(
      {
        rootPublicKey: alice.root.publicKey,
        secretKey: device.secretKey,
        certificate: cert(mallory.root.secretKey, alice.id),
      },
      "op",
      alice.id,
      { issuedAt: now },
    );
    expect(verifyIdentityAuthJson(forged, "op", toHex(alice.id), now)).toBeNull();

    const expired = signIdentityAuthJson(
      {
        rootPublicKey: alice.root.publicKey,
        secretKey: device.secretKey,
        certificate: cert(alice.root.secretKey, alice.id, now),
      },
      "op",
      alice.id,
      { issuedAt: now },
    );
    expect(verifyIdentityAuthJson(expired, "op", toHex(alice.id), now)).toBeNull();
  });

  test("missing or malformed auth is rejected", () => {
    const alice = account();
    expect(verifyIdentityAuthJson({ issuedAt: 1 }, "op", toHex(alice.id))).toBeNull();
    expect(verifyIdentityAuthJson({ auth: { rootPublicKey: "zz" } }, "op", toHex(alice.id))).toBeNull();
  });
});
