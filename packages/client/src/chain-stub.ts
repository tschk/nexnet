/**
 * @nexnet/client — DevChainClient
 *
 * In-memory chain stub for development.
 * AD-10: max 1 username per wallet, no transfer, anti-squat.
 * Replaced when .in chain is ready.
 */

import type {
  ChainApiClient,
  DeviceCertificate,
  DeviceId,
  PasskeyAssertion,
  PasskeyCertificateChallenge,
  PasskeyCredential,
  UsernameRecord,
  ValidatorRecord,
  WalletAddress,
  IdentityId,
} from "@nexnet/types";
import { verifyPasskeyCredentialAuthorization, verifyDeviceCert } from "@nexnet/protocol";
import { randomBytes } from "@nexnet/crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Minimum account age before registering a username (7 days) */
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Release username after 90 days of no presence */
const INACTIVITY_RELEASE_MS = 90 * 24 * 60 * 60 * 1000;

/** AD-14 */
const MIN_VALIDATORS = 4;
const MAX_VALIDATORS = 21;
const MIN_BOND = 1;
const VALIDATOR_POWER_CAP = 1_000_000;

interface AccountMeta {
  createdAt: number;
  lastActiveAt: number;
}

interface PersistedUsernameRecord {
  username: string;
  ownerWallet: string;
  identityId: string;
  registeredAt: number;
}

interface PersistedValidatorRecord {
  wallet: string;
  bondedStake: number;
  effectivePower: number;
  joinedAt: number;
}

interface PersistedDeviceCertificate {
  accountId: string;
  deviceId: string;
  deviceSigningPublicKey: string;
  deviceEncryptionPublicKey: string;
  issuedAt: number;
  expiresAt: number;
  capabilities: number;
  rootSignature: string;
}

interface PersistedPasskeyCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  rpId: string;
  origin: string;
}

interface PendingPasskeyAuthorization {
  challenge: string;
  certificate: PersistedDeviceCertificate;
  expiresAt: number;
}

interface PersistedState {
  accounts: [string, AccountMeta][];
  usernames: PersistedUsernameRecord[];
  history: [string, PersistedUsernameRecord[]][];
  identityRoots?: [string, string][];
  deviceCertificates?: PersistedDeviceCertificate[];
  passkeys?: [string, PersistedPasskeyCredential[]][];
  pendingPasskeyAuthorizations?: [string, PendingPasskeyAuthorization][];
  validators: PersistedValidatorRecord[];
}

export class DevChainClient implements ChainApiClient {
  private usernames = new Map<string, UsernameRecord>();
  private walletToUsername = new Map<string, string>();
  private history = new Map<string, UsernameRecord[]>();
  private identityRoots = new Map<string, WalletAddress>();
  private deviceCertificates = new Map<string, DeviceCertificate>();
  private passkeys = new Map<string, PasskeyCredential[]>();
  private pendingPasskeyAuthorizations = new Map<string, PendingPasskeyAuthorization>();
  private accounts = new Map<string, AccountMeta>(); // walletHex -> meta
  private validators = new Map<string, ValidatorRecord>();

  constructor(private readonly statePath?: string) {
    if (statePath && existsSync(statePath)) {
      this.restore(readFileSync(statePath, "utf8"));
    }
  }

  /**
   * Register an account (call on first wallet creation).
   * Starts the account age clock.
   */
  registerAccount(wallet: WalletAddress): void {
    const walletHex = Buffer.from(wallet).toString("hex");
    if (!this.accounts.has(walletHex)) {
      this.accounts.set(walletHex, {
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      this.persist();
    }
  }

  /**
   * Record presence activity (call when user comes online).
   * Resets inactivity timer.
   */
  recordActivity(wallet: WalletAddress): void {
    const walletHex = Buffer.from(wallet).toString("hex");
    const meta = this.accounts.get(walletHex);
    if (meta) {
      meta.lastActiveAt = Date.now();
      this.persist();
    }
  }

  async registerUsername(
    username: string,
    wallet: WalletAddress,
    identityId: IdentityId
  ): Promise<UsernameRecord> {
    const walletHex = Buffer.from(wallet).toString("hex");
    const normalized = username.toLowerCase().trim();

    // Anti-squat: require account age ≥ 7 days
    const meta = this.accounts.get(walletHex);
    if (!meta) {
      throw new Error("Account not registered — call registerAccount first");
    }
    const accountAge = Date.now() - meta.createdAt;
    if (accountAge < MIN_ACCOUNT_AGE_MS) {
      const daysLeft = Math.ceil((MIN_ACCOUNT_AGE_MS - accountAge) / (24 * 60 * 60 * 1000));
      throw new Error(`Account too new — wait ${daysLeft} more days before registering a username`);
    }

    // AD-10: max 1 per wallet
    if (this.walletToUsername.has(walletHex)) {
      throw new Error("Wallet already owns a username (AD-10)");
    }

    const identityHex = Buffer.from(identityId).toString("hex");
    const rootWallet = this.identityRoots.get(identityHex);
    if (rootWallet && !Buffer.from(rootWallet).equals(Buffer.from(wallet))) {
      throw new Error("Identity root already bound");
    }

    // Check if username is taken AND release if previous owner inactive
    const existing = this.usernames.get(normalized);
    if (existing) {
      const ownerHex = Buffer.from(existing.ownerWallet).toString("hex");
      const ownerMeta = this.accounts.get(ownerHex);
      if (ownerMeta) {
        const inactiveFor = Date.now() - ownerMeta.lastActiveAt;
        if (inactiveFor >= INACTIVITY_RELEASE_MS) {
          // Release inactive username
          this.usernames.delete(normalized);
          this.walletToUsername.delete(ownerHex);
        } else {
          throw new Error("Username already taken");
        }
      } else {
        throw new Error("Username already taken");
      }
    }

    const record: UsernameRecord = {
      username: normalized,
      ownerWallet: wallet,
      identityId,
      registeredAt: Date.now(),
    };

    this.usernames.set(normalized, record);
    this.walletToUsername.set(walletHex, normalized);
    this.identityRoots.set(identityHex, wallet);
    this.appendHistory(normalized, record);
    this.persist();

    return record;
  }

  async resolveUsername(
    username: string
  ): Promise<UsernameRecord | null> {
    return this.usernames.get(username.toLowerCase().trim()) ?? null;
  }

  async transferUsername(): Promise<never> {
    throw new Error("Username transfer disabled — removed to prevent squatting/flipping");
  }

  async getUsernameHistory(username: string): Promise<UsernameRecord[]> {
    return this.history.get(username.toLowerCase().trim()) ?? [];
  }

  async getIdentityRoot(
    identityId: IdentityId
  ): Promise<{ wallet: WalletAddress } | null> {
    const wallet = this.identityRoots.get(Buffer.from(identityId).toString("hex"));
    return wallet ? { wallet } : null;
  }

  async registerDeviceCertificate(
    wallet: WalletAddress,
    certificate: DeviceCertificate
  ): Promise<DeviceCertificate> {
    if (
      wallet.length !== 32 ||
      certificate.accountId.length !== 32 ||
      certificate.deviceId.length !== 32 ||
      certificate.deviceSigningPublicKey.length !== 32 ||
      certificate.deviceEncryptionPublicKey.length !== 32 ||
      certificate.rootSignature.length !== 64 ||
      !Number.isFinite(certificate.issuedAt) ||
      !Number.isFinite(certificate.expiresAt) ||
      certificate.expiresAt <= certificate.issuedAt ||
      certificate.expiresAt <= Date.now()
    ) {
      throw new Error("Invalid device certificate");
    }
    const identityHex = Buffer.from(certificate.accountId).toString("hex");
    const root = this.identityRoots.get(identityHex);
    if (!root || !Buffer.from(root).equals(Buffer.from(wallet))) {
      throw new Error("Wallet is not the identity root");
    }
    if (!verifyDeviceCert(certificate, wallet)) {
      throw new Error("Invalid device certificate signature");
    }
    const stored = structuredClone(certificate);
    this.deviceCertificates.set(this.deviceCertificateKey(stored.accountId, stored.deviceId), stored);
    this.persist();
    return structuredClone(stored);
  }

  async resolveDeviceCertificate(
    identityId: IdentityId,
    deviceId: DeviceId
  ): Promise<DeviceCertificate | null> {
    const certificate = this.deviceCertificates.get(this.deviceCertificateKey(identityId, deviceId));
    const now = Date.now();
    return certificate && certificate.issuedAt <= now && now < certificate.expiresAt
      ? structuredClone(certificate)
      : null;
  }

  async registerPasskeyCredential(
    wallet: WalletAddress,
    identityId: IdentityId,
    credential: PasskeyCredential,
    rootSignature: Uint8Array
  ): Promise<PasskeyCredential> {
    const identityHex = Buffer.from(identityId).toString("hex");
    const root = this.identityRoots.get(identityHex);
    if (!root || !Buffer.from(root).equals(Buffer.from(wallet))) {
      throw new Error("Wallet is not the identity root");
    }
    if (
      !credential.credentialId ||
      credential.publicKey.length === 0 ||
      !Number.isSafeInteger(credential.counter) ||
      credential.counter < 0 ||
      !credential.rpId ||
      !credential.origin ||
      rootSignature.length !== 64 ||
      !verifyPasskeyCredentialAuthorization(wallet, identityId, credential, rootSignature)
    ) {
      throw new Error("Invalid passkey credential authorization");
    }
    const credentials = this.passkeys.get(identityHex) ?? [];
    if (credentials.some((item) => item.credentialId === credential.credentialId)) {
      throw new Error("Passkey credential already registered");
    }
    const stored = structuredClone(credential);
    credentials.push(stored);
    this.passkeys.set(identityHex, credentials);
    this.persist();
    return structuredClone(stored);
  }

  async beginPasskeyDeviceCertificateAuthorization(
    identityId: IdentityId,
    certificate: DeviceCertificate
  ): Promise<PasskeyCertificateChallenge> {
    const identityHex = Buffer.from(identityId).toString("hex");
    if (!this.identityRoots.has(identityHex) || !this.isDeviceCertificateShapeValid(certificate, identityId)) {
      throw new Error("Invalid device certificate");
    }
    if ((this.passkeys.get(identityHex)?.length ?? 0) === 0) {
      throw new Error("No passkey credential registered");
    }
    const authorization = {
      challenge: Buffer.from(randomBytes(32)).toString("base64url"),
      certificate: this.persistedDeviceCertificate(certificate),
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.pendingPasskeyAuthorizations.set(identityHex, authorization);
    this.persist();
    return { challenge: authorization.challenge, expiresAt: authorization.expiresAt };
  }

  async authorizeDeviceCertificateWithPasskey(
    identityId: IdentityId,
    certificate: DeviceCertificate,
    assertion: PasskeyAssertion
  ): Promise<DeviceCertificate> {
    const identityHex = Buffer.from(identityId).toString("hex");
    const pending = this.pendingPasskeyAuthorizations.get(identityHex);
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      !this.isDeviceCertificateShapeValid(certificate, identityId) ||
      !this.sameDeviceCertificate(this.deviceCertificate(pending.certificate), certificate)
    ) {
      throw new Error("Passkey authorization is missing or expired");
    }
    const credential = this.passkeys.get(identityHex)?.find((item) => item.credentialId === assertion.id);
    if (!credential) throw new Error("Passkey credential is not authorized");
    const result = await verifyAuthenticationResponse({
      response: assertion as never,
      expectedChallenge: pending.challenge,
      expectedOrigin: credential.origin,
      expectedRPID: credential.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: Uint8Array.from(credential.publicKey),
        counter: credential.counter,
      },
    });
    if (!result.verified) throw new Error("Invalid passkey assertion");
    credential.counter = result.authenticationInfo.newCounter;
    const stored = structuredClone(certificate);
    this.deviceCertificates.set(this.deviceCertificateKey(stored.accountId, stored.deviceId), stored);
    this.pendingPasskeyAuthorizations.delete(identityHex);
    this.persist();
    return structuredClone(stored);
  }

  private appendHistory(username: string, record: UsernameRecord): void {
    const list = this.history.get(username) ?? [];
    list.push(record);
    this.history.set(username, list);
  }

  private restore(serialized: string): void {
    const state = JSON.parse(serialized) as PersistedState;
    this.accounts = new Map(state.accounts);
    this.usernames = new Map(
      state.usernames.map((record) => [record.username, this.usernameRecord(record)])
    );
    this.history = new Map(
      state.history.map(([username, records]) => [
        username,
        records.map((record) => this.usernameRecord(record)),
      ])
    );
    this.identityRoots = new Map(
      (state.identityRoots ?? []).map(([identityHex, wallet]) => [
        identityHex,
        new Uint8Array(Buffer.from(wallet, "base64")),
      ])
    );
    this.deviceCertificates = new Map(
      (state.deviceCertificates ?? []).map((record) => {
        const certificate = this.deviceCertificate(record);
        return [this.deviceCertificateKey(certificate.accountId, certificate.deviceId), certificate];
      })
    );
    this.passkeys = new Map(
      (state.passkeys ?? []).map(([identityHex, credentials]) => [
        identityHex,
        credentials.map((credential) => this.passkeyCredential(credential)),
      ])
    );
    this.pendingPasskeyAuthorizations = new Map(state.pendingPasskeyAuthorizations ?? []);
    if (this.identityRoots.size === 0) {
      for (const records of this.history.values()) {
        for (const record of records) {
          this.identityRoots.set(
            Buffer.from(record.identityId).toString("hex"),
            record.ownerWallet
          );
        }
      }
    }
    this.validators = new Map(
      state.validators.map((record) => {
        const validator = this.validatorRecord(record);
        return [Buffer.from(validator.wallet).toString("hex"), validator];
      })
    );
    this.walletToUsername = new Map(
      [...this.usernames.values()].map((record) => [
        Buffer.from(record.ownerWallet).toString("hex"),
        record.username,
      ])
    );
  }

  private persist(): void {
    if (!this.statePath) return;
    const serializeUsername = (record: UsernameRecord): PersistedUsernameRecord => ({
      username: record.username,
      ownerWallet: Buffer.from(record.ownerWallet).toString("base64"),
      identityId: Buffer.from(record.identityId).toString("base64"),
      registeredAt: record.registeredAt,
    });
    const state: PersistedState = {
      accounts: [...this.accounts.entries()],
      usernames: [...this.usernames.values()].map(serializeUsername),
      history: [...this.history.entries()].map(([username, records]) => [
        username,
        records.map(serializeUsername),
      ]),
      identityRoots: [...this.identityRoots.entries()].map(([identityHex, wallet]) => [
        identityHex,
        Buffer.from(wallet).toString("base64"),
      ]),
      deviceCertificates: [...this.deviceCertificates.values()].map((certificate) => ({
        ...this.persistedDeviceCertificate(certificate),
      })),
      passkeys: [...this.passkeys.entries()].map(([identityHex, credentials]) => [
        identityHex,
        credentials.map((credential) => this.persistedPasskeyCredential(credential)),
      ]),
      pendingPasskeyAuthorizations: [...this.pendingPasskeyAuthorizations.entries()],
      validators: [...this.validators.values()].map((record) => ({
        wallet: Buffer.from(record.wallet).toString("base64"),
        bondedStake: record.bondedStake,
        effectivePower: record.effectivePower,
        joinedAt: record.joinedAt,
      })),
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state));
    renameSync(temporaryPath, this.statePath);
  }

  private usernameRecord(record: PersistedUsernameRecord): UsernameRecord {
    return {
      username: record.username,
      ownerWallet: new Uint8Array(Buffer.from(record.ownerWallet, "base64")),
      identityId: new Uint8Array(Buffer.from(record.identityId, "base64")),
      registeredAt: record.registeredAt,
    };
  }

  private validatorRecord(record: PersistedValidatorRecord): ValidatorRecord {
    return {
      wallet: new Uint8Array(Buffer.from(record.wallet, "base64")),
      bondedStake: record.bondedStake,
      effectivePower: record.effectivePower,
      joinedAt: record.joinedAt,
    };
  }

  private deviceCertificate(record: PersistedDeviceCertificate): DeviceCertificate {
    return {
      accountId: new Uint8Array(Buffer.from(record.accountId, "base64")),
      deviceId: new Uint8Array(Buffer.from(record.deviceId, "base64")),
      deviceSigningPublicKey: new Uint8Array(Buffer.from(record.deviceSigningPublicKey, "base64")),
      deviceEncryptionPublicKey: new Uint8Array(Buffer.from(record.deviceEncryptionPublicKey, "base64")),
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      capabilities: record.capabilities,
      rootSignature: new Uint8Array(Buffer.from(record.rootSignature, "base64")),
    };
  }

  private persistedDeviceCertificate(certificate: DeviceCertificate): PersistedDeviceCertificate {
    return {
      accountId: Buffer.from(certificate.accountId).toString("base64"),
      deviceId: Buffer.from(certificate.deviceId).toString("base64"),
      deviceSigningPublicKey: Buffer.from(certificate.deviceSigningPublicKey).toString("base64"),
      deviceEncryptionPublicKey: Buffer.from(certificate.deviceEncryptionPublicKey).toString("base64"),
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
      capabilities: certificate.capabilities,
      rootSignature: Buffer.from(certificate.rootSignature).toString("base64"),
    };
  }

  private passkeyCredential(record: PersistedPasskeyCredential): PasskeyCredential {
    return {
      credentialId: record.credentialId,
      publicKey: new Uint8Array(Buffer.from(record.publicKey, "base64")),
      counter: record.counter,
      rpId: record.rpId,
      origin: record.origin,
    };
  }

  private persistedPasskeyCredential(credential: PasskeyCredential): PersistedPasskeyCredential {
    return {
      credentialId: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      rpId: credential.rpId,
      origin: credential.origin,
    };
  }

  private isDeviceCertificateShapeValid(certificate: DeviceCertificate, identityId: IdentityId): boolean {
    return (
      certificate.accountId.length === 32 &&
      Buffer.from(certificate.accountId).equals(Buffer.from(identityId)) &&
      certificate.deviceId.length === 32 &&
      certificate.deviceSigningPublicKey.length === 32 &&
      certificate.deviceEncryptionPublicKey.length === 32 &&
      certificate.rootSignature.length === 64 &&
      Number.isFinite(certificate.issuedAt) &&
      Number.isFinite(certificate.expiresAt) &&
      certificate.expiresAt > certificate.issuedAt &&
      certificate.expiresAt > Date.now()
    );
  }

  private sameDeviceCertificate(a: DeviceCertificate, b: DeviceCertificate): boolean {
    return Buffer.from(a.accountId).equals(Buffer.from(b.accountId)) &&
      Buffer.from(a.deviceId).equals(Buffer.from(b.deviceId)) &&
      Buffer.from(a.deviceSigningPublicKey).equals(Buffer.from(b.deviceSigningPublicKey)) &&
      Buffer.from(a.deviceEncryptionPublicKey).equals(Buffer.from(b.deviceEncryptionPublicKey)) &&
      a.issuedAt === b.issuedAt &&
      a.expiresAt === b.expiresAt &&
      a.capabilities === b.capabilities &&
      Buffer.from(a.rootSignature).equals(Buffer.from(b.rootSignature));
  }

  private deviceCertificateKey(identityId: IdentityId, deviceId: DeviceId): string {
    return `${Buffer.from(identityId).toString("hex")}:${Buffer.from(deviceId).toString("hex")}`;
  }

  async joinValidatorSet(
    wallet: WalletAddress,
    bondedStake: number
  ): Promise<ValidatorRecord> {
    const hex = Buffer.from(wallet).toString("hex");
    if (this.validators.has(hex)) {
      throw new Error("Already a validator (code 20)");
    }
    if (bondedStake < MIN_BOND) {
      throw new Error("Insufficient stake (code 21)");
    }
    if (this.validators.size + 1 > MAX_VALIDATORS) {
      throw new Error("Validator set full (code 22)");
    }
    const effectivePower = Math.min(bondedStake, VALIDATOR_POWER_CAP);
    const rec: ValidatorRecord = {
      wallet,
      bondedStake,
      effectivePower,
      joinedAt: Date.now(),
    };
    this.validators.set(hex, rec);
    this.persist();
    return rec;
  }

  async leaveValidatorSet(wallet: WalletAddress): Promise<void> {
    const hex = Buffer.from(wallet).toString("hex");
    if (!this.validators.has(hex)) {
      throw new Error("Not a validator");
    }
    const after = this.validators.size - 1;
    // Bootstrap: allow leave while size was never required yet
    const bootstrapping = this.validators.size < MIN_VALIDATORS;
    if (!bootstrapping && after < MIN_VALIDATORS) {
      throw new Error("Would drop below min validators (code 23)");
    }
    this.validators.delete(hex);
    this.persist();
  }

  async listValidators(): Promise<ValidatorRecord[]> {
    return [...this.validators.values()].sort(
      (a, b) => b.effectivePower - a.effectivePower
    );
  }
}
