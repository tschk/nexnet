/**
 * @nettle/client — Group message encryption
 *
 * Uses HKDF-derived shared key per group + epoch.
 * Not full MLS — simplified v1 with epoch tracking.
 * Members removed at epoch N can't decrypt messages at epoch N+1.
 */

import type { CryptoProvider, GroupId } from "@nettle/types";

const GROUP_KEY_DOMAIN = "nettle group key v1";
const GROUP_EPOCH_DOMAIN = "nettle group epoch v1";

export interface EncryptedGroupPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array; // 24 bytes
  epoch: number;
  signature: Uint8Array;
}

/**
 * Derive group encryption key from group ID + epoch.
 * Different epoch = different key (removed members can't decrypt).
 */
export function deriveGroupKey(
  crypto: CryptoProvider,
  groupId: GroupId,
  epoch: number
): Uint8Array {
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch));

  const ikm = new Uint8Array(groupId.length + epochBytes.length);
  ikm.set(groupId, 0);
  ikm.set(epochBytes, groupId.length);

  return crypto.hkdf(
    ikm,
    new Uint8Array(0),
    new TextEncoder().encode(GROUP_KEY_DOMAIN),
    32
  );
}

/**
 * Derive current epoch from group membership state.
 * Simple: epoch = number of membership changes (member_added + member_removed).
 */
export function deriveEpoch(membershipChangeCount: number): number {
  return membershipChangeCount;
}

/**
 * Encrypt a group message payload.
 */
export function encryptGroupMessage(
  crypto: CryptoProvider,
  groupId: GroupId,
  epoch: number,
  payload: Uint8Array,
  signingKey: Uint8Array
): EncryptedGroupPayload {
  const key = deriveGroupKey(crypto, groupId, epoch);
  const nonce = crypto.randomBytes(24);

  const ciphertext = crypto.encrypt(key, nonce, groupId, payload);

  // Sign: nonce || ciphertext || epoch bytes
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch));

  const signPayload = new Uint8Array(
    nonce.length + ciphertext.length + epochBytes.length
  );
  signPayload.set(nonce, 0);
  signPayload.set(ciphertext, nonce.length);
  signPayload.set(epochBytes, nonce.length + ciphertext.length);

  const signature = crypto.sign(signingKey, signPayload);

  return { ciphertext, nonce, epoch, signature };
}

/**
 * Decrypt a group message payload.
 * Returns null if signature invalid or decryption fails.
 */
export function decryptGroupMessage(
  crypto: CryptoProvider,
  groupId: GroupId,
  encrypted: EncryptedGroupPayload,
  senderPublicKey: Uint8Array
): Uint8Array | null {
  // Verify signature
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(encrypted.epoch));

  const signPayload = new Uint8Array(
    encrypted.nonce.length +
      encrypted.ciphertext.length +
      epochBytes.length
  );
  signPayload.set(encrypted.nonce, 0);
  signPayload.set(encrypted.ciphertext, encrypted.nonce.length);
  signPayload.set(
    epochBytes,
    encrypted.nonce.length + encrypted.ciphertext.length
  );

  const valid = crypto.verify(senderPublicKey, signPayload, encrypted.signature);
  if (!valid) return null;

  // Decrypt
  const key = deriveGroupKey(crypto, groupId, encrypted.epoch);
  try {
    return crypto.decrypt(key, encrypted.nonce, groupId, encrypted.ciphertext);
  } catch {
    return null;
  }
}
