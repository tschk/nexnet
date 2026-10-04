import type { DeviceCertificate, NexnetEvent, Revocation } from "@nexnet/types";
import { cdeDecode, certificateToJson, eventToJson, revocationToJson, toBase64Url, toHex } from "@nexnet/protocol";

export { certificateToJson, eventToJson, revocationToJson, toBase64Url, toHex };

export class WireError extends Error {}

export function hexBytes(value: unknown, length: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new WireError(`Invalid ${field}`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

export function base64UrlBytes(value: unknown, field: string, maxBytes = 8192): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxBytes * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new WireError(`Invalid ${field}`);
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (bytes.length > maxBytes) throw new WireError(`Invalid ${field}`);
  return bytes;
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WireError(`Invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

export function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WireError(`Invalid ${field}`);
  }
  return value;
}

export function certificateFromJson(value: unknown): DeviceCertificate {
  const input = record(value, "certificate");
  return {
    accountId: hexBytes(input.accountId, 32, "certificate.accountId"),
    deviceId: hexBytes(input.deviceId, 32, "certificate.deviceId"),
    deviceSigningPublicKey: hexBytes(input.deviceSigningPublicKey, 32, "certificate.deviceSigningPublicKey"),
    deviceEncryptionPublicKey: hexBytes(input.deviceEncryptionPublicKey, 32, "certificate.deviceEncryptionPublicKey"),
    issuedAt: safeInteger(input.issuedAt, "certificate.issuedAt"),
    expiresAt: safeInteger(input.expiresAt, "certificate.expiresAt"),
    capabilities: safeInteger(input.capabilities, "certificate.capabilities"),
    rootSignature: base64UrlBytes(input.rootSignature, "certificate.rootSignature", 64),
  };
}

export function revocationFromJson(value: unknown): Revocation {
  const input = record(value, "revocation");
  if (input.kind !== "device" && input.kind !== "ssh" && input.kind !== "passkey") {
    throw new WireError("Invalid revocation.kind");
  }
  if (typeof input.credentialId !== "string" || input.credentialId.length === 0 || input.credentialId.length > 256) {
    throw new WireError("Invalid revocation.credentialId");
  }
  return {
    accountId: hexBytes(input.accountId, 32, "revocation.accountId"),
    kind: input.kind,
    credentialId: input.credentialId,
    sequence: safeInteger(input.sequence, "revocation.sequence"),
    rootSignature: base64UrlBytes(input.rootSignature, "revocation.rootSignature", 64),
  };
}

export function eventFromJson(value: unknown): NexnetEvent {
  const input = record(value, "event");
  if (typeof input.eventType !== "string") throw new WireError("Invalid event.eventType");
  if (!Array.isArray(input.parentIds) || input.parentIds.length > 32) {
    throw new WireError("Invalid event.parentIds");
  }
  return {
    protocolVersion: safeInteger(input.protocolVersion, "event.protocolVersion"),
    eventType: input.eventType,
    eventId: hexBytes(input.eventId, 32, "event.eventId"),
    authorIdentityId: hexBytes(input.authorIdentityId, 32, "event.authorIdentityId"),
    authorDeviceId: hexBytes(input.authorDeviceId, 32, "event.authorDeviceId"),
    createdAt: safeInteger(input.createdAt, "event.createdAt"),
    sequence: safeInteger(input.sequence, "event.sequence"),
    parentIds: input.parentIds.map((id) => hexBytes(id, 32, "event.parentIds")),
    payload: base64UrlBytes(input.payload, "event.payload", 16_384),
    signature: base64UrlBytes(input.signature, "event.signature", 64),
  };
}

export interface ChannelPayload {
  channel: string;
  body: string;
}

export function decodeChannelPayload(payload: Uint8Array): ChannelPayload {
  let decoded: unknown;
  try {
    decoded = cdeDecode(payload);
  } catch {
    throw new WireError("Invalid payload");
  }
  const input = record(decoded, "payload");
  const keys = Object.keys(input);
  if (keys.length !== 2 || typeof input.channel !== "string" || typeof input.body !== "string") {
    throw new WireError("Invalid payload");
  }
  return { channel: input.channel, body: input.body };
}
