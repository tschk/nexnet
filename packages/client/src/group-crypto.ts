/**
 * @nexnet/client — Group message encryption (epoch secrets)
 *
 * Not full MLS. Epoch secret is random; message key = HKDF(secret, group||epoch).
 * Membership change → new secret, wrapped to each member via X25519+AEAD.
 * Removed members lack next epoch secret → cannot decrypt future msgs.
 *
 * ponytail: flat epoch secrets, not MLS tree. Upgrade when large groups need it.
 */

import type { CryptoProvider, GroupId, IdentityId } from "@nexnet/types";
import {
  generateKeyPair as defaultGenerateDh,
  getSharedSecret as defaultDh,
} from "@nexnet/crypto";

const GROUP_KEY_DOMAIN = "nexnet group msg key v1";
const WRAP_INFO = "nexnet group epoch wrap v1";

export interface EncryptedGroupPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array; // 24 bytes
  epoch: number;
  signature: Uint8Array;
}

/** Per-member wrap of the current epoch secret */
export interface EpochSecretWrap {
  memberId: Uint8Array;
  ephemeralPublic: Uint8Array; // 32
  nonce: Uint8Array; // 24
  ciphertext: Uint8Array; // secret + tag
}

export interface GroupEpoch {
  epoch: number;
  secret: Uint8Array; // 32
}

export interface GroupSession {
  groupId: GroupId;
  epoch: number;
  secret: Uint8Array;
  /** local X25519 for receiving wraps */
  dh: { secretKey: Uint8Array; publicKey: Uint8Array };
  /** known member identity → X25519 public */
  memberDh: Map<string, Uint8Array>;
}

function idHex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

function epochBytes(epoch: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(epoch));
  return b;
}

/**
 * Derive 32-byte AEAD key from epoch secret (not from public groupId alone).
 */
export function deriveGroupKey(
  crypto: CryptoProvider,
  epochSecret: Uint8Array,
  groupId: GroupId,
  epoch: number
): Uint8Array {
  const e = epochBytes(epoch);
  const salt = new Uint8Array(groupId.length + e.length);
  salt.set(groupId, 0);
  salt.set(e, groupId.length);
  return crypto.hkdf(
    epochSecret,
    salt,
    new TextEncoder().encode(GROUP_KEY_DOMAIN),
    32
  );
}

/** Epoch number = membership-change count (compat). */
export function deriveEpoch(membershipChangeCount: number): number {
  return membershipChangeCount;
}

/** Fresh group epoch 0 with random secret. */
export function createEpoch(crypto: CryptoProvider): GroupEpoch {
  return { epoch: 0, secret: crypto.randomBytes(32) };
}

/**
 * Next epoch: new random secret (forward secrecy on membership change).
 * Previous secret does not determine next (FS for removed members).
 */
export function advanceEpoch(
  crypto: CryptoProvider,
  current: GroupEpoch
): GroupEpoch {
  return { epoch: current.epoch + 1, secret: crypto.randomBytes(32) };
}

/**
 * Wrap epoch secret to one member's X25519 public key.
 * Ephemeral DH → HKDF → XChaCha seal of secret.
 */
export function wrapEpochSecret(
  crypto: CryptoProvider,
  secret: Uint8Array,
  memberId: IdentityId,
  memberDhPublic: Uint8Array
): EpochSecretWrap {
  const eph = defaultGenerateDh();
  const shared = defaultDh(eph.secretKey, memberDhPublic);
  const wrapKey = crypto.hkdf(
    shared,
    memberId,
    new TextEncoder().encode(WRAP_INFO),
    32
  );
  const nonce = crypto.randomBytes(24);
  const ciphertext = crypto.encrypt(wrapKey, nonce, memberId, secret);
  return {
    memberId: new Uint8Array(memberId),
    ephemeralPublic: eph.publicKey,
    nonce,
    ciphertext,
  };
}

export function unwrapEpochSecret(
  crypto: CryptoProvider,
  wrap: EpochSecretWrap,
  myDhSecret: Uint8Array,
  myIdentityId: IdentityId
): Uint8Array {
  const shared = defaultDh(myDhSecret, wrap.ephemeralPublic);
  const wrapKey = crypto.hkdf(
    shared,
    myIdentityId,
    new TextEncoder().encode(WRAP_INFO),
    32
  );
  return crypto.decrypt(wrapKey, wrap.nonce, myIdentityId, wrap.ciphertext);
}

export function encryptGroupMessage(
  crypto: CryptoProvider,
  groupId: GroupId,
  epoch: number,
  epochSecret: Uint8Array,
  payload: Uint8Array,
  signingKey: Uint8Array
): EncryptedGroupPayload {
  const key = deriveGroupKey(crypto, epochSecret, groupId, epoch);
  const nonce = crypto.randomBytes(24);
  const ciphertext = crypto.encrypt(key, nonce, groupId, payload);

  const e = epochBytes(epoch);
  const signPayload = new Uint8Array(
    nonce.length + ciphertext.length + e.length
  );
  signPayload.set(nonce, 0);
  signPayload.set(ciphertext, nonce.length);
  signPayload.set(e, nonce.length + ciphertext.length);
  const signature = crypto.sign(signingKey, signPayload);

  return { ciphertext, nonce, epoch, signature };
}

export function decryptGroupMessage(
  crypto: CryptoProvider,
  groupId: GroupId,
  epochSecret: Uint8Array,
  encrypted: EncryptedGroupPayload,
  senderPublicKey: Uint8Array
): Uint8Array | null {
  const e = epochBytes(encrypted.epoch);
  const signPayload = new Uint8Array(
    encrypted.nonce.length + encrypted.ciphertext.length + e.length
  );
  signPayload.set(encrypted.nonce, 0);
  signPayload.set(encrypted.ciphertext, encrypted.nonce.length);
  signPayload.set(e, encrypted.nonce.length + encrypted.ciphertext.length);

  if (!crypto.verify(senderPublicKey, signPayload, encrypted.signature)) {
    return null;
  }

  const key = deriveGroupKey(
    crypto,
    epochSecret,
    groupId,
    encrypted.epoch
  );
  try {
    return crypto.decrypt(key, encrypted.nonce, groupId, encrypted.ciphertext);
  } catch {
    return null;
  }
}

// ── In-memory group sessions ─────────────────────────────────────────

const groupSessions = new Map<string, GroupSession>();

export function clearGroupSessions(): void {
  groupSessions.clear();
}

export function getGroupSession(groupId: GroupId): GroupSession | undefined {
  return groupSessions.get(idHex(groupId));
}

export function initGroupSession(
  crypto: CryptoProvider,
  groupId: GroupId,
  epoch?: GroupEpoch
): GroupSession {
  const e = epoch ?? createEpoch(crypto);
  const session: GroupSession = {
    groupId,
    epoch: e.epoch,
    secret: e.secret,
    dh: defaultGenerateDh(),
    memberDh: new Map(),
  };
  groupSessions.set(idHex(groupId), session);
  return session;
}

export function setMemberDh(
  session: GroupSession,
  memberId: IdentityId,
  dhPublic: Uint8Array
): void {
  session.memberDh.set(idHex(memberId), dhPublic);
}

/** Rotate epoch, wrap secret for all known members (except removed). */
export function rotateEpoch(
  crypto: CryptoProvider,
  session: GroupSession,
  activeMemberIds: IdentityId[]
): { epoch: GroupEpoch; wraps: EpochSecretWrap[] } {
  const next = advanceEpoch(crypto, {
    epoch: session.epoch,
    secret: session.secret,
  });
  session.epoch = next.epoch;
  session.secret = next.secret;

  const wraps: EpochSecretWrap[] = [];
  for (const mid of activeMemberIds) {
    const pk = session.memberDh.get(idHex(mid));
    if (!pk) continue;
    wraps.push(wrapEpochSecret(crypto, next.secret, mid, pk));
  }
  return { epoch: next, wraps };
}

/** Apply a received wrap for self. */
export function applyEpochWrap(
  crypto: CryptoProvider,
  session: GroupSession,
  epoch: number,
  wrap: EpochSecretWrap,
  myIdentityId: IdentityId
): void {
  const secret = unwrapEpochSecret(
    crypto,
    wrap,
    session.dh.secretKey,
    myIdentityId
  );
  session.epoch = epoch;
  session.secret = secret;
}
