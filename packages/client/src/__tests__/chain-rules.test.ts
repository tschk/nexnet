import { describe, test, expect } from "bun:test";

/**
 * Mirror of chain/nexnet_chain.in transition codes.
 * Keep in sync with .in — if either changes, both tests must move.
 */

const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INACTIVITY_RELEASE_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_USERNAME_LEN = 2;
const MAX_USERNAME_LEN = 32;

function canRegisterUsername(
  accountAgeMs: number,
  ownsUsername: number,
  nameTaken: number,
  ownerInactiveMs: number,
  nameLen: number
): number {
  if (nameLen < MIN_USERNAME_LEN) return 1;
  if (nameLen > MAX_USERNAME_LEN) return 2;
  if (ownsUsername !== 0) return 3;
  if (accountAgeMs < MIN_ACCOUNT_AGE_MS) return 4;
  if (nameTaken !== 0) {
    if (ownerInactiveMs < INACTIVITY_RELEASE_MS) return 5;
  }
  return 0;
}

function canTransferUsername(): number {
  return 10;
}

function canSetGroupCreator(
  existingCreator: number,
  callerIsCreator: number
): number {
  if (existingCreator === 0) return 0;
  if (callerIsCreator !== 0) return 0;
  return 11;
}

function canRegisterRelay(keyLen: number): number {
  if (keyLen <= 0) return 12;
  return 0;
}

function canBindIdentityRoot(alreadyBound: number): number {
  if (alreadyBound !== 0) return 13;
  return 0;
}

describe("chain transition rules (mirror of chain/nexnet_chain.in)", () => {
  test("register ok for aged free name", () => {
    expect(canRegisterUsername(MIN_ACCOUNT_AGE_MS, 0, 0, 0, 5)).toBe(0);
  });

  test("register rejects short name", () => {
    expect(canRegisterUsername(MIN_ACCOUNT_AGE_MS, 0, 0, 0, 1)).toBe(1);
  });

  test("register rejects long name", () => {
    expect(canRegisterUsername(MIN_ACCOUNT_AGE_MS, 0, 0, 0, 33)).toBe(2);
  });

  test("register rejects existing ownership (AD-10)", () => {
    expect(canRegisterUsername(MIN_ACCOUNT_AGE_MS, 1, 0, 0, 5)).toBe(3);
  });

  test("register rejects young account", () => {
    expect(canRegisterUsername(1000, 0, 0, 0, 5)).toBe(4);
  });

  test("register rejects taken active name", () => {
    expect(canRegisterUsername(MIN_ACCOUNT_AGE_MS, 0, 1, 1000, 5)).toBe(5);
  });

  test("register allows inactive release", () => {
    expect(
      canRegisterUsername(MIN_ACCOUNT_AGE_MS, 0, 1, INACTIVITY_RELEASE_MS, 5)
    ).toBe(0);
  });

  test("transfer always disabled", () => {
    expect(canTransferUsername()).toBe(10);
  });

  test("group creator first set ok", () => {
    expect(canSetGroupCreator(0, 0)).toBe(0);
  });

  test("group creator conflict", () => {
    expect(canSetGroupCreator(1, 0)).toBe(11);
  });

  test("relay empty key rejected", () => {
    expect(canRegisterRelay(0)).toBe(12);
  });

  test("identity already bound rejected", () => {
    expect(canBindIdentityRoot(1)).toBe(13);
  });
});
