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

import type { ServerWebSocket } from "bun";

// ── Types ────────────────────────────────────────────────────────────

interface ClientInfo {
  identityId: string;
  deviceId: string;
  ws: ServerWebSocket<ClientInfo>;
  subscribedRooms: Set<string>;
  connectedAt: number;
}

interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

// ── State ────────────────────────────────────────────────────────────

/** Connected clients by identity hex */
const clients = new Map<string, ClientInfo>();

/** Room subscriptions: roomId -> Set of identity hexes */
const roomSubscriptions = new Map<string, Set<string>>();

// ── Message handlers ─────────────────────────────────────────────────

function handleMessage(sender: ClientInfo, raw: string): void {
  let msg: RelayMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    sender.ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    return;
  }

  switch (msg.type) {
    case "session_offer":
    case "session_answer":
    case "candidate":
      handleSignalling(sender, msg);
      break;

    case "room_subscribe":
      handleRoomSubscribe(sender, msg);
      break;

    case "room_unsubscribe":
      handleRoomUnsubscribe(sender, msg);
      break;

    case "room_event":
      handleRoomEvent(sender, msg);
      break;

    case "dm":
      handleDm(sender, msg);
      break;

    case "ping":
      sender.ws.send(JSON.stringify({ type: "pong" }));
      break;

    default:
      sender.ws.send(
        JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` })
      );
  }
}

function handleSignalling(sender: ClientInfo, msg: RelayMessage): void {
  const targetId = msg.to as string;
  if (!targetId) return;

  const target = clients.get(targetId);
  if (!target) {
    sender.ws.send(
      JSON.stringify({
        type: "error",
        message: `Peer ${targetId.slice(0, 12)} not online`,
      })
    );
    return;
  }

  // Forward to target
  target.ws.send(
    JSON.stringify({
      type: msg.type,
      from: sender.identityId,
      session_id: msg.session_id,
      sdp: msg.sdp,
      candidate: msg.candidate,
    })
  );
}

function handleRoomSubscribe(sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  sender.subscribedRooms.add(roomId);

  if (!roomSubscriptions.has(roomId)) {
    roomSubscriptions.set(roomId, new Set());
  }
  roomSubscriptions.get(roomId)!.add(sender.identityId);

  sender.ws.send(
    JSON.stringify({
      type: "room_subscribed",
      room_id: roomId,
    })
  );

  log(`${sender.identityId.slice(0, 12)} joined room ${roomId.slice(0, 16)}`);
}

function handleRoomUnsubscribe(sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  sender.subscribedRooms.delete(roomId);
  roomSubscriptions.get(roomId)?.delete(sender.identityId);

  sender.ws.send(
    JSON.stringify({
      type: "room_unsubscribed",
      room_id: roomId,
    })
  );
}

function handleRoomEvent(sender: ClientInfo, msg: RelayMessage): void {
  const roomId = msg.room_id as string;
  if (!roomId) return;

  const subscribers = roomSubscriptions.get(roomId);
  if (!subscribers) return;

  const payload = JSON.stringify({
    type: "room_event",
    room_id: roomId,
    from: sender.identityId,
    event: msg.event,
  });

  // Broadcast to all subscribers except sender
  for (const identityHex of subscribers) {
    if (identityHex === sender.identityId) continue;
    const client = clients.get(identityHex);
    if (client) {
      client.ws.send(payload);
    }
  }
}

function handleDm(sender: ClientInfo, msg: RelayMessage): void {
  const targetId = msg.to as string;
  if (!targetId) return;

  const target = clients.get(targetId);
  if (!target) {
    sender.ws.send(
      JSON.stringify({
        type: "error",
        message: `Recipient ${targetId.slice(0, 12)} not online`,
      })
    );
    return;
  }

  // Forward DM to target
  target.ws.send(
    JSON.stringify({
      type: "dm",
      from: sender.identityId,
      envelope: msg.envelope,
    })
  );
}

// ── Logging ──────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Server ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8787", 10);

const server = Bun.serve<ClientInfo>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        clients: clients.size(),
        rooms: roomSubscriptions.size(),
        uptime: process.uptime(),
      });
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const identityId = url.searchParams.get("identity");
      const deviceId = url.searchParams.get("device");

      if (!identityId || !deviceId) {
        return new Response("Missing identity or device param", { status: 400 });
      }

      const upgraded = server.upgrade(req, {
        data: {
          identityId,
          deviceId,
          ws: null as unknown as ServerWebSocket<ClientInfo>,
          subscribedRooms: new Set<string>(),
          connectedAt: Date.now(),
        },
      });

      if (upgraded) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Status page
    if (url.pathname === "/") {
      const clientList = Array.from(clients.values()).map((c) => ({
        identity: c.identityId.slice(0, 16) + "...",
        deviceId: c.deviceId.slice(0, 16) + "...",
        rooms: Array.from(c.subscribedRooms),
        connectedAt: new Date(c.connectedAt).toISOString(),
      }));

      return Response.json({
        name: "nexnet-relay-standalone",
        version: "0.0.1",
        clients: clientList,
        roomCount: roomSubscriptions.size(),
        uptime: process.uptime(),
      });
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const data = ws.data;
      data.ws = ws;

      // Register client (replace existing connection if any)
      const existing = clients.get(data.identityId);
      if (existing) {
        existing.ws.send(
          JSON.stringify({ type: "error", message: "Replaced by new connection" })
        );
        existing.ws.close();
      }

      clients.set(data.identityId, data);
      log(`Connected: ${data.identityId.slice(0, 12)} (${clients.size} total)`);

      ws.send(
        JSON.stringify({
          type: "connected",
          identity: data.identityId,
          relay_time: Date.now(),
        })
      );
    },

    message(ws, message) {
      if (typeof message === "string") {
        handleMessage(ws.data, message);
      }
    },

    close(ws) {
      const data = ws.data;

      // Unsubscribe from all rooms
      for (const roomId of data.subscribedRooms) {
        roomSubscriptions.get(roomId)?.delete(data.identityId);
      }

      // Remove client
      if (clients.get(data.identityId) === data) {
        clients.delete(data.identityId);
      }

      log(`Disconnected: ${data.identityId.slice(0, 12)} (${clients.size} total)`);
    },
  },
});

log(`Nexnet relay listening on ws://localhost:${PORT}/ws`);
log(`Health: http://localhost:${PORT}/health`);
log(`Status: http://localhost:${PORT}/`);
