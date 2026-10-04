/**
 * @nexnet/client — publish/fetch prekey bundles via presence service
 *
 * HTTP: POST /prekeys/publish, GET /prekeys/:identityId
 * On fetch success, also caches into local prekey directory.
 */

import type { IdentityId } from "@nexnet/types";
import type { PrekeyBundle } from "./x3dh.js";
import { publishBundle } from "./prekeys.js";

export interface NetworkPrekeyBundle {
  identityId: string;
  identityDhPublic: string;
  signedPrekeyPublic: string;
  signedPrekeySig: string;
  identitySignPublic: string;
  oneTimePrekeyPublic?: string;
  oneTimePrekeyId?: number;
  updatedAt?: number;
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function fromHex(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h, "hex"));
}

export function bundleToNetwork(identityId: IdentityId, bundle: PrekeyBundle): NetworkPrekeyBundle {
  return {
    identityId: toHex(identityId),
    identityDhPublic: toHex(bundle.identityDhPublic),
    signedPrekeyPublic: toHex(bundle.signedPrekeyPublic),
    signedPrekeySig: toHex(bundle.signedPrekeySig),
    identitySignPublic: toHex(bundle.identitySignPublic),
    oneTimePrekeyPublic: bundle.oneTimePrekeyPublic ? toHex(bundle.oneTimePrekeyPublic) : undefined,
    oneTimePrekeyId: bundle.oneTimePrekeyId,
  };
}

export function bundleFromNetwork(raw: NetworkPrekeyBundle): PrekeyBundle {
  return {
    identityDhPublic: fromHex(raw.identityDhPublic),
    signedPrekeyPublic: fromHex(raw.signedPrekeyPublic),
    signedPrekeySig: fromHex(raw.signedPrekeySig),
    identitySignPublic: fromHex(raw.identitySignPublic),
    oneTimePrekeyPublic: raw.oneTimePrekeyPublic ? fromHex(raw.oneTimePrekeyPublic) : undefined,
    oneTimePrekeyId: raw.oneTimePrekeyId,
  };
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/** POST public bundle to presence worker. */
export async function publishBundleRemote(
  presenceBaseUrl: string,
  identityId: IdentityId,
  bundle: PrekeyBundle,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = bundleToNetwork(identityId, bundle);
  const resp = await fetchImpl(`${trimBase(presenceBaseUrl)}/prekeys/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`prekey publish failed: ${resp.status} ${text}`);
  }
  // Keep local directory in sync
  publishBundle(identityId, bundle);
}

/**
 * GET peer bundle from presence. Caches into local directory on success.
 * Returns null on 404.
 */
export async function fetchBundleRemote(
  presenceBaseUrl: string,
  peerIdentityId: IdentityId,
  fetchImpl: typeof fetch = fetch,
): Promise<PrekeyBundle | null> {
  const idHex = toHex(peerIdentityId);
  const resp = await fetchImpl(`${trimBase(presenceBaseUrl)}/prekeys/${encodeURIComponent(idHex)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`prekey fetch failed: ${resp.status} ${text}`);
  }
  const raw = (await resp.json()) as NetworkPrekeyBundle;
  const bundle = bundleFromNetwork(raw);
  publishBundle(peerIdentityId, bundle);
  return bundle;
}

export async function removeBundleRemote(
  presenceBaseUrl: string,
  identityId: IdentityId,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const idHex = toHex(identityId);
  const resp = await fetchImpl(`${trimBase(presenceBaseUrl)}/prekeys/${encodeURIComponent(idHex)}`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`prekey remove failed: ${resp.status}`);
  }
}
