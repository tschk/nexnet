/**
 * @nexnet/client — Double Ratchet (Signal-style)
 *
 * X25519 DH ratchet + HKDF symmetric ratchet + XChaCha20-Poly1305.
 * No X3DH prekeys: first sender is initiator; root seed is conversation SK.
 */

import {
  generateKeyPair as defaultGenerateDh,
  getSharedSecret as defaultDh,
} from "@nexnet/crypto";

export interface RatchetCrypto {
  hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array;
  encrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array
  ): Uint8Array;
  decrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array
  ): Uint8Array;
  randomBytes(n: number): Uint8Array;
  generateDhKeyPair?: () => { secretKey: Uint8Array; publicKey: Uint8Array };
  dh?: (ourSk: Uint8Array, theirPk: Uint8Array) => Uint8Array;
}

export interface RatchetHeader {
  dh: Uint8Array;
  pn: number;
  n: number;
}

export interface RatchetState {
  DHs: { secretKey: Uint8Array; publicKey: Uint8Array };
  DHr: Uint8Array | null;
  RK: Uint8Array;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  /** key = `${dhHex}:${n}` */
  skipped: Map<string, Uint8Array>;
}

const INFO_RK = new TextEncoder().encode("nexnet dr root v1");
const INFO_CK = new TextEncoder().encode("nexnet dr chain v1");
const MAX_SKIP = 100;
const HEADER_LEN = 32 + 4 + 4; // dh || pn || n
const NONCE_LEN = 24;
export const RATCHET_WIRE_VERSION = 1;

function genDh(crypto: RatchetCrypto) {
  return (crypto.generateDhKeyPair ?? defaultGenerateDh)();
}

function dh(crypto: RatchetCrypto, ourSk: Uint8Array, theirPk: Uint8Array) {
  return (crypto.dh ?? defaultDh)(ourSk, theirPk);
}

/** KDF_RK: (rk, dhOut) → (rk', ck) */
export function kdfRk(
  crypto: RatchetCrypto,
  rk: Uint8Array,
  dhOut: Uint8Array
): { rk: Uint8Array; ck: Uint8Array } {
  const out = crypto.hkdf(dhOut, rk, INFO_RK, 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}

/** KDF_CK: ck → (ck', mk) */
export function kdfCk(
  crypto: RatchetCrypto,
  ck: Uint8Array
): { ck: Uint8Array; mk: Uint8Array } {
  const out = crypto.hkdf(ck, new Uint8Array(0), INFO_CK, 64);
  return { ck: out.slice(0, 32), mk: out.slice(32, 64) };
}

export function initInitiator(
  sk: Uint8Array,
  crypto: RatchetCrypto
): RatchetState {
  const DHs = genDh(crypto);
  // Bootstrap sending chain from SK + public DH (peer can recompute)
  const { rk, ck } = kdfRk(crypto, sk, DHs.publicKey);
  return {
    DHs,
    DHr: null,
    RK: rk,
    CKs: ck,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: new Map(),
  };
}

export function initResponder(
  sk: Uint8Array,
  crypto: RatchetCrypto
): RatchetState {
  return {
    DHs: genDh(crypto),
    DHr: null,
    RK: new Uint8Array(sk),
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: new Map(),
  };
}

function skipKeyId(dhPub: Uint8Array, n: number): string {
  return `${Buffer.from(dhPub).toString("hex")}:${n}`;
}

function skipMessageKeys(
  crypto: RatchetCrypto,
  state: RatchetState,
  until: number,
  dhPub: Uint8Array
): void {
  if (state.CKr === null) return;
  if (until - state.Nr > MAX_SKIP) {
    throw new Error("too many skipped message keys");
  }
  while (state.Nr < until) {
    const { ck, mk } = kdfCk(crypto, state.CKr);
    state.CKr = ck;
    state.skipped.set(skipKeyId(dhPub, state.Nr), mk);
    state.Nr += 1;
  }
}

function dhRatchet(
  crypto: RatchetCrypto,
  state: RatchetState,
  headerDh: Uint8Array
): void {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = headerDh;

  const dhOut1 = dh(crypto, state.DHs.secretKey, state.DHr);
  const r1 = kdfRk(crypto, state.RK, dhOut1);
  state.RK = r1.rk;
  state.CKr = r1.ck;

  state.DHs = genDh(crypto);
  const dhOut2 = dh(crypto, state.DHs.secretKey, state.DHr);
  const r2 = kdfRk(crypto, state.RK, dhOut2);
  state.RK = r2.rk;
  state.CKs = r2.ck;
}

/** First receive: recompute initiator bootstrap chain from SK + their DH public. */
function bootstrapReceive(
  crypto: RatchetCrypto,
  state: RatchetState,
  headerDh: Uint8Array
): void {
  const { rk, ck } = kdfRk(crypto, state.RK, headerDh);
  state.RK = rk;
  state.CKr = ck;
  state.DHr = headerDh;
}

/** Responder first send: open sending chain with existing DHs vs remote public. */
function ensureSendingChain(crypto: RatchetCrypto, state: RatchetState): void {
  if (state.CKs !== null) return;
  if (!state.DHr) throw new Error("ratchet: no remote DH for send");
  // Keep current DHs (from init); peer will DH-ratchet against this public key.
  const dhOut = dh(crypto, state.DHs.secretKey, state.DHr);
  const { rk, ck } = kdfRk(crypto, state.RK, dhOut);
  state.RK = rk;
  state.CKs = ck;
}

export function encodeHeader(header: RatchetHeader): Uint8Array {
  const out = new Uint8Array(HEADER_LEN);
  out.set(header.dh, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(32, header.pn);
  view.setUint32(36, header.n);
  return out;
}

export function decodeHeader(buf: Uint8Array): RatchetHeader {
  if (buf.length < HEADER_LEN) throw new Error("ratchet header too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    dh: buf.slice(0, 32),
    pn: view.getUint32(32),
    n: view.getUint32(36),
  };
}

/**
 * Wire blob: version(1) || header(40) || nonce(24) || ciphertext
 */
export function seal(
  crypto: RatchetCrypto,
  state: RatchetState,
  plaintext: Uint8Array,
  aad: Uint8Array
): Uint8Array {
  ensureSendingChain(crypto, state);
  if (state.CKs === null) throw new Error("ratchet: no sending chain");

  const { ck, mk } = kdfCk(crypto, state.CKs);
  state.CKs = ck;
  const header: RatchetHeader = {
    dh: state.DHs.publicKey,
    pn: state.PN,
    n: state.Ns,
  };
  state.Ns += 1;

  const nonce = crypto.randomBytes(NONCE_LEN);
  const headerBytes = encodeHeader(header);
  // Bind header into AEAD AAD
  const fullAad = new Uint8Array(aad.length + headerBytes.length);
  fullAad.set(aad, 0);
  fullAad.set(headerBytes, aad.length);
  const ct = crypto.encrypt(mk, nonce, fullAad, plaintext);

  const out = new Uint8Array(1 + HEADER_LEN + NONCE_LEN + ct.length);
  out[0] = RATCHET_WIRE_VERSION;
  out.set(headerBytes, 1);
  out.set(nonce, 1 + HEADER_LEN);
  out.set(ct, 1 + HEADER_LEN + NONCE_LEN);
  return out;
}

export function open(
  crypto: RatchetCrypto,
  state: RatchetState,
  blob: Uint8Array,
  aad: Uint8Array
): Uint8Array {
  if (blob.length < 1 + HEADER_LEN + NONCE_LEN + 1) {
    throw new Error("ratchet blob too short");
  }
  if (blob[0] !== RATCHET_WIRE_VERSION) {
    throw new Error("ratchet version mismatch");
  }

  const header = decodeHeader(blob.subarray(1, 1 + HEADER_LEN));
  const nonce = blob.subarray(1 + HEADER_LEN, 1 + HEADER_LEN + NONCE_LEN);
  const ct = blob.subarray(1 + HEADER_LEN + NONCE_LEN);
  const headerBytes = encodeHeader(header);
  const fullAad = new Uint8Array(aad.length + headerBytes.length);
  fullAad.set(aad, 0);
  fullAad.set(headerBytes, aad.length);

  // Try skipped keys first
  const skipId = skipKeyId(header.dh, header.n);
  const skippedMk = state.skipped.get(skipId);
  if (skippedMk) {
    state.skipped.delete(skipId);
    return crypto.decrypt(skippedMk, nonce, fullAad, ct);
  }

  const sameDh =
    state.DHr !== null &&
    state.DHr.length === header.dh.length &&
    state.DHr.every((b, i) => b === header.dh[i]);

  if (!sameDh) {
    // Pure responder, never sent/received: bootstrap from root SK + their DH public.
    // Initiator (already has CKs) receiving first reply must full DH-ratchet instead.
    if (state.DHr === null && state.CKr === null && state.CKs === null) {
      bootstrapReceive(crypto, state, header.dh);
    } else {
      if (state.CKr !== null && state.DHr !== null) {
        skipMessageKeys(crypto, state, header.pn, state.DHr);
      }
      dhRatchet(crypto, state, header.dh);
    }
  }

  if (state.CKr === null) throw new Error("ratchet: no receiving chain");
  skipMessageKeys(crypto, state, header.n, header.dh);
  const { ck, mk } = kdfCk(crypto, state.CKr);
  state.CKr = ck;
  state.Nr += 1;
  return crypto.decrypt(mk, nonce, fullAad, ct);
}

/** In-memory session store. ponytail: no disk persist until multi-device needs it. */
const sessions = new Map<string, RatchetState>();

export function sessionStoreKey(
  conversationId: Uint8Array,
  peerId: Uint8Array
): string {
  return `${Buffer.from(conversationId).toString("hex")}:${Buffer.from(peerId).toString("hex")}`;
}

export function getSession(key: string): RatchetState | undefined {
  return sessions.get(key);
}

export function setSession(key: string, state: RatchetState): void {
  sessions.set(key, state);
}

export function clearSessions(): void {
  sessions.clear();
}

export function getOrCreateSendSession(
  key: string,
  sk: Uint8Array,
  crypto: RatchetCrypto
): RatchetState {
  let state = sessions.get(key);
  if (!state) {
    state = initInitiator(sk, crypto);
    sessions.set(key, state);
  }
  return state;
}

export function getOrCreateRecvSession(
  key: string,
  sk: Uint8Array,
  crypto: RatchetCrypto
): RatchetState {
  let state = sessions.get(key);
  if (!state) {
    state = initResponder(sk, crypto);
    sessions.set(key, state);
  }
  return state;
}
