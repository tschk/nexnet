/**
 * X25519 key agreement (Diffie-Hellman)
 */
import { x25519 } from "@noble/curves/ed25519";

export function generateKeyPair(): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

export function getSharedSecret(
  ourSk: Uint8Array,
  theirPk: Uint8Array
): Uint8Array {
  return x25519.getSharedSecret(ourSk, theirPk);
}
