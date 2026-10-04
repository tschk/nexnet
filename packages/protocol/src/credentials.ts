import type {
  CredentialKind,
  DeviceCertificate,
  IdentityId,
  PublicKey,
  Revocation,
  Signature,
  SshKeyCommitment,
  WalletAddress,
} from "@nexnet/types";
import { DOMAIN_IDENTITY_ID } from "@nexnet/types";
import { deriveId, sign, verify } from "@nexnet/crypto";
import { cdeEncode } from "./cde.js";

const IDENTITY_PROOF_DOMAIN = "nexnet identity registration v1";
const SSH_COMMITMENT_DOMAIN = "nexnet ssh key commitment v1";
const REVOCATION_DOMAIN = "nexnet revocation v1";
const SIGNIN_DOMAIN = "nexnet sign-in v1";

export type SignInMethod = "wallet" | "ssh" | "passkey";

export interface SignInChallengeFields {
  audience: string;
  method: SignInMethod;
  challengeId: string;
  nonce: string;
  expiresAt: number;
  certificate: Pick<
    DeviceCertificate,
    | "accountId"
    | "deviceId"
    | "deviceSigningPublicKey"
    | "deviceEncryptionPublicKey"
    | "issuedAt"
    | "expiresAt"
    | "capabilities"
  >;
}

export function identityIdFromWallet(wallet: WalletAddress): IdentityId {
  return deriveId(DOMAIN_IDENTITY_ID, wallet);
}

function identityProofPreimage(wallet: WalletAddress): Uint8Array {
  return cdeEncode({ domain: IDENTITY_PROOF_DOMAIN, wallet });
}

export function signIdentityProof(rootSk: Uint8Array, wallet: WalletAddress): Signature {
  return sign(rootSk, identityProofPreimage(wallet));
}

export function verifyIdentityProof(wallet: WalletAddress, proof: Signature): boolean {
  return verify(wallet, identityProofPreimage(wallet), proof);
}

function sshCommitmentPreimage(
  accountId: IdentityId,
  commitment: Pick<SshKeyCommitment, "algorithm" | "publicKey">,
): Uint8Array {
  return cdeEncode({
    domain: SSH_COMMITMENT_DOMAIN,
    accountId,
    algorithm: commitment.algorithm,
    publicKey: commitment.publicKey,
  });
}

export function signSshCommitment(
  rootSk: Uint8Array,
  accountId: IdentityId,
  commitment: Pick<SshKeyCommitment, "algorithm" | "publicKey">,
): Signature {
  return sign(rootSk, sshCommitmentPreimage(accountId, commitment));
}

export function verifySshCommitment(
  rootPk: PublicKey,
  accountId: IdentityId,
  commitment: Pick<SshKeyCommitment, "algorithm" | "publicKey">,
  rootSignature: Signature,
): boolean {
  return verify(rootPk, sshCommitmentPreimage(accountId, commitment), rootSignature);
}

function revocationPreimage(
  revocation: Pick<Revocation, "accountId" | "kind" | "credentialId" | "sequence">,
): Uint8Array {
  return cdeEncode({
    domain: REVOCATION_DOMAIN,
    accountId: revocation.accountId,
    kind: revocation.kind satisfies CredentialKind,
    credentialId: revocation.credentialId,
    sequence: revocation.sequence,
  });
}

export function signRevocation(rootSk: Uint8Array, revocation: Omit<Revocation, "rootSignature">): Revocation {
  return { ...revocation, rootSignature: sign(rootSk, revocationPreimage(revocation)) };
}

export function verifyRevocation(rootPk: PublicKey, revocation: Revocation): boolean {
  return verify(rootPk, revocationPreimage(revocation), revocation.rootSignature);
}

export function signInPreimage(fields: SignInChallengeFields): Uint8Array {
  return cdeEncode({
    domain: SIGNIN_DOMAIN,
    audience: fields.audience,
    method: fields.method,
    challengeId: fields.challengeId,
    nonce: fields.nonce,
    expiresAt: fields.expiresAt,
    accountId: fields.certificate.accountId,
    deviceId: fields.certificate.deviceId,
    deviceSigningPublicKey: fields.certificate.deviceSigningPublicKey,
    deviceEncryptionPublicKey: fields.certificate.deviceEncryptionPublicKey,
    certificateIssuedAt: fields.certificate.issuedAt,
    certificateExpiresAt: fields.certificate.expiresAt,
    capabilities: fields.certificate.capabilities,
  });
}
