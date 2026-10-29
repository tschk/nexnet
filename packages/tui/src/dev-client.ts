/**
 * Client adapter — real @nexnet/crypto and @nexnet/client.
 * Ed25519 keypairs, XChaCha20-Poly1305 encryption, WebSocket relay.
 */

import { generateKeyPair, generateSigningKeyPair, cryptoProvider, randomBytes } from "@nexnet/crypto";
import {
  NexnetClient,
  sendDirectMessage,
  joinRoom,
  sendRoomMessage,
  onRoomMessage,
  deriveRoomId,
  onDirectMessage,
  publishLocalPrekeys,
} from "@nexnet/client";
import { cdeEncode, cdeDecode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CborCdeCodec } from "@nexnet/types";

import {
  identity,
  setIdentity,
  setConnStatus,
  addMessage,
  addRoomMessage,
  updateMessage,
  updateRoomMessage,
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

/** Own DMs awaiting a delivery receipt: message id hex → where it is shown. */
const awaitingReceipt = new Map<string, { peerHex: string; id: string }>();

const DEVICE_CERT_LIFETIME_MS = 11 * 60 * 60 * 1000;

// ── Public API ──────────────────────────────────────────────────────

export function generateIdentity(): LocalIdentity {
  const kp = generateSigningKeyPair();
  // Relays and services only accept an identity id derived from the root key.
  const identityId = identityIdFromWallet(kp.publicKey);
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

/**
 * Connect to a relay. `presenceUrl` hosts X3DH prekey bundles; without it DMs
 * cannot open sessions with peers in other processes.
 */
export async function connectDev(
  relayUrl: string,
  presenceUrl: string | undefined = process.env.NEXNET_PRESENCE_URL,
): Promise<void> {
  const id = identity();
  if (!id) throw new Error("generate identity first");

  setConnStatus("connecting");

  const identityId = identityIdFromWallet(id.publicKey);
  // This process holds the root key, so it certifies its own device key.
  const device = generateSigningKeyPair();
  const deviceId = randomBytes(32);
  const now = Date.now();
  const deviceCertificate = issueDeviceCert(
    id.secretKey,
    device.publicKey,
    generateKeyPair().publicKey,
    deviceId,
    identityId,
    now,
    now + DEVICE_CERT_LIFETIME_MS,
    1,
  );

  client = new NexnetClient({
    identityId,
    deviceId,
    crypto: cryptoProvider,
    codec,
    relayUrl,
    presenceUrl,
    // ponytail: throwaway dedupe log until local-first history
    storagePath: mkdtempSync(join(tmpdir(), "nexnet-tui-")),
    signingSecretKey: id.secretKey,
    rootPublicKey: id.publicKey,
    deviceSigningSecretKey: device.secretKey,
    deviceSigningPublicKey: device.publicKey,
    deviceCertificate,
  });

  try {
    await client.connect();
    if (presenceUrl) await publishLocalPrekeys(client);
  } catch {
    client.disconnect();
    client = null;
    setConnStatus("disconnected");
    return;
  }

  setConnStatus("connected");

  client.on("delivery_receipt", (data) => {
    const receipt = data as { from?: unknown; messageId?: Uint8Array | null };
    if (!receipt.messageId) return;
    const key = hexEncode(receipt.messageId);
    const pending = awaitingReceipt.get(key);
    // Only the recipient (authenticated by the relay as `from`) can confirm delivery.
    if (!pending || receipt.from !== pending.peerHex) return;
    awaitingReceipt.delete(key);
    updateMessage(pending.peerHex, pending.id, { delivered: true });
  });

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
        typeof event.payload === "object" && event.payload instanceof Uint8Array ? event.payload : new Uint8Array(),
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
    if (p.peers) setOnlinePeers(new Set<string>(p.peers));
  });
}

export function sendDevMessage(recipientHex: string, text: string): Promise<ChatMessage> {
  const id = identity();
  const active = client;
  if (!id || !active) throw new Error("not connected");

  const msg: ChatMessage = {
    id: nextMsgId(),
    senderHex: id.publicKeyHex,
    senderName: id.username,
    text,
    createdAt: Date.now(),
    delivered: false,
    own: true,
  };

  addMessage(recipientHex, msg);

  // Delivered only when the recipient's receipt arrives; failures stay visible.
  return sendDirectMessage(active, hexDecode(recipientHex), text).then(
    (messageId) => {
      awaitingReceipt.set(hexEncode(messageId), { peerHex: recipientHex, id: msg.id });
      return msg;
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : "send failed";
      // Without a presence service, peers in other processes are unreachable; say so.
      const failed = {
        ...msg,
        error: active.presenceUrl
          ? reason
          : `NEXNET_PRESENCE_URL is not set, so this peer's prekeys cannot be fetched (${reason})`,
      };
      updateMessage(recipientHex, msg.id, { error: failed.error });
      return failed;
    },
  );
}

export function sendDevRoomMessage(roomId: string, text: string): Promise<ChatMessage> {
  const id = identity();
  const active = client;
  if (!id || !active) throw new Error("not connected");

  const msg: ChatMessage = {
    id: nextMsgId(),
    senderHex: id.publicKeyHex,
    senderName: id.username,
    text,
    createdAt: Date.now(),
    delivered: false,
    own: true,
  };

  addRoomMessage(roomId, msg);

  return sendRoomMessage(active, hexDecode(roomId), text).then(
    () => {
      updateRoomMessage(roomId, msg.id, { delivered: true });
      return { ...msg, delivered: true };
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "send failed";
      updateRoomMessage(roomId, msg.id, { error: message });
      return { ...msg, error: message };
    },
  );
}

export function disconnectDev(): void {
  client?.disconnect();
  awaitingReceipt.clear();
  client = null;
  setConnStatus("disconnected");
  setOnlinePeers(new Set<string>());
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
