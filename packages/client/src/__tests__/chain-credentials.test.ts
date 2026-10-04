import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKeyPair } from "@nexnet/crypto";
import {
  identityIdFromWallet,
  issueDeviceCert,
  signIdentityProof,
  signRevocation,
  signSshCommitment,
  sshFingerprint,
} from "@nexnet/protocol";
import { DevChainClient } from "../chain-stub.js";

function wallet() {
  const { secretKey, publicKey } = generateSigningKeyPair();
  return { secretKey, publicKey, identityId: identityIdFromWallet(publicKey) };
}

async function registered(chain: DevChainClient) {
  const w = wallet();
  await chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(w.secretKey, w.publicKey));
  return w;
}

function certificate(w: ReturnType<typeof wallet>, device = generateSigningKeyPair(), id = new Uint8Array(32).fill(5)) {
  const now = Date.now();
  return issueDeviceCert(
    w.secretKey,
    device.publicKey,
    new Uint8Array(32).fill(2),
    id,
    w.identityId,
    now,
    now + 60_000,
    1,
  );
}

describe("identity registration", () => {
  test("is idempotent and resolvable without a username", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const again = await chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(w.secretKey, w.publicKey));
    expect(again.username).toBeNull();
    expect((await chain.getIdentity(w.identityId))?.wallet).toEqual(w.publicKey);
    expect(await chain.getIdentity(new Uint8Array(32))).toBeNull();
  });

  test("rejects a mismatched identity id and a bad proof", async () => {
    const chain = new DevChainClient();
    const w = wallet();
    const other = wallet();
    await expect(
      chain.registerIdentity(w.publicKey, other.identityId, signIdentityProof(w.secretKey, w.publicKey)),
    ).rejects.toThrow("does not match");
    await expect(
      chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(other.secretKey, other.publicKey)),
    ).rejects.toThrow("Invalid identity proof");
  });
});

describe("ssh keys and revocation on the chain", () => {
  test("ssh keys need the wallet signature, resolve, and die on revocation", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const publicKey = new Uint8Array(32).fill(8);
    const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
    const signature = signSshCommitment(w.secretKey, w.identityId, commitment);
    await expect(chain.registerSshKey(w.publicKey, w.identityId, commitment, new Uint8Array(64))).rejects.toThrow();
    await chain.registerSshKey(w.publicKey, w.identityId, commitment, signature);
    await expect(chain.registerSshKey(w.publicKey, w.identityId, commitment, signature)).rejects.toThrow("already");
    expect(await chain.resolveSshKey(w.identityId, commitment.fingerprint)).not.toBeNull();
    await chain.revokeCredential(
      w.publicKey,
      signRevocation(w.secretKey, {
        accountId: w.identityId,
        kind: "ssh",
        credentialId: commitment.fingerprint,
        sequence: 1,
      }),
    );
    expect(await chain.resolveSshKey(w.identityId, commitment.fingerprint)).toBeNull();
    expect(await chain.isRevoked(w.identityId, "ssh", commitment.fingerprint)).toBe(true);
  });

  test("a fingerprint that does not match the key is refused", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const publicKey = new Uint8Array(32).fill(8);
    const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: "SHA256:forged" };
    await expect(
      chain.registerSshKey(
        w.publicKey,
        w.identityId,
        commitment,
        signSshCommitment(w.secretKey, w.identityId, commitment),
      ),
    ).rejects.toThrow("Invalid SSH key");
  });

  test("an identity holds at most eight ssh keys", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    for (let i = 0; i < 8; i++) {
      const publicKey = new Uint8Array(32).fill(10 + i);
      const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
      await chain.registerSshKey(
        w.publicKey,
        w.identityId,
        commitment,
        signSshCommitment(w.secretKey, w.identityId, commitment),
      );
    }
    const publicKey = new Uint8Array(32).fill(99);
    const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
    await expect(
      chain.registerSshKey(
        w.publicKey,
        w.identityId,
        commitment,
        signSshCommitment(w.secretKey, w.identityId, commitment),
      ),
    ).rejects.toThrow("Too many");
  });

  test("revoking an ssh key invalidates only devices it authorised", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const publicKey = new Uint8Array(32).fill(8);
    const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
    await chain.registerSshKey(
      w.publicKey,
      w.identityId,
      commitment,
      signSshCommitment(w.secretKey, w.identityId, commitment),
    );
    const viaSsh = certificate(w, generateSigningKeyPair(), new Uint8Array(32).fill(5));
    const viaRoot = certificate(w, generateSigningKeyPair(), new Uint8Array(32).fill(6));
    await chain.authorizeDeviceCertificateWithSshKey(w.identityId, viaSsh, commitment.fingerprint);
    await chain.registerDeviceCertificate(w.publicKey, viaRoot);
    expect((await chain.getDeviceAuthorization(w.identityId, viaSsh.deviceId))?.kind).toBe("ssh");
    expect((await chain.getDeviceAuthorization(w.identityId, viaRoot.deviceId))?.kind).toBe("root");
    await chain.revokeCredential(
      w.publicKey,
      signRevocation(w.secretKey, {
        accountId: w.identityId,
        kind: "ssh",
        credentialId: commitment.fingerprint,
        sequence: 1,
      }),
    );
    expect(await chain.resolveDeviceCertificate(w.identityId, viaSsh.deviceId)).toBeNull();
    expect(await chain.resolveDeviceCertificate(w.identityId, viaRoot.deviceId)).not.toBeNull();
  });

  test("revocation sequences must increase and revocations need the wallet", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const other = wallet();
    const forged = signRevocation(other.secretKey, {
      accountId: w.identityId,
      kind: "device",
      credentialId: "a".repeat(64),
      sequence: 1,
    });
    await expect(chain.revokeCredential(w.publicKey, forged)).rejects.toThrow("Invalid revocation");
    await chain.revokeCredential(
      w.publicKey,
      signRevocation(w.secretKey, {
        accountId: w.identityId,
        kind: "device",
        credentialId: "a".repeat(64),
        sequence: 2,
      }),
    );
    await expect(
      chain.revokeCredential(
        w.publicKey,
        signRevocation(w.secretKey, {
          accountId: w.identityId,
          kind: "device",
          credentialId: "b".repeat(64),
          sequence: 2,
        }),
      ),
    ).rejects.toThrow("stale");
  });

  test("credentials and revocations survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexnet-chain-"));
    try {
      const path = join(dir, "chain.json");
      const chain = new DevChainClient(path);
      const w = await registered(chain);
      const publicKey = new Uint8Array(32).fill(8);
      const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
      await chain.registerSshKey(
        w.publicKey,
        w.identityId,
        commitment,
        signSshCommitment(w.secretKey, w.identityId, commitment),
      );
      await chain.revokeCredential(
        w.publicKey,
        signRevocation(w.secretKey, {
          accountId: w.identityId,
          kind: "device",
          credentialId: "d".repeat(64),
          sequence: 1,
        }),
      );
      const reloaded = new DevChainClient(path);
      expect(await reloaded.resolveSshKey(w.identityId, commitment.fingerprint)).not.toBeNull();
      expect(await reloaded.isRevoked(w.identityId, "device", "d".repeat(64))).toBe(true);
      expect(await reloaded.getIdentity(w.identityId)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revoked keys free their slot so rotation never locks the identity out", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    for (let round = 0; round < 10; round++) {
      const publicKey = new Uint8Array(32).fill(100 + round);
      const commitment = { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
      await chain.registerSshKey(
        w.publicKey,
        w.identityId,
        commitment,
        signSshCommitment(w.secretKey, w.identityId, commitment),
      );
      await chain.revokeCredential(
        w.publicKey,
        signRevocation(w.secretKey, {
          accountId: w.identityId,
          kind: "ssh",
          credentialId: commitment.fingerprint,
          sequence: round + 1,
        }),
      );
    }
  });

  test("pending passkey challenges are pruned and capped per identity", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const now = Date.now();
    const pending = (chain as unknown as { pendingPasskeyAuthorizations: Map<string, unknown> })
      .pendingPasskeyAuthorizations;
    (chain as unknown as { passkeys: Map<string, unknown[]> }).passkeys.set(Buffer.from(w.identityId).toString("hex"), [
      { credentialId: "c", publicKey: new Uint8Array(1), counter: 0, rpId: "x", origin: "https://x" },
    ]);
    for (let i = 0; i < 40; i++) {
      const id = new Uint8Array(32).fill(i + 1);
      const cert = issueDeviceCert(
        w.secretKey,
        generateSigningKeyPair().publicKey,
        new Uint8Array(32).fill(2),
        id,
        w.identityId,
        now,
        now + 60_000,
        1,
      );
      await chain.beginPasskeyDeviceCertificateAuthorization(w.identityId, cert);
    }
    expect(pending.size).toBeLessThanOrEqual(16);
  });
});
