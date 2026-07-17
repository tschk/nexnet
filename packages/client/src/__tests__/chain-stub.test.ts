import { describe, test, expect } from "bun:test";
import { DevChainClient } from "../chain-stub.js";

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

describe("DevChainClient", () => {
  test("register and resolve username", async () => {
    const chain = new DevChainClient();
    const record = await chain.registerUsername(
      "alice",
      makeWallet(1),
      makeIdentity(1)
    );

    expect(record.username).toBe("alice");
    expect(record.ownerWallet).toEqual(makeWallet(1));

    const resolved = await chain.resolveUsername("alice");
    expect(resolved).not.toBeNull();
    expect(resolved!.username).toBe("alice");
  });

  test("case-insensitive resolution", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("Alice", makeWallet(1), makeIdentity(1));

    const resolved = await chain.resolveUsername("ALICE");
    expect(resolved).not.toBeNull();
    expect(resolved!.username).toBe("alice");
  });

  test("AD-10: one username per wallet", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));

    await expect(
      chain.registerUsername("bob", makeWallet(1), makeIdentity(2))
    ).rejects.toThrow("Wallet already owns a username (AD-10)");
  });

  test("duplicate username rejected", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));

    await expect(
      chain.registerUsername("alice", makeWallet(2), makeIdentity(2))
    ).rejects.toThrow("Username already taken");
  });

  test("transferUsername", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));

    const transferred = await chain.transferUsername(
      "alice",
      makeWallet(2)
    );
    expect(transferred.ownerWallet).toEqual(makeWallet(2));

    const resolved = await chain.resolveUsername("alice");
    expect(resolved!.ownerWallet).toEqual(makeWallet(2));
  });

  test("transfer frees old wallet", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));
    await chain.transferUsername("alice", makeWallet(2));

    // Old wallet can now register again
    const record = await chain.registerUsername(
      "bob",
      makeWallet(1),
      makeIdentity(2)
    );
    expect(record.username).toBe("bob");
  });

  test("getUsernameHistory tracks events", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));
    await chain.transferUsername("alice", makeWallet(2));

    const history = await chain.getUsernameHistory("alice");
    expect(history).toHaveLength(2);
    expect(history[0].ownerWallet).toEqual(makeWallet(1));
    expect(history[1].ownerWallet).toEqual(makeWallet(2));
  });

  test("getIdentityRoot returns wallet", async () => {
    const chain = new DevChainClient();
    await chain.registerUsername("alice", makeWallet(1), makeIdentity(1));

    const root = await chain.getIdentityRoot(makeIdentity(1));
    expect(root).not.toBeNull();
    expect(root!.wallet).toEqual(makeWallet(1));
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
});
