import { describe, test, expect, beforeEach } from "bun:test";
import type {
  DataChannelLike,
  PeerConnectionFactory,
  PeerConnectionLike,
  SessionDescriptionLike,
} from "../webrtc.js";
import { PeerManager } from "../webrtc.js";
import type { NexnetClient } from "../client.js";

type Handler = (data: unknown) => void;

function mockClient() {
  const handlers = new Map<string, Set<Handler>>();
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    identityId: new Uint8Array(32).fill(0x11),
    online: true,
    on(event: string, h: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
    },
    off(event: string, h: Handler) {
      handlers.get(event)?.delete(h);
    },
    emit(event: string, data: unknown) {
      for (const h of handlers.get(event) ?? []) h(data);
    },
    sendSignaling(
      type: string,
      to: string,
      data: Record<string, unknown>
    ) {
      sent.push({ type, to, ...data });
    },
  };
  return {
    client: client as unknown as NexnetClient,
    sent,
    emit: (event: string, data: unknown) => client.emit(event, data),
  };
}

function mockFactory(): {
  factory: PeerConnectionFactory;
  pcs: PeerConnectionLike[];
  channels: DataChannelLike[];
} {
  const pcs: PeerConnectionLike[] = [];
  const channels: DataChannelLike[] = [];

  const factory: PeerConnectionFactory = () => {
    let local: SessionDescriptionLike | null = null;
    let remote: SessionDescriptionLike | null = null;
    const channel: DataChannelLike = {
      readyState: "connecting",
      binaryType: "arraybuffer",
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {
        this.readyState = "closed";
      },
    };
    channels.push(channel);

    const pc: PeerConnectionLike = {
      connectionState: "new",
      iceConnectionState: "new",
      get localDescription() {
        return local;
      },
      get remoteDescription() {
        return remote;
      },
      onicecandidate: null,
      onconnectionstatechange: null,
      ondatachannel: null,
      createDataChannel() {
        return channel;
      },
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\noffer" };
      },
      async createAnswer() {
        return { type: "answer", sdp: "v=0\r\nanswer" };
      },
      async setLocalDescription(desc) {
        local = desc;
      },
      async setRemoteDescription(desc) {
        remote = desc;
      },
      async addIceCandidate() {},
      close() {
        this.connectionState = "closed";
      },
    };
    pcs.push(pc);
    return pc;
  };

  return { factory, pcs, channels };
}

describe("PeerManager", () => {
  let mock: ReturnType<typeof mockClient>;
  let factory: ReturnType<typeof mockFactory>;
  let mgr: PeerManager;

  beforeEach(() => {
    mock = mockClient();
    factory = mockFactory();
    mgr = new PeerManager({
      client: mock.client,
      createPeerConnection: factory.factory,
    });
  });

  test("connect sends session_offer with sdp", async () => {
    const session = await mgr.connect("aabb");
    expect(session.state).toBe("connecting");
    expect(mock.sent.length).toBe(1);
    expect(mock.sent[0]!.type).toBe("session_offer");
    expect(mock.sent[0]!.to).toBe("aabb");
    expect(mock.sent[0]!.sdp).toBe("v=0\r\noffer");
    expect(typeof mock.sent[0]!.session_id).toBe("string");
  });

  test("answer signalling sets remote description", async () => {
    const session = await mgr.connect("aabb");
    mock.emit("session_answer", {
      session_id: session.sessionId,
      sdp: "v=0\r\nanswer",
    });
    // allow microtask
    await Promise.resolve();
    expect(session.pc.remoteDescription?.type).toBe("answer");
  });

  test("incoming offer produces session_answer", async () => {
    mock.emit("session_offer", {
      from: "ccdd",
      session_id: "sess-1",
      sdp: "v=0\r\noffer",
    });
    // handlers are async
    await new Promise((r) => setTimeout(r, 10));
    const answer = mock.sent.find((s) => s.type === "session_answer");
    expect(answer).toBeDefined();
    expect(answer!.to).toBe("ccdd");
    expect(answer!.session_id).toBe("sess-1");
  });

  test("send fails when channel not open", async () => {
    await mgr.connect("aabb");
    expect(mgr.send("aabb", new Uint8Array([1, 2, 3]))).toBe(false);
  });

  test("send works when channel open", async () => {
    const session = await mgr.connect("aabb");
    const ch = factory.channels[0]!;
    const sent: Uint8Array[] = [];
    ch.send = (data: ArrayBuffer | Uint8Array | string) => {
      if (typeof data === "string") sent.push(new TextEncoder().encode(data));
      else sent.push(new Uint8Array(data as ArrayBuffer));
    };
    ch.readyState = "open";
    session.state = "open";
    session.channel = ch;

    expect(mgr.isOpen("aabb")).toBe(true);
    expect(mgr.send("aabb", new Uint8Array([9, 8]))).toBe(true);
    expect(sent[0]).toEqual(new Uint8Array([9, 8]));
  });

  test("close removes session", async () => {
    await mgr.connect("aabb");
    mgr.close("aabb");
    expect(mgr.getSession("aabb")).toBeUndefined();
  });

  test("ICE candidate forwarded to peer connection", async () => {
    const session = await mgr.connect("aabb");
    let added = false;
    session.pc.addIceCandidate = async () => {
      added = true;
    };
    mock.emit("candidate", {
      session_id: session.sessionId,
      candidate: JSON.stringify({ candidate: "cand", sdpMid: "0" }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(added).toBe(true);
  });
});
