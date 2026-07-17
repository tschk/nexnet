/**
 * Dev-mode client adapter.
 * Generates Ed25519 keypairs, stores identity locally, and provides
 * stub methods that work with in-memory state so the TUI is functional
 * before the real @nettle/client is wired up.
 */

import {
  identity,
  setIdentity,
  setConnStatus,
  addMessage,
  addRoomMessage,
  setOnlinePeers,
  setRooms,
  setDiscoveredUsers,
  nextMsgId,
  type LocalIdentity,
  type ChatMessage,
} from "./state";

// ── Crypto helpers (minimal, dev-only) ──────────────────────────────

function randomHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyHex: string } {
  // Dev-mode: 32 random bytes as "public key"
  // Real impl uses @noble/ed25519
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);
  const publicKey = new Uint8Array(32);
  crypto.getRandomValues(publicKey);
  const publicKeyHex = Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { publicKey, secretKey, publicKeyHex };
}

// ── Public API ──────────────────────────────────────────────────────

export function generateIdentity(): LocalIdentity {
  const kp = generateKeypair();
  const id: LocalIdentity = {
    publicKeyHex: kp.publicKeyHex,
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    username: kp.publicKeyHex.slice(0, 12),
  };
  setIdentity(id);
  return id;
}

export async function connectDev(relayUrl: string): Promise<void> {
  const id = identity();
  if (!id) return;

  setConnStatus("connecting");

  // Simulate connection delay
  await new Promise((r) => setTimeout(r, 500));

  setConnStatus("connected");

  // Seed some fake rooms
  setRooms([
    {
      id: "room-general",
      name: "#general",
      memberCount: 3,
      messages: [],
      lastActivity: Date.now() - 60_000,
    },
    {
      id: "room-dev",
      name: "#dev",
      memberCount: 2,
      messages: [],
      lastActivity: Date.now() - 120_000,
    },
  ]);

  // Seed fake discovered users
  setDiscoveredUsers([
    {
      identityHex: randomHex(32),
      username: "alice",
      bio: "Building decentralized chat.",
      interests: ["software.rust", "crypto.p2p"],
      online: true,
    },
    {
      identityHex: randomHex(32),
      username: "bob",
      bio: "Privacy enthusiast.",
      interests: ["crypto.privacy", "software.zig"],
      online: false,
    },
    {
      identityHex: randomHex(32),
      username: "charlie",
      bio: "Terminal UI lover.",
      interests: ["software.typescript", "design.tui"],
      online: true,
    },
  ]);
}

export function sendDevMessage(recipientHex: string, text: string): ChatMessage {
  const id = identity();
  if (!id) throw new Error("not logged in");

  const msg: ChatMessage = {
    id: nextMsgId(),
    senderHex: id.publicKeyHex,
    senderName: id.username,
    text,
    createdAt: Date.now(),
    delivered: true,
    own: true,
  };

  addMessage(recipientHex, msg);

  // Simulate echo reply after 1-3s (dev mode)
  setTimeout(
    () => {
      const reply: ChatMessage = {
        id: nextMsgId(),
        senderHex: recipientHex,
        senderName: recipientHex.slice(0, 12),
        text: `echo: ${text}`,
        createdAt: Date.now(),
        delivered: true,
        own: false,
      };
      addMessage(recipientHex, reply);
    },
    1000 + Math.random() * 2000,
  );

  return msg;
}

export function sendDevRoomMessage(roomId: string, text: string): ChatMessage {
  const id = identity();
  if (!id) throw new Error("not logged in");

  const msg: ChatMessage = {
    id: nextMsgId(),
    senderHex: id.publicKeyHex,
    senderName: id.username,
    text,
    createdAt: Date.now(),
    delivered: true,
    own: true,
  };

  addRoomMessage(roomId, msg);
  return msg;
}

export function disconnectDev(): void {
  setConnStatus("disconnected");
  setOnlinePeers(new Set());
}
