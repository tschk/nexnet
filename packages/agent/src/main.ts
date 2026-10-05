#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  identityIdFromWallet,
  parseSshPublicKey,
  revocationToJson,
  signIdentityProof,
  signRevocation,
  signSshCommitment,
  sshFingerprint,
  toBase64Url,
  toHex,
} from "@nexnet/protocol";
import { GatewayApi } from "./api.js";
import { AgentError } from "./errors.js";
import { createNodePlatform, defaultWalletPath, FileWalletStore, locateSshKey } from "./node-platform.js";
import { serveStdio } from "./stdio.js";

const USAGE = `nexnet-agent [serve]            speak the terminal protocol on stdin/stdout
nexnet-agent identity           show the local identity
nexnet-agent ssh-link [PUBKEY]  authorise an ssh key with this wallet
nexnet-agent revoke device|ssh|passkey ID

NEXNET_GATEWAY_URL selects the gateway; NEXNET_WALLET the wallet file; NEXNET_SSH_KEY the ssh key.`;

async function main(argv: string[]): Promise<number> {
  const [command = "serve", ...rest] = argv;
  const gatewayUrl = process.env.NEXNET_GATEWAY_URL ?? null;
  const store = new FileWalletStore(defaultWalletPath());
  if (command === "serve") {
    await serveStdio(createNodePlatform({ gatewayUrl }));
    return 0;
  }
  if (command === "identity") {
    const wallet = await store.load();
    if (!wallet) {
      console.log("no identity on this device; create one from the terminal UI (Identity page, c)");
      return 0;
    }
    console.log(toHex(identityIdFromWallet(wallet.publicKey)));
    return 0;
  }
  if (command === "ssh-link" || command === "revoke") {
    if (!gatewayUrl) throw new AgentError("unconfigured", "Set NEXNET_GATEWAY_URL");
    const wallet = await store.load();
    if (!wallet) throw new AgentError("unauthenticated", "No identity on this device");
    const api = new GatewayApi(gatewayUrl);
    const identityId = identityIdFromWallet(wallet.publicKey);
    await api.request("POST", "/v1/identity", {
      wallet: toHex(wallet.publicKey),
      proof: toBase64Url(signIdentityProof(wallet.secretKey, wallet.publicKey)),
    });
    if (command === "ssh-link") {
      const path = rest[0] ?? locateSshKey()?.publicPath;
      if (!path) throw new AgentError("invalid", "No ssh public key found; pass a path");
      const publicKey = parseSshPublicKey(readFileSync(path, "utf8"));
      const result = await api.request<{ fingerprint: string }>("POST", "/v1/credentials/ssh", {
        identityId: toHex(identityId),
        publicKey: readFileSync(path, "utf8").trim(),
        rootSignature: toBase64Url(
          signSshCommitment(wallet.secretKey, identityId, { algorithm: "ssh-ed25519", publicKey }),
        ),
      });
      console.log(`linked ${result.fingerprint ?? sshFingerprint(publicKey)}`);
      return 0;
    }
    const [kind, credentialId] = rest;
    if ((kind !== "device" && kind !== "ssh" && kind !== "passkey") || !credentialId) {
      console.error(USAGE);
      return 2;
    }
    const revocation = signRevocation(wallet.secretKey, {
      accountId: identityId,
      kind,
      credentialId,
      sequence: Date.now(),
    });
    await api.request("POST", "/v1/credentials/revoke", { revocation: revocationToJson(revocation) });
    console.log(`revoked ${kind} ${credentialId}`);
    return 0;
  }
  console.error(USAGE);
  return command === "--help" || command === "help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  },
);
