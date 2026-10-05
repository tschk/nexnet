import type { DeviceCertificate, NexnetEvent, Revocation } from "@nexnet/types";

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error("Invalid hex");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

export function certificateToJson(certificate: DeviceCertificate) {
  return {
    accountId: toHex(certificate.accountId),
    deviceId: toHex(certificate.deviceId),
    deviceSigningPublicKey: toHex(certificate.deviceSigningPublicKey),
    deviceEncryptionPublicKey: toHex(certificate.deviceEncryptionPublicKey),
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
    capabilities: certificate.capabilities,
    rootSignature: toBase64Url(certificate.rootSignature),
  };
}

export function revocationToJson(revocation: Revocation) {
  return {
    accountId: toHex(revocation.accountId),
    kind: revocation.kind,
    credentialId: revocation.credentialId,
    sequence: revocation.sequence,
    rootSignature: toBase64Url(revocation.rootSignature),
  };
}

export function eventToJson(event: NexnetEvent) {
  return {
    protocolVersion: event.protocolVersion,
    eventType: event.eventType,
    eventId: toHex(event.eventId),
    authorIdentityId: toHex(event.authorIdentityId),
    authorDeviceId: toHex(event.authorDeviceId),
    createdAt: event.createdAt,
    sequence: event.sequence,
    parentIds: event.parentIds.map(toHex),
    payload: toBase64Url(event.payload),
    signature: toBase64Url(event.signature),
  };
}
