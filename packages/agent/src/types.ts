import type { SignInMethod } from "@nexnet/protocol";

export type ChannelName = "updates" | "public";

export interface Author {
  id: string;
  short: string;
  username: string | null;
}

export interface Message {
  id: string;
  author: Author;
  body: string;
  at: number;
}

export interface AgentState {
  gateway: { status: "unconfigured" | "offline" | "online"; url: string | null };
  identity: { id: string; short: string; username: string | null } | null;
  session: { method: SignInMethod; expiresAt: number } | null;
  owner: boolean;
}

export interface WalletSecret {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface WalletStore {
  load(): Promise<WalletSecret | null>;
  create(): Promise<WalletSecret>;
}

export interface SshSignature {
  publicKey: string;
  signature: string;
}

export interface PasskeyAssertionResult {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, unknown>;
}

export interface Platform {
  gatewayUrl: string | null;
  audience?: string;
  wallet: WalletStore;
  methods(): SignInMethod[];
  now(): number;
  signSsh?(preimage: Uint8Array): Promise<SshSignature>;
  assertPasskey?(challenge: string, rpId: string): Promise<PasskeyAssertionResult>;
}

export type Outbound =
  | { id: number | string; ok: true; result: unknown }
  | { id: number | string | null; ok: false; error: { code: string; message: string } }
  | { event: "message"; channel: ChannelName; message: Message }
  | { event: "state"; state: AgentState }
  | { event: "error"; code: string; message: string };
