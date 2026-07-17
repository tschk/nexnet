/**
 * XChaCha20-Poly1305 AEAD (AD-5)
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

export function encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.encrypt(plaintext);
}

export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}
