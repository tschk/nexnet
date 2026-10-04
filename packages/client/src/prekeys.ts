/**
 * @nexnet/client — prekey directory + local material registry
 *
 * In-process default. Swap with relay/presence fetch later.
 */

import type { CryptoProvider, IdentityId, PublicKey } from "@nexnet/types";
import { createLocalPrekeys, exportBundle, type LocalPrekeyMaterial, type PrekeyBundle } from "./x3dh.js";

function idHex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

/** Published bundles (identity hex → bundle). */
const published = new Map<string, PrekeyBundle>();

/** Local material for this device (identity hex → material). */
const localByIdentity = new Map<string, LocalPrekeyMaterial>();

export function publishBundle(identityId: IdentityId, bundle: PrekeyBundle): void {
  published.set(idHex(identityId), bundle);
}

export function fetchBundle(identityId: IdentityId): PrekeyBundle | undefined {
  return published.get(idHex(identityId));
}

export function unpublishBundle(identityId: IdentityId): void {
  published.delete(idHex(identityId));
}

export function clearPrekeyDirectory(): void {
  published.clear();
  localByIdentity.clear();
}

/**
 * Create local prekeys, store them, publish public bundle.
 * Returns material for X3DH respond path.
 */
export function setupLocalPrekeys(
  crypto: CryptoProvider,
  identityId: IdentityId,
  identitySignSecret: Uint8Array,
  identitySignPublic: PublicKey,
  oneTimeCount = 10,
): LocalPrekeyMaterial {
  const material = createLocalPrekeys(crypto, identitySignSecret, oneTimeCount);
  localByIdentity.set(idHex(identityId), material);
  publishBundle(identityId, exportBundle(material, identitySignPublic));
  return material;
}

export function getLocalPrekeys(identityId: IdentityId): LocalPrekeyMaterial | undefined {
  return localByIdentity.get(idHex(identityId));
}

/** Re-publish after OTP consumption (drops used OTP from public bundle). */
export function refreshPublishedBundle(identityId: IdentityId, identitySignPublic: PublicKey): void {
  const material = localByIdentity.get(idHex(identityId));
  if (!material) return;
  publishBundle(identityId, exportBundle(material, identitySignPublic));
}
