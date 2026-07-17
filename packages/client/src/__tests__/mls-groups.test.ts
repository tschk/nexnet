import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cryptoProvider } from "@nexnet/crypto";
import { cdeDecode, cdeEncode } from "@nexnet/protocol";
import type { CborCdeCodec } from "@nexnet/types";
import { NexnetClient } from "../client.js";
import {
  addMember,
  applyGroupMembershipMessage,
  clearMlsGroups,
  createGroup,
  onGroupMessage,
  publishMlsKeyPackage,
  removeMember,
  sendGroupMessage,
} from "../mls-groups.js";

const codec: CborCdeCodec = { encode: cdeEncode, decode: cdeDecode };

function client(identity: number): NexnetClient {
  return new NexnetClient({
    identityId: new Uint8Array(32).fill(identity),
    deviceId: new Uint8Array(32).fill(identity + 1),
    crypto: cryptoProvider,
    codec,
    relayUrl: "https://relay.example.com",
    storagePath: "/tmp/nexnet-mls-groups",
    signingSecretKey: cryptoProvider.generateSigningKeyPair().secretKey,
  });
}

function capture(client: NexnetClient): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  (client as unknown as { _online: boolean })._online = true;
  client.sendWs = (message) => sent.push(message);
  return sent;
}

describe("MLS group client path", () => {
  beforeEach(clearMlsGroups);
  afterEach(clearMlsGroups);

  test("joins through a welcome and decrypts only post-join messages", async () => {
    const alice = client(1);
    const bob = client(2);
    const sent = capture(alice);
    capture(bob);
    await publishMlsKeyPackage(alice);
    await publishMlsKeyPackage(bob);

    const groupId = await createGroup(alice, "crew", []);
    await sendGroupMessage(alice, groupId, "before bob");
    const oldMessage = sent.at(-1)!;
    const received: string[] = [];
    onGroupMessage(bob, groupId, ({ text }) => received.push(text));

    await addMember(alice, groupId, bob.identityId);
    await applyGroupMembershipMessage(bob, sent.at(-1) as never);

    bob.emit("group_message", oldMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([]);

    await sendGroupMessage(alice, groupId, "after bob");
    bob.emit("group_message", sent.at(-1)!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual(["after bob"]);
  });

  test("a removed member cannot send or decrypt a future message", async () => {
    const alice = client(3);
    const bob = client(4);
    const sent = capture(alice);
    capture(bob);
    await publishMlsKeyPackage(alice);
    await publishMlsKeyPackage(bob);
    const groupId = await createGroup(alice, "crew", [bob.identityId]);
    await applyGroupMembershipMessage(bob, sent.at(-1) as never);

    const received: string[] = [];
    onGroupMessage(bob, groupId, ({ text }) => received.push(text));
    await removeMember(alice, groupId, bob.identityId);
    await applyGroupMembershipMessage(bob, sent.at(-1) as never);
    await expect(sendGroupMessage(bob, groupId, "no longer a member")).rejects.toThrow("Removed from group");

    await sendGroupMessage(alice, groupId, "after removal");
    bob.emit("group_message", sent.at(-1)!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([]);
  });
});
