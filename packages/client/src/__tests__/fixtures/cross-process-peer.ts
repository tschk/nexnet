/**
 * One DM peer in its own process, for cross-process-dm.test.ts.
 * Usage: bun cross-process-peer.ts <relayUrl> <presenceUrl> [peerIdentityHex]
 * Without a peer it waits for a DM and replies "pong:<text>"; with one it
 * sends "hello" and waits for the reply. Emits JSON lines on stdout.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cryptoProvider, generateKeyPair, generateSigningKeyPair, randomBytes } from "@nexnet/crypto";
import { cdeDecode, cdeEncode, identityIdFromWallet, issueDeviceCert } from "@nexnet/protocol";
import { NexnetClient, onDirectMessage, publishLocalPrekeys, sendDirectMessage } from "../../index.js";

const [relayUrl, presenceUrl, peerHex] = process.argv.slice(2) as [string, string, string | undefined];
const emit = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

const root = generateSigningKeyPair();
const device = generateSigningKeyPair();
const identityId = identityIdFromWallet(root.publicKey);
const deviceId = randomBytes(32);
const now = Date.now();
const client = new NexnetClient({
  identityId,
  deviceId,
  crypto: cryptoProvider,
  codec: { encode: cdeEncode, decode: cdeDecode },
  relayUrl,
  presenceUrl,
  storagePath: mkdtempSync(join(tmpdir(), "nexnet-xproc-")),
  signingSecretKey: root.secretKey,
  rootPublicKey: root.publicKey,
  deviceSigningSecretKey: device.secretKey,
  deviceSigningPublicKey: device.publicKey,
  deviceCertificate: issueDeviceCert(
    root.secretKey,
    device.publicKey,
    generateKeyPair().publicKey,
    deviceId,
    identityId,
    now - 60_000,
    now + 3_600_000,
    1,
  ),
});

try {
  await client.connect();
  await publishLocalPrekeys(client);
  onDirectMessage(client, (envelope, payload) => {
    emit({ event: "dm", text: payload.text });
    if (!peerHex) void sendDirectMessage(client, envelope.senderIdentityId, `pong:${payload.text}`);
  });
  emit({ event: "ready", identity: client.identityHex });
  if (peerHex) {
    await sendDirectMessage(client, new Uint8Array(Buffer.from(peerHex, "hex")), "hello");
    emit({ event: "sent" });
  }
} catch (error) {
  emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
