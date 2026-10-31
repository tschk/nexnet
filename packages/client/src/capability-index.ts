import {
  identityProofFromJson,
  identityProofToJson,
  signIdentityAuthJson,
  verifyIdentityAuthJson,
  toHex,
  fromHex,
  type IdentityProofJson,
} from "@nexnet/protocol";
import type { NexnetClient } from "./client.js";
import { sendDirectMessage } from "./dm.js";
import { AgentProtocolError } from "./agent-envelope.js";
import {
  CAPABILITY_TTL_MS,
  claimObject,
  parseCapabilities,
  parseCapabilityFields,
  isCapabilityName,
  type CapabilityFields,
  type CapabilityDescription,
  type IndexedCapabilityClaim,
} from "./capability-claims.js";

type Advertisement = CapabilityFields & { auth: IdentityProofJson };
const OPERATION = "agent.capabilities.v1";

/** Closed local index, one independently verified claim per pinned principal. No network fetches or execution. */
export class CapabilityIndex {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly client: NexnetClient,
    private readonly roots: ReadonlyMap<string, Uint8Array>,
  ) {}
  private get state() {
    return this.client.persistentState!;
  }

  private verify(value: unknown, now: number): { signed: Advertisement; entry: IndexedCapabilityClaim } | null {
    try {
      if (!claimObject(value)) return null;
      const { auth, ...fields } = value;
      const advertisement = parseCapabilityFields(fields);
      const pinned = this.roots.get(advertisement.identityId);
      const proof = identityProofFromJson(auth);
      const cert = proof.certificate;
      if (
        !pinned ||
        toHex(pinned) !== toHex(proof.rootPublicKey) ||
        !cert ||
        advertisement.issuedAt > now ||
        advertisement.issuedAt < cert.issuedAt ||
        advertisement.expiresAt > cert.expiresAt ||
        advertisement.expiresAt <= now
      )
        return null;
      const signed = { ...advertisement, auth: identityProofToJson(proof) };
      const verified = verifyIdentityAuthJson(signed, OPERATION, advertisement.identityId, now);
      if (!verified?.deviceId) return null;
      return {
        signed,
        entry: { evidence: "signed_self_description", deviceId: toHex(verified.deviceId), advertisement },
      };
    } catch {
      return null;
    }
  }

  publish(
    peer: string,
    capabilities: CapabilityDescription[],
    ttlMs: number,
  ): Promise<{ messageId: string; revision: number }> {
    const operation = this.tail.then(async () => {
      if (!this.roots.has(peer)) throw new AgentProtocolError("peer_not_allowed");
      const parsed = parseCapabilities(capabilities);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > CAPABILITY_TTL_MS)
        throw new AgentProtocolError("invalid_capabilities");
      await this.client.ensureDeviceCertificate();
      const name = "capabilities:v1:revision";
      const revision = (this.state.store.get(name) ? this.state.read<number>(name) : 0) + 1;
      const now = Date.now();
      const signed = signIdentityAuthJson(this.client.identitySigner(), OPERATION, this.client.identityId, {
        version: 1,
        kind: "capability_claims",
        identityId: toHex(this.client.identityId),
        revision,
        issuedAt: now,
        expiresAt: Math.min(now + ttlMs, this.client.deviceCertificate!.expiresAt),
        capabilities: parsed,
      });
      // Local signing is validated by the same parser; never queue an unsupported shape or exhausted counter.
      const { auth: _auth, ...fields } = signed;
      try {
        parseCapabilityFields(fields);
      } catch {
        throw new AgentProtocolError("invalid_capabilities");
      }
      if (new TextEncoder().encode(JSON.stringify(signed)).length > 8192)
        throw new AgentProtocolError("invalid_capabilities");
      const messageId = await sendDirectMessage(
        this.client,
        fromHex(peer),
        { contentType: "agent_capabilities", text: JSON.stringify(signed) },
        undefined,
        { commitMetadata: () => this.state.write(name, revision) },
      );
      return { messageId: toHex(messageId), revision };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  search(capability?: string): IndexedCapabilityClaim[] {
    if (capability !== undefined && !isCapabilityName(capability)) throw new AgentProtocolError("invalid_capabilities");
    const now = Date.now();
    for (const name of this.state.store.keys("inbox:")) {
      const seen = `capabilities:v1:seen:${name}`;
      if (this.state.store.get(seen)) continue;
      const bytes = this.state.store.get(name)!;
      let verified: ReturnType<CapabilityIndex["verify"]> = null;
      try {
        const raw = this.client.codec.decode<unknown>(bytes);
        if (
          claimObject(raw) &&
          claimObject(raw.envelope) &&
          raw.envelope.senderIdentityId instanceof Uint8Array &&
          claimObject(raw.payload) &&
          raw.payload.contentType === "agent_capabilities" &&
          typeof raw.payload.text === "string" &&
          new TextEncoder().encode(raw.payload.text).length <= 8192
        ) {
          verified = this.verify(JSON.parse(raw.payload.text), now);
          if (verified && verified.entry.advertisement.identityId !== toHex(raw.envelope.senderIdentityId))
            verified = null;
        }
      } catch {
        /* An invalid advertisement is isolated from every other inbox/index entry. */
      }
      this.state.store.transaction(() => {
        if (verified) {
          const peer = verified.entry.advertisement.identityId;
          const watermark = `capabilities:v1:watermark:${peer}`;
          const previous = this.state.store.get(watermark) ? this.state.read<number>(watermark) : 0;
          if (verified.entry.advertisement.revision > previous) {
            this.state.write(`capabilities:v1:index:${peer}`, verified.signed);
            this.state.write(watermark, verified.entry.advertisement.revision);
          }
        }
        this.state.write(seen, true);
      });
    }
    const entries: IndexedCapabilityClaim[] = [];
    for (const name of this.state.store.keys("capabilities:v1:index:")) {
      const bytes = this.state.store.get(name)!;
      try {
        const verified = this.verify(this.client.codec.decode<unknown>(bytes), now);
        if (
          verified &&
          (!capability || verified.entry.advertisement.capabilities.some((entry) => entry.name === capability))
        )
          entries.push(verified.entry);
      } catch {
        /* Malformed legacy/cached rows never poison the whole index. */
      }
    }
    return entries.sort((a, b) => a.advertisement.identityId.localeCompare(b.advertisement.identityId));
  }
}
