/**
 * @nexnet/client — publish/fetch prekey bundles via presence service
 *
 * HTTP: POST /prekeys/publish, GET /prekeys/:identityId, DELETE /prekeys/:identityId
 * Publish and delete carry an identity proof; fetched bundles are re-verified
 * against the requested identity so a presence server cannot swap them.
 * On fetch success, also caches into local prekey directory.
 */

import type { IdentityId } from "@nexnet/types";
import {
  identityProofFromJson,
  signIdentityAuthJson,
  verifyIdentityAuthJson,
  type IdentitySigner,
} from "@nexnet/protocol";
import type { NexnetClient } from "./client.js";
import { exportBundle, type PrekeyBundle } from "./x3dh.js";
import { publishBundle, setupLocalPrekeys } from "./prekeys.js";

/** Root public keys proven by a fetched bundle's identity proof (identity hex → key). */
const verifiedRootKeys = new Map<string, Uint8Array>();

/** Root public key of `identityId`, if a verified bundle for it has been fetched. */
export function verifiedRootPublicKey(identityId: IdentityId): Uint8Array | undefined {
  return verifiedRootKeys.get(toHex(identityId));
}

let lastIssuedAt = 0;
/** Strictly increasing timestamp; services reject a repeated or older issuedAt. */
function nextIssuedAt(): number {
  lastIssuedAt = Math.max(Date.now(), lastIssuedAt + 1);
  return lastIssuedAt;
}

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

/** POST public bundle to presence worker, signed by the identity. */
export async function publishBundleRemote(
  presenceBaseUrl: string,
  identityId: IdentityId,
  bundle: PrekeyBundle,
  signer: IdentitySigner,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = signIdentityAuthJson(signer, "prekeys.publish", identityId, {
    ...bundleToNetwork(identityId, bundle),
    issuedAt: nextIssuedAt(),
  });
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
  const { updatedAt: _updatedAt, ...signed } = (await resp.json()) as NetworkPrekeyBundle & {
    auth?: unknown;
    issuedAt?: number;
  };
  if (signed.identityId !== idHex || !verifyIdentityAuthJson(signed, "prekeys.publish", idHex)) {
    throw new Error("prekey bundle is not signed by the requested identity");
  }
  verifiedRootKeys.set(idHex, identityProofFromJson(signed.auth).rootPublicKey);
  const bundle = bundleFromNetwork(signed);
  publishBundle(peerIdentityId, bundle);
  return bundle;
}

export async function removeBundleRemote(
  presenceBaseUrl: string,
  identityId: IdentityId,
  signer: IdentitySigner,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const idHex = toHex(identityId);
  const body = signIdentityAuthJson(signer, "prekeys.remove", identityId, {
    identityId: idHex,
    issuedAt: nextIssuedAt(),
  });
  const resp = await fetchImpl(`${trimBase(presenceBaseUrl)}/prekeys/${encodeURIComponent(idHex)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`prekey remove failed: ${resp.status}`);
  }
}

/**
 * Create this device's X3DH prekeys and publish the bundle to the client's
 * presence service, so peers in other processes can open sessions with it.
 */
export async function publishLocalPrekeys(
  client: NexnetClient,
  oneTimeCount = 10,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!client.presenceUrl) throw new Error("presenceUrl is required to publish prekeys");
  const signer = client.identitySigner();
  const signPublic = signer.certificate?.deviceSigningPublicKey ?? signer.rootPublicKey;
  const material = setupLocalPrekeys(client.crypto, client.identityId, signer.secretKey, signPublic, oneTimeCount);
  await publishBundleRemote(
    client.presenceUrl,
    client.identityId,
    exportBundle(material, signPublic),
    signer,
    fetchImpl,
  );
}
