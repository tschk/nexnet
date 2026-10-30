/** Agent protocol v1. Admission deadlines are not execution timeouts. */
export type AgentValue = null | boolean | number | string | AgentValue[] | { [key: string]: AgentValue };
export interface AgentRequest {
  version: 1;
  kind: "request";
  correlationId: string;
  capability: string;
  acceptBefore: number;
  input: AgentValue;
}
export type AgentResult = {
  version: 1;
  kind: "result";
  correlationId: string;
} & ({ status: "accepted" } | { status: "completed"; value: AgentValue });
export interface AgentError {
  version: 1;
  kind: "error";
  correlationId: string;
  stage: "admission" | "execution";
  code: string;
  message: string;
}
export type AgentEnvelope = AgentRequest | AgentResult | AgentError;
export type AgentEvidence = Exclude<AgentEnvelope, AgentRequest>;
export type AgentExecution =
  | { state: "awaiting_evidence" }
  | { state: "accepted"; outcome: "not_reported" }
  | { state: "completed"; result: AgentValue }
  | { state: "failed"; error: AgentError };
export type AgentAdmission = Exclude<AgentExecution, { state: "awaiting_evidence" }> | { state: "awaiting_admission" };
export interface AgentOutgoing {
  peer: string;
  request: AgentRequest;
  transport: { messageId: string; state: "queued" | "delivered" };
  execution: AgentExecution;
}
export type AgentInboxEntry =
  | { kind: "request"; peer: string; request: AgentRequest; execution: AgentAdmission }
  | { kind: "rejected"; peer: string; messageId: string; code: string };
export type AgentAdmissionDecision =
  | {
      kind: "new_admission";
      entry: Extract<AgentInboxEntry, { kind: "request" }> & {
        execution: Extract<AgentAdmission, { state: "accepted" }>;
      };
    }
  | { kind: "existing_decision"; entry: Extract<AgentInboxEntry, { kind: "request" }> };

export class AgentProtocolError extends Error {
  constructor(readonly code: string) {
    super(`Agent protocol: ${code}`);
  }
}

export const isAgentPeer = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isCorrelationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => {
  throw new AgentProtocolError("invalid_envelope");
};
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) invalid();
}
function json(value: unknown, depth = 0): AgentValue {
  if (depth > 12) return invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => json(item, depth + 1));
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]));
  return invalid();
}

/** Strict version/field/size parsing also used by the fetch-only SDK. */
export function parseAgentEnvelope(value: unknown): AgentEnvelope {
  if (!object(value) || value.version !== 1 || !isCorrelationId(value.correlationId)) return invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > 4096) return invalid();
  const base = { version: 1, correlationId: value.correlationId } as const;
  switch (value.kind) {
    case "request":
      keys(value, ["version", "kind", "correlationId", "capability", "acceptBefore", "input"]);
      if (
        typeof value.capability !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(value.capability) ||
        typeof value.acceptBefore !== "number" ||
        !Number.isSafeInteger(value.acceptBefore) ||
        value.acceptBefore < 0
      )
        return invalid();
      return {
        ...base,
        kind: "request",
        capability: value.capability,
        acceptBefore: value.acceptBefore,
        input: json(value.input),
      };
    case "result":
      if (value.status === "accepted") {
        keys(value, ["version", "kind", "correlationId", "status"]);
        return { ...base, kind: "result", status: "accepted" };
      }
      if (value.status !== "completed") return invalid();
      keys(value, ["version", "kind", "correlationId", "status", "value"]);
      return { ...base, kind: "result", status: "completed", value: json(value.value) };
    case "error":
      keys(value, ["version", "kind", "correlationId", "stage", "code", "message"]);
      if (
        (value.stage !== "admission" && value.stage !== "execution") ||
        typeof value.code !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(value.code) ||
        typeof value.message !== "string" ||
        value.message.length > 1024
      )
        return invalid();
      return { ...base, kind: "error", stage: value.stage, code: value.code, message: value.message };
    default:
      return invalid();
  }
}

export function parseAgentExecution(value: unknown): AgentExecution {
  if (!object(value)) return invalid();
  switch (value.state) {
    case "awaiting_evidence":
      return { state: value.state };
    case "accepted":
      if (value.outcome !== "not_reported") return invalid();
      return { state: value.state, outcome: "not_reported" };
    case "completed":
      return { state: value.state, result: json(value.result) };
    case "failed": {
      const error = parseAgentEnvelope(value.error);
      if (error.kind !== "error") return invalid();
      return { state: value.state, error };
    }
    default:
      return invalid();
  }
}

export function parseAgentOutgoing(value: unknown): AgentOutgoing {
  if (
    !object(value) ||
    !isAgentPeer(value.peer) ||
    !object(value.transport) ||
    !isAgentPeer(value.transport.messageId) ||
    (value.transport.state !== "queued" && value.transport.state !== "delivered")
  )
    return invalid();
  const request = parseAgentEnvelope(value.request);
  if (request.kind !== "request") return invalid();
  const execution = parseAgentExecution(value.execution);
  if (execution.state === "failed" && execution.error.correlationId !== request.correlationId) return invalid();
  return {
    peer: value.peer,
    request,
    transport: { messageId: value.transport.messageId, state: value.transport.state },
    execution,
  };
}

export function parseAgentInboxEntry(value: unknown): AgentInboxEntry {
  if (!object(value) || !isAgentPeer(value.peer)) return invalid();
  if (value.kind === "rejected" && isAgentPeer(value.messageId) && typeof value.code === "string")
    return { kind: "rejected", peer: value.peer, messageId: value.messageId, code: value.code };
  if (value.kind !== "request" || !object(value.execution)) return invalid();
  const request = parseAgentEnvelope(value.request);
  if (request.kind !== "request") return invalid();
  const execution =
    value.execution.state === "awaiting_admission"
      ? { state: "awaiting_admission" as const }
      : parseAgentExecution(value.execution);
  if (execution.state === "awaiting_evidence") return invalid();
  if (execution.state === "failed" && execution.error.correlationId !== request.correlationId) return invalid();
  return { kind: "request", peer: value.peer, request, execution };
}
