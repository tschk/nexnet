import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import { NexnetClient } from "../client.js";
import { PeerManager } from "../webrtc.js";
import { createWeriftPeerConnection } from "../werift-factory.js";
import type { CborCdeCodec } from "@nexnet/types";

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    let msg: { type?: string; to?: string; from?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // Relay signalling: deliver to matching identity
    if (msg.to) {
      for (const ws of MockWebSocket.instances) {
        if (ws === this) continue;
        const m = ws.url.match(/identity=([0-9a-f]+)/i);
        if (m?.[1] === msg.to) {
          // inject from if missing
          const payload = { ...msg };
          if (!payload.from) {
            const sm = this.url.match(/identity=([0-9a-f]+)/i);
            if (sm) (payload as { from: string }).from = sm[1]!;
          }
          queueMicrotask(() =>
            ws.onmessage?.({ data: JSON.stringify(payload) })
          );
        }
      }
    }
  }

  close(): void {
    this.readyState = 3;
  }
}

function makeClient(fill: number, sk: Uint8Array): NexnetClient {
  return new NexnetClient({
    identityId: new Uint8Array(32).fill(fill),
    deviceId: new Uint8Array(32).fill(fill ^ 0x11),
    crypto: cryptoProvider,
    codec,
    relayUrl: "https://relay.example.com",
    storagePath: `/tmp/werift-${fill}`,
    signingSecretKey: sk,
  });
}

describe("werift PeerManager", () => {
  let origWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
  });

  test("two peers open data channel and exchange bytes", async () => {
    const kpA = cryptoProvider.generateSigningKeyPair();
    const kpB = cryptoProvider.generateSigningKeyPair();
    const alice = makeClient(0x11, kpA.secretKey);
    const bob = makeClient(0x22, kpB.secretKey);
    await alice.connect();
    await bob.connect();

    const bobHex = Buffer.from(bob.identityId).toString("hex");
    const aliceHex = Buffer.from(alice.identityId).toString("hex");

    const received: Uint8Array[] = [];
    const pmBob = new PeerManager({
      client: bob,
      createPeerConnection: createWeriftPeerConnection({
        iceServers: [],
      }),
      onMessage: (_peer, data) => {
        received.push(data);
      },
    });

    const pmAlice = new PeerManager({
      client: alice,
      createPeerConnection: createWeriftPeerConnection({
        iceServers: [],
      }),
    });

    await pmAlice.connect(bobHex);

    // Wait for ICE + DTLS + SCTP (local candidates via relay mock)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (pmAlice.isOpen(bobHex) && pmBob.isOpen(aliceHex)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(pmAlice.isOpen(bobHex)).toBe(true);
    expect(pmBob.isOpen(aliceHex)).toBe(true);

    const ok = pmAlice.send(bobHex, new Uint8Array([7, 8, 9]));
    expect(ok).toBe(true);

    const msgDeadline = Date.now() + 5000;
    while (Date.now() < msgDeadline && received.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toEqual(new Uint8Array([7, 8, 9]));

    pmAlice.destroy();
    pmBob.destroy();
    await alice.disconnect();
    await bob.disconnect();
  }, 30000);
});
