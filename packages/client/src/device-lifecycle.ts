import type { DeviceCertificate } from "@nexnet/types";
import { verifyDeviceCert } from "@nexnet/protocol";
import type { NexnetClient } from "./client.js";
import { fetchBundle } from "./prekeys.js";
import { publishBundleRemote } from "./prekey-network.js";

export const DEVICE_CERT_LIFETIME_MS = 11 * 60 * 60 * 1000;
const RENEW_BEFORE_EXPIRY_MS = DEVICE_CERT_LIFETIME_MS / 5;
const RENEW_CHECK_INTERVAL_MS = 60_000;

/** The caller owns signing authority; the client receives only a certificate. */
export type DeviceCertificateRenewer = (certificate: DeviceCertificate, now: number) => Promise<DeviceCertificate>;

/** Process-local lifecycle only. Persistence and delegated grants are separate concerns. */
export class DeviceCertificateLifecycle {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private needsPublish = false;

  constructor(
    private readonly client: NexnetClient,
    private readonly renew: DeviceCertificateRenewer,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // ensure() emits the failure; never leave a rejected timer promise unhandled.
      void this.ensure(Date.now()).catch(() => {});
    }, RENEW_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.pending = null;
  }

  ensure(now: number): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.update(now).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async requestRenewal(certificate: DeviceCertificate, now: number): Promise<DeviceCertificate> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.renew(structuredClone(certificate), now),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("device certificate signer timed out")), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async update(now: number): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    let stage = "device_certificate_renewal_failed";
    try {
      const previous = client.deviceCertificate;
      if (!previous || !client.rootPublicKey || !client.deviceSigningSecretKey || !client.deviceSigningPublicKey) {
        throw new Error("certificate renewal requires certified device credentials and the principal public key");
      }
      if (previous.expiresAt - now <= RENEW_BEFORE_EXPIRY_MS) {
        const renewed = await this.requestRenewal(previous, now);
        if (generation !== this.generation) throw new Error("certificate renewal cancelled by disconnect");
        const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
        if (
          !same(renewed.accountId, previous.accountId) ||
          !same(renewed.deviceId, previous.deviceId) ||
          !same(renewed.deviceSigningPublicKey, previous.deviceSigningPublicKey) ||
          !same(renewed.deviceEncryptionPublicKey, previous.deviceEncryptionPublicKey) ||
          renewed.capabilities !== previous.capabilities ||
          !Number.isSafeInteger(renewed.issuedAt) ||
          !Number.isSafeInteger(renewed.expiresAt) ||
          renewed.issuedAt > now ||
          renewed.expiresAt <= Math.max(now, Date.now()) ||
          renewed.expiresAt - renewed.issuedAt > DEVICE_CERT_LIFETIME_MS ||
          !verifyDeviceCert(renewed, client.rootPublicKey)
        ) {
          throw new Error("signer returned an invalid renewal or changed device authority");
        }
        client.setDeviceCredentials(renewed, client.deviceSigningSecretKey, client.deviceSigningPublicKey);
        this.needsPublish = true;
      }
      if (this.needsPublish) {
        const bundle = fetchBundle(client.identityId);
        if (client.presenceUrl && bundle) {
          stage = "prekey_publish_failed";
          await publishBundleRemote(client.presenceUrl, client.identityId, bundle, client.identitySigner());
        }
        // On failure this stays true, so a valid new certificate cannot hide a
        // failed publication until the next 11-hour renewal window.
        this.needsPublish = false;
      }
    } catch (error) {
      if (generation !== this.generation) throw error;
      const message = error instanceof Error ? error.message : "device certificate renewal failed";
      client.emit("error", { type: stage, message });
      if (client.deviceCertificateExpired()) {
        void client.disconnect();
        client.emit("auth_failed", { message: `device certificate expired: ${message}` });
      }
      throw error;
    }
  }
}
