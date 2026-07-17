import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import {
  createLocalPrekeys,
  exportBundle,
  verifyBundle,
  x3dhInitiate,
  x3dhRespond,
} from "../x3dh.js";
import {
  clearSessions,
  deserializeState,
  initInitiator,
  initResponder,
  open,
  seal,
  serializeState,
  setSessionBackend,
  getOrCreateSendSession,
  saveSession,
  getSession,
  type SessionBackend,
} from "../double-ratchet.js";

const te = new TextEncoder();
const aad = () => te.encode("aad");

function memBackend(): SessionBackend & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    get(k) {
      const v = data.get(k);
      return v ? new Uint8Array(v) : null;
    },
    put(k, blob) {
      data.set(k, new Uint8Array(blob));
    },
    delete(k) {
      data.delete(k);
    },
    clear() {
      data.clear();
    },
  };
}

describe("X3DH", () => {
  test("bundle signature verifies", () => {
    const kp = cryptoProvider.generateSigningKeyPair();
    const local = createLocalPrekeys(cryptoProvider, kp.secretKey, 3);
    const bundle = exportBundle(local, kp.publicKey);
    expect(verifyBundle(cryptoProvider, bundle)).toBe(true);
  });

  test("initiate/respond agree on SK with one-time prekey", () => {
    const aliceSign = cryptoProvider.generateSigningKeyPair();
    const bobSign = cryptoProvider.generateSigningKeyPair();
    const alice = createLocalPrekeys(cryptoProvider, aliceSign.secretKey, 0);
    const bob = createLocalPrekeys(cryptoProvider, bobSign.secretKey, 5);
    const bundle = exportBundle(bob, bobSign.publicKey);
    expect(bundle.oneTimePrekeyId).toBeDefined();

    const init = x3dhInitiate(
      cryptoProvider,
      alice.identityDh.secretKey,
      bundle
    );
    const resp = x3dhRespond(
      cryptoProvider,
      bob,
      alice.identityDh.publicKey,
      init.ekPublic,
      init.usedOneTimePrekeyId
    );
    expect(init.sk).toEqual(resp.sk);
  });

  test("initiate/respond without OTP still agree", () => {
    const aliceSign = cryptoProvider.generateSigningKeyPair();
    const bobSign = cryptoProvider.generateSigningKeyPair();
    const alice = createLocalPrekeys(cryptoProvider, aliceSign.secretKey, 0);
    const bob = createLocalPrekeys(cryptoProvider, bobSign.secretKey, 0);
    const bundle = exportBundle(bob, bobSign.publicKey);
    expect(bundle.oneTimePrekeyPublic).toBeUndefined();

    const init = x3dhInitiate(
      cryptoProvider,
      alice.identityDh.secretKey,
      bundle
    );
    const resp = x3dhRespond(
      cryptoProvider,
      bob,
      alice.identityDh.publicKey,
      init.ekPublic
    );
    expect(init.sk).toEqual(resp.sk);
  });

  test("X3DH SK seeds Double Ratchet successfully", () => {
    const aliceSign = cryptoProvider.generateSigningKeyPair();
    const bobSign = cryptoProvider.generateSigningKeyPair();
    const alice = createLocalPrekeys(cryptoProvider, aliceSign.secretKey, 0);
    const bob = createLocalPrekeys(cryptoProvider, bobSign.secretKey, 1);
    const bundle = exportBundle(bob, bobSign.publicKey);
    const init = x3dhInitiate(
      cryptoProvider,
      alice.identityDh.secretKey,
      bundle
    );
    const resp = x3dhRespond(
      cryptoProvider,
      bob,
      alice.identityDh.publicKey,
      init.ekPublic,
      init.usedOneTimePrekeyId
    );

    const aState = initInitiator(init.sk, cryptoProvider);
    const bState = initResponder(resp.sk, cryptoProvider);
    const pt = te.encode("x3dh-dm");
    const blob = seal(cryptoProvider, aState, pt, aad());
    expect(open(cryptoProvider, bState, blob, aad())).toEqual(pt);
  });

  test("tampered signed prekey rejected", () => {
    const kp = cryptoProvider.generateSigningKeyPair();
    const local = createLocalPrekeys(cryptoProvider, kp.secretKey, 0);
    const bundle = exportBundle(local, kp.publicKey);
    bundle.signedPrekeyPublic = cryptoProvider.randomBytes(32);
    expect(verifyBundle(cryptoProvider, bundle)).toBe(false);
  });
});

describe("persisted ratchet sessions", () => {
  let backend: ReturnType<typeof memBackend>;

  beforeEach(() => {
    setSessionBackend(null);
    clearSessions();
    backend = memBackend();
    setSessionBackend(backend);
  });

  afterEach(() => {
    setSessionBackend(null);
    clearSessions();
  });

  test("serialize/deserialize preserves state", () => {
    const sk = cryptoProvider.randomBytes(32);
    const state = initInitiator(sk, cryptoProvider);
    seal(cryptoProvider, state, te.encode("a"), aad());
    const back = deserializeState(serializeState(state));
    expect(back.Ns).toBe(state.Ns);
    expect(back.RK).toEqual(state.RK);
    expect(back.DHs.publicKey).toEqual(state.DHs.publicKey);
  });

  test("session reloads from backend after memory drop", () => {
    const sk = cryptoProvider.randomBytes(32);
    const key = "c1:p1";
    const s1 = getOrCreateSendSession(key, sk, cryptoProvider);
    seal(cryptoProvider, s1, te.encode("one"), aad());
    saveSession(key, s1);
    expect(backend.data.has(key)).toBe(true);

    // Drop memory only — keep backend data
    setSessionBackend(null);
    clearSessions();
    setSessionBackend(backend);

    const s2 = getSession(key);
    expect(s2).toBeDefined();
    expect(s2!.Ns).toBe(1);
    expect(s2!.CKs).not.toBeNull();
  });
});
