/**
 * @nexnet/client — native WebRTC via werift (Node/Bun)
 *
 * Real RTCPeerConnection implementation for PeerManager.
 */

import {
  RTCPeerConnection,
  type RTCDataChannel,
  type RTCIceCandidate,
  type RTCSessionDescription,
} from "werift";
import type {
  DataChannelLike,
  IceCandidateLike,
  PeerConnectionFactory,
  PeerConnectionLike,
  SessionDescriptionLike,
} from "./webrtc.js";

function adaptChannel(ch: RTCDataChannel): DataChannelLike {
  const adapted: DataChannelLike = {
    get readyState() {
      return ch.readyState;
    },
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data: ArrayBuffer | Uint8Array | string) {
      if (typeof data === "string") {
        ch.send(data);
      } else {
        ch.send(Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
      }
    },
    close() {
      ch.close();
    },
  };

  ch.onopen = () => adapted.onopen?.({});
  ch.onclose = () => adapted.onclose?.({});
  ch.onerror = (e) => adapted.onerror?.(e);
  ch.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "string") {
      adapted.onmessage?.({ data });
    } else if (data instanceof ArrayBuffer) {
      adapted.onmessage?.({ data });
    } else if (Buffer.isBuffer(data)) {
      const bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      adapted.onmessage?.({
        data: bytes.buffer,
      });
    } else {
      adapted.onmessage?.({ data: new Uint8Array(data as ArrayBuffer).buffer });
    }
  };

  return adapted;
}

function adaptPc(pc: RTCPeerConnection): PeerConnectionLike {
  const adapted: PeerConnectionLike = {
    get connectionState() {
      return pc.connectionState;
    },
    get iceConnectionState() {
      return pc.iceConnectionState;
    },
    get localDescription() {
      const d = pc.localDescription;
      return d ? { type: d.type as SessionDescriptionLike["type"], sdp: d.sdp } : null;
    },
    get remoteDescription() {
      const d = pc.remoteDescription;
      return d ? { type: d.type as SessionDescriptionLike["type"], sdp: d.sdp } : null;
    },
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel(label: string) {
      return adaptChannel(pc.createDataChannel(label));
    },
    async createOffer() {
      const offer = await pc.createOffer();
      return { type: offer.type as "offer", sdp: offer.sdp };
    },
    async createAnswer() {
      const answer = await pc.createAnswer();
      return { type: answer.type as "answer", sdp: answer.sdp };
    },
    async setLocalDescription(desc: SessionDescriptionLike) {
      await pc.setLocalDescription({
        type: desc.type as "offer" | "answer",
        sdp: desc.sdp ?? "",
      });
    },
    async setRemoteDescription(desc: SessionDescriptionLike) {
      await pc.setRemoteDescription({
        type: desc.type as "offer" | "answer",
        sdp: desc.sdp ?? "",
      });
    },
    async addIceCandidate(c: IceCandidateLike) {
      await pc.addIceCandidate({
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? undefined,
        sdpMLineIndex: c.sdpMLineIndex ?? undefined,
      } as RTCIceCandidate);
    },
    close() {
      pc.close();
    },
  };

  pc.onicecandidate = (ev) => {
    const cand = ev.candidate as RTCIceCandidate | undefined;
    adapted.onicecandidate?.({
      candidate: cand
        ? {
            candidate: cand.candidate,
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
            toJSON: () => ({
              candidate: cand.candidate,
              sdpMid: cand.sdpMid,
              sdpMLineIndex: cand.sdpMLineIndex,
            }),
          }
        : null,
    });
  };

  pc.onconnectionstatechange = () => {
    adapted.onconnectionstatechange?.();
  };

  pc.ondatachannel = (ev) => {
    adapted.ondatachannel?.({ channel: adaptChannel(ev.channel) });
  };

  return adapted;
}

/** Factory for PeerManager — real werift RTCPeerConnection. */
export function createWeriftPeerConnection(
  config?: ConstructorParameters<typeof RTCPeerConnection>[0]
): PeerConnectionFactory {
  return () => adaptPc(new RTCPeerConnection(config));
}

export { RTCPeerConnection };
