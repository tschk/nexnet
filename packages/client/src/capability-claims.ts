/** Signed self-descriptions are claims, never verified competence or authority. */
import { AgentProtocolError } from "./agent-envelope.js";
export interface CapabilityDescription {
  name: string;
  description: string;
}
export interface CapabilityFields {
  version: 1;
  kind: "capability_claims";
  identityId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  capabilities: CapabilityDescription[];
}
export interface IndexedCapabilityClaim {
  evidence: "signed_self_description";
  deviceId: string;
  advertisement: CapabilityFields;
}
export const CAPABILITY_TTL_MS = 3600_000;
export const isCapabilityName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
export const claimObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => {
  throw new AgentProtocolError("invalid_capabilities");
};
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseCapabilities(value: unknown): CapabilityDescription[] {
  if (!Array.isArray(value) || value.length > 16) return invalid();
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !claimObject(entry) ||
      Object.keys(entry).length !== 2 ||
      !isCapabilityName(entry.name) ||
      typeof entry.description !== "string" ||
      new TextEncoder().encode(entry.description).length > 160 ||
      names.has(entry.name)
    )
      return invalid();
    names.add(entry.name);
    return { name: entry.name, description: entry.description };
  });
}

export function parseCapabilityFields(value: unknown): CapabilityFields {
  if (
    !claimObject(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== 1 ||
    value.kind !== "capability_claims" ||
    !id(value.identityId) ||
    !timestamp(value.revision) ||
    value.revision < 1 ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    value.expiresAt <= value.issuedAt ||
    value.expiresAt - value.issuedAt > CAPABILITY_TTL_MS
  )
    return invalid();
  return {
    version: 1,
    kind: "capability_claims",
    identityId: value.identityId,
    revision: value.revision,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    capabilities: parseCapabilities(value.capabilities),
  };
}

export function parseIndexedCapabilityClaim(value: unknown): IndexedCapabilityClaim {
  if (!claimObject(value) || value.evidence !== "signed_self_description" || !id(value.deviceId)) return invalid();
  return {
    evidence: value.evidence,
    deviceId: value.deviceId,
    advertisement: parseCapabilityFields(value.advertisement),
  };
}
