import { describe, test, expect, beforeEach } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { generateKeyPair } from "@nexnet/crypto";
import {
  deriveGroupKey,
  deriveEpoch,
  encryptGroupMessage,
  decryptGroupMessage,
  createEpoch,
  advanceEpoch,
  wrapEpochSecret,
  unwrapEpochSecret,
  initGroupSession,
  setMemberDh,
  rotateEpoch,
  applyEpochWrap,
  clearGroupSessions,
  getGroupSession,
} from "../group-crypto.js";

describe("Group encryption", () => {
  const crypto = cryptoProvider;
  const groupId = crypto.deriveId(
    "nexnet group id v1",
    new TextEncoder().encode("test-group")
  );

  beforeEach(() => {
    clearGroupSessions();
  });

  test("deriveGroupKey produces 32 bytes", () => {
    const secret = crypto.randomBytes(32);
    const key = deriveGroupKey(crypto, secret, groupId, 0);
    expect(key.length).toBe(32);
  });

  test("different secrets yield different keys", () => {
    const a = deriveGroupKey(crypto, crypto.randomBytes(32), groupId, 0);
    const b = deriveGroupKey(crypto, crypto.randomBytes(32), groupId, 0);
    expect(a).not.toEqual(b);
  });

  test("same secret+epoch is deterministic", () => {
    const secret = new Uint8Array(32).fill(0x42);
    const a = deriveGroupKey(crypto, secret, groupId, 1);
    const b = deriveGroupKey(crypto, secret, groupId, 1);
    expect(a).toEqual(b);
  });

  test("encrypt/decrypt roundtrip", () => {
    const kp = crypto.generateSigningKeyPair();
    const epoch = createEpoch(crypto);
    const payload = new TextEncoder().encode("Hello group!");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      epoch.epoch,
      epoch.secret,
      payload,
      kp.secretKey
    );

    expect(encrypted.epoch).toBe(0);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.nonce.length).toBe(24);

    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      epoch.secret,
      encrypted,
      kp.publicKey
    );

    expect(decrypted).not.toBeNull();
    expect(new TextDecoder().decode(decrypted!)).toBe("Hello group!");
  });

  test("wrong epoch secret fails to decrypt", () => {
    const kp = crypto.generateSigningKeyPair();
    const epoch = createEpoch(crypto);
    const payload = new TextEncoder().encode("secret");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      epoch.epoch,
      epoch.secret,
      payload,
      kp.secretKey
    );

    const wrongSecret = crypto.randomBytes(32);
    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      wrongSecret,
      encrypted,
      kp.publicKey
    );

    expect(decrypted).toBeNull();
  });

  test("wrong signature fails", () => {
    const kp = crypto.generateSigningKeyPair();
    const kp2 = crypto.generateSigningKeyPair();
    const epoch = createEpoch(crypto);
    const payload = new TextEncoder().encode("signed");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      epoch.epoch,
      epoch.secret,
      payload,
      kp.secretKey
    );

    const decrypted = decryptGroupMessage(
      crypto,
      groupId,
      epoch.secret,
      encrypted,
      kp2.publicKey
    );

    expect(decrypted).toBeNull();
  });

  test("deriveEpoch from membership changes", () => {
    expect(deriveEpoch(0)).toBe(0);
    expect(deriveEpoch(1)).toBe(1);
    expect(deriveEpoch(5)).toBe(5);
  });

  test("advanceEpoch changes secret", () => {
    const e0 = createEpoch(crypto);
    const e1 = advanceEpoch(crypto, e0);
    expect(e1.epoch).toBe(1);
    expect(e1.secret).not.toEqual(e0.secret);
  });

  test("removed member can't decrypt new epoch", () => {
    const kp = crypto.generateSigningKeyPair();
    const e0 = createEpoch(crypto);
    const e1 = advanceEpoch(crypto, e0);
    const payload = new TextEncoder().encode("epoch 1 message");

    const encrypted = encryptGroupMessage(
      crypto,
      groupId,
      e1.epoch,
      e1.secret,
      payload,
      kp.secretKey
    );

    // Old epoch secret fails
    expect(
      decryptGroupMessage(crypto, groupId, e0.secret, encrypted, kp.publicKey)
    ).toBeNull();

    // New secret works
    expect(
      decryptGroupMessage(crypto, groupId, e1.secret, encrypted, kp.publicKey)
    ).not.toBeNull();
  });

  test("wrap/unwrap epoch secret for member", () => {
    const memberId = new Uint8Array(32).fill(0xaa);
    const memberDh = generateKeyPair();
    const secret = crypto.randomBytes(32);

    const wrap = wrapEpochSecret(crypto, secret, memberId, memberDh.publicKey);
    const opened = unwrapEpochSecret(
      crypto,
      wrap,
      memberDh.secretKey,
      memberId
    );
    expect(opened).toEqual(secret);
  });

  test("rotateEpoch distributes new secret to members", () => {
    const aliceId = new Uint8Array(32).fill(0x01);
    const bobId = new Uint8Array(32).fill(0x02);
    const aliceDh = generateKeyPair();
    const bobDh = generateKeyPair();

    const session = initGroupSession(crypto, groupId);
    setMemberDh(session, aliceId, aliceDh.publicKey);
    setMemberDh(session, bobId, bobDh.publicKey);

    const oldSecret = new Uint8Array(session.secret);
    const { epoch, wraps } = rotateEpoch(crypto, session, [aliceId, bobId]);

    expect(epoch.epoch).toBe(1);
    expect(session.secret).not.toEqual(oldSecret);
    expect(wraps.length).toBe(2);

    // Bob applies wrap
    const bobSession = initGroupSession(crypto, crypto.randomBytes(32)); // dummy
    bobSession.dh = bobDh;
    applyEpochWrap(crypto, bobSession, epoch.epoch, wraps[1]!, bobId);
    expect(bobSession.secret).toEqual(session.secret);
    expect(bobSession.epoch).toBe(1);
  });

  test("getGroupSession returns init'd session", () => {
    expect(getGroupSession(groupId)).toBeUndefined();
    initGroupSession(crypto, groupId);
    expect(getGroupSession(groupId)?.groupId).toEqual(groupId);
  });
});
