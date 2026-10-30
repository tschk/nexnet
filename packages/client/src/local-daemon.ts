import { timingSafeEqual } from "node:crypto";
import { identityIdFromWallet, fromHex, toHex } from "@nexnet/protocol";
import type { OutboundQueueItem } from "@nexnet/types";
import {
  createPersistentClient,
  openPersistentClient,
  type DeviceCredentials,
  type PersistentClientConfig,
} from "./persistent-client.js";
import { onDirectMessage, sendDirectMessage } from "./dm.js";
import type { LocalInboxMessage, LocalMessageState, LocalPresence, LocalStatus } from "./local-api.js";
import { AgentMailbox } from "./agent-mailbox.js";
import { AgentProtocolError, isAgentPeer, isCorrelationId, parseAgentEnvelope } from "./agent-envelope.js";
import { CapabilityIndex } from "./capability-index.js";
import { claimObject, parseCapabilities } from "./capability-claims.js";

type DeviceSource =
  | { mode: "create"; config: PersistentClientConfig; credentials: DeviceCredentials }
  | { mode: "open"; config: PersistentClientConfig };

export interface LocalDaemonConfig {
  /** Host-owned secret-provider boundary; never exposed over HTTP. */
  loadDevice(): Promise<DeviceSource>;
  /** Independent, host-provided random 32-byte token encoded as lowercase hex. */
  loadControlToken(): Promise<string>;
  trustedPeerRoots: readonly Uint8Array[];
  port?: number;
}

const idPattern = /^[0-9a-f]{64}$/;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (data: unknown, status = 200) => Response.json({ version: 1, data }, { status, headers });
const failure = (code: string, status: number) => Response.json({ version: 1, error: { code } }, { status, headers });

/** Host-only native keychain/secret-service reader. No disk, environment or generation fallback. */
export async function readOsSecret32(reference: { service: string; name: string }): Promise<Uint8Array> {
  const value = await Bun.secrets.get(reference);
  if (!value || !idPattern.test(value)) throw new Error("OS secret is missing or is not a 32-byte lowercase hex value");
  return fromHex(value);
}

/** Privileged local transport control, NOT a delegated execution service. */
export async function startLocalDaemon(options: LocalDaemonConfig) {
  const token = await options.loadControlToken();
  if (!idPattern.test(token)) throw new Error("Control token must be 32 random bytes encoded as lowercase hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const roots = new Map<string, Uint8Array>();
  for (const root of options.trustedPeerRoots) {
    if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error("Invalid trusted peer root");
    roots.set(toHex(identityIdFromWallet(root)), new Uint8Array(root));
  }
  const allowed = new Set(roots.keys());
  const source = await options.loadDevice();
  const client =
    source.mode === "create"
      ? createPersistentClient(source.config, source.credentials)
      : openPersistentClient(source.config);
  const state = client.persistentState!;
  const agents = new AgentMailbox(client, allowed);
  const capabilityIndex = new CapabilityIndex(client, roots);
  let stopping = false;
  let transportError = false;
  client.on("error", () => {
    transportError = true;
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    if (toHex(source.config.unlockKey) === token) throw new Error("Control token must not reuse the device unlock key");
    // Old obligations must not bypass a newly narrowed trusted-peer policy.
    // pending() excludes backoff-delayed messages, so inspect all stored obligations too.
    for (const name of state.store.keys("queue:")) {
      const item = state.read<OutboundQueueItem>(name);
      if (item.deliveryState === "pending" && !allowed.has(toHex(item.recipientIdentityId))) {
        throw new Error("Pending outbox includes a peer outside the trusted allowlist");
      }
    }
    onDirectMessage(
      client,
      () => {},
      (identity) => roots.get(toHex(identity)),
      undefined,
      allowed,
    );
    await client.connect();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 0,
      maxRequestBodySize: 16 * 1024,
      async fetch(request) {
        const authority = `127.0.0.1:${server!.port}`;
        if (request.headers.get("host") !== authority || request.headers.has("origin"))
          return failure("forbidden", 403);
        const provided = Buffer.from(request.headers.get("authorization") ?? "");
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
          return failure("unauthorized", 401);
        if (stopping) return failure("stopping", 503);
        const url = new URL(request.url);
        try {
          if (request.method === "GET" && url.pathname === "/v1/status") {
            const status: LocalStatus = {
              identityId: toHex(client.identityId),
              deviceId: toHex(client.deviceId),
              online: client.online,
              certificateExpiresAt: client.deviceCertificate!.expiresAt,
              transportError,
            };
            return reply(status);
          }
          if (request.method === "GET" && url.pathname === "/v1/inbox") {
            const inbox: LocalInboxMessage[] = client
              .inbox()
              .filter((message) => allowed.has(toHex(message.envelope.senderIdentityId)))
              .map(({ envelope, payload }) => ({
                messageId: toHex(envelope.messageId),
                peer: toHex(envelope.senderIdentityId),
                text: payload.text ?? "",
                createdAt: envelope.createdAt,
              }));
            return reply(inbox);
          }
          if (url.pathname === "/v1/agent/capabilities") {
            if (request.method === "GET") {
              if (
                [...url.searchParams.keys()].some((name) => name !== "capability") ||
                url.searchParams.getAll("capability").length > 1
              )
                return failure("invalid_capabilities", 400);
              return reply(capabilityIndex.search(url.searchParams.get("capability") ?? undefined));
            }
            if (request.method === "POST") {
              if (request.headers.get("content-type") !== "application/json") return failure("invalid_json", 415);
              const body: unknown = await request.json();
              if (
                !claimObject(body) ||
                Object.keys(body).length !== 3 ||
                !isAgentPeer(body.peer) ||
                typeof body.ttlMs !== "number"
              )
                return failure("invalid_capabilities", 400);
              return reply(
                await capabilityIndex.publish(body.peer, parseCapabilities(body.capabilities), body.ttlMs),
                202,
              );
            }
          }
          if (request.method === "GET" && url.pathname === "/v1/agent/inbox") return reply(agents.inbox());
          const agentPath = url.pathname.match(/^\/v1\/agent\/requests\/([0-9a-f]{64})\/([A-Za-z0-9_-]{1,128})$/);
          if (request.method === "GET" && agentPath) return reply(agents.outgoing(agentPath[1]!, agentPath[2]!));
          if (
            request.method === "POST" &&
            ["/v1/agent/requests", "/v1/agent/admit", "/v1/agent/respond"].includes(url.pathname)
          ) {
            if (request.headers.get("content-type") !== "application/json") return failure("invalid_json", 415);
            const body: unknown = await request.json();
            if (
              !body ||
              typeof body !== "object" ||
              !("peer" in body) ||
              !isAgentPeer(body.peer) ||
              Object.keys(body).length !== 2
            )
              return failure("invalid_envelope", 400);
            if (!allowed.has(body.peer)) return failure("peer_not_allowed", 403);
            if (url.pathname === "/v1/agent/admit") {
              if (!("correlationId" in body) || !isCorrelationId(body.correlationId))
                return failure("invalid_envelope", 400);
              return reply(await agents.admit(body.peer, body.correlationId));
            }
            if (!("envelope" in body)) return failure("invalid_envelope", 400);
            const envelope = parseAgentEnvelope(body.envelope);
            if (url.pathname === "/v1/agent/requests") {
              if (envelope.kind !== "request") return failure("invalid_envelope", 400);
              return reply(await agents.submit(body.peer, envelope), 202);
            }
            if (envelope.kind === "request") return failure("invalid_envelope", 400);
            return reply(await agents.respond(body.peer, envelope));
          }
          if (request.method === "POST" && url.pathname === "/v1/messages") {
            if (request.headers.get("content-type") !== "application/json") return failure("invalid_json", 415);
            const body: unknown = await request.json();
            if (
              !body ||
              typeof body !== "object" ||
              !("peer" in body) ||
              !("text" in body) ||
              typeof body.peer !== "string" ||
              !idPattern.test(body.peer) ||
              typeof body.text !== "string" ||
              new TextEncoder().encode(body.text).length > 4096 ||
              !body.text.length ||
              Object.keys(body).some((key) => key !== "peer" && key !== "text")
            )
              return failure("invalid_message", 400);
            if (!allowed.has(body.peer)) return failure("peer_not_allowed", 403);
            const messageId = await sendDirectMessage(client, fromHex(body.peer), body.text);
            const result: LocalMessageState = { messageId: toHex(messageId), state: "queued" };
            return reply(result, 202);
          }
          const messageId = url.pathname.match(/^\/v1\/messages\/([0-9a-f]{64})$/)?.[1];
          if (request.method === "GET" && messageId) {
            const name = `queue:${messageId}`;
            if (!state.store.get(name)) return failure("not_found", 404);
            const item = state.read<OutboundQueueItem>(name);
            if (!allowed.has(toHex(item.recipientIdentityId))) return failure("peer_not_allowed", 403);
            const result: LocalMessageState = {
              messageId,
              state: item.deliveryState === "delivered" ? "delivered" : "queued",
            };
            return reply(result);
          }
          const peer = url.pathname.match(/^\/v1\/presence\/([0-9a-f]{64})$/)?.[1];
          if (request.method === "GET" && peer) {
            if (!allowed.has(peer)) return failure("peer_not_allowed", 403);
            let online: boolean | null = null;
            try {
              const response = await fetch(
                `${client.relayUrl.replace(/^ws/, "http").replace(/\/$/, "")}/online/${peer}`,
                {
                  signal: AbortSignal.timeout(5000),
                  redirect: "error",
                },
              );
              const observed: unknown = await response.json();
              if (
                response.ok &&
                observed &&
                typeof observed === "object" &&
                "identityId" in observed &&
                observed.identityId === peer &&
                "online" in observed &&
                typeof observed.online === "boolean"
              )
                online = observed.online;
            } catch {
              /* Missing evidence is unknown, never inferred offline. */
            }
            const result: LocalPresence = { peer, online };
            return reply(result);
          }
          return failure("not_found", 404);
        } catch (error) {
          if (error instanceof SyntaxError) return failure("invalid_json", 400);
          if (error instanceof AgentProtocolError)
            return failure(
              error.code,
              error.code === "not_found"
                ? 404
                : error.code === "peer_not_allowed"
                  ? 403
                  : error.code === "invalid_envelope" || error.code === "invalid_capabilities"
                    ? 400
                    : 409,
            );
          transportError = true;
          // Never return cryptographic state, host paths or provider errors to control clients.
          return failure("transport_failed", 503);
        }
      },
    });
  } catch (error) {
    await client.close();
    throw error;
  }
  const active = server;
  return {
    url: `http://127.0.0.1:${active.port}`,
    async close() {
      if (stopping) return;
      stopping = true;
      // Drain HTTP sends before releasing the device lock; no late write after ownership handoff.
      await active.stop();
      await client.close();
      expected.fill(0);
    },
  };
}
