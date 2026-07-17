/**
 * @nexnet/client — Private groups (AD-23: on-chain creator)
 *
 * Group ID = deriveId(DOMAIN_GROUP_ID, name).
 * Messages sealed with epoch secret; membership change rotates secret.
 */

import type { GroupId, IdentityId, PublicKey } from "@nexnet/types";
import { DOMAIN_GROUP_ID } from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import {
  decryptGroupMessage,
  encryptGroupMessage,
  getGroupSession,
  initGroupSession,
  type EncryptedGroupPayload,
} from "./group-crypto.js";

export async function createGroup(
  client: NexnetClient,
  name: string,
  members: IdentityId[]
): Promise<GroupId> {
  const nameBytes = new TextEncoder().encode(name.trim());
  const groupId = client.crypto.deriveId(DOMAIN_GROUP_ID, nameBytes);

  // Local epoch session for creator
  initGroupSession(client.crypto, groupId);

  client.sendWs({
    type: "group.create",
    groupId: Array.from(groupId),
    name,
    members: members.map((m) => Array.from(m)),
    creator: Array.from(client.identityId),
  });

  return groupId;
}

export async function addMember(
  client: NexnetClient,
  groupId: GroupId,
  identityId: IdentityId
): Promise<void> {
  client.sendWs({
    type: "group.add_member",
    groupId: Array.from(groupId),
    identityId: Array.from(identityId),
    actor: Array.from(client.identityId),
  });
}

export async function removeMember(
  client: NexnetClient,
  groupId: GroupId,
  identityId: IdentityId
): Promise<void> {
  client.sendWs({
    type: "group.remove_member",
    groupId: Array.from(groupId),
    identityId: Array.from(identityId),
    actor: Array.from(client.identityId),
  });
}

export async function sendGroupMessage(
  client: NexnetClient,
  groupId: GroupId,
  text: string
): Promise<void> {
  let session = getGroupSession(groupId);
  if (!session) {
    session = initGroupSession(client.crypto, groupId);
  }

  const payload = client.codec.encode({ text });
  const encrypted = encryptGroupMessage(
    client.crypto,
    groupId,
    session.epoch,
    session.secret,
    payload,
    client.signingSecretKey
  );

  client.sendWs({
    type: "group.message",
    groupId: Array.from(groupId),
    epoch: encrypted.epoch,
    nonce: Array.from(encrypted.nonce),
    ciphertext: Array.from(encrypted.ciphertext),
    signature: Array.from(encrypted.signature),
    sender: Array.from(client.identityId),
    timestamp: Date.now(),
  });
}

/**
 * @param getSenderPublicKey — Ed25519 public for signature check.
 *   Without it, messages are dropped (cannot verify).
 */
export function onGroupMessage(
  client: NexnetClient,
  groupId: GroupId,
  callback: (data: { text: string; senderId: IdentityId }) => void,
  getSenderPublicKey?: (identityId: IdentityId) => PublicKey | undefined
): void {
  const groupIdHex = Buffer.from(groupId).toString("hex");

  client.on("group_message", (data) => {
    const msg = data as {
      groupId?: string;
      epoch?: number;
      nonce?: number[];
      ciphertext?: number[];
      signature?: number[];
      /** legacy plaintext path */
      payload?: number[];
      sender?: number[];
    };
    if (msg.groupId !== groupIdHex) return;

    try {
      // Encrypted path
      if (msg.ciphertext && msg.nonce && msg.signature != null && msg.epoch != null) {
        const session = getGroupSession(groupId);
        if (!session) return;

        const senderId = new Uint8Array(msg.sender ?? []);
        const senderPk = getSenderPublicKey?.(senderId);
        if (!senderPk) return;

        const encrypted: EncryptedGroupPayload = {
          epoch: msg.epoch,
          nonce: new Uint8Array(msg.nonce),
          ciphertext: new Uint8Array(msg.ciphertext),
          signature: new Uint8Array(msg.signature),
        };

        const plain = decryptGroupMessage(
          client.crypto,
          groupId,
          session.secret,
          encrypted,
          senderPk
        );
        if (!plain) return;

        const payload = client.codec.decode<{ text: string }>(plain);
        callback({ text: payload.text, senderId });
        return;
      }

      // Legacy plaintext (pre-epoch) — only if no ciphertext field
      if (msg.payload) {
        const payload = client.codec.decode<{ text: string }>(
          new Uint8Array(msg.payload)
        );
        callback({
          text: payload.text,
          senderId: new Uint8Array(msg.sender ?? []),
        });
      }
    } catch {
      // malformed — ignore
    }
  });
}
