import { createSignal } from "solid-js";

// ── Screen routing ──────────────────────────────────────────────────

export type Screen = "login" | "chatList" | "dm" | "room" | "discover";

const [screen, setScreen] = createSignal<Screen>("login");
export { screen };
export const navigate = setScreen;

// ── Identity ────────────────────────────────────────────────────────

export interface LocalIdentity {
  publicKeyHex: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  username: string;
}

const [identity, setIdentity] = createSignal<LocalIdentity | null>(null);
export { identity, setIdentity };

// ── Connection ──────────────────────────────────────────────────────

export type ConnStatus = "disconnected" | "connecting" | "connected";

const [connStatus, setConnStatus] = createSignal<ConnStatus>("disconnected");
export { connStatus, setConnStatus };

// ── Messages ────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  senderHex: string;
  senderName: string;
  text: string;
  createdAt: number;
  delivered: boolean;
  own: boolean;
}

export interface Conversation {
  peerHex: string;
  peerName: string;
  messages: ChatMessage[];
  lastActivity: number;
  online: boolean;
}

const [conversations, setConversations] = createSignal<Conversation[]>([]);
export { conversations, setConversations };

export function addMessage(peerHex: string, msg: ChatMessage) {
  setConversations((prev) => {
    const idx = prev.findIndex((c) => c.peerHex === peerHex);
    if (idx >= 0) {
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        messages: [...updated[idx].messages, msg],
        lastActivity: msg.createdAt,
      };
      return updated.sort((a, b) => b.lastActivity - a.lastActivity);
    }
    return [
      ...prev,
      {
        peerHex,
        peerName: msg.senderName,
        messages: [msg],
        lastActivity: msg.createdAt,
        online: false,
      },
    ].sort((a, b) => b.lastActivity - a.lastActivity);
  });
}

// ── Active conversation ─────────────────────────────────────────────

const [activePeer, setActivePeer] = createSignal<string | null>(null);
export { activePeer, setActivePeer };

// ── Rooms ───────────────────────────────────────────────────────────

export interface Room {
  id: string;
  name: string;
  memberCount: number;
  messages: ChatMessage[];
  lastActivity: number;
}

const [rooms, setRooms] = createSignal<Room[]>([]);
export { rooms, setRooms };

export function addRoomMessage(roomId: string, msg: ChatMessage) {
  setRooms((prev) => {
    const idx = prev.findIndex((r) => r.id === roomId);
    if (idx >= 0) {
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        messages: [...updated[idx].messages, msg],
        lastActivity: msg.createdAt,
      };
      return updated.sort((a, b) => b.lastActivity - a.lastActivity);
    }
    return prev;
  });
}

const [activeRoom, setActiveRoom] = createSignal<string | null>(null);
export { activeRoom, setActiveRoom };

// ── Presence ────────────────────────────────────────────────────────

const [onlinePeers, setOnlinePeers] = createSignal<Set<string>>(new Set());
export { onlinePeers, setOnlinePeers };

// ── Discovery ───────────────────────────────────────────────────────

export interface DiscoveredUser {
  identityHex: string;
  username: string;
  bio: string;
  interests: string[];
  online: boolean;
}

const [discoveredUsers, setDiscoveredUsers] = createSignal<DiscoveredUser[]>([]);
export { discoveredUsers, setDiscoveredUsers };

// ── Dev mode helpers ────────────────────────────────────────────────

let messageCounter = 0;
export function nextMsgId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}
