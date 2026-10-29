/**
 * Proof of possession for identity-scoped service operations.
 *
 * An identity id is `identityIdFromWallet(rootPublicKey)`, so a proof is
 * self-certifying: it carries the root public key and a signature by either
 * the root key itself or a device key with a root-signed certificate. Relays
 * and services verify a proof against the operation, the claimed identity and
 * the exact request fields before acting on that identity's behalf.
 */
import type { DeviceCertificate, IdentityId, PublicKey, Signature } from "@nexnet/types";
import { sign, verify } from "@nexnet/crypto";
import { cdeEncode } from "./cde.js";
import { identityIdFromWallet } from "./credentials.js";
import { verifyDeviceCert } from "./device-cert.js";
import { certificateToJson, fromBase64Url, fromHex, toBase64Url, toHex } from "./wire.js";

const IDENTITY_AUTH_DOMAIN = "nexnet identity auth v1";

/** Maximum clock skew accepted for a signed request's `issuedAt`. */
export const IDENTITY_AUTH_MAX_SKEW_MS = 5 * 60_000;

export interface IdentityProof {
  rootPublicKey: PublicKey;
  /** Present when a device key, not the root key, produced the signature. */
  certificate?: DeviceCertificate;
  signature: Signature;
}

export interface IdentitySigner {
  rootPublicKey: PublicKey;
  /** Root secret key, or the device secret key when `certificate` is set. */
  secretKey: Uint8Array;
  certificate?: DeviceCertificate;
}

export interface IdentityProofJson {
  rootPublicKey: string;
  certificate?: ReturnType<typeof certificateToJson>;
  signature: string;
}

export interface VerifiedIdentity {
  /** Device id from the certificate; null for a root-key signature. */
  deviceId: Uint8Array | null;
}

export function identityAuthPreimage(operation: string, identityId: IdentityId, fields: unknown): Uint8Array {
  return cdeEncode({ domain: IDENTITY_AUTH_DOMAIN, operation, identityId, fields });
}

export function signIdentityAuth(
  signer: IdentitySigner,
  operation: string,
  identityId: IdentityId,
  fields: unknown,
): IdentityProof {
  return {
    rootPublicKey: signer.rootPublicKey,
    ...(signer.certificate ? { certificate: signer.certificate } : {}),
    signature: sign(signer.secretKey, identityAuthPreimage(operation, identityId, fields)),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Verify that `proof` was produced by the holder of `identityId`'s root key or
 * of a currently valid device certificate issued by it. Returns null on any
 * mismatch. Callers enforce freshness of fields such as `issuedAt` or nonces.
 */
export function verifyIdentityAuth(
  proof: IdentityProof,
  operation: string,
  identityId: IdentityId,
  fields: unknown,
  now: number = Date.now(),
): VerifiedIdentity | null {
  try {
    if (identityId.length !== 32 || !sameBytes(identityIdFromWallet(proof.rootPublicKey), identityId)) return null;
    let signingKey = proof.rootPublicKey;
    let deviceId: Uint8Array | null = null;
    const cert = proof.certificate;
    if (cert) {
      if (!sameBytes(cert.accountId, identityId) || cert.issuedAt > now || cert.expiresAt <= now) return null;
      if (!verifyDeviceCert(cert, proof.rootPublicKey)) return null;
      signingKey = cert.deviceSigningPublicKey;
      deviceId = cert.deviceId;
    }
    if (!verify(signingKey, identityAuthPreimage(operation, identityId, fields), proof.signature)) return null;
    return { deviceId };
  } catch {
    return null;
  }
}

/** True when `issuedAt` is an integer timestamp within the accepted clock skew. */
export function isFreshIssuedAt(issuedAt: unknown, now: number = Date.now()): issuedAt is number {
  return (
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    Math.abs(now - issuedAt) <= IDENTITY_AUTH_MAX_SKEW_MS
  );
}

export function identityProofToJson(proof: IdentityProof): IdentityProofJson {
  return {
    rootPublicKey: toHex(proof.rootPublicKey),
    ...(proof.certificate ? { certificate: certificateToJson(proof.certificate) } : {}),
    signature: toBase64Url(proof.signature),
  };
}

function hexField(value: unknown, length: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2) throw new Error(`Invalid ${field}`);
  return fromHex(value);
}

function intField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function signatureField(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) throw new Error(`Invalid ${field}`);
  return fromBase64Url(value);
}

/** Parse a JSON proof. Throws on malformed input; does not verify. */
export function identityProofFromJson(value: unknown): IdentityProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid auth");
  const input = value as Record<string, unknown>;
  const proof: IdentityProof = {
    rootPublicKey: hexField(input.rootPublicKey, 32, "auth.rootPublicKey"),
    signature: signatureField(input.signature, "auth.signature"),
  };
  if (input.certificate !== undefined) {
    if (typeof input.certificate !== "object" || input.certificate === null) throw new Error("Invalid certificate");
    const cert = input.certificate as Record<string, unknown>;
    proof.certificate = {
      accountId: hexField(cert.accountId, 32, "certificate.accountId"),
      deviceId: hexField(cert.deviceId, 32, "certificate.deviceId"),
      deviceSigningPublicKey: hexField(cert.deviceSigningPublicKey, 32, "certificate.deviceSigningPublicKey"),
      deviceEncryptionPublicKey: hexField(cert.deviceEncryptionPublicKey, 32, "certificate.deviceEncryptionPublicKey"),
      issuedAt: intField(cert.issuedAt, "certificate.issuedAt"),
      expiresAt: intField(cert.expiresAt, "certificate.expiresAt"),
      capabilities: intField(cert.capabilities, "certificate.capabilities"),
      rootSignature: signatureField(cert.rootSignature, "certificate.rootSignature"),
    };
  }
  return proof;
}

/**
 * Verify a JSON request body of the form `{ ...fields, auth }` for the given
 * operation and hex identity id. The signed fields are the body without
 * `auth`, so every field the service acts on is covered by the signature.
 */
export function verifyIdentityAuthJson(
  body: Record<string, unknown>,
  operation: string,
  identityHex: unknown,
  now: number = Date.now(),
): VerifiedIdentity | null {
  try {
    if (typeof identityHex !== "string" || identityHex.length !== 64) return null;
    const { auth, ...fields } = body;
    return verifyIdentityAuth(identityProofFromJson(auth), operation, fromHex(identityHex), fields, now);
  } catch {
    return null;
  }
}

/** Sign a JSON request body; `fields` must be JSON-safe (undefined is dropped). */
export function signIdentityAuthJson<T extends Record<string, unknown>>(
  signer: IdentitySigner,
  operation: string,
  identityId: IdentityId,
  fields: T,
): T & { auth: IdentityProofJson } {
  const normalized = JSON.parse(JSON.stringify(fields)) as T;
  return { ...normalized, auth: identityProofToJson(signIdentityAuth(signer, operation, identityId, normalized)) };
}
