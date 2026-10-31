import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { generateSigningKeyPair } from "@nexnet/crypto";
import { identityIdFromWallet, signIdentityAuthJson, toHex } from "@nexnet/protocol";
import worker, { RelaySession } from "./index.js";

// Minimal DurableObjectState mock
function createMockState() {
  return {
    storage: {},
    acceptWebSocket: mock(() => {}),
  } as unknown as DurableObjectState;
}

function createMockEnv() {
  return { RELAY: {} as DurableObjectNamespace };
}

type MockWs = WebSocket & { _sent: Array<Record<string, unknown>>; _closed: number | null };

function createMockWs(): MockWs {
  const sent: unknown[] = [];
  const ws = {
    send: mock((data: string) => {
      sent.push(JSON.parse(data));
    }),
    close: mock((code?: number) => {
      ws._closed = code ?? 1000;
    }),
    _sent: sent,
    _closed: null as number | null,
  };
  return ws as unknown as MockWs;
}

interface Identity {
  hex: string;
  id: Uint8Array;
  root: { publicKey: Uint8Array; secretKey: Uint8Array };
  device: string;
}

function makeIdentity(deviceFill: number): Identity {
  const root = generateSigningKeyPair();
  const id = identityIdFromWallet(root.publicKey);
  return { hex: toHex(id), id, root, device: toHex(new Uint8Array(32).fill(deviceFill)) };
}

// WebSocketPair is a Cloudflare Workers API — mock it for Bun and keep the server end.
let lastServer: MockWs | null = null;
const origWSP = (globalThis as any).WebSocketPair;
beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    0 = createMockWs();
    1 = (lastServer = createMockWs());
  };
});
afterEach(() => {
  if (origWSP) (globalThis as any).WebSocketPair = origWSP;
  else delete (globalThis as any).WebSocketPair;
});

/** Upgrade as `claimed` and answer the relay's challenge with `signer`'s root key. */
async function open(relay: RelaySession, claimed: Identity): Promise<{ ws: MockWs; nonce: string }> {
  const resp = await relay.fetch(new Request(`https://relay/ws?identity=${claimed.hex}&device=${claimed.device}`));
  expect(resp.status).toBe(101);
  const ws = lastServer!;
  const challenge = ws._sent.find((m) => m.type === "auth_challenge") as { nonce: string };
  ws._sent.length = 0;
  return { ws, nonce: challenge.nonce };
}

async function connect(relay: RelaySession, claimed: Identity, signer: Identity = claimed): Promise<MockWs> {
  const { ws, nonce } = await open(relay, claimed);
  const { auth } = signIdentityAuthJson(
    { rootPublicKey: signer.root.publicKey, secretKey: signer.root.secretKey },
    "relay.connect",
    claimed.id,
    { audience: "relay", nonce, deviceId: claimed.device },
  );
  await relay.webSocketMessage(ws, JSON.stringify({ type: "auth", auth }));
  return ws;
}

async function send(relay: RelaySession, ws: WebSocket, msg: unknown) {
  await relay.webSocketMessage(ws, JSON.stringify(msg));
}

describe("RelaySession", () => {
  let relay: RelaySession;
  let alice: Identity;
  let bob: Identity;
  let charlie: Identity;

  beforeEach(() => {
    relay = new RelaySession(createMockState(), createMockEnv());
    alice = makeIdentity(1);
    bob = makeIdentity(2);
    charlie = makeIdentity(3);
  });

  test("WebSocket upgrade requires hex identity and device params", async () => {
    for (const path of ["/ws", "/ws?identity=alice&device=d1"]) {
      const resp = await relay.fetch(new Request(`https://relay${path}`));
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toContain("identity");
    }
  });

  test("upgrade issues a challenge and a valid proof authenticates", async () => {
    const ws = await connect(relay, alice);
    expect(ws._sent).toEqual([{ type: "authenticated", identity: alice.hex }]);
    expect(ws._closed).toBeNull();
  });

  test("status endpoint returns connection count", async () => {
    const pending = await open(relay, bob);
    await connect(relay, alice);
    const resp = await relay.fetch(new Request("https://relay/status"));
    expect(resp.status).toBe(200);
    expect((await resp.json()) as unknown).toEqual({ connections: 1, rooms: 0 });
    await relay.webSocketClose(pending.ws);
  });

  test("an unproven socket claiming an identity receives none of its traffic", async () => {
    const impostor = (await open(relay, bob)).ws;
    const wsA = await connect(relay, alice);
    await send(relay, wsA, { type: "dm", to: bob.hex, envelope: [1] });
    await send(relay, wsA, { type: "session_offer", to: bob.hex, sdp: "x", session_id: "s" });
    expect(impostor._sent).toEqual([]);

    // Anything but a valid auth reply closes the socket.
    await send(relay, impostor, { type: "dm", to: alice.hex, envelope: [2] });
    expect(impostor._closed).toBe(4401);
    expect(wsA._sent.filter((m) => m.type === "dm")).toEqual([]);
  });

  test("a proof from another identity's key is rejected and cannot evict the owner", async () => {
    const owner = await connect(relay, bob);
    const forged = await connect(relay, bob, charlie);
    expect(forged._sent).toEqual([{ type: "error", message: "authentication failed" }]);
    expect(forged._closed).toBe(4401);

    const wsA = await connect(relay, alice);
    await send(relay, wsA, { type: "dm", to: bob.hex, envelope: [7] });
    expect(owner._sent.at(-1)).toEqual({ type: "dm", from: alice.hex, envelope: [7] });
    expect(owner._closed).toBeNull();
  });

  test("a null auth reply is rejected immediately", async () => {
    const { ws } = await open(relay, alice);
    await relay.webSocketMessage(ws, "null");
    expect(ws._closed).toBe(4401);
  });

  test("a proof for a different nonce is rejected", async () => {
    const first = await open(relay, alice);
    const second = await open(relay, alice);
    const { auth } = signIdentityAuthJson(
      { rootPublicKey: alice.root.publicKey, secretKey: alice.root.secretKey },
      "relay.connect",
      alice.id,
      { audience: "relay", nonce: first.nonce, deviceId: alice.device },
    );
    await send(relay, second.ws, { type: "auth", auth });
    expect(second.ws._closed).toBe(4401);
    await relay.webSocketClose(first.ws);
  });

  test("session_offer routes to target with the authenticated sender as from", async () => {
    const wsA = await connect(relay, alice);
    const wsB = await connect(relay, bob);
    wsB._sent.length = 0;

    await send(relay, wsA, {
      type: "session_offer",
      to: bob.hex,
      from: charlie.hex,
      sdp: "fake-sdp",
      session_id: "sess-1",
    });

    expect(wsB._sent).toEqual([
      { type: "session_offer", to: bob.hex, from: alice.hex, sdp: "fake-sdp", session_id: "sess-1" },
    ]);
  });

  test("session_offer to offline target is silently dropped", async () => {
    const wsA = await connect(relay, alice);
    wsA._sent.length = 0;
    await send(relay, wsA, { type: "session_offer", to: charlie.hex, sdp: "fake-sdp", session_id: "sess-2" });
    expect(wsA._sent).toHaveLength(0);
  });

  test("room_event broadcasts to subscribed peers only", async () => {
    const wsA = await connect(relay, alice);
    const wsB = await connect(relay, bob);
    const wsC = await connect(relay, charlie);
    for (const ws of [wsA, wsB, wsC]) ws._sent.length = 0;

    await send(relay, wsA, { type: "room_subscribe", room_id: "general" });
    await send(relay, wsB, { type: "room_subscribe", room_id: "general" });
    await send(relay, wsA, { type: "room_event", room_id: "general", event: { text: "hello" } });

    expect(wsB._sent).toHaveLength(1);
    expect(wsB._sent[0]).toMatchObject({ type: "room_event", room_id: "general" });
    expect(wsA._sent).toHaveLength(0);
    expect(wsC._sent).toHaveLength(0);
  });

  test("room_unsubscribe stops receiving events", async () => {
    const wsA = await connect(relay, alice);
    const wsB = await connect(relay, bob);
    wsB._sent.length = 0;

    await send(relay, wsA, { type: "room_subscribe", room_id: "test-room" });
    await send(relay, wsB, { type: "room_subscribe", room_id: "test-room" });
    await send(relay, wsB, { type: "room_unsubscribe", room_id: "test-room" });
    await send(relay, wsA, { type: "room_event", room_id: "test-room", event: { text: "still here?" } });

    expect(wsB._sent).toHaveLength(0);
  });
});

test("Hono health route forwards to the relay Durable Object", async () => {
  const fetch = mock(async () => new Response(JSON.stringify({ connections: 0, rooms: 0 })));
  const env = {
    RELAY: { idFromName: mock(() => "default"), get: mock(() => ({ fetch })) },
  } as unknown as { RELAY: DurableObjectNamespace };
  const response = await worker.fetch(new Request("https://relay/health"), env, {} as ExecutionContext);

  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(fetch).toHaveBeenCalledWith("https://relay/status");
});
