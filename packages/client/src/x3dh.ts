/**
 * @nexnet/client — X3DH-style session bootstrap (Signal-compatible shape)
 *
 * SK = HKDF(DH1 || DH2 || DH3 [|| DH4], salt=0, info="nexnet x3dh v1")
 * DH1 = DH(IKa, SPKb)
 * DH2 = DH(EKa, IKb)
 * DH3 = DH(EKa, SPKb)
 * DH4 = DH(EKa, OPKb) optional one-time prekey
 *
 * Uses X25519 + HKDF from @nexnet/crypto. Signed prekey verified with Ed25519.
 */

import {
  generateKeyPair as defaultGenerateDh,
  getSharedSecret as defaultDh,
} from "@nexnet/crypto";
import type { CryptoProvider, PublicKey, Signature } from "@nexnet/types";

const X3DH_INFO = new TextEncoder().encode("nexnet x3dh v1");

export interface PrekeyBundle {
  identityDhPublic: Uint8Array; // 32 IKb
  signedPrekeyPublic: Uint8Array; // 32 SPKb
  signedPrekeySig: Signature; // Ed25519 over SPKb
  identitySignPublic: PublicKey; // Ed25519 for verify
  oneTimePrekeyPublic?: Uint8Array; // 32 OPKb optional
  oneTimePrekeyId?: number;
}

export interface LocalPrekeyMaterial {
  identityDh: { secretKey: Uint8Array; publicKey: Uint8Array };
  signedPrekey: { secretKey: Uint8Array; publicKey: Uint8Array };
  signedPrekeySig: Signature;
  /** one-time prekeys: id → secret */
  oneTime: Map<number, { secretKey: Uint8Array; publicKey: Uint8Array }>;
  nextOtpId: number;
}

export interface X3dhInitResult {
  /** 32-byte shared root for Double Ratchet */
  sk: Uint8Array;
  /** ephemeral public to send with first message */
  ekPublic: Uint8Array;
  usedOneTimePrekeyId?: number;
  /** remote signed prekey used (for ratchet DHr bootstrap) */
  remoteSpk: Uint8Array;
}

export interface X3dhRecvResult {
  sk: Uint8Array;
  remoteEk: Uint8Array;
  remoteSpkUsed: boolean;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Create local identity DH + signed prekey (+ N one-time). */
export function createLocalPrekeys(
  crypto: CryptoProvider,
  identitySignSecret: Uint8Array,
  oneTimeCount = 10
): LocalPrekeyMaterial {
  const identityDh = defaultGenerateDh();
  const signedPrekey = defaultGenerateDh();
  const signedPrekeySig = crypto.sign(
    identitySignSecret,
    signedPrekey.publicKey
  );
  const oneTime = new Map<
    number,
    { secretKey: Uint8Array; publicKey: Uint8Array }
  >();
  for (let i = 1; i <= oneTimeCount; i++) {
    oneTime.set(i, defaultGenerateDh());
  }
  return {
    identityDh,
    signedPrekey,
    signedPrekeySig,
    oneTime,
    nextOtpId: oneTimeCount + 1,
  };
}

/** Public bundle for directory / presence publish. */
export function exportBundle(
  material: LocalPrekeyMaterial,
  identitySignPublic: PublicKey
): PrekeyBundle {
  // consume lowest OTP id if any
  let otp: { id: number; publicKey: Uint8Array } | undefined;
  for (const [id, kp] of material.oneTime) {
    otp = { id, publicKey: kp.publicKey };
    break;
  }
  return {
    identityDhPublic: material.identityDh.publicKey,
    signedPrekeyPublic: material.signedPrekey.publicKey,
    signedPrekeySig: material.signedPrekeySig,
    identitySignPublic,
    oneTimePrekeyPublic: otp?.publicKey,
    oneTimePrekeyId: otp?.id,
  };
}

export function verifyBundle(
  crypto: CryptoProvider,
  bundle: PrekeyBundle
): boolean {
  return crypto.verify(
    bundle.identitySignPublic,
    bundle.signedPrekeyPublic,
    bundle.signedPrekeySig
  );
}

/**
 * Alice initiates toward Bob's bundle.
 * Returns SK + her ephemeral public (must travel with first ciphertext).
 */
export function x3dhInitiate(
  crypto: CryptoProvider,
  aliceIdentityDhSecret: Uint8Array,
  bob: PrekeyBundle
): X3dhInitResult {
  if (!verifyBundle(crypto, bob)) {
    throw new Error("x3dh: invalid signed prekey signature");
  }
  const ek = defaultGenerateDh();
  const dh1 = defaultDh(aliceIdentityDhSecret, bob.signedPrekeyPublic);
  const dh2 = defaultDh(ek.secretKey, bob.identityDhPublic);
  const dh3 = defaultDh(ek.secretKey, bob.signedPrekeyPublic);
  let ikm: Uint8Array;
  let usedOneTimePrekeyId: number | undefined;
  if (bob.oneTimePrekeyPublic) {
    const dh4 = defaultDh(ek.secretKey, bob.oneTimePrekeyPublic);
    ikm = concat(dh1, dh2, dh3, dh4);
    usedOneTimePrekeyId = bob.oneTimePrekeyId;
  } else {
    ikm = concat(dh1, dh2, dh3);
  }
  const sk = crypto.hkdf(ikm, new Uint8Array(0), X3DH_INFO, 32);
  return {
    sk,
    ekPublic: ek.publicKey,
    usedOneTimePrekeyId,
    remoteSpk: bob.signedPrekeyPublic,
  };
}

/**
 * Bob completes X3DH from Alice's identity DH public + ephemeral public.
 * Consumes one-time prekey if id provided.
 */
export function x3dhRespond(
  crypto: CryptoProvider,
  bob: LocalPrekeyMaterial,
  aliceIdentityDhPublic: Uint8Array,
  aliceEkPublic: Uint8Array,
  usedOneTimePrekeyId?: number
): X3dhRecvResult {
  const dh1 = defaultDh(bob.signedPrekey.secretKey, aliceIdentityDhPublic);
  const dh2 = defaultDh(bob.identityDh.secretKey, aliceEkPublic);
  const dh3 = defaultDh(bob.signedPrekey.secretKey, aliceEkPublic);
  let ikm: Uint8Array;
  if (usedOneTimePrekeyId !== undefined) {
    const otp = bob.oneTime.get(usedOneTimePrekeyId);
    if (!otp) throw new Error("x3dh: unknown one-time prekey");
    const dh4 = defaultDh(otp.secretKey, aliceEkPublic);
    ikm = concat(dh1, dh2, dh3, dh4);
    bob.oneTime.delete(usedOneTimePrekeyId);
  } else {
    ikm = concat(dh1, dh2, dh3);
  }
  const sk = crypto.hkdf(ikm, new Uint8Array(0), X3DH_INFO, 32);
  return { sk, remoteEk: aliceEkPublic, remoteSpkUsed: true };
}
