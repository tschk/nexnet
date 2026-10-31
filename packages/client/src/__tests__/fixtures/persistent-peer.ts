import { readFileSync } from "node:fs";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeEncode, cdeDecode } from "@nexnet/protocol";
import { openPersistentClient } from "../../persistent-client.js";
import { onDirectMessage, sendDirectMessage } from "../../dm.js";
import { publishBundle } from "../../prekeys.js";
import type { PrekeyBundle } from "../../x3dh.js";

const [mode, storagePath, path] = process.argv.slice(2);
if (!storagePath || !path) throw new Error("arguments required");
const input = cdeDecode<{
  identityId: Uint8Array;
  rootPublicKey: Uint8Array;
  bundle: PrekeyBundle;
  text: string;
  envelope: number[];
}>(readFileSync(path));
const client = openPersistentClient({
  storagePath,
  unlockKey: new Uint8Array(32).fill(77),
  crypto: cryptoProvider,
  codec: { encode: cdeEncode, decode: cdeDecode },
  relayUrl: "http://unused",
});
try {
  publishBundle(input.identityId, input.bundle);
  if (mode === "send") {
    const id = await sendDirectMessage(client, input.identityId, input.text);
    const item = client
      .outboundQueue()
      .pendingForRecipient(input.identityId)
      .find((item) => Buffer.from(item.messageId).equals(Buffer.from(id)))!;
    console.log(JSON.stringify({ envelope: Array.from(item.encryptedEnvelope) }));
  } else {
    onDirectMessage(
      client,
      () => {},
      () => input.rootPublicKey,
    );
    client.emit("dm", { envelope: input.envelope });
    console.log(JSON.stringify({ messages: client.inbox().map((message) => message.payload.text) }));
  }
} finally {
  await client.close();
}
