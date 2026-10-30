import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { cryptoProvider, generateKeyPair, generateSigningKeyPair, randomBytes } from "@nexnet/crypto";
import { cdeDecode, cdeEncode, identityIdFromWallet, issueDeviceCert, verifyDeviceCert } from "@nexnet/protocol";
import type { DeviceCertificate } from "@nexnet/types";
import { NexnetClient } from "../client.js";
import { DEVICE_CERT_LIFETIME_MS, type DeviceCertificateRenewer } from "../device-lifecycle.js";
import { setupLocalPrekeys } from "../prekeys.js";

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

function device(override?: (sign: DeviceCertificateRenewer, rootSecretKey: Uint8Array) => DeviceCertificateRenewer) {
  const root = generateSigningKeyPair();
  const key = generateSigningKeyPair();
  const sign: DeviceCertificateRenewer = async (cert, now) =>
    issueDeviceCert(
      root.secretKey,
      cert.deviceSigningPublicKey,
      cert.deviceEncryptionPublicKey,
      cert.deviceId,
      cert.accountId,
      now,
      now + DEVICE_CERT_LIFETIME_MS,
      cert.capabilities,
    );
  const certificate = issueDeviceCert(
    root.secretKey,
    key.publicKey,
    generateKeyPair().publicKey,
    randomBytes(32),
    identityIdFromWallet(root.publicKey),
    Date.now(),
    Date.now() + DEVICE_CERT_LIFETIME_MS,
    1,
  );
  const config = {
    identityId: certificate.accountId,
    deviceId: certificate.deviceId,
    crypto: cryptoProvider,
    codec: { encode: cdeEncode, decode: cdeDecode },
    relayUrl: "ws://127.0.0.1:1",
    storagePath: "",
    signingSecretKey: key.secretKey,
    rootPublicKey: root.publicKey,
    deviceSigningSecretKey: key.secretKey,
    deviceSigningPublicKey: key.publicKey,
    deviceCertificate: certificate,
    renewDeviceCertificate: override ? override(sign, root.secretKey) : sign,
  };
  return { client: new NexnetClient(config), config, certificate };
}

test("renewal begins at 80% lifetime, not before, and preserves certified device keys", async () => {
  const { client, certificate } = device();
  const threshold = certificate.expiresAt - DEVICE_CERT_LIFETIME_MS / 5;
  setSystemTime(new Date(threshold - 1));
  await client.ensureDeviceCertificate();
  expect(client.deviceCertificate).toBe(certificate);
  setSystemTime(new Date(threshold));
  await client.ensureDeviceCertificate();
  expect(client.deviceCertificate).toMatchObject({
    issuedAt: threshold,
    expiresAt: threshold + 11 * 60 * 60 * 1000,
    deviceSigningPublicKey: certificate.deviceSigningPublicKey,
    deviceEncryptionPublicKey: certificate.deviceEncryptionPublicKey,
  });
  expect(verifyDeviceCert(client.deviceCertificate!, client.rootPublicKey!)).toBe(true);
});

test("accepts a certificate issued after the renewal request but before the signer response arrives", async () => {
  const { client, certificate } = device((sign) => async (cert, now) => {
    setSystemTime(new Date(now + 1000));
    return sign(cert, Date.now());
  });
  setSystemTime(new Date(certificate.expiresAt - 1000));
  await client.ensureDeviceCertificate();
  expect(client.deviceCertificate!.issuedAt).toBe(certificate.expiresAt);
});

test("concurrent callers share renewal and disconnect discards an in-flight signer response", async () => {
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  const { client, certificate } = device((sign) => async (cert, now) => {
    requests++;
    await gate.promise;
    return sign(cert, now);
  });
  setSystemTime(new Date(certificate.expiresAt));
  const first = client.ensureDeviceCertificate().catch((error: unknown) => error);
  const second = client.ensureDeviceCertificate().catch((error: unknown) => error);
  expect(requests).toBe(1);
  await client.disconnect();
  gate.resolve();
  for (const error of await Promise.all([first, second])) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toContain("cancelled by disconnect");
  }
  expect(client.deviceCertificate).toBe(certificate);
  await client.ensureDeviceCertificate();
  expect(client.deviceCertificate!.expiresAt).toBeGreaterThan(certificate.expiresAt);
});

test("a late signer response from an abandoned connect cannot disconnect its replacement", async () => {
  const gate = Promise.withResolvers<void>();
  let first = true;
  const { config, certificate } = device((sign) => async (cert, now) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    return sign(cert, now);
  });
  const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
  const { createRelay } = await import(RELAY_MODULE);
  const relay = createRelay().listen({ hostname: "127.0.0.1", port: 0 });
  const client = new NexnetClient({ ...config, relayUrl: `ws://127.0.0.1:${relay.server!.port}` });
  setSystemTime(new Date(certificate.expiresAt - 1000));
  const abandoned = client.connect().catch((error: unknown) => error);
  try {
    await client.disconnect();
    await client.connect();
    expect(client.online).toBe(true);
    gate.resolve();
    expect(await abandoned).toBeInstanceOf(Error);
    expect(client.online).toBe(true);
  } finally {
    gate.resolve();
    await abandoned;
    await client.disconnect();
    relay.stop(true);
  }
});

test.each([
  "principal",
  "device",
  "signing key",
  "encryption key",
  "capabilities",
  "too long",
  "future",
  "expired",
  "signature",
])("rejects a renewal that changes %s", async (change) => {
  const { client, certificate } = device((sign, rootSecretKey) => async (cert, now) => {
    const candidate: DeviceCertificate = {
      ...cert,
      ...(change === "principal" ? { accountId: randomBytes(32) } : {}),
      ...(change === "device" ? { deviceId: randomBytes(32) } : {}),
      ...(change === "signing key" ? { deviceSigningPublicKey: generateSigningKeyPair().publicKey } : {}),
      ...(change === "encryption key" ? { deviceEncryptionPublicKey: generateKeyPair().publicKey } : {}),
      ...(change === "capabilities" ? { capabilities: 255 } : {}),
    };
    const signed = await sign(candidate, now);
    if (change === "too long") signed.expiresAt++;
    if (change === "future") signed.issuedAt = now + 1;
    if (change === "expired") signed.expiresAt = now;
    // Except for the explicit bad-signature case these are genuine root-signed
    // certificates, so signature verification alone cannot pass this test.
    const result = issueDeviceCert(
      rootSecretKey,
      signed.deviceSigningPublicKey,
      signed.deviceEncryptionPublicKey,
      signed.deviceId,
      signed.accountId,
      signed.issuedAt,
      signed.expiresAt,
      signed.capabilities,
    );
    if (change === "signature") result.rootSignature = new Uint8Array(64);
    return result;
  });
  setSystemTime(new Date(certificate.expiresAt - 1000));
  await expect(client.ensureDeviceCertificate()).rejects.toThrow("invalid renewal");
  expect(client.deviceCertificate).toBe(certificate);
});

test("an unavailable signer disconnects an authenticated headless client at expiry", async () => {
  const { config, certificate } = device(() => async () => {
    throw new Error("principal signer unavailable");
  });
  const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
  const { createRelay } = await import(RELAY_MODULE);
  const relay = createRelay().listen({ hostname: "127.0.0.1", port: 0 });
  const connected = new NexnetClient({
    ...config,
    relayUrl: `ws://127.0.0.1:${relay.server!.port}`,
  });
  const failures: unknown[] = [];
  connected.on("auth_failed", (failure) => failures.push(failure));
  try {
    await connected.connect();
    expect(connected.online).toBe(true);
    setSystemTime(new Date(certificate.expiresAt));
    await expect(connected.ensureDeviceCertificate()).rejects.toThrow("principal signer unavailable");
    expect(connected.online).toBe(false);
    expect(failures).toEqual([{ message: "device certificate expired: principal signer unavailable" }]);
    await expect(connected.connect()).rejects.toThrow("principal signer unavailable");
  } finally {
    await connected.disconnect();
    relay.stop(true);
  }
});

test("a stalled signer times out rather than blocking every future send", async () => {
  jest.useFakeTimers();
  const { client, certificate } = device(() => () => new Promise(() => {}));
  setSystemTime(new Date(certificate.expiresAt));
  const failure = client.ensureDeviceCertificate().catch((error: unknown) => error);
  jest.advanceTimersByTime(15_000);
  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message).toContain("signer timed out");
  expect(client.online).toBe(false);
});

test("an idle connected client renews on its timer and disconnect stops renewal", async () => {
  jest.useFakeTimers();
  const requested = Promise.withResolvers<void>();
  const { config, certificate } = device((sign) => async (cert, now) => {
    requested.resolve();
    return sign(cert, now);
  });
  const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
  const { createRelay } = await import(RELAY_MODULE);
  const relay = createRelay().listen({ hostname: "127.0.0.1", port: 0 });
  const client = new NexnetClient({ ...config, relayUrl: `ws://127.0.0.1:${relay.server!.port}` });
  try {
    await client.connect();
    setSystemTime(new Date(certificate.expiresAt - DEVICE_CERT_LIFETIME_MS / 5));
    jest.advanceTimersByTime(60_000);
    await requested.promise;
    await client.ensureDeviceCertificate();
    expect(client.deviceCertificate!.expiresAt).toBeGreaterThan(certificate.expiresAt);
    const renewed = client.deviceCertificate;
    await client.disconnect();
    setSystemTime(new Date(renewed!.expiresAt));
    jest.advanceTimersByTime(60_000);
    expect(client.deviceCertificate).toBe(renewed);
  } finally {
    await client.disconnect();
    jest.useRealTimers();
    relay.stop(true);
  }
});

test("a failed renewed prekey publication is retried even though the new certificate is valid", async () => {
  let publications = 0;
  let reject = true;
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      publications++;
      return new Response("", { status: reject ? 401 : 200 });
    },
  });
  const { config, certificate } = device();
  const client = new NexnetClient({ ...config, presenceUrl: `http://127.0.0.1:${service.port}` });
  setupLocalPrekeys(client.crypto, client.identityId, config.deviceSigningSecretKey, config.deviceSigningPublicKey);
  try {
    setSystemTime(new Date(certificate.expiresAt - 1000));
    await expect(client.ensureDeviceCertificate()).rejects.toThrow("401");
    expect(client.deviceCertificate!.expiresAt).toBeGreaterThan(certificate.expiresAt);
    reject = false;
    await client.ensureDeviceCertificate();
    expect(publications).toBe(2);
    await client.ensureDeviceCertificate();
    expect(publications).toBe(2);
  } finally {
    service.stop(true);
    await client.disconnect();
  }
});
