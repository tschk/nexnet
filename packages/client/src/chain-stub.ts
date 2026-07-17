/**
 * @nettle/client — DevChainClient
 *
 * In-memory chain stub for development.
 * AD-10: max 1 username per wallet, free registration, free transfer.
 * Replaced when .in chain is ready.
 */

import type {
  ChainApiClient,
  UsernameRecord,
  WalletAddress,
  IdentityId,
} from "@nettle/types";

export class DevChainClient implements ChainApiClient {
  private usernames = new Map<string, UsernameRecord>();
  private walletToUsername = new Map<string, string>();
  private history = new Map<string, UsernameRecord[]>();

  async registerUsername(
    username: string,
    wallet: WalletAddress,
    identityId: IdentityId
  ): Promise<UsernameRecord> {
    const walletHex = Buffer.from(wallet).toString("hex");
    const normalized = username.toLowerCase().trim();

    if (this.walletToUsername.has(walletHex)) {
      throw new Error("Wallet already owns a username (AD-10)");
    }
    if (this.usernames.has(normalized)) {
      throw new Error("Username already taken");
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

  async transferUsername(
    username: string,
    newOwner: WalletAddress
  ): Promise<UsernameRecord> {
    const normalized = username.toLowerCase().trim();
    const existing = this.usernames.get(normalized);
    if (!existing) {
      throw new Error("Username not found");
    }

    const oldWalletHex = Buffer.from(existing.ownerWallet).toString("hex");
    this.walletToUsername.delete(oldWalletHex);

    const updated: UsernameRecord = {
      ...existing,
      ownerWallet: newOwner,
      registeredAt: Date.now(),
    };

    this.usernames.set(normalized, updated);
    this.walletToUsername.set(Buffer.from(newOwner).toString("hex"), normalized);
    this.appendHistory(normalized, updated);

    return updated;
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
}
