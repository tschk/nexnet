/**
 * @nexnet/relay-standalone — Self-hosted Nexnet relay server
 *
 * Runs on any machine with Bun. No Cloudflare dependency.
 * Handles: WebSocket signalling, room gossip, presence proxy.
 *
 * Usage:
 *   bun run src/index.ts              # default port 8787
 *   PORT=9000 bun run src/index.ts    # custom port
 */

import { Elysia, t } from "elysia";
import type { ElysiaWS } from "elysia/ws";

// ── Types ────────────────────────────────────────────────────────────

interface SocketData {
  query: {
    identity: string;
    device: string;
  };
}

type RelaySocket = ElysiaWS<SocketData>;

interface ClientInfo {
  identityId: string;
  deviceId: string;
  ws: RelaySocket;
  subscribedRooms: Set<string>;
  connectedAt: number;
}

interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

// ── State ────────────────────────────────────────────────────────────

/** Connected clients by identity hex */
interface RelayState {
  clients: Map<string, ClientInfo>;
  roomSubscriptions: Map<string, Set<string>>;
}

// ── Message handlers ─────────────────────────────────────────────────

function send(ws: RelaySocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function handleMessage(state: RelayState, sender: ClientInfo, raw: string): void {
  let msg: RelayMessage;
  try {
    msg = JSON.parse(raw) as RelayMessage;
  } catch {
    send(sender.ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "session_offer":
    case "session_answer":
    case "candidate":
      handleSignalling(state, sender, msg);
      break;

    case "room_subscribe":
      handleRoomSubscribe(state, sender, msg);
      break;

    case "room_unsubscribe":
      handleRoomUnsubscribe(state, sender, msg);
      break;

    case "room_event":
      handleRoomEvent(state, sender, msg);
      break;

    case "dm":
      handleDm(state, sender, msg);
      break;

    case "delivery_receipt":
      handleDeliveryReceipt(state, sender, msg);
      break;

    case "ping":
      send(sender.ws, { type: "pong" });
      break;

    default:
      send(sender.ws, { type: "error", message: `Unknown type: ${msg.type}` });
  }
}

function handleSignalling(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const targetId = msg.to as string;
  if (!targetId) return;

  const target = state.clients.get(targetId);
  if (!target) {
    send(sender.ws, {
      type: "error",
      message: `Peer ${targetId.slice(0, 12)} not online`,
    });
    return;
  }

  // Forward to target
  send(target.ws, {
    type: msg.type,
    from: sender.identityId,
    session_id: msg.session_id,
    sdp: msg.sdp,
    candidate: msg.candidate,
  });
}

function handleRoomSubscribe(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  sender.subscribedRooms.add(roomId);

  if (!state.roomSubscriptions.has(roomId)) {
    state.roomSubscriptions.set(roomId, new Set());
  }
  state.roomSubscriptions.get(roomId)!.add(sender.identityId);

  send(sender.ws, { type: "room_subscribed", room_id: roomId });

  log(`${sender.identityId.slice(0, 12)} joined room ${roomId.slice(0, 16)}`);
}

function handleRoomUnsubscribe(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  sender.subscribedRooms.delete(roomId);
  const subscribers = state.roomSubscriptions.get(roomId);
  subscribers?.delete(sender.identityId);
  if (subscribers?.size === 0) state.roomSubscriptions.delete(roomId);

  send(sender.ws, { type: "room_unsubscribed", room_id: roomId });
}

function handleRoomEvent(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  const subscribers = state.roomSubscriptions.get(roomId);
  if (!subscribers) return;

  const payload = {
    type: "room_event",
    room_id: roomId,
    from: sender.identityId,
    event: msg.event,
  };

  // Broadcast to all subscribers except sender
  for (const identityHex of subscribers) {
    if (identityHex === sender.identityId) continue;
    const client = state.clients.get(identityHex);
    if (client) send(client.ws, payload);
  }
}

function handleDm(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const targetId = msg.to as string;
  if (!targetId) return;

  const target = state.clients.get(targetId);
  if (!target) {
    send(sender.ws, {
      type: "error",
      message: `Recipient ${targetId.slice(0, 12)} not online`,
    });
    return;
  }

  // Forward DM to target
  send(target.ws, { type: "dm", from: sender.identityId, envelope: msg.envelope });
}

function handleDeliveryReceipt(state: RelayState, sender: ClientInfo, msg: RelayMessage): void {
  const targetId = msg.to as string;
  if (!targetId || typeof msg.receipt !== "object" || msg.receipt === null) return;
  const target = state.clients.get(targetId);
  if (!target) return;
  send(target.ws, {
    type: "delivery_receipt",
    from: sender.identityId,
    receipt: msg.receipt,
  });
}

function removeClient(state: RelayState, client: ClientInfo): void {
  // Unsubscribe from all rooms
  for (const roomId of client.subscribedRooms) {
    const subscribers = state.roomSubscriptions.get(roomId);
    subscribers?.delete(client.identityId);
    if (subscribers?.size === 0) state.roomSubscriptions.delete(roomId);
  }
  // Remove client
  if (state.clients.get(client.identityId) === client) state.clients.delete(client.identityId);
}

// ── Logging ──────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Server ───────────────────────────────────────────────────────────

export function createRelay() {
  /** Connected clients by identity hex */
  const state: RelayState = {
    clients: new Map(),
    roomSubscriptions: new Map(),
  };

  /** Room subscriptions: roomId -> Set of identity hexes */
  return new Elysia()
    // Health check
    .get("/health", () => ({
      status: "ok",
      clients: state.clients.size,
      rooms: state.roomSubscriptions.size,
      uptime: process.uptime(),
    }))
    // Status page
    .get("/", () => ({
      name: "nexnet-relay-standalone",
      version: "0.0.1",
      clients: Array.from(state.clients.values()).map((client) => ({
        identity: `${client.identityId.slice(0, 16)}...`,
        deviceId: `${client.deviceId.slice(0, 16)}...`,
        rooms: Array.from(client.subscribedRooms),
        connectedAt: new Date(client.connectedAt).toISOString(),
      })),
      roomCount: state.roomSubscriptions.size,
      uptime: process.uptime(),
    }))
    // WebSocket upgrade
    .ws("/ws", {
      // Attach metadata for lifecycle handlers
      query: t.Object({ identity: t.String(), device: t.String() }),
      open(ws) {
        const client: ClientInfo = {
          identityId: ws.data.query.identity,
          deviceId: ws.data.query.device,
          ws,
          subscribedRooms: new Set(),
          connectedAt: Date.now(),
        };

        // Register client (replace existing connection if any)
        const existing = state.clients.get(client.identityId);
        if (existing) {
          send(existing.ws, { type: "error", message: "Replaced by new connection" });
          existing.ws.close();
        }

        // Store connection
        state.clients.set(client.identityId, client);
        log(`Connected: ${client.identityId.slice(0, 12)} (${state.clients.size} total)`);
        send(ws, { type: "connected", identity: client.identityId, relay_time: Date.now() });
      },
      message(ws, message) {
        const client = state.clients.get(ws.data.query.identity);
        if (client?.ws.raw === ws.raw) {
          handleMessage(state, client, typeof message === "string" ? message : JSON.stringify(message));
        }
      },
      close(ws) {
        const client = state.clients.get(ws.data.query.identity);
        if (client?.ws.raw !== ws.raw) return;
        removeClient(state, client);
        log(`Disconnected: ${client.identityId.slice(0, 12)} (${state.clients.size} total)`);
      },
    });
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  createRelay().listen(port);
  log(`Nexnet relay listening on ws://localhost:${port}/ws`);
  log(`Health: http://localhost:${port}/health`);
  log(`Status: http://localhost:${port}/`);
}
