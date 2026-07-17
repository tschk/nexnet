/**
 * Device certificates (AD-6)
 *
 * A root identity issues a certificate binding a device's signing
 * and encryption public keys to a time window and capability set.
 */
import type { DeviceCertificate, IdentityId, PublicKey, Signature } from "@nettle/types";
import { sign, verify } from "@nettle/crypto";
import { cdeEncode } from "./cde.js";

/** Fields to sign in a device certificate (everything except rootSignature). */
interface DeviceCertPreimage {
  accountId: IdentityId;
  deviceId: DeviceCertificate["deviceId"];
  deviceSigningPublicKey: PublicKey;
  deviceEncryptionPublicKey: PublicKey;
  issuedAt: number;
  expiresAt: number;
  capabilities: number;
}

/** Issue a device certificate signed by the root identity key. */
export function issueDeviceCert(
  rootSk: Uint8Array,
  devicePk: PublicKey,
  deviceEncryptionPk: PublicKey,
  deviceId: DeviceCertificate["deviceId"],
  accountId: IdentityId,
  issuedAt: number,
  expiresAt: number,
  capabilities: number
): DeviceCertificate {
  const preimage: DeviceCertPreimage = {
    accountId,
    deviceId,
    deviceSigningPublicKey: devicePk,
    deviceEncryptionPublicKey: deviceEncryptionPk,
    issuedAt,
    expiresAt,
    capabilities,
  };
  const rootSignature = sign(rootSk, cdeEncode(preimage));
  return {
    ...preimage,
    rootSignature,
  };
}

/** Verify a device certificate was signed by the given root public key. */
export function verifyDeviceCert(
  cert: DeviceCertificate,
  rootPk: PublicKey
): boolean {
  const preimage: DeviceCertPreimage = {
    accountId: cert.accountId,
    deviceId: cert.deviceId,
    deviceSigningPublicKey: cert.deviceSigningPublicKey,
    deviceEncryptionPublicKey: cert.deviceEncryptionPublicKey,
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    capabilities: cert.capabilities,
  };
  return verify(rootPk, cdeEncode(preimage), cert.rootSignature);
}
