/**
 * @nexnet/crypto — cryptographic primitives
 *
 * Re-exports all modules and provides a default CryptoProvider
 * implementing the interface from @nexnet/types.
 */
import type { CryptoProvider } from "@nexnet/types";

export { deriveId } from "./hash.js";
export { generateSigningKeyPair, sign, verify } from "./ed25519.js";
export { generateKeyPair, getSharedSecret } from "./x25519.js";
export { encrypt, decrypt } from "./aead.js";
export { deriveKey as hkdf } from "./kdf.js";
export { randomBytes } from "./random.js";

import { deriveId } from "./hash.js";
import { generateSigningKeyPair, sign, verify } from "./ed25519.js";
import { encrypt, decrypt } from "./aead.js";
import { deriveKey } from "./kdf.js";
import { randomBytes } from "./random.js";

/** Default CryptoProvider backed by noble libs */
export const cryptoProvider: CryptoProvider = {
  deriveId,
  sign,
  verify,
  generateSigningKeyPair,
  encrypt,
  decrypt,
  randomBytes,
  hkdf: deriveKey,
};
