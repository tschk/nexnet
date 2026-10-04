import { describe, expect, test } from "bun:test";
import { generateSigningKeyPair } from "@nexnet/crypto";
import {
  identityIdFromWallet,
  signIdentityProof,
  signInPreimage,
  signRevocation,
  signSshCommitment,
  verifyIdentityProof,
  verifyRevocation,
  verifySshCommitment,
} from "./credentials.js";

const key = new Uint8Array(32).fill(9);

describe("identity proofs", () => {
  test("the identity id is derived from the wallet and differs per wallet", () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    expect(identityIdFromWallet(a.publicKey)).toHaveLength(32);
    expect(identityIdFromWallet(a.publicKey)).toEqual(identityIdFromWallet(a.publicKey));
    expect(identityIdFromWallet(a.publicKey)).not.toEqual(identityIdFromWallet(b.publicKey));
  });

  test("only the wallet's own proof verifies", () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    expect(verifyIdentityProof(a.publicKey, signIdentityProof(a.secretKey, a.publicKey))).toBe(true);
    expect(verifyIdentityProof(a.publicKey, signIdentityProof(b.secretKey, a.publicKey))).toBe(false);
  });
});

describe("ssh commitments", () => {
  test("bind the account and the exact key", () => {
    const root = generateSigningKeyPair();
    const accountId = identityIdFromWallet(root.publicKey);
    const commitment = { algorithm: "ssh-ed25519" as const, publicKey: key };
    const signature = signSshCommitment(root.secretKey, accountId, commitment);
    expect(verifySshCommitment(root.publicKey, accountId, commitment, signature)).toBe(true);
    expect(
      verifySshCommitment(
        root.publicKey,
        accountId,
        { ...commitment, publicKey: new Uint8Array(32).fill(1) },
        signature,
      ),
    ).toBe(false);
    expect(verifySshCommitment(root.publicKey, new Uint8Array(32), commitment, signature)).toBe(false);
  });
});

describe("revocations", () => {
  test("bind kind, credential id and sequence", () => {
    const root = generateSigningKeyPair();
    const accountId = identityIdFromWallet(root.publicKey);
    const revocation = signRevocation(root.secretKey, {
      accountId,
      kind: "ssh",
      credentialId: "SHA256:x",
      sequence: 3,
    });
    expect(verifyRevocation(root.publicKey, revocation)).toBe(true);
    expect(verifyRevocation(root.publicKey, { ...revocation, sequence: 4 })).toBe(false);
    expect(verifyRevocation(root.publicKey, { ...revocation, kind: "passkey" })).toBe(false);
    expect(verifyRevocation(root.publicKey, { ...revocation, credentialId: "SHA256:y" })).toBe(false);
    expect(verifyRevocation(generateSigningKeyPair().publicKey, revocation)).toBe(false);
  });
});

describe("sign-in preimage", () => {
  test("changes with the audience, method and challenge", () => {
    const base = {
      audience: "a",
      method: "wallet" as const,
      challengeId: "c",
      nonce: "n",
      expiresAt: 1,
      certificate: {
        accountId: key,
        deviceId: key,
        deviceSigningPublicKey: key,
        deviceEncryptionPublicKey: key,
        issuedAt: 1,
        expiresAt: 2,
        capabilities: 1,
      },
    };
    const original = signInPreimage(base);
    expect(signInPreimage({ ...base })).toEqual(original);
    expect(signInPreimage({ ...base, audience: "b" })).not.toEqual(original);
    expect(signInPreimage({ ...base, method: "ssh" })).not.toEqual(original);
    expect(signInPreimage({ ...base, challengeId: "d" })).not.toEqual(original);
    expect(signInPreimage({ ...base, nonce: "m" })).not.toEqual(original);
  });
});
