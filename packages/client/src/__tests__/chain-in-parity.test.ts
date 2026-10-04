import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const inBinary = Bun.which("in");
const source = readFileSync(join(import.meta.dir, "../../../../chain/nexnet_chain.in"), "utf8");
const mainAt = source.indexOf("fn main() -> Int {");

function runIn(expression: string): number {
  const dir = mkdtempSync(join(tmpdir(), "nexnet-in-"));
  try {
    const file = join(dir, "rule.in");
    writeFileSync(file, `${source.slice(0, mainAt)}fn main() -> Int {\n  return ${expression};\n}\n`);
    const result = Bun.spawnSync([inBinary!, "execute", file]);
    if (result.exitCode === 0) return 0;
    const reported = /exited with status (\d+)/.exec(`${result.stdout}${result.stderr}`);
    return reported ? Number(reported[1]) : -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wallet() {
  const { secretKey, publicKey } = generateSigningKeyPair();
  return { secretKey, publicKey, identityId: identityIdFromWallet(publicKey) };
}

async function registered(chain: DevChainClient) {
  const w = wallet();
  await chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(w.secretKey, w.publicKey));
  return w;
}

function sshCommitment(seed: number) {
  const publicKey = new Uint8Array(32).fill(seed);
  return { algorithm: "ssh-ed25519" as const, publicKey, fingerprint: sshFingerprint(publicKey) };
}

describe.skipIf(!inBinary)("inauguration .in rules agree with the development chain", () => {
  test("the committed self-check passes", () => {
    expect(
      Bun.spawnSync([inBinary!, "execute", join(import.meta.dir, "../../../../chain/nexnet_chain.in")]).exitCode,
    ).toBe(0);
  });

  test("a rule that rejects reports its code", () => {
    expect(runIn("can_register_identity(0, 1, 0)")).toBe(30);
  });

  test("identity registration", async () => {
    const chain = new DevChainClient();
    const w = wallet();
    const other = wallet();
    await expect(
      chain.registerIdentity(w.publicKey, other.identityId, signIdentityProof(w.secretKey, w.publicKey)),
    ).rejects.toThrow("does not match");
    expect(runIn("can_register_identity(0, 1, 0)")).toBe(30);
    await expect(
      chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(other.secretKey, other.publicKey)),
    ).rejects.toThrow("Invalid identity proof");
    expect(runIn("can_register_identity(1, 0, 0)")).toBe(31);
    await chain.registerIdentity(w.publicKey, w.identityId, signIdentityProof(w.secretKey, w.publicKey));
    expect(runIn("can_register_identity(1, 1, 0)")).toBe(0);
  });

  test("ssh key registration", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const commitment = sshCommitment(8);
    const signature = signSshCommitment(w.secretKey, w.identityId, commitment);
    await expect(chain.registerSshKey(w.publicKey, w.identityId, commitment, new Uint8Array(64))).rejects.toThrow();
    expect(runIn("can_register_ssh_key(0, 0, 0, 0)")).toBe(35);
    await chain.registerSshKey(w.publicKey, w.identityId, commitment, signature);
    expect(runIn("can_register_ssh_key(1, 0, 0, 1)")).toBe(0);
    await expect(chain.registerSshKey(w.publicKey, w.identityId, commitment, signature)).rejects.toThrow("already");
    expect(runIn("can_register_ssh_key(1, 1, 0, 1)")).toBe(33);
    for (let i = 1; i < 8; i++) {
      const next = sshCommitment(20 + i);
      await chain.registerSshKey(w.publicKey, w.identityId, next, signSshCommitment(w.secretKey, w.identityId, next));
    }
    const ninth = sshCommitment(99);
    await expect(
      chain.registerSshKey(w.publicKey, w.identityId, ninth, signSshCommitment(w.secretKey, w.identityId, ninth)),
    ).rejects.toThrow("Too many");
    expect(runIn("can_register_ssh_key(8, 0, 0, 1)")).toBe(32);
  });

  test("revocation sequencing and signatures", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const other = wallet();
    await expect(
      chain.revokeCredential(
        w.publicKey,
        signRevocation(other.secretKey, {
          accountId: w.identityId,
          kind: "device",
          credentialId: "a".repeat(64),
          sequence: 1,
        }),
      ),
    ).rejects.toThrow("Invalid revocation");
    expect(runIn("can_revoke_credential(1, 0, 0)")).toBe(37);
    await chain.revokeCredential(
      w.publicKey,
      signRevocation(w.secretKey, {
        accountId: w.identityId,
        kind: "device",
        credentialId: "a".repeat(64),
        sequence: 2,
      }),
    );
    expect(runIn("can_revoke_credential(2, 0, 1)")).toBe(0);
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
    expect(runIn("can_revoke_credential(2, 2, 1)")).toBe(36);
  });

  test("device certificates die with their device or authorising credential", async () => {
    const chain = new DevChainClient();
    const w = await registered(chain);
    const commitment = sshCommitment(8);
    await chain.registerSshKey(
      w.publicKey,
      w.identityId,
      commitment,
      signSshCommitment(w.secretKey, w.identityId, commitment),
    );
    const now = Date.now();
    const device = generateSigningKeyPair();
    const certificate = issueDeviceCert(
      w.secretKey,
      device.publicKey,
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(5),
      w.identityId,
      now,
      now + 60_000,
      1,
    );
    await chain.authorizeDeviceCertificateWithSshKey(w.identityId, certificate, commitment.fingerprint);
    expect(await chain.resolveDeviceCertificate(w.identityId, certificate.deviceId)).not.toBeNull();
    expect(runIn("can_use_device_certificate(0, 0, 0)")).toBe(0);
    await chain.revokeCredential(
      w.publicKey,
      signRevocation(w.secretKey, {
        accountId: w.identityId,
        kind: "ssh",
        credentialId: commitment.fingerprint,
        sequence: 1,
      }),
    );
    expect(await chain.resolveDeviceCertificate(w.identityId, certificate.deviceId)).toBeNull();
    expect(runIn("can_use_device_certificate(0, 1, 0)")).toBe(38);
    expect(runIn("can_use_device_certificate(1, 0, 0)")).toBe(38);
    expect(runIn("can_use_device_certificate(0, 0, 1)")).toBe(39);
  });
});
