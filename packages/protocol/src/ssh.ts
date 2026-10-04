import { sha256, sha512 } from "@noble/hashes/sha2";
import { verify } from "@nexnet/crypto";
import type { PublicKey } from "@nexnet/types";

export const SSH_SIGNATURE_NAMESPACE = "nexnet-auth";

const SSH_ED25519 = "ssh-ed25519";
const SSHSIG_MAGIC = new TextEncoder().encode("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const MAX_SIGNATURE_BYTES = 4096;

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  raw(length: number): Uint8Array {
    if (length < 0 || length > this.remaining()) throw new Error("Truncated SSH data");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint32(): number {
    const b = this.raw(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  string(): Uint8Array {
    return this.raw(this.uint32());
  }

  text(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.string());
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function sshString(bytes: Uint8Array): Uint8Array {
  return concat(uint32(bytes.length), bytes);
}

function sshText(text: string): Uint8Array {
  return sshString(new TextEncoder().encode(text));
}

export function sshPublicKeyBlob(publicKey: PublicKey): Uint8Array {
  return concat(sshText(SSH_ED25519), sshString(publicKey));
}

export function sshFingerprint(publicKey: PublicKey): string {
  return `SHA256:${Buffer.from(sha256(sshPublicKeyBlob(publicKey))).toString("base64").replace(/=+$/, "")}`;
}

function parsePublicKeyBlob(blob: Uint8Array): PublicKey {
  const reader = new Reader(blob);
  if (reader.text() !== SSH_ED25519) throw new Error("Only ssh-ed25519 keys are supported");
  const key = reader.string();
  if (key.length !== 32 || reader.remaining() !== 0) throw new Error("Invalid ssh-ed25519 key");
  return new Uint8Array(key);
}

export function parseSshPublicKey(line: string): PublicKey {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] !== SSH_ED25519) throw new Error("Only ssh-ed25519 keys are supported");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1]!)) throw new Error("Invalid ssh-ed25519 key");
  return parsePublicKeyBlob(new Uint8Array(Buffer.from(fields[1]!, "base64")));
}

export function formatSshPublicKey(publicKey: PublicKey): string {
  return `${SSH_ED25519} ${Buffer.from(sshPublicKeyBlob(publicKey)).toString("base64")}`;
}

function dearmor(armored: string): Uint8Array {
  const lines = armored.trim().split(/\r?\n/);
  if (lines.length < 3 || lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) {
    throw new Error("Invalid SSH signature armor");
  }
  const body = lines.slice(1, -1).join("");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length > MAX_SIGNATURE_BYTES * 2) {
    throw new Error("Invalid SSH signature armor");
  }
  return new Uint8Array(Buffer.from(body, "base64"));
}

export function verifySshSignature(
  armoredSignature: string,
  message: Uint8Array,
  expectedPublicKey: PublicKey,
  namespace: string = SSH_SIGNATURE_NAMESPACE
): boolean {
  try {
    const reader = new Reader(dearmor(armoredSignature));
    const magic = reader.raw(SSHSIG_MAGIC.length);
    if (Buffer.compare(Buffer.from(magic), Buffer.from(SSHSIG_MAGIC)) !== 0) return false;
    if (reader.uint32() !== 1) return false;
    const publicKey = parsePublicKeyBlob(reader.string());
    if (Buffer.compare(Buffer.from(publicKey), Buffer.from(expectedPublicKey)) !== 0) return false;
    if (reader.text() !== namespace) return false;
    if (reader.string().length !== 0) return false;
    const hashAlgorithm = reader.text();
    const digest =
      hashAlgorithm === "sha512" ? sha512(message) : hashAlgorithm === "sha256" ? sha256(message) : null;
    if (!digest) return false;
    const signatureBlob = new Reader(reader.string());
    if (reader.remaining() !== 0) return false;
    if (signatureBlob.text() !== SSH_ED25519) return false;
    const signature = signatureBlob.string();
    if (signature.length !== 64 || signatureBlob.remaining() !== 0) return false;
    const signed = concat(
      SSHSIG_MAGIC,
      sshText(namespace),
      sshString(new Uint8Array(0)),
      sshText(hashAlgorithm),
      sshString(digest)
    );
    return verify(publicKey, signed, new Uint8Array(signature));
  } catch {
    return false;
  }
}
