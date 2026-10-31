import type { LocalInboxMessage, LocalMessageState, LocalPresence, LocalStatus } from "./local-api.js";
export type { LocalInboxMessage, LocalMessageState, LocalPresence, LocalStatus } from "./local-api.js";
import {
  isCorrelationId,
  parseAgentEnvelope,
  parseAgentOutgoing,
  parseAgentInboxEntry,
  type AgentRequest,
  type AgentEvidence,
  type AgentOutgoing,
  type AgentInboxEntry,
  type AgentAdmissionDecision,
} from "./agent-envelope.js";
export type {
  AgentValue,
  AgentRequest,
  AgentResult,
  AgentError,
  AgentEnvelope,
  AgentExecution,
  AgentOutgoing,
  AgentInboxEntry,
  AgentAdmissionDecision,
} from "./agent-envelope.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const invalid = () => new Error("Invalid local daemon response");

export class LocalApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Local daemon: ${code}`);
  }
}

/** Fetch-only SDK: no device keys, unlock key, storage or root signer in the caller. */
export class LocalNexnet {
  private readonly url: string;
  constructor(
    url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Local daemon URL must be an explicit http://127.0.0.1:PORT origin");
    }
    if (!id(token)) throw new Error("Invalid local control token");
    this.url = parsed.origin;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const result: unknown = await response.json();
    if (!object(result) || result.version !== 1) throw invalid();
    if (!response.ok) {
      if (!object(result.error) || typeof result.error.code !== "string") throw invalid();
      throw new LocalApiError(result.error.code, response.status);
    }
    return result.data;
  }

  async status(): Promise<LocalStatus> {
    const result = await this.request("/v1/status");
    if (
      !object(result) ||
      !id(result.identityId) ||
      !id(result.deviceId) ||
      typeof result.online !== "boolean" ||
      typeof result.transportError !== "boolean" ||
      typeof result.certificateExpiresAt !== "number" ||
      !Number.isSafeInteger(result.certificateExpiresAt)
    )
      throw invalid();
    return {
      identityId: result.identityId,
      deviceId: result.deviceId,
      online: result.online,
      certificateExpiresAt: result.certificateExpiresAt,
      transportError: result.transportError,
    };
  }

  private messageState(result: unknown): LocalMessageState {
    if (!object(result) || !id(result.messageId) || (result.state !== "queued" && result.state !== "delivered"))
      throw invalid();
    return { messageId: result.messageId, state: result.state };
  }

  async send(peer: string, text: string): Promise<LocalMessageState> {
    if (!id(peer)) throw new Error("Invalid peer identity");
    return this.messageState(await this.request("/v1/messages", { peer, text }));
  }

  async delivery(messageId: string): Promise<LocalMessageState> {
    if (!id(messageId)) throw new Error("Invalid message id");
    const result = this.messageState(await this.request(`/v1/messages/${messageId}`));
    if (result.messageId !== messageId) throw invalid();
    return result;
  }

  async inbox(): Promise<LocalInboxMessage[]> {
    const result = await this.request("/v1/inbox");
    if (!Array.isArray(result)) throw invalid();
    return result.map((entry: unknown) => {
      if (
        !object(entry) ||
        !id(entry.messageId) ||
        !id(entry.peer) ||
        typeof entry.text !== "string" ||
        typeof entry.createdAt !== "number" ||
        !Number.isSafeInteger(entry.createdAt)
      )
        throw invalid();
      return { messageId: entry.messageId, peer: entry.peer, text: entry.text, createdAt: entry.createdAt };
    });
  }

  async presence(peer: string): Promise<LocalPresence> {
    if (!id(peer)) throw new Error("Invalid peer identity");
    const result = await this.request(`/v1/presence/${peer}`);
    if (!object(result) || result.peer !== peer || (result.online !== null && typeof result.online !== "boolean"))
      throw invalid();
    return { peer, online: result.online };
  }

  async submit(peer: string, envelope: AgentRequest): Promise<AgentOutgoing> {
    if (!id(peer)) throw invalid();
    const parsed = parseAgentEnvelope(envelope);
    if (parsed.kind !== "request") throw invalid();
    const result = parseAgentOutgoing(await this.request("/v1/agent/requests", { peer, envelope: parsed }));
    if (result.peer !== peer || result.request.correlationId !== parsed.correlationId) throw invalid();
    return result;
  }

  /** A timeout is lack of evidence, not failed execution. No automatic retry or re-execution. */
  async execution(peer: string, correlationId: string): Promise<AgentOutgoing> {
    if (!id(peer) || !isCorrelationId(correlationId)) throw invalid();
    const result = parseAgentOutgoing(await this.request(`/v1/agent/requests/${peer}/${correlationId}`));
    if (result.peer !== peer || result.request.correlationId !== correlationId) throw invalid();
    return result;
  }

  async agentInbox(): Promise<AgentInboxEntry[]> {
    const result = await this.request("/v1/agent/inbox");
    if (!Array.isArray(result)) throw invalid();
    return result.map(parseAgentInboxEntry);
  }

  /** Privileged host lifecycle recording, not a delegated grant or an executor. */
  async admit(peer: string, correlationId: string): Promise<AgentAdmissionDecision> {
    if (!id(peer) || !isCorrelationId(correlationId)) throw invalid();
    const result = await this.request("/v1/agent/admit", { peer, correlationId });
    if (!object(result) || (result.kind !== "new_admission" && result.kind !== "existing_decision")) throw invalid();
    const entry = parseAgentInboxEntry(result.entry);
    if (
      entry.kind !== "request" ||
      entry.peer !== peer ||
      entry.request.correlationId !== correlationId ||
      entry.execution.state === "awaiting_admission" ||
      (result.kind === "new_admission" && entry.execution.state !== "accepted")
    )
      throw invalid();
    if (result.kind === "new_admission") {
      if (entry.execution.state !== "accepted") throw invalid();
      return { kind: result.kind, entry: { ...entry, execution: entry.execution } };
    }
    return { kind: result.kind, entry };
  }

  async respond(peer: string, envelope: AgentEvidence): Promise<Extract<AgentInboxEntry, { kind: "request" }>> {
    if (!id(peer)) throw invalid();
    const parsed = parseAgentEnvelope(envelope);
    if (parsed.kind === "request") throw invalid();
    const result = parseAgentInboxEntry(await this.request("/v1/agent/respond", { peer, envelope: parsed }));
    if (result.kind !== "request" || result.peer !== peer || result.request.correlationId !== parsed.correlationId)
      throw invalid();
    return result;
  }
}
