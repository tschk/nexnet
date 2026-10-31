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

export type ConnStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

const [connStatus, setConnStatus] = createSignal<ConnStatus>("disconnected");
export { connStatus, setConnStatus };

/** Why the connection is degraded (expired certificate, rejected auth, prekey publish failure); null when healthy. */
const [connProblem, setConnProblem] = createSignal<string | null>(null);
export { connProblem, setConnProblem };

// ── Messages ────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  senderHex: string;
  senderName: string;
  text: string;
  createdAt: number;
  /** Own DMs: the recipient's delivery receipt arrived. Own room posts: the relay accepted it. */
  delivered: boolean;
  /** Why an own message could not be sent; it was never delivered. */
  error?: string;
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

export function updateMessage(peerHex: string, id: string, patch: Partial<ChatMessage>) {
  setConversations((prev) =>
    prev.map((c) =>
      c.peerHex !== peerHex ? c : { ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) },
    ),
  );
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

export function updateRoomMessage(roomId: string, id: string, patch: Partial<ChatMessage>) {
  setRooms((prev) =>
    prev.map((r) =>
      r.id !== roomId ? r : { ...r, messages: r.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) },
    ),
  );
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
