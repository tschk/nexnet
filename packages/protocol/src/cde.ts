/**
 * CBOR Deterministic Encoding (CDE) — AD-4, AD-4b
 *
 * Canonical encoding: map keys sorted lexicographically by UTF-8 bytes,
 * definite-length encoding only, no indeterminate-length items.
 */
import { encode, decode, cdeEncodeOptions } from "cbor2";

/** Encode a value to canonical CBOR bytes (CDE). */
export function cdeEncode(value: unknown): Uint8Array {
  return encode(value, cdeEncodeOptions);
}

/** Decode canonical CBOR bytes to a value. */
export function cdeDecode<T = unknown>(bytes: Uint8Array): T {
  return decode(bytes) as T;
}
