import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateSigningKeyPair, publicKeyFromSecret } from "@nexnet/crypto";
import { SSH_SIGNATURE_NAMESPACE, fromBase64Url, parseSshPublicKey, toBase64Url } from "@nexnet/protocol";
import type { SignInMethod } from "@nexnet/protocol";
import { AgentError } from "./errors.js";
import type { Platform, SshSignature, WalletSecret, WalletStore } from "./types.js";

export function defaultWalletPath(env: Record<string, string | undefined> = process.env): string {
  if (env.NEXNET_WALLET) return env.NEXNET_WALLET;
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "nexnet", "wallet.json");
}

export class FileWalletStore implements WalletStore {
  constructor(private readonly path: string) {}

  async load(): Promise<WalletSecret | null> {
    if (!existsSync(this.path)) return null;
    if ((statSync(this.path).mode & 0o077) !== 0) {
      throw new AgentError("internal", `Wallet file ${this.path} must not be readable by others (chmod 600)`);
    }
    let parsed: { version?: number; secretKey?: string };
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new AgentError("internal", `Wallet file ${this.path} is unreadable`);
    }
    if (parsed.version !== 1 || typeof parsed.secretKey !== "string") {
      throw new AgentError("internal", `Wallet file ${this.path} has an unknown format`);
    }
    const secretKey = fromBase64Url(parsed.secretKey);
    return { secretKey, publicKey: publicKeyFromSecret(secretKey) };
  }

  async create(): Promise<WalletSecret> {
    const wallet = generateSigningKeyPair();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ version: 1, secretKey: toBase64Url(wallet.secretKey) }), {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(this.path, 0o600);
    return wallet;
  }
}

export interface SshKeyLocation {
  publicPath: string;
  privatePath: string | null;
}

export function locateSshKey(env: Record<string, string | undefined> = process.env): SshKeyLocation | null {
  const configured = env.NEXNET_SSH_KEY;
  const base = configured ?? join(homedir(), ".ssh", "id_ed25519");
  const publicPath = base.endsWith(".pub") ? base : `${base}.pub`;
  const privatePath = base.endsWith(".pub") ? base.slice(0, -4) : base;
  if (!existsSync(publicPath)) return null;
  try {
    parseSshPublicKey(readFileSync(publicPath, "utf8"));
  } catch {
    return null;
  }
  return { publicPath, privatePath: existsSync(privatePath) ? privatePath : null };
}

async function runSshKeygen(args: string[], input: Uint8Array): Promise<string | null> {
  const child = Bun.spawn(["ssh-keygen", ...args], {
    stdin: new Blob([new Uint8Array(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SSH_ASKPASS: "/usr/bin/false", SSH_ASKPASS_REQUIRE: "force" },
  });
  const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return code === 0 && stdout.includes("BEGIN SSH SIGNATURE") ? stdout : null;
}

export function sshSigner(location: SshKeyLocation, env: Record<string, string | undefined> = process.env) {
  return async (preimage: Uint8Array): Promise<SshSignature> => {
    const publicKey = readFileSync(location.publicPath, "utf8").trim();
    const base = ["-Y", "sign", "-n", SSH_SIGNATURE_NAMESPACE];
    let signature: string | null = null;
    if (env.SSH_AUTH_SOCK) signature = await runSshKeygen([...base, "-U", "-f", location.publicPath], preimage);
    if (!signature && location.privatePath) signature = await runSshKeygen([...base, "-f", location.privatePath], preimage);
    if (!signature) {
      throw new AgentError("unauthenticated", "Could not sign with the SSH key; load it into ssh-agent first");
    }
    return { publicKey, signature };
  };
}

export interface NodePlatformOptions {
  gatewayUrl: string | null;
  walletPath?: string;
  env?: Record<string, string | undefined>;
}

export function createNodePlatform(options: NodePlatformOptions): Platform {
  const env = options.env ?? process.env;
  const ssh = Bun.which("ssh-keygen") ? locateSshKey(env) : null;
  return {
    gatewayUrl: options.gatewayUrl,
    wallet: new FileWalletStore(options.walletPath ?? defaultWalletPath(env)),
    methods: () => (ssh ? (["wallet", "ssh"] as SignInMethod[]) : (["wallet"] as SignInMethod[])),
    now: () => Date.now(),
    ...(ssh ? { signSsh: sshSigner(ssh, env) } : {}),
  };
}
