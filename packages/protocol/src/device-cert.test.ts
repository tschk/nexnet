import { describe, test, expect } from "bun:test";
import {
  authorizePasskeyCredential,
  issueDeviceCert,
  verifyDeviceCert,
  verifyPasskeyCredentialAuthorization,
} from "./device-cert.js";
import { generateSigningKeyPair } from "@nexnet/crypto";

describe("DeviceCertificate", () => {
  const root = generateSigningKeyPair();
  const deviceSigning = generateSigningKeyPair();
  const deviceEncryption = generateSigningKeyPair();
  const accountId = new Uint8Array(32).fill(0xaa);
  const deviceId = new Uint8Array(32).fill(0xbb);
  const now = Date.now();

  test("roundtrip: issue then verify succeeds", () => {
    const cert = issueDeviceCert(
      root.secretKey,
      deviceSigning.publicKey,
      deviceEncryption.publicKey,
      deviceId,
      accountId,
      now,
      now + 86_400_000,
      0xff
    );
    expect(verifyDeviceCert(cert, root.publicKey)).toBe(true);
  });

  test("wrong root key fails verification", () => {
    const otherRoot = generateSigningKeyPair();
    const cert = issueDeviceCert(
      root.secretKey,
      deviceSigning.publicKey,
      deviceEncryption.publicKey,
      deviceId,
      accountId,
      now,
      now + 86_400_000,
      0xff
    );
    expect(verifyDeviceCert(cert, otherRoot.publicKey)).toBe(false);
  });

  test("tampered cert fails verification", () => {
    const cert = issueDeviceCert(
      root.secretKey,
      deviceSigning.publicKey,
      deviceEncryption.publicKey,
      deviceId,
      accountId,
      now,
      now + 86_400_000,
      0xff
    );
    cert.capabilities = 0x00;
    expect(verifyDeviceCert(cert, root.publicKey)).toBe(false);
  });

  test("cert contains correct fields", () => {
    const cert = issueDeviceCert(
      root.secretKey,
      deviceSigning.publicKey,
      deviceEncryption.publicKey,
      deviceId,
      accountId,
      now,
      now + 86_400_000,
      0xff
    );
    expect(cert.accountId).toEqual(accountId);
    expect(cert.deviceId).toEqual(deviceId);
    expect(cert.capabilities).toBe(0xff);
    expect(cert.rootSignature.length).toBe(64);
  });

  test("root authorizes an immutable passkey commitment", () => {
    const credential = {
      credentialId: "credential-id",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      rpId: "nexnet.example",
      origin: "https://nexnet.example",
    };
    const signature = authorizePasskeyCredential(root.secretKey, accountId, credential);
    expect(verifyPasskeyCredentialAuthorization(root.publicKey, accountId, credential, signature)).toBe(true);
    expect(
      verifyPasskeyCredentialAuthorization(
        root.publicKey,
        accountId,
        { ...credential, rpId: "other.example" },
        signature
      )
    ).toBe(false);
  });
});
