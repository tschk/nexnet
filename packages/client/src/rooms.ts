/**
 * @nexnet/client — Public chatrooms
 *
 * Room ID = deriveId(DOMAIN_ROOM_ID, normalizedRoomName).
 * Messages are signed plaintext published via relay.
 *
 * Moderation: per-user cooldown, votekick, automod spam filter.
 */

import type { RoomId, NexnetEvent } from "@nexnet/types";
import { DOMAIN_ROOM_ID, PROTOCOL_VERSION } from "@nexnet/types";
import type { NexnetClient } from "./client.js";

// ── Constants ────────────────────────────────────────────────────────

/** Default messages per user per minute in a room */
const DEFAULT_RATE_LIMIT = 5;
/** Rate limit window (1 minute) */
const RATE_WINDOW_MS = 60_000;
/** Votekick threshold: fraction of active users needed */
const VOTEKICK_THRESHOLD = 2 / 3;
/** Votekick expiry (5 minutes to collect votes) */
const VOTEKICK_WINDOW_MS = 5 * 60_1000;
/** Auto-ban duration for spam (30 minutes) */
const SPAM_BAN_MS = 30 * 60_1000;
/** Max identical messages in window before automod */
const SPAM_DUPLICATE_THRESHOLD = 3;

// ── Room ID ──────────────────────────────────────────────────────────

export function deriveRoomId(
  crypto: NexnetClient["crypto"],
  roomName: string
): RoomId {
  const normalized = roomName.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  return crypto.deriveId(DOMAIN_ROOM_ID, encoded);
}

// ── Moderation state (per-room, per-client) ──────────────────────────

interface UserRateState {
  timestamps: number[];
  recentTexts: string[];
}

interface Votekick {
  target: string; // identity hex
  votes: Set<string>; // voter identity hexes
  startedAt: number;
  startedBy: string;
}

interface RoomModeration {
  rateLimit: number; // msgs per window
  userStates: Map<string, UserRateState>; // identityHex -> state
  bans: Map<string, number>; // identityHex -> unban timestamp
  votekicks: Map<string, Votekick>; // target hex -> votekick
}

const modState = new Map<string, RoomModeration>(); // roomIdHex -> mod

function getMod(roomIdHex: string, rateLimit = DEFAULT_RATE_LIMIT): RoomModeration {
  if (!modState.has(roomIdHex)) {
    modState.set(roomIdHex, {
      rateLimit,
      userStates: new Map(),
      bans: new Map(),
      votekicks: new Map(),
    });
  }
  return modState.get(roomIdHex)!;
}

// ── Rate limiting / cooldown ─────────────────────────────────────────

function checkCooldown(
  mod: RoomModeration,
  userHex: string
): { allowed: boolean; reason?: string } {
  // Check ban
  const banUntil = mod.bans.get(userHex);
  if (banUntil && Date.now() < banUntil) {
    const secs = Math.ceil((banUntil - Date.now()) / 1000);
    return { allowed: false, reason: `Banned for ${secs}s (spam)` };
  }
  if (banUntil && Date.now() >= banUntil) {
    mod.bans.delete(userHex);
  }

  // Check rate limit
  const state = mod.userStates.get(userHex) ?? { timestamps: [], recentTexts: [] };
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Prune old timestamps
  state.timestamps = state.timestamps.filter((t) => t > windowStart);

  if (state.timestamps.length >= mod.rateLimit) {
    const oldestInWindow = state.timestamps[0];
    const waitMs = oldestInWindow + RATE_WINDOW_MS - now;
    const waitSec = Math.ceil(waitMs / 1000);
    return { allowed: false, reason: `Cooldown: wait ${waitSec}s` };
  }

  return { allowed: true };
}

function recordMessage(
  mod: RoomModeration,
  userHex: string,
  text: string
): void {
  const state = mod.userStates.get(userHex) ?? { timestamps: [], recentTexts: [] };
  state.timestamps.push(Date.now());
  state.recentTexts.push(text);

  // Keep only recent texts for spam detection
  if (state.recentTexts.length > 10) {
    state.recentTexts = state.recentTexts.slice(-10);
  }

  mod.userStates.set(userHex, state);
}

// ── Automod (spam detection) ─────────────────────────────────────────

function automodCheck(
  mod: RoomModeration,
  userHex: string,
  text: string
): { blocked: boolean; reason?: string } {
  const state = mod.userStates.get(userHex);
  if (!state) return { blocked: false };

  // Check duplicate spam
  const recentDuplicates = state.recentTexts.filter((t) => t === text).length;
  if (recentDuplicates >= SPAM_DUPLICATE_THRESHOLD) {
    // Auto-ban
    mod.bans.set(userHex, Date.now() + SPAM_BAN_MS);
    return {
      blocked: true,
      reason: `Auto-mod: duplicate message spam — banned for 30 minutes`,
    };
  }

  // Check excessive caps (>80% caps in message >20 chars)
  if (text.length > 20) {
    const capsCount = (text.match(/[A-Z]/g) ?? []).length;
    if (capsCount / text.length > 0.8) {
      return {
        blocked: true,
        reason: `Auto-mod: excessive caps — use normal capitalization`,
      };
    }
  }

  // Check message length abuse
  if (text.length > 4000) {
    return {
      blocked: true,
      reason: `Auto-mod: message too long (max 4000 chars)`,
    };
  }

  return { blocked: false };
}

// ── Votekick ─────────────────────────────────────────────────────────

/**
 * Start a votekick against a user. Returns the votekick state.
 */
export function startVotekick(
  roomIdHex: string,
  targetHex: string,
  initiatorHex: string
): { success: boolean; message: string } {
  const mod = getMod(roomIdHex);

  // Can't votekick yourself
  if (targetHex === initiatorHex) {
    return { success: false, message: "Cannot votekick yourself" };
  }

  // Check existing votekick
  const existing = mod.votekicks.get(targetHex);
  if (existing && Date.now() - existing.startedAt < VOTEKICK_WINDOW_MS) {
    return { success: false, message: "Votekick already in progress" };
  }

  const votekick: Votekick = {
    target: targetHex,
    votes: new Set([initiatorHex]),
    startedAt: Date.now(),
    startedBy: initiatorHex,
  };

  mod.votekicks.set(targetHex, votekick);
  return { success: true, message: `Votekick started against ${targetHex.slice(0, 12)}` };
}

/**
 * Vote on an active votekick.
 */
export function voteKick(
  roomIdHex: string,
  targetHex: string,
  voterHex: string
): { kicked: boolean; message: string } {
  const mod = getMod(roomIdHex);
  const votekick = mod.votekicks.get(targetHex);

  if (!votekick || Date.now() - votekick.startedAt >= VOTEKICK_WINDOW_MS) {
    return { kicked: false, message: "No active votekick" };
  }

  votekick.votes.add(voterHex);

  // Check threshold (need ⅔ of a reasonable minimum — at least 3 votes)
  const voteCount = votekick.votes.size;
  if (voteCount >= 3) {
    // Kick: ban for 30 minutes
    mod.bans.set(targetHex, Date.now() + SPAM_BAN_MS);
    mod.votekicks.delete(targetHex);
    return {
      kicked: true,
      message: `${targetHex.slice(0, 12)} votekicked (${voteCount} votes)`,
    };
  }

  return {
    kicked: false,
    message: `Vote recorded (${voteCount}/3 needed)`,
  };
}

/**
 * Check if a user is currently banned from a room.
 */
export function isBanned(roomIdHex: string, userHex: string): boolean {
  const mod = modState.get(roomIdHex);
  if (!mod) return false;
  const banUntil = mod.bans.get(userHex);
  return banUntil !== undefined && Date.now() < banUntil;
}

// ── Room operations ──────────────────────────────────────────────────

export async function joinRoom(
  client: NexnetClient,
  roomName: string
): Promise<RoomId> {
  const roomId = deriveRoomId(client.crypto, roomName);
  const roomIdHex = Buffer.from(roomId).toString("hex");

  client.subscribeRoom(roomIdHex);

  return roomId;
}

export async function leaveRoom(
  client: NexnetClient,
  roomId: RoomId
): Promise<void> {
  const roomIdHex = Buffer.from(roomId).toString("hex");
  client.unsubscribeRoom(roomIdHex);
}

/**
 * Send a room message with cooldown and automod checks.
 * Returns { sent, reason } if blocked by moderation.
 */
export async function sendRoomMessage(
  client: NexnetClient,
  roomId: RoomId,
  text: string
): Promise<{ sent: boolean; reason?: string }> {
  const roomIdHex = Buffer.from(roomId).toString("hex");
  const userHex = Buffer.from(client.identityId).toString("hex");

  // Check ban
  if (isBanned(roomIdHex, userHex)) {
    return { sent: false, reason: "You are temporarily banned from this room" };
  }

  // Check cooldown
  const mod = getMod(roomIdHex);
  const cooldown = checkCooldown(mod, userHex);
  if (!cooldown.allowed) {
    return { sent: false, reason: cooldown.reason };
  }

  // Check automod
  const automod = automodCheck(mod, userHex, text);
  if (automod.blocked) {
    return { sent: false, reason: automod.reason };
  }

  // Record message for rate limiting + spam detection
  recordMessage(mod, userHex, text);

  // Send
  const now = Date.now();
  const eventCde = client.codec.encode({
    protocolVersion: PROTOCOL_VERSION,
    eventType: "room.message",
    authorIdentityId: client.identityId,
    authorDeviceId: client.deviceId,
    createdAt: now,
    sequence: now,
    parentIds: [],
    payload: client.codec.encode({ text }),
  });

  const signature = client.crypto.sign(client.signingSecretKey, eventCde);

  client.sendRoomEvent(roomIdHex, {
    event: Array.from(eventCde),
    signature: Array.from(signature),
  });

  return { sent: true };
}

export function onRoomMessage(
  client: NexnetClient,
  roomId: RoomId,
  callback: (event: NexnetEvent) => void
): void {
  const roomIdHex = Buffer.from(roomId).toString("hex");

  client.on("room_event", (data) => {
    const msg = data as { room_id?: string; event?: { event?: number[] } };
    if (msg.room_id === roomIdHex && msg.event?.event) {
      try {
        const bytes = new Uint8Array(msg.event.event);
        const event = client.codec.decode<NexnetEvent>(bytes);
        callback(event);
      } catch {
        // malformed — ignore
      }
    }
  });
}
