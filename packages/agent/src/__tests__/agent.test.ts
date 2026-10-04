import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevChainClient } from "@nexnet/client/chain-stub";
import { generateSigningKeyPair } from "@nexnet/crypto";
import { Gateway } from "@nexnet/gateway";
import type { GatewayHandle } from "@nexnet/gateway";
import {
  identityIdFromWallet,
  revocationToJson,
  signRevocation,
  signSshCommitment,
  toBase64Url,
  toHex,
} from "@nexnet/protocol";
import { AgentCore } from "../core.js";
import { FileWalletStore, locateSshKey, sshSigner } from "../node-platform.js";
import type { Outbound, Platform, WalletSecret, WalletStore } from "../types.js";
import type { SignInMethod } from "@nexnet/protocol";

class MemoryWallet implements WalletStore {
  constructor(public secret: WalletSecret | null = null) {}
  async load() {
    return this.secret;
  }
  async create() {
    this.secret = generateSigningKeyPair();
    return this.secret;
  }
}

class Client {
  readonly out: Outbound[] = [];
  readonly core: AgentCore;
  private next = 1;

  constructor(platform: Platform) {
    this.core = new AgentCore(platform, (o) => this.out.push(o));
  }

  async send(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = this.next++;
    await this.core.handleLine(JSON.stringify({ id, cmd, ...args }));
    const reply = this.out.find((o) => "id" in o && o.id === id);
    if (!reply) throw new Error("no reply");
    return reply;
  }

  events(name: string): any[] {
    return this.out.filter((o) => "event" in o && o.event === name);
  }
}

let dir: string;
let handle: GatewayHandle;
let port: number;
let ownerWallet: WalletSecret;
let clients: Client[];
let clock = 0;

function makeGateway(): Gateway {
  return new Gateway(
    {
      audience: "nexnet:test",
      ownerIdentity: toHex(identityIdFromWallet(ownerWallet.publicKey)),
      stateDir: dir,
      rpId: null,
      origins: [],
      now: () => Date.now() + clock,
      publicRetentionMs: 86_400_000,
      sessionMaxMs: 43_200_000,
      wsAuthTimeoutMs: 2000,
    },
    new DevChainClient(join(dir, "chain.json")),
  );
}

function platform(
  wallet: MemoryWallet,
  extra: Partial<Platform> = {},
  url: string | null = `http://127.0.0.1:${port}`,
): Platform {
  return {
    gatewayUrl: url,
    audience: "nexnet:test",
    wallet,
    methods: () => ["wallet"] as SignInMethod[],
    now: () => Date.now() + clock,
    ...extra,
  };
}

async function client(
  wallet = new MemoryWallet(),
  extra: Partial<Platform> = {},
  url?: string | null,
): Promise<Client> {
  const c = new Client(platform(wallet, extra, url));
  await c.core.init();
  clients.push(c);
  return c;
}

async function until(predicate: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await Bun.sleep(15);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexnet-agent-"));
  ownerWallet = generateSigningKeyPair();
  handle = makeGateway().listen(0);
  port = handle.server.port as number;
  clients = [];
  clock = 0;
});

afterEach(async () => {
  for (const c of clients) c.core.close();
  await handle.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("protocol hygiene", () => {
  test("malformed, oversized, id-less and unknown requests get structured errors", async () => {
    const c = await client();
    await c.core.handleLine("not json");
    await c.core.handleLine("[]");
    await c.core.handleLine(JSON.stringify({ cmd: "state" }));
    await c.core.handleLine("x".repeat(70_000));
    const unknown = await c.send("nope");
    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe("invalid");
    expect(c.out.filter((o) => "ok" in o && !o.ok && o.id === null)).toHaveLength(4);
  });

  test("hello reports the methods this platform can perform", async () => {
    const c = await client();
    const hello = await c.send("hello", { protocol: 1 });
    expect(hello.result).toEqual({ agent: "nexnet-agent", protocol: 1, methods: ["wallet"] });
  });
});

describe("unconfigured gateway", () => {
  test("state says unconfigured and network commands fail with unconfigured", async () => {
    const c = await client(new MemoryWallet(), {}, null);
    expect((await c.send("state")).result.gateway).toEqual({ status: "unconfigured", url: null });
    for (const [cmd, args] of [
      ["identity.create", {}],
      ["history", { channel: "public" }],
      ["post", { channel: "public", body: "hi" }],
      ["subscribe", { channels: ["public"] }],
    ] as const) {
      const reply = await c.send(cmd, args);
      expect(reply.error.code).toBe("unconfigured");
    }
  });

  test("an unreachable gateway is offline, not unconfigured", async () => {
    const c = await client(new MemoryWallet(), {}, "http://127.0.0.1:1");
    expect((await c.send("state")).result.gateway.status).toBe("offline");
    expect((await c.send("identity.create")).error.code).toBe("offline");
  });
});

describe("identity, sign-in and posting against the gateway", () => {
  test("create identity, sign in, post, read back, sign out", async () => {
    const c = await client();
    expect((await c.send("state")).result.identity).toBeNull();
    const anonymous = await c.send("post", { channel: "public", body: "too early" });
    expect(anonymous.error.code).toBe("unauthenticated");
    const created = await c.send("identity.create");
    expect(created.ok).toBe(true);
    expect(created.result.identity.short).toMatch(/^nx1[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(created.result.session).toBeNull();
    expect((await c.send("identity.create")).error.code).toBe("invalid");
    const signedIn = await c.send("signin", { method: "wallet" });
    expect(signedIn.result.session.method).toBe("wallet");
    expect(signedIn.result.owner).toBe(false);
    const posted = await c.send("post", { channel: "public", body: "hello from the agent" });
    expect(posted.result.message.body).toBe("hello from the agent");
    const history = await c.send("history", { channel: "public", limit: 10 });
    expect(history.result.messages.map((m: any) => m.body)).toEqual(["hello from the agent"]);
    expect(history.result.messages[0].author.id).toBe(created.result.identity.id);
    await c.send("signout");
    expect((await c.send("state")).result.session).toBeNull();
    expect((await c.send("post", { channel: "public", body: "after" })).error.code).toBe("unauthenticated");
  });

  test("sign-in without an identity is refused and unsupported methods are invalid", async () => {
    const c = await client();
    expect((await c.send("signin", { method: "wallet" })).error.code).toBe("unauthenticated");
    await c.send("identity.create");
    expect((await c.send("signin", { method: "ssh" })).error.code).toBe("invalid");
    expect((await c.send("signin", { method: "passkey" })).error.code).toBe("invalid");
    expect((await c.send("signin", { method: "carrier-pigeon" })).error.code).toBe("invalid");
  });

  test("a returning device signs in with its stored wallet", async () => {
    const wallet = new MemoryWallet();
    const first = await client(wallet);
    const created = await first.send("identity.create");
    const second = await client(wallet);
    expect((await second.send("state")).result.identity.id).toBe(created.result.identity.id);
    expect((await second.send("signin", { method: "wallet" })).ok).toBe(true);
    expect((await second.send("post", { channel: "public", body: "from the second process" })).ok).toBe(true);
  });

  test("only the owner may post to updates and the state says so", async () => {
    const visitor = await client();
    await visitor.send("identity.create");
    await visitor.send("signin", { method: "wallet" });
    const denied = await visitor.send("post", { channel: "updates", body: "nope" });
    expect(denied.error.code).toBe("forbidden");
    const owner = await client(new MemoryWallet(ownerWallet));
    await owner.send("signin", { method: "wallet" }).then((r) => expect(r.ok).toBe(true));
    expect((await owner.send("state")).result.owner).toBe(true);
    expect((await owner.send("post", { channel: "updates", body: "shipping" })).ok).toBe(true);
    expect((await visitor.send("history", { channel: "updates" })).result.messages[0].body).toBe("shipping");
  });

  test("input validation happens before the network", async () => {
    const c = await client();
    await c.send("identity.create");
    await c.send("signin", { method: "wallet" });
    expect((await c.send("post", { channel: "public", body: "" })).error.code).toBe("invalid");
    expect((await c.send("post", { channel: "public", body: "x".repeat(2001) })).error.code).toBe("invalid");
    expect((await c.send("post", { channel: "other", body: "x" })).error.code).toBe("invalid");
    expect((await c.send("post", { channel: "public", body: "\u001b[2J" })).error.code).toBe("invalid");
    expect((await c.send("history", { channel: "public", limit: 0 })).error.code).toBe("invalid");
  });

  test("rate limiting surfaces as rate_limited and keeps the session", async () => {
    const c = await client();
    await c.send("identity.create");
    await c.send("signin", { method: "wallet" });
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const reply = await c.send("post", { channel: "public", body: `m${i}` });
      codes.push(reply.ok ? "ok" : reply.error.code);
    }
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited", "rate_limited"]);
    expect((await c.send("state")).result.session).not.toBeNull();
  });

  test("sessions expire on the client clock", async () => {
    const c = await client();
    await c.send("identity.create");
    await c.send("signin", { method: "wallet" });
    clock += 12 * 60 * 60 * 1000;
    expect((await c.send("post", { channel: "public", body: "late" })).error.code).toBe("unauthenticated");
  });
});

describe("ssh sign-in", () => {
  test("a wallet-linked ssh key signs in through ssh-keygen", async () => {
    const keyDir = mkdtempSync(join(tmpdir(), "nexnet-agent-ssh-"));
    try {
      const keyPath = join(keyDir, "id_ed25519");
      expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath]).exitCode).toBe(0);
      const env = { NEXNET_SSH_KEY: keyPath };
      const location = locateSshKey(env)!;
      expect(location).not.toBeNull();
      const wallet = new MemoryWallet();
      const c = await client(wallet, { methods: () => ["wallet", "ssh"], signSsh: sshSigner(location, env) });
      await c.send("identity.create");
      const unlinked = await c.send("signin", { method: "ssh" });
      expect(unlinked.error.code).toBe("unauthenticated");

      const secret = wallet.secret!;
      const identityId = identityIdFromWallet(secret.publicKey);
      const { parseSshPublicKey } = await import("@nexnet/protocol");
      const line = await Bun.file(location.publicPath).text();
      const link = await fetch(`http://127.0.0.1:${port}/v1/credentials/ssh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identityId: toHex(identityId),
          publicKey: line.trim(),
          rootSignature: toBase64Url(
            signSshCommitment(secret.secretKey, identityId, {
              algorithm: "ssh-ed25519",
              publicKey: parseSshPublicKey(line),
            }),
          ),
        }),
      });
      expect(link.status).toBe(201);
      const fingerprint = ((await link.json()) as { fingerprint: string }).fingerprint;

      const signedIn = await c.send("signin", { method: "ssh" });
      expect(signedIn.ok).toBe(true);
      expect(signedIn.result.session.method).toBe("ssh");
      expect((await c.send("post", { channel: "public", body: "via ssh" })).ok).toBe(true);

      const revocation = signRevocation(secret.secretKey, {
        accountId: identityId,
        kind: "ssh",
        credentialId: fingerprint,
        sequence: Date.now(),
      });
      const revoked = await fetch(`http://127.0.0.1:${port}/v1/credentials/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revocation: revocationToJson(revocation) }),
      });
      expect(revoked.status).toBe(200);
      const after = await c.send("post", { channel: "public", body: "after revoke" });
      expect(after.error.code).toBe("unauthenticated");
      expect((await c.send("state")).result.session).toBeNull();
      expect((await c.send("signin", { method: "ssh" })).error.code).toBe("revoked");
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });

  test("an unusable ssh key fails cleanly without prompting", async () => {
    const keyDir = mkdtempSync(join(tmpdir(), "nexnet-agent-ssh-"));
    try {
      const keyPath = join(keyDir, "id_ed25519");
      Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "secret", "-f", keyPath]);
      const env = { NEXNET_SSH_KEY: keyPath };
      const c = await client(new MemoryWallet(), {
        methods: () => ["wallet", "ssh"],
        signSsh: sshSigner(locateSshKey(env)!, env),
      });
      await c.send("identity.create");
      const reply = await c.send("signin", { method: "ssh" });
      expect(reply.error.code).toBe("unauthenticated");
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});

describe("streaming, revocation and reconnects", () => {
  test("a subscriber receives another agent's posts and revocation drops its session", async () => {
    const writer = await client();
    await writer.send("identity.create");
    await writer.send("signin", { method: "wallet" });
    const reader = await client();
    await reader.send("subscribe", { channels: ["updates", "public"] });
    await until(() => reader.core.state().gateway.status === "online");
    await Bun.sleep(100);
    await writer.send("post", { channel: "public", body: "live" });
    await until(() => reader.events("message").length === 1);
    expect(reader.events("message")[0].message.body).toBe("live");
    expect(reader.events("message")[0].channel).toBe("public");

    const secret = (writer.core as any).wallet as WalletSecret;
    const deviceId = toHex((writer.core as any).device.deviceId);
    await writer.send("subscribe", { channels: ["public"] });
    await Bun.sleep(150);
    const revocation = signRevocation(secret.secretKey, {
      accountId: identityIdFromWallet(secret.publicKey),
      kind: "device",
      credentialId: deviceId,
      sequence: Date.now(),
    });
    await fetch(`http://127.0.0.1:${port}/v1/credentials/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revocation: revocationToJson(revocation) }),
    });
    await until(() => writer.events("error").some((e) => e.code === "revoked"));
    expect(writer.core.state().session).toBeNull();
  });

  test("the stream survives a gateway restart and fills the gap", async () => {
    const writer = await client();
    await writer.send("identity.create");
    await writer.send("signin", { method: "wallet" });
    const reader = await client();
    await reader.send("history", { channel: "public" });
    await reader.send("subscribe", { channels: ["public"] });
    await until(() => reader.core.state().gateway.status === "online");
    await Bun.sleep(100);
    await writer.send("post", { channel: "public", body: "before restart" });
    await until(() => reader.events("message").length === 1);

    await handle.close();
    await until(() => reader.core.state().gateway.status === "offline");
    handle = makeGateway().listen(port);
    await until(() => reader.core.state().gateway.status === "online", 8000);

    const second = await client((writer.core as any).platform.wallet);
    await second.send("signin", { method: "wallet" });
    expect((await second.send("post", { channel: "public", body: "after restart" })).ok).toBe(true);
    await until(() => reader.events("message").some((e) => e.message.body === "after restart"), 8000);
    expect(reader.events("message").map((e) => e.message.body)).toEqual(["before restart", "after restart"]);
    expect(reader.events("state").some((e) => e.state.gateway.status === "offline")).toBe(true);
  });

  test("a writer keeps a valid sequence across its own reconnect", async () => {
    const wallet = new MemoryWallet();
    const c = await client(wallet);
    await c.send("identity.create");
    await c.send("signin", { method: "wallet" });
    expect((await c.send("post", { channel: "public", body: "one" })).ok).toBe(true);
    await handle.close();
    expect((await c.send("post", { channel: "public", body: "two" })).error.code).toBe("offline");
    handle = makeGateway().listen(port);
    expect((await c.send("post", { channel: "public", body: "two" })).ok).toBe(true);
    expect((await c.send("post", { channel: "public", body: "three" })).ok).toBe(true);
  });
});

describe("file wallet", () => {
  test("creates once with private permissions and refuses lax permissions", async () => {
    const path = join(dir, "wallet", "wallet.json");
    const store = new FileWalletStore(path);
    expect(await store.load()).toBeNull();
    const created = await store.create();
    const loaded = await store.load();
    expect(toHex(loaded!.publicKey)).toBe(toHex(created.publicKey));
    await expect(store.create()).rejects.toThrow();
    chmodSync(path, 0o644);
    await expect(store.load()).rejects.toThrow(/readable by others/);
  });

  test("rejects corrupt wallet files", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{nope", { mode: 0o600 });
    await expect(new FileWalletStore(path).load()).rejects.toThrow();
    writeFileSync(path, JSON.stringify({ version: 2 }), { mode: 0o600 });
    await expect(new FileWalletStore(path).load()).rejects.toThrow(/format/);
  });
});

describe("review fixes", () => {
  test("a gateway answering with another audience is not signed for", async () => {
    const c = await client(new MemoryWallet(), { audience: "https://other.example" });
    await c.send("identity.create");
    const reply = await c.send("signin", { method: "wallet" });
    expect(reply.error.code).toBe("invalid");
    expect(reply.error.message).toMatch(/audience/);
    expect((await c.send("state")).result.session).toBeNull();
  });

  test("non-https, non-loopback gateways are treated as unconfigured", async () => {
    const c = await client(new MemoryWallet(), {}, "http://chat.example.test");
    expect((await c.send("state")).result.gateway.status).toBe("unconfigured");
  });

  test("history is trimmed to fit one protocol line", async () => {
    const poster = await client();
    await poster.send("identity.create");
    await poster.send("signin", { method: "wallet" });
    for (let i = 0; i < 5; i++) {
      const wallet = new MemoryWallet();
      const other = await client(wallet);
      await other.send("identity.create");
      await other.send("signin", { method: "wallet" });
      for (let j = 0; j < 5; j++) {
        await other.send("post", { channel: "public", body: `${i}${j}`.padEnd(1990, "x") });
      }
    }
    const history = await poster.send("history", { channel: "public", limit: 50 });
    expect(history.ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(history)).length).toBeLessThan(65_536);
    expect(history.result.messages.length).toBeGreaterThan(10);
  });

  test("switching sign-in method in one process works", async () => {
    const c = await client();
    await c.send("identity.create");
    expect((await c.send("signin", { method: "wallet" })).ok).toBe(true);
    await c.send("signout");
    expect((await c.send("signin", { method: "wallet" })).ok).toBe(true);
    expect((await c.send("post", { channel: "public", body: "after re-sign-in" })).ok).toBe(true);
  });
});

describe("failed re-sign-in", () => {
  test("keeps posting with the old session when a second sign-in fails", async () => {
    const keyDir = mkdtempSync(join(tmpdir(), "nexnet-agent-ssh-"));
    try {
      const keyPath = join(keyDir, "id_ed25519");
      Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
      const env = { NEXNET_SSH_KEY: keyPath };
      const c = await client(new MemoryWallet(), {
        methods: () => ["wallet", "ssh"],
        signSsh: sshSigner(locateSshKey(env)!, env),
      });
      await c.send("identity.create");
      expect((await c.send("signin", { method: "wallet" })).ok).toBe(true);
      expect((await c.send("post", { channel: "public", body: "before" })).ok).toBe(true);
      const failed = await c.send("signin", { method: "ssh" });
      expect(failed.error.code).toBe("unauthenticated");
      expect((await c.send("state")).result.session.method).toBe("wallet");
      expect((await c.send("post", { channel: "public", body: "after the failed attempt" })).ok).toBe(true);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});
