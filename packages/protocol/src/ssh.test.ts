import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SSH_SIGNATURE_NAMESPACE,
  formatSshPublicKey,
  parseSshPublicKey,
  sshFingerprint,
  verifySshSignature,
} from "./ssh.js";

function generate() {
  const dir = mkdtempSync(join(tmpdir(), "nexnet-sshsig-"));
  const keyPath = join(dir, "key");
  const result = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", keyPath]);
  if (result.exitCode !== 0) throw new Error("ssh-keygen unavailable");
  return { dir, keyPath };
}

function signWith(keyPath: string, dir: string, message: Uint8Array, namespace: string, hash?: string): string {
  const file = join(dir, `msg-${Math.random().toString(16).slice(2)}`);
  writeFileSync(file, message);
  const args = ["ssh-keygen", "-Y", "sign", "-f", keyPath, "-n", namespace];
  if (hash) args.push("-O", `hashalg=${hash}`);
  args.push(file);
  const result = Bun.spawnSync(args);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return readFileSync(`${file}.sig`, "utf8");
}

describe("OpenSSH ed25519 keys", () => {
  test("parses, re-formats and fingerprints like ssh-keygen", () => {
    const { dir, keyPath } = generate();
    try {
      const line = readFileSync(`${keyPath}.pub`, "utf8").trim();
      const publicKey = parseSshPublicKey(line);
      expect(publicKey).toHaveLength(32);
      expect(formatSshPublicKey(publicKey)).toBe(line.split(" ").slice(0, 2).join(" "));
      const listed = Bun.spawnSync(["ssh-keygen", "-lf", `${keyPath}.pub`]).stdout.toString();
      expect(listed).toContain(sshFingerprint(publicKey));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects other algorithms and malformed keys", () => {
    expect(() => parseSshPublicKey("ssh-rsa AAAAB3NzaC1yc2E")).toThrow();
    expect(() => parseSshPublicKey("ssh-ed25519")).toThrow();
    expect(() => parseSshPublicKey("ssh-ed25519 !!!!")).toThrow();
    expect(() => parseSshPublicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA")).toThrow();
  });
});

describe("SSHSIG verification", () => {
  test("accepts real ssh-keygen signatures with sha512 and sha256", () => {
    const { dir, keyPath } = generate();
    try {
      const publicKey = parseSshPublicKey(readFileSync(`${keyPath}.pub`, "utf8"));
      const message = new TextEncoder().encode("challenge bytes \u0000\u0001\u0002");
      for (const hash of [undefined, "sha256", "sha512"]) {
        const signature = signWith(keyPath, dir, message, SSH_SIGNATURE_NAMESPACE, hash);
        expect(verifySshSignature(signature, message, publicKey)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects tampering, wrong key, wrong namespace and garbage", () => {
    const first = generate();
    const second = generate();
    try {
      const publicKey = parseSshPublicKey(readFileSync(`${first.keyPath}.pub`, "utf8"));
      const otherKey = parseSshPublicKey(readFileSync(`${second.keyPath}.pub`, "utf8"));
      const message = new TextEncoder().encode("hello");
      const signature = signWith(first.keyPath, first.dir, message, SSH_SIGNATURE_NAMESPACE);
      expect(verifySshSignature(signature, new TextEncoder().encode("hellp"), publicKey)).toBe(false);
      expect(verifySshSignature(signature, message, otherKey)).toBe(false);
      const foreign = signWith(first.keyPath, first.dir, message, "git");
      expect(verifySshSignature(foreign, message, publicKey)).toBe(false);
      expect(verifySshSignature("not a signature", message, publicKey)).toBe(false);
      expect(verifySshSignature("", message, publicKey)).toBe(false);
      const lines = signature.trim().split("\n");
      lines[1] = lines[1]!.slice(0, 20) + (lines[1]![20] === "A" ? "B" : "A") + lines[1]!.slice(21);
      expect(verifySshSignature(lines.join("\n"), message, publicKey)).toBe(false);
      expect(verifySshSignature(signature.replace("END SSH", "END XXX"), message, publicKey)).toBe(false);
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });
});
