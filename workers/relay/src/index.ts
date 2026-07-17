/**
 * @nexnet/worker-relay — WebRTC signalling + room gossip
 *
 * Durable Object: RelaySession
 * - Holds WebSocket connections per identity
 * - Routes session offers/answers/candidates between peers
 * - Distributes room events to subscribed clients
 *
 * AD: relays never permanently store private message bodies.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

// ── Message types ────────────────────────────────────────────────────

interface SessionOfferMessage {
  type: "session_offer";
  to: string;
  sdp: string;
  session_id: string;
}

interface SessionAnswerMessage {
  type: "session_answer";
  to: string;
  sdp: string;
  session_id: string;
}

interface CandidateMessage {
  type: "candidate";
  to: string;
  candidate: string;
  session_id: string;
}

interface RoomSubscribeMessage {
  type: "room_subscribe";
  room_id: string;
}

interface RoomEventMessage {
  type: "room_event";
  room_id: string;
  event: Record<string, unknown>;
}

interface RoomUnsubscribeMessage {
  type: "room_unsubscribe";
  room_id: string;
}

interface DmMessage {
  type: "dm";
  to: string;
  envelope: number[];
}

interface DeliveryReceiptMessage {
  type: "delivery_receipt";
  to: string;
  receipt: Record<string, unknown>;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

type RelayMessage =
  | SessionOfferMessage
  | SessionAnswerMessage
  | CandidateMessage
  | RoomSubscribeMessage
  | RoomEventMessage
  | RoomUnsubscribeMessage
  | DmMessage
  | DeliveryReceiptMessage;

// ── Types ────────────────────────────────────────────────────────────

interface Env {
  RELAY: DurableObjectNamespace;
}

// ── Durable Object: RelaySession ─────────────────────────────────────

interface ConnectionEntry {
  ws: WebSocket;
  identity: string;
  device: string;
  rooms: Set<string>;
}

export class RelaySession {
  private state: DurableObjectState;
  // identity -> connection
  private connections = new Map<string, ConnectionEntry>();
  // room_id -> set of identities
  private roomSubscriptions = new Map<string, Set<string>>();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/status") {
      return jsonResponse({
        connections: this.connections.size,
        rooms: this.roomSubscriptions.size,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const identity = url.searchParams.get("identity");
    const device = url.searchParams.get("device");

    if (!identity || !device) {
      return jsonResponse({ error: "identity and device required" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);

    // Store connection
    this.connections.set(identity, {
      ws: server,
      identity,
      device,
      rooms: new Set(),
    });

    // Attach metadata for lifecycle handlers
    (server as any)._identity = identity;

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string") return;

    let msg: RelayMessage;
    try {
      msg = JSON.parse(data) as RelayMessage;
    } catch {
      this.sendWs(ws, { type: "error", message: "invalid JSON" });
      return;
    }

    const senderIdentity = (ws as any)._identity as string | undefined;
    if (!senderIdentity) return;

    switch (msg.type) {
      case "session_offer":
      case "session_answer":
      case "candidate":
        this.forwardSignaling(msg);
        break;
      case "dm":
        this.forwardDm(msg);
        break;
      case "delivery_receipt":
        this.forwardReceipt(senderIdentity, msg);
        break;
      case "room_subscribe":
        this.subscribeRoom(senderIdentity, msg.room_id);
        break;
      case "room_unsubscribe":
        this.unsubscribeRoom(senderIdentity, msg.room_id);
        break;
      case "room_event":
        this.broadcastRoomEvent(senderIdentity, msg);
        break;
    }
  }

  async webSocketClose(ws: WebSocket) {
    const identity = (ws as any)._identity as string | undefined;
    if (identity) {
      this.removeConnection(identity);
    }
  }

  async webSocketError(ws: WebSocket) {
    const identity = (ws as any)._identity as string | undefined;
    if (identity) {
      this.removeConnection(identity);
    }
  }

  // ── DM forwarding ─────────────────────────────────────────────────

  private forwardDm(msg: DmMessage): void {
    const target = this.connections.get(msg.to);
    if (!target) return;
    this.sendWs(target.ws, msg);
  }

  private forwardReceipt(senderIdentity: string, msg: DeliveryReceiptMessage): void {
    const target = this.connections.get(msg.to);
    if (!target) return;
    this.sendWs(target.ws, {
      type: "delivery_receipt",
      from: senderIdentity,
      receipt: msg.receipt,
    });
  }

  // ── Signaling ──────────────────────────────────────────────────────

  private forwardSignaling(
    msg: SessionOfferMessage | SessionAnswerMessage | CandidateMessage
  ): void {
    const target = this.connections.get(msg.to);
    if (!target) {
      // Target offline — silently drop. Sender can retry.
      return;
    }
    this.sendWs(target.ws, msg);
  }

  // ── Room gossip ────────────────────────────────────────────────────

  private subscribeRoom(identity: string, roomId: string): void {
    const entry = this.connections.get(identity);
    if (!entry) return;

    entry.rooms.add(roomId);

    let subs = this.roomSubscriptions.get(roomId);
    if (!subs) {
      subs = new Set();
      this.roomSubscriptions.set(roomId, subs);
    }
    subs.add(identity);
  }

  private unsubscribeRoom(identity: string, roomId: string): void {
    const entry = this.connections.get(identity);
    if (entry) {
      entry.rooms.delete(roomId);
    }

    const subs = this.roomSubscriptions.get(roomId);
    if (subs) {
      subs.delete(identity);
      if (subs.size === 0) {
        this.roomSubscriptions.delete(roomId);
      }
    }
  }

  private broadcastRoomEvent(
    senderIdentity: string,
    msg: RoomEventMessage
  ): void {
    const subs = this.roomSubscriptions.get(msg.room_id);
    if (!subs) return;

    for (const identity of subs) {
      if (identity === senderIdentity) continue;
      const entry = this.connections.get(identity);
      if (entry) {
        this.sendWs(entry.ws, msg);
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private removeConnection(identity: string): void {
    const entry = this.connections.get(identity);
    if (!entry) return;

    // Remove from all room subscriptions
    for (const roomId of entry.rooms) {
      const subs = this.roomSubscriptions.get(roomId);
      if (subs) {
        subs.delete(identity);
        if (subs.size === 0) {
          this.roomSubscriptions.delete(roomId);
        }
      }
    }

    this.connections.delete(identity);
  }

  private sendWs(ws: WebSocket, data: unknown): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Connection dead, will be cleaned up on close/error
    }
  }
}

// ── Fetch handler ────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

app.get("/ws", (c) => handleWebSocket(c.req.raw, c.env));
app.post("/relay/path", (c) => handleRelayPath(c.req.raw, c.env));
app.get("/health", (c) => handleHealth(c.req.raw, c.env));
app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : "internal error" }, 500));

export default app;

async function handleWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const identity = url.searchParams.get("identity");
  const device = url.searchParams.get("device");

  if (!identity || !device) {
    return jsonResponse({ error: "identity and device query params required" }, 400);
  }

  // All connections go to a single DO instance (the relay)
  const id = env.RELAY.idFromName("default");
  const stub = env.RELAY.get(id);
  return stub.fetch(request);
}

async function handleRelayPath(
  _request: Request,
  _env: Env
): Promise<Response> {
  // Stub: onion relay path request
  // TODO: implement actual relay path selection when multi-hop sessions land (AD-21)
  return jsonResponse({
    relay_path: [],
    hops: 0,
    note: "relay path selection not yet implemented",
  });
}

async function handleHealth(
  _request: Request,
  env: Env
): Promise<Response> {
  const id = env.RELAY.idFromName("default");
  const stub = env.RELAY.get(id);
  const statusResp = await stub.fetch("https://relay/status");
  const status = await statusResp.json() as Record<string, unknown>;
  return jsonResponse({ status: "ok", ...status });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
