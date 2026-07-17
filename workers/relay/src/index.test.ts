import { describe, test, expect, mock, beforeEach } from "bun:test";
import worker, { RelaySession } from "./index.js";

// Minimal DurableObjectState mock
function createMockState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => store.delete(key),
      list: async () => [...store.entries()],
    },
    acceptWebSocket: mock(() => {}),
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
  } as unknown as DurableObjectState;
}

function createMockEnv() {
  return { RELAY: {} as DurableObjectNamespace };
}

// Mock WebSocket that captures sent messages
function createMockWs(identity: string) {
  const sent: unknown[] = [];
  const ws = {
    send: mock((data: string) => { sent.push(JSON.parse(data)); }),
    close: mock(() => {}),
    _identity: identity,
    _sent: sent,
  };
  return ws as unknown as WebSocket & { _sent: unknown[] };
}

describe("RelaySession", () => {
  let relay: RelaySession;

  beforeEach(() => {
    relay = new RelaySession(createMockState(), createMockEnv());
  });

  test("WebSocket upgrade requires identity and device params", async () => {
    const req = new Request("https://relay/ws");
    const resp = await relay.fetch(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("identity");
  });

  test("WebSocket upgrade succeeds with valid params", async () => {
    // WebSocketPair is a Cloudflare Workers API — mock it for Bun
    const origWSP = (globalThis as any).WebSocketPair;
    (globalThis as any).WebSocketPair = class {
      0: any; 1: any;
      constructor() { this[0] = {}; this[1] = {}; }
    };
    try {
      const req = new Request("https://relay/ws?identity=alice&device=d1");
      const resp = await relay.fetch(req);
      expect(resp.status).toBe(101);
    } finally {
      if (origWSP) (globalThis as any).WebSocketPair = origWSP;
      else delete (globalThis as any).WebSocketPair;
    }
  });

  test("status endpoint returns connection count", async () => {
    const req = new Request("https://relay/status");
    const resp = await relay.fetch(req);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { connections: number; rooms: number };
    expect(body.connections).toBe(0);
    expect(body.rooms).toBe(0);
  });

  test("session_offer routes to target connection", async () => {
    // Simulate two connected clients by calling webSocketMessage directly
    const wsA = createMockWs("alice");
    const wsB = createMockWs("bob");

    // Manually register connections (bypass WebSocket upgrade)
    (relay as any).connections.set("alice", {
      ws: wsA, identity: "alice", device: "d1", rooms: new Set(),
    });
    (relay as any).connections.set("bob", {
      ws: wsB, identity: "bob", device: "d2", rooms: new Set(),
    });

    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "session_offer",
      to: "bob",
      sdp: "fake-sdp",
      session_id: "sess-1",
    }));

    expect((wsB as any)._sent).toHaveLength(1);
    expect((wsB as any)._sent[0]).toMatchObject({
      type: "session_offer",
      to: "bob",
      sdp: "fake-sdp",
    });
  });

  test("session_offer to offline target is silently dropped", async () => {
    const wsA = createMockWs("alice");
    (relay as any).connections.set("alice", {
      ws: wsA, identity: "alice", device: "d1", rooms: new Set(),
    });

    // Should not throw
    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "session_offer",
      to: "offline-user",
      sdp: "fake-sdp",
      session_id: "sess-2",
    }));

    expect((wsA as any)._sent).toHaveLength(0);
  });

  test("room_event broadcasts to subscribed peers only", async () => {
    const wsA = createMockWs("alice");
    const wsB = createMockWs("bob");
    const wsC = createMockWs("charlie");

    (relay as any).connections.set("alice", {
      ws: wsA, identity: "alice", device: "d1", rooms: new Set(),
    });
    (relay as any).connections.set("bob", {
      ws: wsB, identity: "bob", device: "d2", rooms: new Set(),
    });
    (relay as any).connections.set("charlie", {
      ws: wsC, identity: "charlie", device: "d3", rooms: new Set(),
    });

    // Alice and Bob subscribe to room "general", Charlie does not
    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "room_subscribe", room_id: "general",
    }));
    await relay.webSocketMessage(wsB as unknown as WebSocket, JSON.stringify({
      type: "room_subscribe", room_id: "general",
    }));

    // Alice sends room event
    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "room_event",
      room_id: "general",
      event: { text: "hello" },
    }));

    // Bob should receive it, Alice (sender) and Charlie (not subscribed) should not
    expect((wsB as any)._sent).toHaveLength(1);
    expect((wsB as any)._sent[0]).toMatchObject({
      type: "room_event",
      room_id: "general",
    });
    expect((wsA as any)._sent).toHaveLength(0);
    expect((wsC as any)._sent).toHaveLength(0);
  });

  test("room_unsubscribe stops receiving events", async () => {
    const wsA = createMockWs("alice");
    const wsB = createMockWs("bob");

    (relay as any).connections.set("alice", {
      ws: wsA, identity: "alice", device: "d1", rooms: new Set(),
    });
    (relay as any).connections.set("bob", {
      ws: wsB, identity: "bob", device: "d2", rooms: new Set(),
    });

    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "room_subscribe", room_id: "test-room",
    }));
    await relay.webSocketMessage(wsB as unknown as WebSocket, JSON.stringify({
      type: "room_subscribe", room_id: "test-room",
    }));
    await relay.webSocketMessage(wsB as unknown as WebSocket, JSON.stringify({
      type: "room_unsubscribe", room_id: "test-room",
    }));

    await relay.webSocketMessage(wsA as unknown as WebSocket, JSON.stringify({
      type: "room_event",
      room_id: "test-room",
      event: { text: "still here?" },
    }));

    expect((wsB as any)._sent).toHaveLength(0);
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
