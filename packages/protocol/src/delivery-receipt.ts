import type { DeliveryReceipt, IdentityId } from "@nexnet/types";
import {
  IDENTITY_AUTH_MAX_SKEW_MS,
  identityProofFromJson,
  signIdentityAuthJson,
  verifyIdentityAuth,
  type IdentitySigner,
} from "./identity-auth.js";
import { fromHex, toHex } from "./wire.js";

/** JSON-safe v2 receipt; the existing identity-proof domain covers every field. */
export function signDeliveryReceipt(signer: IdentitySigner, receipt: DeliveryReceipt) {
  if (!signer.certificate) throw new Error("delivery receipts require a device certificate");
  return signIdentityAuthJson(signer, "dm.delivery_receipt", receipt.recipientIdentityId, {
    version: receipt.version,
    senderIdentityId: toHex(receipt.senderIdentityId),
    recipientIdentityId: toHex(receipt.recipientIdentityId),
    messageId: Array.from(receipt.messageId),
    recipientDeviceId: Array.from(receipt.recipientDeviceId),
    storedAt: receipt.storedAt,
  });
}

/** A root-only proof is insufficient: a particular certified recipient device must attest storage. */
export function verifyDeliveryReceipt(
  value: unknown,
  senderIdentityId: IdentityId,
  now = Date.now(),
): DeliveryReceipt | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { auth, ...fields } = value as Record<string, unknown>;
    const { version, recipientIdentityId, recipientDeviceId, messageId, storedAt } = fields;
    if (
      version !== 2 ||
      fields.senderIdentityId !== toHex(senderIdentityId) ||
      typeof recipientIdentityId !== "string" ||
      !/^[0-9a-f]{64}$/.test(recipientIdentityId) ||
      !isId(recipientDeviceId) ||
      !isId(messageId) ||
      typeof storedAt !== "number" ||
      !Number.isSafeInteger(storedAt) ||
      storedAt < 0 ||
      storedAt > now + IDENTITY_AUTH_MAX_SKEW_MS
    )
      return null;
    const proof = identityProofFromJson(auth);
    const certificate = proof.certificate;
    if (
      !certificate ||
      storedAt < certificate.issuedAt ||
      storedAt >= certificate.expiresAt ||
      !certificate.deviceId.every((byte, i) => byte === recipientDeviceId[i])
    )
      return null;
    const recipient = fromHex(recipientIdentityId);
    if (!verifyIdentityAuth(proof, "dm.delivery_receipt", recipient, fields, now)) return null;
    return {
      version,
      senderIdentityId,
      recipientIdentityId: recipient,
      messageId: new Uint8Array(messageId),
      recipientDeviceId: new Uint8Array(recipientDeviceId),
      storedAt,
    };
  } catch {
    return null;
  }
}

function isId(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 32 && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
}
