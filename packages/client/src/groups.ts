/**
 * @nettle/client — Private groups (AD-23: on-chain creator)
 *
 * Group ID = deriveId(DOMAIN_GROUP_ID, creatorIdentity || name).
 * Group events are signed and relayed.
 */

import type { GroupId, IdentityId } from "@nettle/types";
import { DOMAIN_GROUP_ID, PROTOCOL_VERSION } from "@nettle/types";
import type { NettleClient } from "./client.js";

export async function createGroup(
  client: NettleClient,
  name: string,
  members: IdentityId[]
): Promise<GroupId> {
  const nameBytes = new TextEncoder().encode(name.trim());
  const groupId = client.crypto.deriveId(DOMAIN_GROUP_ID, nameBytes);

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
  client: NettleClient,
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
  client: NettleClient,
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
  client: NettleClient,
  groupId: GroupId,
  text: string
): Promise<void> {
  client.sendWs({
    type: "group.message",
    groupId: Array.from(groupId),
    payload: Array.from(client.codec.encode({ text })),
    sender: Array.from(client.identityId),
    timestamp: Date.now(),
  });
}

export function onGroupMessage(
  client: NettleClient,
  groupId: GroupId,
  callback: (data: { text: string; senderId: IdentityId }) => void
): void {
  const groupIdHex = Buffer.from(groupId).toString("hex");

  client.on("group_message", (data) => {
    const msg = data as {
      groupId?: string;
      payload?: number[];
      sender?: number[];
    };
    if (msg.groupId === groupIdHex && msg.payload) {
      try {
        const payload = client.codec.decode<{ text: string }>(
          new Uint8Array(msg.payload)
        );
        callback({
          text: payload.text,
          senderId: new Uint8Array(msg.sender ?? []),
        });
      } catch {
        // malformed — ignore
      }
    }
  });
}
