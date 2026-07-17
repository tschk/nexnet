import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { NettleClient } from "../client.js";
import type {
  CryptoProvider,
  CborCdeCodec,
  IdentityId,
  DeviceId,
} from "@nettle/types";

// ── Mock crypto/codec ────────────────────────────────────────────────

function createMockCrypto(): CryptoProvider {
  return {
    deriveId(_context: string, data: Uint8Array): Uint8Array {
      const out = new Uint8Array(32);
      for (let i = 0; i < data.length; i++) {
        out[i % 32] ^= data[i];
        out[(i + 7) % 32] ^= (data[i] * 31) & 0xff;
      }
      return out;
    },
    sign(): Uint8Array {
      return new Uint8Array(64);
    },
    verify(): boolean {
      return true;
    },
    generateSigningKeyPair() {
      return { secretKey: new Uint8Array(64), publicKey: new Uint8Array(32) };
    },
    encrypt(_key: Uint8Array, _nonce: Uint8Array, _aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
      return new Uint8Array(plaintext);
    },
    decrypt(_key: Uint8Array, _nonce: Uint8Array, _aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
      return new Uint8Array(ciphertext);
    },
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(n).fill(42);
    },
    hkdf(): Uint8Array {
      return new Uint8Array(32);
    },
  };
}

function createMockCodec(): CborCdeCodec {
  return {
    encode(value: unknown): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(value));
    },
    decode<T = unknown>(bytes: Uint8Array): T {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    },
  };
}

// ── Mock WebSocket ───────────────────────────────────────────────────

type WsEventHandler = (event: any) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0; // CONNECTING
  onopen: WsEventHandler | null = null;
  onclose: WsEventHandler | null = null;
  onerror: WsEventHandler | null = null;
  onmessage: WsEventHandler | null = null;
  sent: string[] = [];

  // Control whether connection succeeds
  static autoConnect = true;
  // Control close behavior
  static closeOnConnect = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);

    if (MockWebSocket.autoConnect) {
      // Simulate async open
      queueMicrotask(() => {
        if (MockWebSocket.closeOnConnect) {
          this.readyState = 3; // CLOSED
          this.onclose?.({ code: 1006, reason: "mock close" });
        } else {
          this.readyState = 1; // OPEN
          this.onopen?.({});
        }
      });
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "client close" });
  }

  // Test helpers
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  simulateClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "abnormal" });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function createTestClient(overrides?: Partial<ConstructorParameters<typeof NettleClient>[0]>): {
  client: NettleClient;
  identityId: IdentityId;
  deviceId: DeviceId;
} {
  const identityId = new Uint8Array(32).fill(0xaa);
  const deviceId = new Uint8Array(32).fill(0xbb);

  const client = new NettleClient({
    identityId,
    deviceId,
    crypto: createMockCrypto(),
    codec: createMockCodec(),
    relayUrl: "https://relay.example.com",
    storagePath: "/tmp/nettle-test",
    signingSecretKey: new Uint8Array(64).fill(0xcc),
    maxReconnectAttempts: 3,
    reconnectBaseMs: 10,
    reconnectMaxMs: 50,
    ...overrides,
  });

  return { client, identityId, deviceId };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("NettleClient WebSocket", () => {
  let origWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    MockWebSocket.autoConnect = true;
    MockWebSocket.closeOnConnect = false;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = origWebSocket;
  });

  test("connect builds correct URL with identity and device hex", async () => {
    const { client } = createTestClient();
    await client.connect();

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("/ws?");
    expect(ws.url).toContain("identity=" + "aa".repeat(32));
    expect(ws.url).toContain("device=" + "bb".repeat(32));
    expect(ws.url).toMatch(/^wss:\/\//); // https -> wss

    await client.disconnect();
  });

  test("connect sets online=true and emits connected", async () => {
    const { client } = createTestClient();
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));

    expect(client.online).toBe(false);
    await client.connect();
    expect(client.online).toBe(true);
    expect(events).toEqual(["connected"]);

    await client.disconnect();
  });

  test("disconnect sets online=false and emits disconnected", async () => {
    const { client } = createTestClient();
    const events: string[] = [];
    client.on("disconnected", () => events.push("disconnected"));

    await client.connect();
    expect(client.online).toBe(true);

    await client.disconnect();
    expect(client.online).toBe(false);
    expect(events).toEqual(["disconnected"]);
  });

  test("connect is idempotent — second call is no-op", async () => {
    const { client } = createTestClient();
    await client.connect();
    await client.connect(); // should not throw or create new WS
    expect(MockWebSocket.instances.length).toBe(1);

    await client.disconnect();
  });

  test("sendWs sends JSON over WebSocket", async () => {
    const { client } = createTestClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    client.sendWs({ type: "test", value: 42 });

    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "test", value: 42 });

    await client.disconnect();
  });

  test("sendWs throws when not connected", () => {
    const { client } = createTestClient();
    expect(() => client.sendWs({ type: "test" })).toThrow("Not connected");
  });

  test("sendSignaling forwards to relay", async () => {
    const { client } = createTestClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    client.sendSignaling("session_offer", "cc".repeat(32), {
      sdp: "v=0...",
      session_id: "sess1",
    });

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("session_offer");
    expect(sent.to).toBe("cc".repeat(32));
    expect(sent.sdp).toBe("v=0...");
    expect(sent.session_id).toBe("sess1");

    await client.disconnect();
  });

  test("subscribeRoom sends room_subscribe", async () => {
    const { client } = createTestClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    client.subscribeRoom("dd".repeat(32));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("room_subscribe");
    expect(sent.room_id).toBe("dd".repeat(32));

    await client.disconnect();
  });

  test("unsubscribeRoom sends room_unsubscribe", async () => {
    const { client } = createTestClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    client.unsubscribeRoom("dd".repeat(32));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("room_unsubscribe");
    expect(sent.room_id).toBe("dd".repeat(32));

    await client.disconnect();
  });

  test("sendRoomEvent sends room_event", async () => {
    const { client } = createTestClient();
    await client.connect();

    const ws = MockWebSocket.instances[0];
    client.sendRoomEvent("dd".repeat(32), { text: "hello" });

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("room_event");
    expect(sent.room_id).toBe("dd".repeat(32));
    expect(sent.event.text).toBe("hello");

    await client.disconnect();
  });

  test("sendDm returns true when connected", async () => {
    const { client } = createTestClient();
    await client.connect();

    const result = client.sendDm("cc".repeat(32), [1, 2, 3]);
    expect(result).toBe(true);

    const ws = MockWebSocket.instances[0];
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("dm");
    expect(sent.to).toBe("cc".repeat(32));
    expect(sent.envelope).toEqual([1, 2, 3]);

    await client.disconnect();
  });

  test("sendDm returns false when not connected", () => {
    const { client } = createTestClient();
    const result = client.sendDm("cc".repeat(32), [1, 2, 3]);
    expect(result).toBe(false);
  });

  test("incoming dm message emits dm event", async () => {
    const { client } = createTestClient();
    await client.connect();

    const received: unknown[] = [];
    client.on("dm", (data) => received.push(data));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({ type: "dm", envelope: [1, 2, 3] }));

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ type: "dm", envelope: [1, 2, 3] });

    await client.disconnect();
  });

  test("incoming session_offer emits session_offer event", async () => {
    const { client } = createTestClient();
    await client.connect();

    const received: unknown[] = [];
    client.on("session_offer", (data) => received.push(data));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(
      JSON.stringify({
        type: "session_offer",
        from: "cc".repeat(32),
        sdp: "v=0...",
        session_id: "sess1",
      })
    );

    expect(received.length).toBe(1);

    await client.disconnect();
  });

  test("incoming room_event emits room_event event", async () => {
    const { client } = createTestClient();
    await client.connect();

    const received: unknown[] = [];
    client.on("room_event", (data) => received.push(data));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(
      JSON.stringify({
        type: "room_event",
        room_id: "dd".repeat(32),
        event: { text: "hello" },
      })
    );

    expect(received.length).toBe(1);

    await client.disconnect();
  });

  test("incoming error emits error event", async () => {
    const { client } = createTestClient();
    await client.connect();

    const received: unknown[] = [];
    client.on("error", (data) => received.push(data));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(
      JSON.stringify({ type: "error", message: "invalid JSON" })
    );

    expect(received.length).toBe(1);

    await client.disconnect();
  });

  test("malformed JSON is silently ignored", async () => {
    const { client } = createTestClient();
    await client.connect();

    const received: unknown[] = [];
    client.on("dm", (data) => received.push(data));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage("not valid json {{{");

    expect(received.length).toBe(0);

    await client.disconnect();
  });

  test("reconnects on abnormal close with exponential backoff", async () => {
    const { client } = createTestClient();
    const events: string[] = [];
    client.on("reconnecting", (data) => {
      const msg = data as { attempt: number; delayMs: number };
      events.push(`reconnect:${msg.attempt}`);
    });
    client.on("connected", () => events.push("connected"));

    await client.connect();
    expect(MockWebSocket.instances.length).toBe(1);

    // Simulate abnormal close
    MockWebSocket.instances[0].simulateClose();

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toContain("reconnect:1");
    expect(events.filter((e) => e === "connected").length).toBe(2);
    expect(MockWebSocket.instances.length).toBe(2);

    await client.disconnect();
  });

  test("does not reconnect on intentional disconnect", async () => {
    const { client } = createTestClient();
    const events: string[] = [];
    client.on("reconnecting", () => events.push("reconnecting"));

    await client.connect();
    await client.disconnect();

    // Wait to ensure no reconnect attempt
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toEqual([]);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  test("reconnect gives up after maxReconnectAttempts", async () => {
    const { client } = createTestClient({ maxReconnectAttempts: 2 });
    const events: string[] = [];
    client.on("reconnecting", (data) => {
      const msg = data as { attempt: number };
      events.push(`attempt:${msg.attempt}`);
    });

    await client.connect();
    expect(MockWebSocket.instances.length).toBe(1);

    // After first connect, make reconnects fail immediately
    MockWebSocket.closeOnConnect = true;

    // Simulate abnormal close on current connection
    MockWebSocket.instances[0].simulateClose();

    // Wait for all reconnect attempts to exhaust
    await new Promise((r) => setTimeout(r, 300));

    // Should have attempted exactly 2 reconnects then given up
    expect(events.filter((e) => e.startsWith("attempt:")).length).toBe(2);

    // No additional WS instances beyond the 2 failed reconnects + original
    expect(MockWebSocket.instances.length).toBe(3);

    await client.disconnect();
  });

  test("ws:// URL for http relayUrl", async () => {
    const { client } = createTestClient({ relayUrl: "http://localhost:8787" });
    await client.connect();

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toMatch(/^ws:\/\//);
    expect(ws.url).toContain("localhost:8787/ws?");

    await client.disconnect();
  });

  test("strips trailing slashes from relayUrl", async () => {
    const { client } = createTestClient({ relayUrl: "https://relay.example.com///" });
    await client.connect();

    const ws = MockWebSocket.instances[0];
    expect(ws.url).not.toContain("///ws");
    expect(ws.url).toContain("relay.example.com/ws?");

    await client.disconnect();
  });
});

describe("NettleClient two-instance DM flow", () => {
  let origWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    MockWebSocket.autoConnect = true;
    MockWebSocket.closeOnConnect = false;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = origWebSocket;
  });

  test("client A sends DM, client B receives it via relay mock", async () => {
    // Simulate relay: when A sends, deliver to B
    const relayMiddleware = (sender: MockWebSocket, data: string) => {
      const msg = JSON.parse(data);
      if (msg.type === "dm" && msg.to) {
        // Find B's WebSocket and deliver
        const recipientWs = MockWebSocket.instances.find(
          (ws) => ws !== sender && ws.url.includes(`identity=${msg.to}`)
        );
        if (recipientWs) {
          queueMicrotask(() => {
            recipientWs.simulateMessage(data);
          });
        }
      }
    };

    // Patch MockWebSocket.send to trigger relay
    const origSend = MockWebSocket.prototype.send;
    MockWebSocket.prototype.send = function (data: string) {
      origSend.call(this, data);
      relayMiddleware(this as any, data);
    };

    (globalThis as any).WebSocket = MockWebSocket;

    const identityA = new Uint8Array(32).fill(0xaa);
    const identityB = new Uint8Array(32).fill(0xbb);

    const clientA = new NettleClient({
      identityId: identityA,
      deviceId: new Uint8Array(32).fill(0x01),
      crypto: createMockCrypto(),
      codec: createMockCodec(),
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nettle-a",
      signingSecretKey: new Uint8Array(64).fill(0xcc),
    });

    const clientB = new NettleClient({
      identityId: identityB,
      deviceId: new Uint8Array(32).fill(0x02),
      crypto: createMockCrypto(),
      codec: createMockCodec(),
      relayUrl: "https://relay.example.com",
      storagePath: "/tmp/nettle-b",
      signingSecretKey: new Uint8Array(64).fill(0xdd),
    });

    await clientA.connect();
    await clientB.connect();

    // B listens for DMs
    const receivedByB: unknown[] = [];
    clientB.on("dm", (data) => receivedByB.push(data));

    // A sends DM to B
    const recipientHex = Buffer.from(identityB).toString("hex");
    const sent = clientA.sendDm(recipientHex, [10, 20, 30]);
    expect(sent).toBe(true);

    // Wait for async relay delivery
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedByB.length).toBe(1);
    expect((receivedByB[0] as any).envelope).toEqual([10, 20, 30]);

    await clientA.disconnect();
    await clientB.disconnect();

    MockWebSocket.prototype.send = origSend;
  });
});
