import { cdeEncode, fromHex, toHex } from "@nexnet/protocol";
import type { OutboundQueueItem } from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import { sendDirectMessage } from "./dm.js";
import type { PersistentDmState } from "./persistent-client.js";
import {
  AgentProtocolError,
  parseAgentEnvelope,
  type AgentRequest,
  type AgentEnvelope,
  type AgentEvidence,
  type AgentExecution,
  type AgentOutgoing,
  type AgentInboxEntry,
  type AgentAdmissionDecision,
} from "./agent-envelope.js";

type Incoming = Extract<AgentInboxEntry, { kind: "request" }>;
type StoredOutgoing = Omit<AgentOutgoing, "transport"> & { messageId: string };
const same = (a: unknown, b: unknown) => Buffer.from(cdeEncode(a)).equals(Buffer.from(cdeEncode(b)));
const fail = (code: string): never => {
  throw new AgentProtocolError(code);
};
const key = (direction: "in" | "out", peer: string, correlation: string) =>
  `agent:v1:${direction}:${peer}:${correlation}`;

/** One instance per exclusively owned device. No executor and no automatic admission. */
export class AgentMailbox {
  private readonly state: PersistentDmState;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly client: NexnetClient,
    private readonly allowed: ReadonlySet<string>,
  ) {
    if (!client.persistentState) throw new Error("Agent mailbox requires an exclusively owned persistent device");
    this.state = client.persistentState;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private read<T>(name: string): T | undefined {
    return this.state.store.get(name) ? this.state.read<T>(name) : undefined;
  }

  private checkPeer(peer: string): void {
    if (!this.allowed.has(peer)) fail("peer_not_allowed");
  }

  /** Replay authenticated durable inbox, not a lossy callback. Each observation commits once. */
  private sync(): void {
    for (const { envelope, payload } of this.client.inbox()) {
      const peer = toHex(envelope.senderIdentityId);
      if (!this.allowed.has(peer) || payload.contentType !== "agent") continue;
      const messageId = toHex(envelope.messageId);
      const seen = `agent:v1:seen:${messageId}`;
      if (this.state.store.get(seen)) continue;
      this.state.store.transaction(() => {
        try {
          if (typeof payload.text !== "string" || new TextEncoder().encode(payload.text).length > 4096)
            fail("invalid_envelope");
          let wire: unknown;
          try {
            wire = JSON.parse(payload.text);
          } catch {
            fail("invalid_envelope");
          }
          const message = parseAgentEnvelope(wire);
          const name = key(message.kind === "request" ? "in" : "out", peer, message.correlationId);
          if (message.kind === "request") {
            const previous = this.read<Incoming>(name);
            if (previous && !same(previous.request, message)) fail("correlation_conflict");
            if (!previous)
              this.state.write(name, {
                kind: "request",
                peer,
                request: message,
                execution: { state: "awaiting_admission" },
              } satisfies Incoming);
          } else {
            const previous = this.read<StoredOutgoing>(name);
            if (!previous) return fail("unknown_correlation");
            this.state.write(name, { ...previous, execution: this.apply(previous.execution, message) });
          }
        } catch (error) {
          if (!(error instanceof AgentProtocolError)) throw error;
          this.state.write(`agent:v1:rejected:${messageId}`, {
            kind: "rejected",
            peer,
            messageId,
            code: error.code,
          } satisfies AgentInboxEntry);
        }
        this.state.write(seen, true);
      });
    }
  }

  private apply(previous: AgentExecution, evidence: AgentEvidence): AgentExecution {
    if (evidence.kind === "result" && evidence.status === "accepted") {
      if (previous.state === "failed" && previous.error.stage === "admission") fail("conflicting_evidence");
      return previous.state === "awaiting_evidence" ? { state: "accepted", outcome: "not_reported" } : previous;
    }
    const next: AgentExecution =
      evidence.kind === "error" ? { state: "failed", error: evidence } : { state: "completed", result: evidence.value };
    if (previous.state === "completed" || previous.state === "failed") {
      if (!same(previous, next)) fail("conflicting_evidence");
      return previous;
    }
    if (previous.state === "accepted" && evidence.kind === "error" && evidence.stage === "admission")
      fail("conflicting_evidence");
    return next;
  }

  inbox(): AgentInboxEntry[] {
    this.sync();
    return [...this.state.store.keys("agent:v1:in:"), ...this.state.store.keys("agent:v1:rejected:")]
      .map((name) => this.state.read<AgentInboxEntry>(name))
      .filter((entry) => this.allowed.has(entry.peer));
  }

  outgoing(peer: string, correlationId: string): AgentOutgoing {
    this.checkPeer(peer);
    this.sync();
    const record = this.read<StoredOutgoing>(key("out", peer, correlationId));
    if (!record) return fail("not_found");
    const item = this.state.read<OutboundQueueItem>(`queue:${record.messageId}`);
    return {
      peer,
      request: record.request,
      execution: record.execution,
      transport: { messageId: record.messageId, state: item.deliveryState === "delivered" ? "delivered" : "queued" },
    };
  }

  submit(peer: string, request: AgentRequest): Promise<AgentOutgoing> {
    return this.exclusive(async () => {
      this.checkPeer(peer);
      const parsed = parseAgentEnvelope(request);
      if (parsed.kind !== "request") return fail("invalid_envelope");
      const name = key("out", peer, parsed.correlationId);
      const previous = this.read<StoredOutgoing>(name);
      if (previous && !same(previous.request, parsed)) return fail("correlation_conflict");
      if (!previous)
        await this.send(peer, parsed, (messageId) => {
          this.state.write(name, {
            peer,
            request: parsed,
            messageId,
            execution: { state: "awaiting_evidence" },
          } satisfies StoredOutgoing);
        });
      return this.outgoing(peer, parsed.correlationId);
    });
  }

  private incoming(peer: string, correlationId: string): Incoming {
    this.checkPeer(peer);
    this.sync();
    return this.read<Incoming>(key("in", peer, correlationId)) ?? fail("not_found");
  }

  admit(peer: string, correlationId: string): Promise<AgentAdmissionDecision> {
    return this.exclusive(async () => {
      const entry = this.incoming(peer, correlationId);
      if (entry.execution.state !== "awaiting_admission") return { kind: "existing_decision", entry };
      const accepted: AgentEvidence = { version: 1, kind: "result", correlationId, status: "accepted" };
      const expired = {
        version: 1,
        kind: "error",
        correlationId,
        stage: "admission",
        code: "admission_expired",
        message: "Admission deadline elapsed; work was not accepted",
      } satisfies AgentEvidence;
      let decision: AgentAdmissionDecision | undefined;
      let evidenceIsAccepted = Date.now() < entry.request.acceptBefore;
      const commit = () => {
        // If a slow network preparation crosses the deadline, roll back rather than acknowledge false admission.
        if (Date.now() >= entry.request.acceptBefore && evidenceIsAccepted) fail("admission_deadline_changed");
        entry.execution = evidenceIsAccepted
          ? { state: "accepted", outcome: "not_reported" }
          : { state: "failed", error: expired };
        this.state.write(key("in", peer, correlationId), entry);
        decision =
          entry.execution.state === "accepted"
            ? { kind: "new_admission", entry: { ...entry, execution: entry.execution } }
            : { kind: "existing_decision", entry };
      };
      try {
        await this.send(peer, evidenceIsAccepted ? accepted : expired, commit);
      } catch (error) {
        if (!(error instanceof AgentProtocolError) || error.code !== "admission_deadline_changed") throw error;
        evidenceIsAccepted = false;
        await this.send(peer, expired, commit);
      }
      return decision ?? fail("missing_admission");
    });
  }

  respond(peer: string, evidence: AgentEvidence): Promise<Incoming> {
    return this.exclusive(async () => {
      const parsed = parseAgentEnvelope(evidence);
      if (parsed.kind === "request" || (parsed.kind === "result" && parsed.status === "accepted"))
        return fail("invalid_transition");
      const entry = this.incoming(peer, parsed.correlationId);
      let next: AgentExecution;
      if (entry.execution.state === "awaiting_admission") {
        if (parsed.kind !== "error" || parsed.stage !== "admission") return fail("not_accepted");
        next = { state: "failed", error: parsed };
      } else {
        next = this.apply(entry.execution, parsed);
      }
      if (next.state === "awaiting_evidence") return fail("invalid_transition");
      if (same(next, entry.execution)) return entry;
      await this.send(peer, parsed, () => {
        entry.execution = next;
        this.state.write(key("in", peer, parsed.correlationId), entry);
      });
      return entry;
    });
  }

  private async send(peer: string, envelope: AgentEnvelope, commit: (messageId: string) => void): Promise<void> {
    await sendDirectMessage(
      this.client,
      fromHex(peer),
      { contentType: "agent", text: JSON.stringify(envelope) },
      undefined,
      { commitMetadata: (id) => commit(toHex(id)) },
    );
  }
}
