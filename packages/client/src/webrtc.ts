/**
 * @nexnet/client — Direct peer sessions (WebRTC data channels)
 *
 * Relay only for signalling (offer/answer/ICE). Message bodies go P2P when up.
 * RTCPeerConnection injected — works in browser; Node needs wrtc/werift later.
 *
 * ponytail: no WebRTC npm dep. Inject factory. Add native package when shipping Node peers.
 */

import type { NexnetClient } from "./client.js";

export type PeerMessageHandler = (
  peerIdentityHex: string,
  data: Uint8Array
) => void;

/** Minimal RTC types so we don't depend on DOM lib everywhere */
export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  toJSON?: () => {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };
}

export interface SessionDescriptionLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface DataChannelLike {
  readyState: string;
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(): void;
}

export interface PeerConnectionLike {
  connectionState: string;
  iceConnectionState: string;
  localDescription: SessionDescriptionLike | null;
  remoteDescription: SessionDescriptionLike | null;
  onicecandidate: ((ev: { candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(desc: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: SessionDescriptionLike): Promise<void>;
  addIceCandidate(c: IceCandidateLike): Promise<void>;
  close(): void;
}

export type PeerConnectionFactory = () => PeerConnectionLike;

export interface PeerSession {
  peerIdentityHex: string;
  sessionId: string;
  pc: PeerConnectionLike;
  channel: DataChannelLike | null;
  state: "connecting" | "open" | "closed" | "failed";
}

export interface PeerManagerOptions {
  client: NexnetClient;
  createPeerConnection: PeerConnectionFactory;
  onMessage?: PeerMessageHandler;
  /** Called when direct path fails — caller may fall back to relay */
  onFailed?: (peerIdentityHex: string, reason: string) => void;
  onOpen?: (peerIdentityHex: string) => void;
}

function randomSessionId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}

function candidateJson(c: IceCandidateLike): string {
  if (c.toJSON) return JSON.stringify(c.toJSON());
  return JSON.stringify({
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
  });
}

export class PeerManager {
  private readonly client: NexnetClient;
  private readonly createPc: PeerConnectionFactory;
  private readonly onMessage?: PeerMessageHandler;
  private readonly onFailed?: (peer: string, reason: string) => void;
  private readonly onOpen?: (peer: string) => void;
  private readonly sessions = new Map<string, PeerSession>(); // peer hex → session
  private readonly bySessionId = new Map<string, PeerSession>();
  private unsub: Array<() => void> = [];

  constructor(opts: PeerManagerOptions) {
    this.client = opts.client;
    this.createPc = opts.createPeerConnection;
    this.onMessage = opts.onMessage;
    this.onFailed = opts.onFailed;
    this.onOpen = opts.onOpen;
    this.wireSignaling();
  }

  /** Active open data-channel peer? */
  isOpen(peerIdentityHex: string): boolean {
    const s = this.sessions.get(peerIdentityHex);
    return !!s && s.state === "open" && s.channel?.readyState === "open";
  }

  getSession(peerIdentityHex: string): PeerSession | undefined {
    return this.sessions.get(peerIdentityHex);
  }

  /**
   * Offer direct session to peer. Caller still owns message path fallback.
   */
  async connect(peerIdentityHex: string): Promise<PeerSession> {
    const existing = this.sessions.get(peerIdentityHex);
    if (existing && existing.state !== "closed" && existing.state !== "failed") {
      return existing;
    }

    const sessionId = randomSessionId();
    const pc = this.createPc();
    const session: PeerSession = {
      peerIdentityHex,
      sessionId,
      pc,
      channel: null,
      state: "connecting",
    };
    this.track(session);

    const channel = pc.createDataChannel("nexnet");
    this.bindChannel(session, channel);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      try {
        this.client.sendSignaling("candidate", peerIdentityHex, {
          session_id: sessionId,
          candidate: candidateJson(ev.candidate),
        });
      } catch {
        // offline — ignore
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        session.state = pc.connectionState === "failed" ? "failed" : "closed";
        if (session.state === "failed") {
          this.onFailed?.(peerIdentityHex, "connection_failed");
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.client.sendSignaling("session_offer", peerIdentityHex, {
      session_id: sessionId,
      sdp: offer.sdp ?? "",
      from: Buffer.from(this.client.identityId).toString("hex"),
    });

    return session;
  }

  /** Send binary over data channel. Returns false if not open. */
  send(peerIdentityHex: string, data: Uint8Array): boolean {
    const s = this.sessions.get(peerIdentityHex);
    if (!s || s.state !== "open" || !s.channel || s.channel.readyState !== "open") {
      return false;
    }
    s.channel.send(data);
    return true;
  }

  close(peerIdentityHex: string): void {
    const s = this.sessions.get(peerIdentityHex);
    if (!s) return;
    try {
      s.channel?.close();
      s.pc.close();
    } catch {
      // ignore
    }
    s.state = "closed";
    this.sessions.delete(peerIdentityHex);
    this.bySessionId.delete(s.sessionId);
  }

  destroy(): void {
    for (const peer of [...this.sessions.keys()]) this.close(peer);
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  private track(session: PeerSession): void {
    this.sessions.set(session.peerIdentityHex, session);
    this.bySessionId.set(session.sessionId, session);
  }

  private bindChannel(session: PeerSession, channel: DataChannelLike): void {
    session.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      session.state = "open";
      this.onOpen?.(session.peerIdentityHex);
    };
    channel.onclose = () => {
      if (session.state === "open") session.state = "closed";
    };
    channel.onerror = () => {
      session.state = "failed";
      this.onFailed?.(session.peerIdentityHex, "channel_error");
    };
    channel.onmessage = (ev) => {
      const raw = ev.data;
      const bytes =
        typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : new Uint8Array(raw);
      this.onMessage?.(session.peerIdentityHex, bytes);
    };
  }

  private wireSignaling(): void {
    const onOffer = async (data: unknown) => {
      const msg = data as {
        from?: string;
        session_id?: string;
        sdp?: string;
        to?: string;
      };
      if (!msg.from || !msg.session_id || !msg.sdp) return;

      const peerIdentityHex = msg.from;
      const pc = this.createPc();
      const session: PeerSession = {
        peerIdentityHex,
        sessionId: msg.session_id,
        pc,
        channel: null,
        state: "connecting",
      };
      this.track(session);

      pc.ondatachannel = (ev) => this.bindChannel(session, ev.channel);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        try {
          this.client.sendSignaling("candidate", peerIdentityHex, {
            session_id: session.sessionId,
            candidate: candidateJson(ev.candidate),
          });
        } catch {
          // ignore
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          session.state = "failed";
          this.onFailed?.(peerIdentityHex, "connection_failed");
        }
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.client.sendSignaling("session_answer", peerIdentityHex, {
        session_id: session.sessionId,
        sdp: answer.sdp ?? "",
      });
    };

    const onAnswer = async (data: unknown) => {
      const msg = data as { session_id?: string; sdp?: string };
      if (!msg.session_id || !msg.sdp) return;
      const session = this.bySessionId.get(msg.session_id);
      if (!session) return;
      await session.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    };

    const onCandidate = async (data: unknown) => {
      const msg = data as { session_id?: string; candidate?: string };
      if (!msg.session_id || !msg.candidate) return;
      const session = this.bySessionId.get(msg.session_id);
      if (!session) return;
      try {
        const parsed = JSON.parse(msg.candidate) as IceCandidateLike;
        await session.pc.addIceCandidate(parsed);
      } catch {
        // bad candidate — ignore
      }
    };

    this.client.on("session_offer", onOffer);
    this.client.on("session_answer", onAnswer);
    this.client.on("candidate", onCandidate);
    this.unsub.push(
      () => this.client.off("session_offer", onOffer),
      () => this.client.off("session_answer", onAnswer),
      () => this.client.off("candidate", onCandidate)
    );
  }
}
