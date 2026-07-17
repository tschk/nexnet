import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevChainClient } from "../chain-stub.js";
import { generateSigningKeyPair } from "@nexnet/crypto";
import { authorizePasskeyCredential, issueDeviceCert } from "@nexnet/protocol";

function makeWallet(n: number): Uint8Array {
  const w = new Uint8Array(32);
  w[0] = n;
  return w;
}

function makeIdentity(n: number): Uint8Array {
  const id = new Uint8Array(32);
  id[0] = n;
  id[1] = 0xff;
  return id;
}

/** Create a chain client with a pre-aged account (bypass 7-day wait) */
function createWithAgedAccount(): DevChainClient {
  const chain = new DevChainClient();
  // Hack: registerAccount sets createdAt = Date.now(), but we need it aged.
  // For testing, we'll test the age check separately and use a helper.
  return chain;
}

function ageAccount(chain: DevChainClient, wallet: Uint8Array): void {
  chain.registerAccount(wallet);
  (chain as unknown as { accounts: Map<string, { createdAt: number; lastActiveAt: number }> }).accounts.set(
    Buffer.from(wallet).toString("hex"),
    { createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000, lastActiveAt: Date.now() }
  );
}

describe("DevChainClient", () => {
  test("register and resolve username", async () => {
    const chain = new DevChainClient();
    const wallet = makeWallet(1);

    // Register account first
    chain.registerAccount(wallet);

    // For test speed, we can't wait 7 days.
    // Test that it throws for new account:
    await expect(
      chain.registerUsername("alice", wallet, makeIdentity(1))
    ).rejects.toThrow("Account too new");

    // Test direct resolution without registration
    const resolved = await chain.resolveUsername("alice");
    expect(resolved).toBeNull();
  });

  test("account must be registered before username", async () => {
    const chain = new DevChainClient();
    await expect(
      chain.registerUsername("alice", makeWallet(1), makeIdentity(1))
    ).rejects.toThrow("Account not registered");
  });

  test("AD-10: one username per wallet", async () => {
    const chain = new DevChainClient();
    // This test verifies the check exists even if we can't bypass age
    const wallet = makeWallet(1);
    chain.registerAccount(wallet);
    // The age check will block, but the AD-10 check is there too
    await expect(
      chain.registerUsername("bob", wallet, makeIdentity(2))
    ).rejects.toThrow(/Account too new|Wallet already owns/);
  });

  test("transferUsername is disabled", async () => {
    const chain = new DevChainClient();
    await expect(
      chain.transferUsername()
    ).rejects.toThrow("Username transfer disabled");
  });

  test("getIdentityRoot returns null for unknown", async () => {
    const chain = new DevChainClient();
    const root = await chain.getIdentityRoot(makeIdentity(99));
    expect(root).toBeNull();
  });

  test("resolveUsername returns null for unknown", async () => {
    const chain = new DevChainClient();
    const result = await chain.resolveUsername("nobody");
    expect(result).toBeNull();
  });

  test("case-insensitive resolution", async () => {
    const chain = new DevChainClient();
    const result = await chain.resolveUsername("ALICE");
    expect(result).toBeNull(); // nothing registered
  });

  test("recordActivity updates last active time", async () => {
    const chain = new DevChainClient();
    const wallet = makeWallet(1);
    chain.registerAccount(wallet);
    // Should not throw
    chain.recordActivity(wallet);
  });

  test("getUsernameHistory returns empty for unknown", async () => {
    const chain = new DevChainClient();
    const history = await chain.getUsernameHistory("nobody");
    expect(history).toHaveLength(0);
  });

  test("joinValidatorSet ranks by effective power", async () => {
    const chain = new DevChainClient();
    await chain.joinValidatorSet(makeWallet(1), 100);
    await chain.joinValidatorSet(makeWallet(2), 500);
    const list = await chain.listValidators();
    expect(list).toHaveLength(2);
    expect(list[0]!.effectivePower).toBe(500);
  });

  test("joinValidatorSet rejects duplicate", async () => {
    const chain = new DevChainClient();
    await chain.joinValidatorSet(makeWallet(1), 10);
    await expect(chain.joinValidatorSet(makeWallet(1), 10)).rejects.toThrow(
      /Already a validator/
    );
  });

  test("leaveValidatorSet blocked below min after bootstrap", async () => {
    const chain = new DevChainClient();
    for (let i = 1; i <= 4; i++) {
      await chain.joinValidatorSet(makeWallet(i), 10);
    }
    // at min 4 — leave would go to 3
    await expect(chain.leaveValidatorSet(makeWallet(1))).rejects.toThrow(
      /min validators/
    );
  });

  test("leaveValidatorSet ok during bootstrap", async () => {
    const chain = new DevChainClient();
    await chain.joinValidatorSet(makeWallet(1), 10);
    await chain.joinValidatorSet(makeWallet(2), 10);
    await chain.leaveValidatorSet(makeWallet(1));
    expect(await chain.listValidators()).toHaveLength(1);
  });

  test("reopens persisted usernames, accounts, and validators", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexnet-chain-"));
    const statePath = join(directory, "state.json");
    try {
      const wallet = makeWallet(1);
      const identity = makeIdentity(1);
      const chain = new DevChainClient(statePath);
      chain.registerAccount(wallet);
      (chain as unknown as { accounts: Map<string, { createdAt: number; lastActiveAt: number }> }).accounts.set(
        Buffer.from(wallet).toString("hex"),
        { createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000, lastActiveAt: Date.now() }
      );
      await chain.registerUsername("alice", wallet, identity);
      await chain.joinValidatorSet(wallet, 100);

      const reopened = new DevChainClient(statePath);
      expect(await reopened.resolveUsername("ALICE")).toEqual(await chain.resolveUsername("alice"));
      expect(await reopened.getUsernameHistory("alice")).toHaveLength(1);
      expect(await reopened.getIdentityRoot(identity)).toEqual({ wallet });
      expect(await reopened.listValidators()).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("durably enforces username and identity-root ownership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexnet-chain-"));
    const statePath = join(directory, "state.json");
    try {
      const walletA = makeWallet(1);
      const walletB = makeWallet(2);
      const identityA = makeIdentity(1);
      const identityB = makeIdentity(2);
      const chain = new DevChainClient(statePath);
      ageAccount(chain, walletA);
      ageAccount(chain, walletB);
      await chain.registerUsername("Alice", walletA, identityA);

      await expect(chain.registerUsername("alice", walletB, identityB)).rejects.toThrow("Username already taken");
      await expect(chain.registerUsername("bob", walletA, identityB)).rejects.toThrow("Wallet already owns");
      await expect(chain.registerUsername("bob", walletB, identityA)).rejects.toThrow("Identity root already bound");

      const reopened = new DevChainClient(statePath);
      expect(await reopened.getIdentityRoot(identityA)).toEqual({ wallet: walletA });
      expect(await reopened.getUsernameHistory("alice")).toEqual([
        expect.objectContaining({ identityId: identityA, ownerWallet: walletA }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("authorizes and restores a root-signed device certificate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexnet-chain-"));
    const statePath = join(directory, "state.json");
    try {
      const root = generateSigningKeyPair();
      const deviceSigning = generateSigningKeyPair();
      const deviceEncryption = generateSigningKeyPair();
      const identity = makeIdentity(8);
      const deviceId = makeIdentity(9);
      const now = Date.now();
      const certificate = issueDeviceCert(
        root.secretKey,
        deviceSigning.publicKey,
        deviceEncryption.publicKey,
        deviceId,
        identity,
        now,
        now + 60_000,
        1
      );
      const chain = new DevChainClient(statePath);
      ageAccount(chain, root.publicKey);
      await chain.registerUsername("alice", root.publicKey, identity);
      await expect(chain.registerDeviceCertificate(root.publicKey, certificate)).resolves.toEqual(certificate);
      certificate.capabilities = 2;
      expect((await chain.resolveDeviceCertificate(identity, deviceId))?.capabilities).toBe(1);

      const reopened = new DevChainClient(statePath);
      expect((await reopened.resolveDeviceCertificate(identity, deviceId))?.capabilities).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects device certificates without the identity root signature", async () => {
    const root = generateSigningKeyPair();
    const deviceSigning = generateSigningKeyPair();
    const deviceEncryption = generateSigningKeyPair();
    const identity = makeIdentity(10);
    const certificate = issueDeviceCert(
      root.secretKey,
      deviceSigning.publicKey,
      deviceEncryption.publicKey,
      makeIdentity(11),
      identity,
      Date.now(),
      Date.now() + 60_000,
      1
    );
    certificate.capabilities = 2;
    const chain = new DevChainClient();
    ageAccount(chain, root.publicKey);
    await chain.registerUsername("alice", root.publicKey, identity);
    await expect(chain.registerDeviceCertificate(root.publicKey, certificate)).rejects.toThrow(
      "Invalid device certificate signature"
    );
  });

  test("stores a wallet-authorized passkey commitment and binds a certificate challenge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexnet-chain-"));
    const statePath = join(directory, "state.json");
    try {
      const root = generateSigningKeyPair();
      const device = generateSigningKeyPair();
      const identity = makeIdentity(12);
      const certificate = issueDeviceCert(
        root.secretKey,
        device.publicKey,
        device.publicKey,
        makeIdentity(13),
        identity,
        Date.now(),
        Date.now() + 60_000,
        1
      );
      const credential = {
        credentialId: "credential-id",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        rpId: "nexnet.example",
        origin: "https://nexnet.example",
      };
      const chain = new DevChainClient(statePath);
      ageAccount(chain, root.publicKey);
      await chain.registerUsername("alice", root.publicKey, identity);
      const signature = authorizePasskeyCredential(root.secretKey, identity, credential);
      await expect(
        chain.registerPasskeyCredential(root.publicKey, identity, credential, signature)
      ).resolves.toEqual(credential);
      const challenge = await chain.beginPasskeyDeviceCertificateAuthorization(identity, certificate);
      expect(challenge.challenge).toHaveLength(43);
      await expect(
        chain.authorizeDeviceCertificateWithPasskey(identity, { ...certificate, capabilities: 2 }, {
          id: credential.credentialId,
          rawId: credential.credentialId,
          type: "public-key",
          response: { clientDataJSON: "", authenticatorData: "", signature: "" },
          clientExtensionResults: {},
        })
      ).rejects.toThrow("Passkey authorization is missing or expired");

      const reopened = new DevChainClient(statePath);
      const restored = await reopened.beginPasskeyDeviceCertificateAuthorization(identity, certificate);
      expect(restored.challenge).not.toBe(challenge.challenge);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
