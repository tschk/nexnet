/**
 * BLAKE3-256 domain separation (AD-8)
 *
 * Uses BLAKE3's native KDF mode (derive_key): blake3(data, { context }).
 * Different context strings produce completely different outputs for the same data.
 */
import { blake3 } from "@noble/hashes/blake3";

export function deriveId(context: string, data: Uint8Array): Uint8Array {
  return blake3(data, { context, dkLen: 32 });
}
