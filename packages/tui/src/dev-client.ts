/**
 * Client adapter — real @nexnet/crypto and @nexnet/client.
 * Ed25519 keypairs, XChaCha20-Poly1305 encryption, WebSocket relay.
 */

import { generateSigningKeyPair, deriveId, cryptoProvider } from "@nexnet/crypto";
import { NexnetClient, sendDirectMessage, joinRoom, sendRoomMessage, onRoomMessage, deriveRoomId, onDirectMessage } from "@nexnet/client";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import type { CborCdeCodec } from "@nexnet/types";

import {
  identity,
  setIdentity,
  setConnStatus,
  addMessage,
  addRoomMessage,
  setOnlinePeers,
  setRooms,
  nextMsgId,
  type LocalIdentity,
  type ChatMessage,
} from "./state";

// ── Codec singleton ─────────────────────────────────────────────────

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };

// ── Client singleton ────────────────────────────────────────────────

let client: NexnetClient | null = null;

// ── Public API ──────────────────────────────────────────────────────

export function generateIdentity(): LocalIdentity {
  const kp = generateSigningKeyPair();
  const identityId = deriveId("nexnet identity v1", kp.publicKey);
  const identityIdHex = hexEncode(identityId);

  const id: LocalIdentity = {
    publicKeyHex: identityIdHex,
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    username: identityIdHex.slice(0, 12),
  };
  setIdentity(id);
  return id;
}

export async function connectDev(relayUrl: string): Promise<void> {
  const id = identity();
  if (!id) throw new Error("generate identity first");

  setConnStatus("connecting");

  const identityId = deriveId("nexnet identity v1", id.publicKey);
  // ponytail: reuse publicKey as deviceId for single-device v1
  const deviceId = id.publicKey.slice(0, 32);

  client = new NexnetClient({
    identityId,
    deviceId,
    crypto: cryptoProvider,
    codec,
    relayUrl,
    storagePath: "", // ponytail: no persistence until local-first history
    signingSecretKey: id.secretKey,
  });

  try {
    await client.connect();
  } catch {
    setConnStatus("disconnected");
    return;
  }

  setConnStatus("connected");

  // Subscribe to default rooms
  const defaultRooms = ["general", "dev"];
  for (const name of defaultRooms) {
    const roomId = deriveRoomId(client.crypto, name);
    const roomIdHex = hexEncode(roomId);
    await joinRoom(client, name);

    setRooms((prev) => {
      if (prev.some((r) => r.id === roomIdHex)) return prev;
      return [
        ...prev,
        {
          id: roomIdHex,
          name: `#${name}`,
          memberCount: 0,
          messages: [],
          lastActivity: Date.now(),
        },
      ];
    });

    onRoomMessage(client, roomId, (event) => {
      const payload = codec.decode<{ text?: string }>(
        typeof event.payload === "object" && event.payload instanceof Uint8Array
          ? event.payload
          : new Uint8Array()
      );
      const authorHex = hexEncode(event.authorIdentityId);
      const own = authorHex === id.publicKeyHex;
      const msg: ChatMessage = {
        id: nextMsgId(),
        senderHex: authorHex,
        senderName: own ? id.username : authorHex.slice(0, 12),
        text: payload.text ?? "",
        createdAt: event.createdAt,
        delivered: true,
        own,
      };
      addRoomMessage(roomIdHex, msg);
    });
  }

  // Handle inbound DMs (real decryption via @nexnet/client)
  onDirectMessage(client, (envelope, payload) => {
    const authorHex = hexEncode(envelope.senderIdentityId);
    const msg: ChatMessage = {
      id: nextMsgId(),
      senderHex: authorHex,
      senderName: authorHex.slice(0, 12),
      text: payload.text ?? "[non-text message]",
      createdAt: envelope.createdAt,
      delivered: true,
      own: false,
    };
    addMessage(authorHex, msg);
  });

  // Handle presence
  client.on("presence", (data) => {
    const p = data as { peers?: string[] };
    if (p.peers) setOnlinePeers(new Set(p.peers));
  });
}

export function sendDevMessage(recipientHex: string, text: string): ChatMessage {
  const id = identity();
  if (!id || !client) throw new Error("not connected");

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

  // Fire-and-forget async send — real encryption via sendDirectMessage
  const recipientId = hexDecode(recipientHex);
  sendDirectMessage(client, recipientId, text).catch(() => {
    // ponytail: mark undelivered later
  });

  return msg;
}

export function sendDevRoomMessage(roomId: string, text: string): ChatMessage {
  const id = identity();
  if (!id || !client) throw new Error("not connected");

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

  const roomIdBytes = hexDecode(roomId);
  sendRoomMessage(client, roomIdBytes, text).catch(() => {});

  return msg;
}

export function disconnectDev(): void {
  client?.disconnect();
  client = null;
  setConnStatus("disconnected");
  setOnlinePeers(new Set());
}

// ── Hex helpers ─────────────────────────────────────────────────────

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
