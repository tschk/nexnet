/**
 * @nexnet/client — optional direct DM transport (WebRTC data channel)
 *
 * When PeerManager channel is open, envelopes skip relay.
 * Fallback always remains client.sendDm / queue.
 */

import type { PeerManager } from "./webrtc.js";

let peerManager: PeerManager | null = null;

export function setDirectTransport(pm: PeerManager | null): void {
  peerManager = pm;
}

export function getDirectTransport(): PeerManager | null {
  return peerManager;
}

/**
 * Try send envelope bytes over open data channel.
 * Returns true if delivered on direct path.
 */
export function trySendDirect(peerIdentityHex: string, envelopeBytes: Uint8Array): boolean {
  if (!peerManager?.isOpen(peerIdentityHex)) return false;
  return peerManager.send(peerIdentityHex, envelopeBytes);
}
