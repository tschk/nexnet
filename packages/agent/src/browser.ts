import { encode } from "cbor2";
import { generateSigningKeyPair, publicKeyFromSecret, randomBytes } from "@nexnet/crypto";
import {
  authorizePasskeyCredential,
  fromBase64Url,
  identityIdFromWallet,
  signIdentityProof,
  toBase64Url,
  toHex,
} from "@nexnet/protocol";
import type { SignInMethod } from "@nexnet/protocol";
import { GatewayApi } from "./api.js";
import { AgentCore } from "./core.js";
import type { Outbound, PasskeyAssertionResult, Platform, WalletSecret, WalletStore } from "./types.js";

export const FRAME_PREFIX = "@@nexnet ";
const DB_NAME = "nexnet";
const STORE = "keys";
const MAX_FRAME = 65_536;

export interface BridgeOptions {
  gatewayUrl: string | null;
  indexedDB?: IDBFactory;
  credentials?: CredentialsContainer;
  location?: { hostname: string; origin: string };
  now?: () => number;
  fetcher?: typeof fetch;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class KeyStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const opening = this.factory.open(DB_NAME, 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
    }
    return this.db;
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.open();
    const value = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
    return (value as T | undefined) ?? null;
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key));
  }

  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const existing = store.get(key);
      existing.onsuccess = () => {
        if (existing.result !== undefined) {
          resolve(false);
          return;
        }
        store.put(value, key);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

class IndexedDbWallet implements WalletStore {
  constructor(private readonly keys: KeyStore) {}

  async load(): Promise<WalletSecret | null> {
    const stored = await this.keys.get<{ secretKey: Uint8Array }>("wallet");
    if (!stored || stored.secretKey.length !== 32) return null;
    const secretKey = new Uint8Array(stored.secretKey);
    return { secretKey, publicKey: publicKeyFromSecret(secretKey) };
  }

  async create(): Promise<WalletSecret> {
    const wallet = generateSigningKeyPair();
    if (!(await this.keys.putIfAbsent("wallet", { secretKey: wallet.secretKey }))) {
      throw new Error("A wallet already exists in this browser");
    }
    return wallet;
  }
}

function coseFromSpki(spki: Uint8Array): Uint8Array {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("Unsupported passkey public key");
  return new Uint8Array(
    encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, point.slice(1, 33)],
        [-3, point.slice(33, 65)],
      ])
    )
  );
}

export interface Bridge {
  feed(bytes: Uint8Array): void;
  registerPasskey(): Promise<void>;
  passkeySupported(): boolean;
  hasWallet(): Promise<boolean>;
  close(): void;
}

export function createBridge(options: BridgeOptions, send: (frame: string) => void): Bridge {
  const factory = options.indexedDB ?? indexedDB;
  const credentials = options.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
  const where = options.location ?? location;
  const keys = new KeyStore(factory);
  const wallet = new IndexedDbWallet(keys);
  const now = options.now ?? (() => Date.now());
  const supported = () => !!credentials;
  let passkeyId: string | null = null;

  const platform: Platform = {
    gatewayUrl: options.gatewayUrl,
    wallet,
    methods: () => (passkeyId && supported() ? (["wallet", "passkey"] as SignInMethod[]) : (["wallet"] as SignInMethod[])),
    now,
    assertPasskey: async (challenge: string, rpId: string): Promise<PasskeyAssertionResult> => {
      const credentialId = passkeyId ?? (await keys.get<string>("passkey"));
      if (!credentials || !credentialId) throw new Error("No passkey registered in this browser");
      const result = (await credentials.get({
        publicKey: {
          challenge: fromBase64Url(challenge) as BufferSource,
          rpId,
          allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId) as BufferSource }],
          userVerification: "required",
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!result) throw new Error("Passkey assertion was cancelled");
      const response = result.response as AuthenticatorAssertionResponse;
      return {
        id: result.id,
        rawId: toBase64Url(new Uint8Array(result.rawId)),
        type: "public-key",
        response: {
          clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
          authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
          signature: toBase64Url(new Uint8Array(response.signature)),
          ...(response.userHandle ? { userHandle: toBase64Url(new Uint8Array(response.userHandle)) } : {}),
        },
        clientExtensionResults: {},
      };
    },
  };

  const emit = (output: Outbound) => send(`${FRAME_PREFIX}${JSON.stringify(output)}\n`);
  const core = new AgentCore(platform, emit, options.fetcher);
  const ready = (async () => {
    passkeyId = await keys.get<string>("passkey");
    await core.init();
  })().catch(() => undefined);

  const decoder = new TextDecoder();
  let pending = "";

  return {
    feed(bytes) {
      pending += decoder.decode(bytes, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.startsWith(FRAME_PREFIX)) {
          void ready.then(() => core.handleLine(line.slice(FRAME_PREFIX.length)));
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_FRAME) pending = "";
    },
    passkeySupported: supported,
    async hasWallet() {
      return (await wallet.load()) !== null;
    },
    async registerPasskey() {
      await ready;
      if (!supported() || !credentials) throw new Error("Passkeys are not supported in this browser");
      if (!options.gatewayUrl) throw new Error("No gateway is configured");
      const secret = await wallet.load();
      if (!secret) throw new Error("Create an identity in the terminal first");
      const api = new GatewayApi(options.gatewayUrl, options.fetcher);
      await api.request("POST", "/v1/identity", {
        wallet: toHex(secret.publicKey),
        proof: toBase64Url(signIdentityProof(secret.secretKey, secret.publicKey)),
      });
      const created = (await credentials.create({
        publicKey: {
          rp: { id: where.hostname, name: "Nexnet" },
          user: { id: randomBytes(16) as BufferSource, name: "nexnet", displayName: "Nexnet" },
          challenge: randomBytes(32) as BufferSource,
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          attestation: "none",
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!created) throw new Error("Passkey registration was cancelled");
      const response = created.response as AuthenticatorAttestationResponse;
      const spki = response.getPublicKey();
      if (!spki) throw new Error("The authenticator did not return a public key");
      const credential = {
        credentialId: toBase64Url(new Uint8Array(created.rawId)),
        publicKey: coseFromSpki(new Uint8Array(spki)),
        counter: 0,
        rpId: where.hostname,
        origin: where.origin,
      };
      const identityId = identityIdFromWallet(secret.publicKey);
      await api.request("POST", "/v1/credentials/passkey", {
        identityId: toHex(identityId),
        credential: { ...credential, publicKey: toBase64Url(credential.publicKey) },
        rootSignature: toBase64Url(authorizePasskeyCredential(secret.secretKey, identityId, credential)),
      });
      await keys.put("passkey", credential.credentialId);
      passkeyId = credential.credentialId;
    },
    close() {
      core.close();
    },
  };
}
