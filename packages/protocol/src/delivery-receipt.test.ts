import { expect, test } from "bun:test";
import { publicKeyFromSecret } from "@nexnet/crypto";
import type { DeliveryReceipt } from "@nexnet/types";
import { identityIdFromWallet } from "./credentials.js";
import { issueDeviceCert } from "./device-cert.js";
import { signIdentityAuthJson } from "./identity-auth.js";
import { signDeliveryReceipt, verifyDeliveryReceipt } from "./delivery-receipt.js";

const now = 1_800_000_000_000;
const rootSecret = new Uint8Array(32).fill(1);
const secretKey = new Uint8Array(32).fill(2);
const rootPublicKey = publicKeyFromSecret(rootSecret);
const recipientIdentityId = identityIdFromWallet(rootPublicKey);
const senderIdentityId = identityIdFromWallet(publicKeyFromSecret(new Uint8Array(32).fill(4)));
const recipientDeviceId = new Uint8Array(32).fill(3);
const certificate = issueDeviceCert(
  rootSecret,
  publicKeyFromSecret(secretKey),
  new Uint8Array(32).fill(6),
  recipientDeviceId,
  recipientIdentityId,
  now - 1000,
  now + 11 * 60 * 60 * 1000,
  1,
);
const signer = { rootPublicKey, secretKey, certificate };
const receipt: DeliveryReceipt = {
  version: 2,
  senderIdentityId,
  recipientIdentityId,
  messageId: new Uint8Array(32).fill(5),
  recipientDeviceId,
  storedAt: now,
};

test("device receipt v2 matches the existing identity-auth domain vector", () => {
  const signed = signDeliveryReceipt(signer, receipt);
  expect(signed.auth.signature).toBe(
    "uKMjBf6FPHGvQVaHsQ3XTexlXcLr3OKk3_soS7PRAX-Wa6PEhmqXL-g2-9M0qwI9GW79Pc7ZL182n9GX-asICA",
  );
  expect(verifyDeliveryReceipt(JSON.parse(JSON.stringify(signed)), senderIdentityId, now)).toEqual(receipt);
  expect(verifyDeliveryReceipt(signed, recipientIdentityId, now)).toBeNull();
  expect(verifyDeliveryReceipt(signed, senderIdentityId, certificate.expiresAt)).toBeNull();
  expect(verifyDeliveryReceipt(signed, senderIdentityId, certificate.issuedAt - 1)).toBeNull();
});

test("root-only proofs and proofs for other operations are not device receipts", () => {
  const { auth: _, ...fields } = signDeliveryReceipt(signer, receipt);
  const rootOnly = signIdentityAuthJson(
    { rootPublicKey, secretKey: rootSecret },
    "dm.delivery_receipt",
    recipientIdentityId,
    fields,
  );
  const otherOperation = signIdentityAuthJson(signer, "prekeys.publish", recipientIdentityId, fields);
  expect(verifyDeliveryReceipt(rootOnly, senderIdentityId, now)).toBeNull();
  expect(verifyDeliveryReceipt(otherOperation, senderIdentityId, now)).toBeNull();
  expect(() => signDeliveryReceipt({ rootPublicKey, secretKey: rootSecret }, receipt)).toThrow("device certificate");
});

test.each([
  ["version", 1],
  ["senderIdentityId", "ab".repeat(32)],
  ["recipientIdentityId", "cd".repeat(32)],
  ["recipientDeviceId", Array.from(new Uint8Array(32).fill(9))],
  ["storedAt", certificate.issuedAt - 1],
  ["storedAt", certificate.expiresAt],
  ["storedAt", now + 5 * 60_000 + 1],
  ["storedAt", -1],
  ["storedAt", 1.5],
  ["messageId", Array.from({ length: 31 }, () => 5)],
  ["messageId", Array.from({ length: 33 }, () => 5)],
  ["messageId", Array.from({ length: 32 }, () => 256)],
  ["messageId", Array.from({ length: 32 }, () => -1)],
  ["messageId", Array.from({ length: 32 }, () => "5")],
])("rejects invalid signed field %s = %j", (field, value) => {
  const { auth: _, ...fields } = signDeliveryReceipt(signer, receipt);
  const signed = signIdentityAuthJson(signer, "dm.delivery_receipt", recipientIdentityId, {
    ...fields,
    [field]: value,
  });
  expect(verifyDeliveryReceipt(signed, senderIdentityId, now)).toBeNull();
});

test("tampering with a receipt or its root-certified device cannot authenticate it", () => {
  const signed = signDeliveryReceipt(signer, receipt);
  expect(
    verifyDeliveryReceipt({ ...signed, messageId: Array.from({ length: 32 }, () => 7) }, senderIdentityId, now),
  ).toBeNull();
  const forged = structuredClone(signed);
  if (!forged.auth.certificate) throw new Error("missing fixture certificate");
  forged.auth.certificate.deviceSigningPublicKey = "ab".repeat(32);
  expect(verifyDeliveryReceipt(forged, senderIdentityId, now)).toBeNull();
  const swapped = signDeliveryReceipt({ ...signer, secretKey: new Uint8Array(32).fill(9) }, receipt);
  expect(verifyDeliveryReceipt(swapped, senderIdentityId, now)).toBeNull();
});

test.each(
  [null, undefined, 3, "receipt", [], {}, { signature: Array.from({ length: 64 }, () => 0) }].map((value) => [value]),
)("malformed or legacy receipt %j is unproven", (input) =>
  expect(verifyDeliveryReceipt(input, senderIdentityId, now)).toBeNull(),
);
