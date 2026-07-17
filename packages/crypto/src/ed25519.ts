/**
 * Ed25519 signing operations
 */
import { ed25519 } from "@noble/curves/ed25519";
import type { Signature, PublicKey } from "@nexnet/types";

export function generateSigningKeyPair(): {
  secretKey: Uint8Array;
  publicKey: PublicKey;
} {
  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

export function sign(
  secretKey: Uint8Array,
  message: Uint8Array
): Signature {
  return ed25519.sign(message, secretKey);
}

export function verify(
  publicKey: PublicKey,
  message: Uint8Array,
  signature: Signature
): boolean {
  return ed25519.verify(signature, message, publicKey);
}
