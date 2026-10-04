import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { DevChainClient } from "@nexnet/client/chain-stub";
import { Gateway } from "@nexnet/gateway";
import type { GatewayHandle } from "@nexnet/gateway";
import { FRAME_PREFIX, createBridge } from "../browser.js";
import type { Bridge } from "../browser.js";

const ORIGIN = "https://nexnet.test";
const RP_ID = "nexnet.test";

function fakeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rawId = randomBytes(16);
  let counter = 0;
  const credentials = {
    async create() {
      return {
        rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
        response: { getPublicKey: () => new Uint8Array(publicKey.export({ type: "spki", format: "der" })).buffer },
      };
    },
    async get(options: { publicKey: { challenge: ArrayBuffer; rpId: string } }) {
      counter += 1;
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: Buffer.from(options.publicKey.challenge as ArrayBuffer).toString("base64url"),
          origin: ORIGIN,
          crossOrigin: false,
        })
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([createHash("sha256").update(options.publicKey.rpId).digest(), Buffer.from([0x05]), count]);
      const signer = createSign("SHA256");
      signer.update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]));
      const signature = signer.sign(privateKey);
      const copy = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return {
        id: rawId.toString("base64url"),
        rawId: copy(rawId),
        response: {
          clientDataJSON: copy(clientData),
          authenticatorData: copy(authData),
          signature: copy(signature),
          userHandle: null,
        },
      };
    },
  };
  return credentials as unknown as CredentialsContainer;
}

let dir: string;
let handle: GatewayHandle;
let frames: any[];
let bridge: Bridge;
let next = 1;

function makeBridge(idb: IDBFactory, credentials?: CredentialsContainer): Bridge {
  frames = [];
  return createBridge(
    {
      gatewayUrl: handle.url,
      indexedDB: idb as unknown as IDBFactory,
      credentials,
      location: { hostname: RP_ID, origin: ORIGIN },
    },
    (frame) => {
      expect(frame.startsWith(FRAME_PREFIX)).toBe(true);
      frames.push(JSON.parse(frame.slice(FRAME_PREFIX.length)));
    }
  );
}

async function ask(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const id = next++;
  bridge.feed(new TextEncoder().encode(`${FRAME_PREFIX}${JSON.stringify({ id, cmd, ...args })}\n`));
  const start = Date.now();
  while (!frames.some((f) => f.id === id)) {
    if (Date.now() - start > 5000) throw new Error(`no reply to ${cmd}`);
    await Bun.sleep(10);
  }
  return frames.find((f) => f.id === id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexnet-bridge-"));
  handle = new Gateway(
    {
      audience: "nexnet:test",
      ownerIdentity: null,
      stateDir: dir,
      rpId: RP_ID,
      origins: [ORIGIN],
      now: () => Date.now(),
      publicRetentionMs: 86_400_000,
      sessionMaxMs: 43_200_000,
      wsAuthTimeoutMs: 2000,
    },
    new DevChainClient(join(dir, "chain.json"))
  ).listen(0);
});

afterEach(async () => {
  bridge?.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("browser bridge", () => {
  test("framed requests drive identity, sign-in and posting; console noise is ignored", async () => {
    bridge = makeBridge(new IDBFactory());
    bridge.feed(new TextEncoder().encode("login: \r\nkernel: noise\n@@nexnet {broken\n"));
    expect((await ask("hello", { protocol: 1 })).result.methods).toEqual(["wallet"]);
    expect((await ask("identity.create")).ok).toBe(true);
    expect((await ask("signin", { method: "wallet" })).result.session.method).toBe("wallet");
    expect((await ask("post", { channel: "public", body: "from the browser bridge" })).ok).toBe(true);
    expect((await ask("history", { channel: "public" })).result.messages[0].body).toBe("from the browser bridge");
  });

  test("a frame split across reads is reassembled", async () => {
    bridge = makeBridge(new IDBFactory());
    const id = next++;
    const line = `${FRAME_PREFIX}${JSON.stringify({ id, cmd: "hello" })}\n`;
    bridge.feed(new TextEncoder().encode(line.slice(0, 15)));
    bridge.feed(new TextEncoder().encode(line.slice(15)));
    const start = Date.now();
    while (!frames.some((f) => f.id === id)) {
      if (Date.now() - start > 3000) throw new Error("no reply");
      await Bun.sleep(10);
    }
  });

  test("the wallet persists across page loads in IndexedDB", async () => {
    const idb = new IDBFactory();
    bridge = makeBridge(idb);
    const created = await ask("identity.create");
    bridge.close();
    bridge = makeBridge(idb);
    expect((await ask("state")).result.identity.id).toBe(created.result.identity.id);
    expect((await ask("identity.create")).error.code).toBe("invalid");
  });

  test("a registered passkey signs in with a WebAuthn assertion more than once", async () => {
    const idb = new IDBFactory();
    const authenticator = fakeAuthenticator();
    bridge = makeBridge(idb, authenticator);
    await ask("identity.create");
    expect((await ask("hello")).result.methods).toEqual(["wallet"]);
    await bridge.registerPasskey();
    bridge.close();
    bridge = makeBridge(idb, authenticator);
    expect((await ask("hello")).result.methods).toEqual(["wallet", "passkey"]);
    const signedIn = await ask("signin", { method: "passkey" });
    expect(signedIn.ok).toBe(true);
    expect(signedIn.result.session.method).toBe("passkey");
    expect((await ask("post", { channel: "public", body: "signed in with a passkey" })).ok).toBe(true);
    const again = await ask("signin", { method: "passkey" });
    expect(again.ok).toBe(true);
  });

  test("passkey registration needs an identity and a gateway", async () => {
    bridge = makeBridge(new IDBFactory(), fakeAuthenticator());
    await expect(bridge.registerPasskey()).rejects.toThrow(/identity/i);
  });
});
