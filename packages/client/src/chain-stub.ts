/**
 * @nexnet/client — DevChainClient
 *
 * In-memory chain stub for development.
 * AD-10: max 1 username per wallet, no transfer, anti-squat.
 * Replaced when .in chain is ready.
 */

import type {
  ChainApiClient,
  UsernameRecord,
  ValidatorRecord,
  WalletAddress,
  IdentityId,
} from "@nexnet/types";

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

export class DevChainClient implements ChainApiClient {
  private usernames = new Map<string, UsernameRecord>();
  private walletToUsername = new Map<string, string>();
  private history = new Map<string, UsernameRecord[]>();
  private accounts = new Map<string, AccountMeta>(); // walletHex -> meta
  private validators = new Map<string, ValidatorRecord>();

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
    this.appendHistory(normalized, record);

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
    for (const record of this.usernames.values()) {
      if (Buffer.from(record.identityId).equals(Buffer.from(identityId))) {
        return { wallet: record.ownerWallet };
      }
    }
    return null;
  }

  private appendHistory(username: string, record: UsernameRecord): void {
    const list = this.history.get(username) ?? [];
    list.push(record);
    this.history.set(username, list);
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
  }

  async listValidators(): Promise<ValidatorRecord[]> {
    return [...this.validators.values()].sort(
      (a, b) => b.effectivePower - a.effectivePower
    );
  }
}
