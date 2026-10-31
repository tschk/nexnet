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
  publishBundleRemote,
  fetchBundle,
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
  setConnProblem,
  addMessage,
  addRoomMessage,
  updateMessage,
  updateRoomMessage,
  setOnlinePeers,
  onlinePeers,
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
/** Renew once less than this much validity remains (i.e. at 80% of the lifetime). */
const RENEW_BEFORE_EXPIRY_MS = DEVICE_CERT_LIFETIME_MS / 5;
const RENEW_CHECK_INTERVAL_MS = 60_000;

/** This process's device signing key; its certificate is re-issued by the root key on renewal. */
let deviceKey: { secretKey: Uint8Array; publicKey: Uint8Array } | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;

function issueCertificate(active: NexnetClient, now = Date.now()) {
  const id = identity()!;
  return issueDeviceCert(
    id.secretKey,
    deviceKey!.publicKey,
    generateKeyPair().publicKey,
    active.deviceId,
    active.identityId,
    now,
    now + DEVICE_CERT_LIFETIME_MS,
    1,
  );
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^prekey publish failed: /, "");
}

/**
 * Re-issue the device certificate when it is near expiry, then republish the
 * prekey bundle under the new certificate (a bundle's proof expires with the
 * certificate that signed it). Failures are shown, never swallowed.
 */
export async function renewDeviceCertificateIfNeeded(now = Date.now()): Promise<void> {
  const active = client;
  const cert = active?.deviceCertificate;
  if (!active || !cert || !deviceKey || cert.expiresAt - now > RENEW_BEFORE_EXPIRY_MS) return;
  active.setDeviceCredentials(issueCertificate(active, now), deviceKey.secretKey, deviceKey.publicKey);
  if (!active.presenceUrl) return;
  const bundle = fetchBundle(active.identityId);
  if (!bundle) return;
  try {
    await publishBundleRemote(active.presenceUrl, active.identityId, bundle, active.identitySigner());
  } catch (error) {
    if (client === active) setConnProblem(`prekey republish failed (${errorText(error)})`);
  }
}

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
  // This process holds the root key, so it certifies (and later renews) its own device key.
  deviceKey = generateSigningKeyPair();
  const deviceId = randomBytes(32);
  const now = Date.now();
  const deviceCertificate = issueDeviceCert(
    id.secretKey,
    deviceKey.publicKey,
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
    deviceSigningSecretKey: deviceKey.secretKey,
    deviceSigningPublicKey: deviceKey.publicKey,
    deviceCertificate,
  });
  const active = client;
  setConnProblem(null);

  // Status follows the real connection, not the last successful connect.
  active.on("connected", () => {
    if (client !== active) return;
    setConnStatus("connected");
    setConnProblem(null);
  });
  active.on("disconnected", () => {
    if (client !== active) return;
    setOnlinePeers(new Set<string>());
    setConnStatus("reconnecting");
  });
  active.on("reconnecting", () => {
    if (client !== active) return;
    setConnStatus("reconnecting");
    // Reconnecting signs a fresh relay proof; make sure the certificate is valid for it.
    void renewDeviceCertificateIfNeeded();
  });
  active.on("auth_failed", (data) => {
    if (client !== active) return;
    setConnStatus("disconnected");
    setConnProblem((data as { message?: string }).message ?? "relay rejected authentication");
  });
  active.on("error", (data) => {
    const event = data as { type?: string; message?: string };
    if (client === active && event.type === "prekey_publish_failed") {
      setConnProblem(`prekey republish failed (${errorText(new Error(event.message))})`);
    }
  });

  // Listen before connecting and publishing prekeys, so an early DM or receipt is not dropped.
  client.on("verified_delivery_receipt", (data) => {
    const receipt = data as { from?: unknown; messageId?: Uint8Array | null };
    if (!receipt.messageId) return;
    const key = hexEncode(receipt.messageId);
    const pending = awaitingReceipt.get(key);
    // The queue verifies the recipient's signature before confirming delivery.
    if (!pending || receipt.from !== pending.peerHex) return;
    awaitingReceipt.delete(key);
    updateMessage(pending.peerHex, pending.id, { delivered: true, queued: false, error: undefined });
  });

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

  // Subscribe before connect: the initial authenticated snapshot can arrive immediately.
  setOnlinePeers(new Set<string>());
  client.on("presence", (data) => {
    const p = data as { identityId?: string; status?: string };
    if (!p.identityId) return;
    const peers = new Set(onlinePeers());
    if (p.status === "online") peers.add(p.identityId);
    else if (p.status === "offline") peers.delete(p.identityId);
    setOnlinePeers(peers);
  });

  try {
    await client.connect();
  } catch {
    client.disconnect();
    client = null;
    setConnStatus("disconnected");
    return;
  }

  // Rooms only need the relay; a presence failure must not drop the session,
  // but peers cannot open new DM sessions to us until a publish succeeds.
  if (presenceUrl) {
    await publishLocalPrekeys(active).catch((error: unknown) =>
      setConnProblem(`prekey publish failed (${errorText(error)}); peers cannot start DMs with you`),
    );
  }

  setConnStatus("connected");
  renewTimer = setInterval(() => void renewDeviceCertificateIfNeeded(), RENEW_CHECK_INTERVAL_MS);
  renewTimer.unref?.();

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
  return renewDeviceCertificateIfNeeded()
    .then(() => sendDirectMessage(active, hexDecode(recipientHex), text))
    .then(
      (messageId) => {
        // The sender's durable queue retains the encrypted message while a peer
        // is offline. Lack of a receipt means queued, not lost or delivered.
        const key = hexEncode(messageId);
        awaitingReceipt.set(key, { peerHex: recipientHex, id: msg.id });
        updateMessage(recipientHex, msg.id, { queued: true });
        return { ...msg, queued: true };
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
  // Pending receipts are kept: one may still arrive after reconnecting.
  const active = client;
  client = null;
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  active?.disconnect();
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
