import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "cbor2";
import { DevChainClient } from "@nexnet/client/chain-stub";
import { generateKeyPair, generateSigningKeyPair, sign } from "@nexnet/crypto";
import {
  authorizePasskeyCredential,
  cdeEncode,
  formatSshPublicKey,
  identityIdFromWallet,
  issueDeviceCert,
  signEvent,
  signIdentityProof,
  signInPreimage,
  signRevocation,
  signSshCommitment,
  sshFingerprint,
} from "@nexnet/protocol";
import type { SignInMethod } from "@nexnet/protocol";
import type { DeviceCertificate, Revocation } from "@nexnet/types";
import { Gateway } from "../gateway.js";
import type { GatewayHandle } from "../gateway.js";
import type { GatewayConfig } from "../config.js";
import { certificateToJson, eventToJson, revocationToJson, toBase64Url, toHex } from "../wire.js";

export const RP_ID = "nexnet.test";
export const ORIGIN = "https://nexnet.test";
export const AUDIENCE = "nexnet:test";

export interface Clock {
  offset: number;
  now(): number;
}

export function makeClock(): Clock {
  const clock: Clock = { offset: 0, now: () => Date.now() + clock.offset };
  return clock;
}

export interface Harness {
  gateway: Gateway;
  handle: GatewayHandle;
  chain: DevChainClient;
  clock: Clock;
  url: string;
  owner: Wallet;
  dir: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  withOwner?: boolean;
  origins?: string[];
  rpId?: string | null;
  stateDir?: string;
  publicRetentionMs?: number;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = options.stateDir ?? mkdtempSync(join(tmpdir(), "nexnet-gateway-"));
  const clock = makeClock();
  const owner = makeWallet();
  const chain = new DevChainClient(join(dir, "chain.json"));
  const config: GatewayConfig = {
    audience: AUDIENCE,
    ownerIdentity: options.withOwner === false ? null : owner.identityHex,
    stateDir: dir,
    rpId: options.rpId === undefined ? RP_ID : options.rpId,
    origins: options.origins ?? [ORIGIN],
    now: () => clock.now(),
    publicRetentionMs: options.publicRetentionMs ?? 24 * 60 * 60 * 1000,
    sessionMaxMs: 12 * 60 * 60 * 1000,
    wsAuthTimeoutMs: 300,
  };
  const gateway = new Gateway(config, chain);
  const handle = gateway.listen(0);
  return {
    gateway,
    handle,
    chain,
    clock,
    url: handle.url,
    owner,
    dir,
    close: async () => {
      await handle.close();
      if (!options.stateDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Wallet {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  identityId: Uint8Array;
  identityHex: string;
}

export function makeWallet(): Wallet {
  const { secretKey, publicKey } = generateSigningKeyPair();
  const identityId = identityIdFromWallet(publicKey);
  return { secretKey, publicKey, identityId, identityHex: toHex(identityId) };
}

export interface Device {
  signingSecretKey: Uint8Array;
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  deviceId: Uint8Array;
}

export function makeDevice(): Device {
  const signing = generateSigningKeyPair();
  const encryption = generateKeyPair();
  return {
    signingSecretKey: signing.secretKey,
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    deviceId: randomBytes(32),
  };
}

export function issueCertificate(
  wallet: Wallet,
  device: Device,
  clock: Clock,
  lifetimeMs = 60 * 60 * 1000
): DeviceCertificate {
  const issuedAt = clock.now();
  return issueDeviceCert(
    wallet.secretKey,
    device.signingPublicKey,
    device.encryptionPublicKey,
    new Uint8Array(device.deviceId),
    wallet.identityId,
    issuedAt,
    issuedAt + lifetimeMs,
    1
  );
}

export function unsignedCertificate(
  wallet: Wallet,
  device: Device,
  clock: Clock,
  lifetimeMs = 60 * 60 * 1000
): DeviceCertificate {
  const issuedAt = clock.now();
  return {
    accountId: wallet.identityId,
    deviceId: new Uint8Array(device.deviceId),
    deviceSigningPublicKey: device.signingPublicKey,
    deviceEncryptionPublicKey: device.encryptionPublicKey,
    issuedAt,
    expiresAt: issuedAt + lifetimeMs,
    capabilities: 1,
    rootSignature: new Uint8Array(64),
  };
}

export interface ApiResult {
  status: number;
  body: any;
}

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {}
): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function createIdentity(base: string, wallet: Wallet): Promise<ApiResult> {
  return api(base, "POST", "/v1/identity", {
    wallet: toHex(wallet.publicKey),
    proof: toBase64Url(signIdentityProof(wallet.secretKey, wallet.publicKey)),
  });
}

export interface Challenge {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  audience: string;
  passkeyChallenge: string | null;
}

export async function requestChallenge(
  base: string,
  method: SignInMethod,
  certificate: DeviceCertificate
): Promise<ApiResult> {
  return api(base, "POST", "/v1/auth/challenge", { method, certificate: certificateToJson(certificate) });
}

export function preimageFor(method: SignInMethod, challenge: Challenge, certificate: DeviceCertificate): Uint8Array {
  return signInPreimage({
    audience: challenge.audience,
    method,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    certificate,
  });
}

export interface Session {
  token: string;
  identityId: string;
  deviceId: string;
  nextSequence: number;
  device: Device;
  wallet: Wallet;
  certificate: DeviceCertificate;
  sequence: number;
}

export async function signInWallet(
  h: Pick<Harness, "url" | "clock">,
  wallet: Wallet,
  device = makeDevice()
): Promise<Session> {
  const certificate = issueCertificate(wallet, device, h.clock);
  const challenge = await requestChallenge(h.url, "wallet", certificate);
  if (challenge.status !== 200) throw new Error(`challenge failed: ${JSON.stringify(challenge.body)}`);
  const preimage = preimageFor("wallet", challenge.body, certificate);
  const verified = await api(h.url, "POST", "/v1/auth/verify", {
    challengeId: challenge.body.challengeId,
    deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
  });
  if (verified.status !== 201) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  return {
    token: verified.body.token,
    identityId: verified.body.identityId,
    deviceId: verified.body.deviceId,
    nextSequence: verified.body.nextSequence,
    device,
    wallet,
    certificate,
    sequence: verified.body.nextSequence,
  };
}

export interface SshKey {
  dir: string;
  keyPath: string;
  publicKeyLine: string;
  publicKey: Uint8Array;
  fingerprint: string;
  cleanup(): void;
}

export async function makeSshKey(): Promise<SshKey> {
  const dir = mkdtempSync(join(tmpdir(), "nexnet-ssh-"));
  const keyPath = join(dir, "id_ed25519");
  const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", keyPath]);
  if (generated.exitCode !== 0) throw new Error("ssh-keygen failed");
  const publicKeyLine = (await Bun.file(`${keyPath}.pub`).text()).trim();
  const { parseSshPublicKey } = await import("@nexnet/protocol");
  const publicKey = parseSshPublicKey(publicKeyLine);
  return {
    dir,
    keyPath,
    publicKeyLine,
    publicKey,
    fingerprint: sshFingerprint(publicKey),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function sshSignAsync(key: SshKey, message: Uint8Array, namespace = "nexnet-auth"): Promise<string> {
  const messagePath = join(key.dir, `message-${randomBytes(4).toString("hex")}`);
  writeFileSync(messagePath, message);
  const result = Bun.spawnSync(["ssh-keygen", "-Y", "sign", "-f", key.keyPath, "-n", namespace, messagePath]);
  if (result.exitCode !== 0) throw new Error(`ssh-keygen sign failed: ${result.stderr.toString()}`);
  return Bun.file(`${messagePath}.sig`).text();
}

export async function linkSshKey(base: string, wallet: Wallet, key: SshKey): Promise<ApiResult> {
  return api(base, "POST", "/v1/credentials/ssh", {
    identityId: wallet.identityHex,
    publicKey: key.publicKeyLine,
    rootSignature: toBase64Url(
      signSshCommitment(wallet.secretKey, wallet.identityId, { algorithm: "ssh-ed25519", publicKey: key.publicKey })
    ),
  });
}

export async function signInSsh(
  h: Pick<Harness, "url" | "clock">,
  wallet: Wallet,
  key: SshKey,
  device = makeDevice()
): Promise<{ result: ApiResult; session?: Session; challenge: Challenge; certificate: DeviceCertificate }> {
  const certificate = unsignedCertificate(wallet, device, h.clock);
  const challengeResponse = await requestChallenge(h.url, "ssh", certificate);
  if (challengeResponse.status !== 200) throw new Error(`challenge failed: ${JSON.stringify(challengeResponse.body)}`);
  const challenge = challengeResponse.body as Challenge;
  const preimage = preimageFor("ssh", challenge, certificate);
  const result = await api(h.url, "POST", "/v1/auth/verify", {
    challengeId: challenge.challengeId,
    deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
    ssh: { publicKey: key.publicKeyLine, signature: await sshSignAsync(key, preimage) },
  });
  const session: Session | undefined =
    result.status === 201
      ? {
          token: result.body.token,
          identityId: result.body.identityId,
          deviceId: result.body.deviceId,
          nextSequence: result.body.nextSequence,
          device,
          wallet,
          certificate,
          sequence: result.body.nextSequence,
        }
      : undefined;
  return { result, session, challenge, certificate };
}

export interface Authenticator {
  credentialId: string;
  coseKey: Uint8Array;
  counter: number;
  privateKey: KeyObject;
}

export function makeAuthenticator(): Authenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = new Uint8Array(
    encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ])
    )
  );
  return { credentialId: randomBytes(16).toString("base64url"), coseKey, counter: 0, privateKey };
}

export async function registerPasskey(base: string, wallet: Wallet, authenticator: Authenticator): Promise<ApiResult> {
  const credential = {
    credentialId: authenticator.credentialId,
    publicKey: authenticator.coseKey,
    counter: authenticator.counter,
    rpId: RP_ID,
    origin: ORIGIN,
  };
  return api(base, "POST", "/v1/credentials/passkey", {
    identityId: wallet.identityHex,
    credential: { ...credential, publicKey: toBase64Url(credential.publicKey) },
    rootSignature: toBase64Url(authorizePasskeyCredential(wallet.secretKey, wallet.identityId, credential)),
  });
}

export function assertion(authenticator: Authenticator, challenge: string, options: { origin?: string; rpId?: string } = {}) {
  authenticator.counter += 1;
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: options.origin ?? ORIGIN, crossOrigin: false })
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(authenticator.counter);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(options.rpId ?? RP_ID).digest(),
    Buffer.from([0x05]),
    counter,
  ]);
  const signer = createSign("SHA256");
  signer.update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]));
  const signature = signer.sign(authenticator.privateKey);
  return {
    id: authenticator.credentialId,
    rawId: authenticator.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
    clientExtensionResults: {},
  };
}

export async function signInPasskey(
  h: Pick<Harness, "url" | "clock">,
  wallet: Wallet,
  authenticator: Authenticator,
  device = makeDevice(),
  assertionOptions: { origin?: string; rpId?: string } = {}
): Promise<{ result: ApiResult; session?: Session; challenge: Challenge; certificate: DeviceCertificate }> {
  const certificate = unsignedCertificate(wallet, device, h.clock);
  const challengeResponse = await requestChallenge(h.url, "passkey", certificate);
  if (challengeResponse.status !== 200) {
    throw new Error(`challenge failed: ${JSON.stringify(challengeResponse.body)}`);
  }
  const challenge = challengeResponse.body as Challenge;
  const preimage = preimageFor("passkey", challenge, certificate);
  const result = await api(h.url, "POST", "/v1/auth/verify", {
    challengeId: challenge.challengeId,
    deviceSignature: toBase64Url(sign(device.signingSecretKey, preimage)),
    passkey: assertion(authenticator, challenge.passkeyChallenge!, assertionOptions),
  });
  const session: Session | undefined =
    result.status === 201
      ? {
          token: result.body.token,
          identityId: result.body.identityId,
          deviceId: result.body.deviceId,
          nextSequence: result.body.nextSequence,
          device,
          wallet,
          certificate,
          sequence: result.body.nextSequence,
        }
      : undefined;
  return { result, session, challenge, certificate };
}

export function postEvent(
  session: Session,
  channel: string,
  body: string,
  options: { createdAt?: number; sequence?: number; signWith?: Uint8Array } = {}
) {
  const sequence = options.sequence ?? session.sequence;
  return signEvent(
    {
      protocolVersion: 1,
      eventType: "channel.post",
      authorIdentityId: session.wallet.identityId,
      authorDeviceId: new Uint8Array(session.device.deviceId),
      createdAt: options.createdAt ?? Date.now(),
      sequence,
      parentIds: [],
      payload: cdeEncode({ channel, body }),
    },
    options.signWith ?? session.device.signingSecretKey
  );
}

export async function post(
  h: Pick<Harness, "url">,
  session: Session,
  channel: string,
  body: string,
  options: { createdAt?: number; sequence?: number; signWith?: Uint8Array; token?: string } = {}
): Promise<ApiResult> {
  const event = postEvent(session, channel, body, options);
  const result = await api(
    h.url,
    "POST",
    `/v1/channels/${channel}/messages`,
    { event: eventToJson(event) },
    options.token ?? session.token
  );
  if (result.status === 201 && options.sequence === undefined) session.sequence += 1;
  return result;
}

export function revocation(
  wallet: Wallet,
  kind: Revocation["kind"],
  credentialId: string,
  sequence: number
): Revocation {
  return signRevocation(wallet.secretKey, { accountId: wallet.identityId, kind, credentialId, sequence });
}

export async function revoke(base: string, value: Revocation): Promise<ApiResult> {
  return api(base, "POST", "/v1/credentials/revoke", { revocation: revocationToJson(value) });
}

export function formatKey(publicKey: Uint8Array): string {
  return formatSshPublicKey(publicKey);
}
