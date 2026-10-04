/**
 * @nexnet/client — Private groups (AD-23: on-chain creator)
 *
 * Group ID = deriveId(DOMAIN_GROUP_ID, name).
 * Membership change rotates epoch secret + wraps to active members.
 */

import type { GroupId, IdentityId, PublicKey } from "@nexnet/types";
import { DOMAIN_GROUP_ID } from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import {
  applyEpochWrap,
  decryptGroupMessage,
  encryptGroupMessage,
  getGroupSession,
  initGroupSession,
  rotateEpoch,
  setMemberDh,
  type EncryptedGroupPayload,
  type EpochSecretWrap,
  type GroupSession,
} from "./group-crypto.js";

/** groupId hex → active member identity hex set */
const membership = new Map<string, Set<string>>();

function gHex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

function ensureMembership(groupId: GroupId): Set<string> {
  const k = gHex(groupId);
  let s = membership.get(k);
  if (!s) {
    s = new Set();
    membership.set(k, s);
  }
  return s;
}

export function clearGroupMembership(): void {
  membership.clear();
}

export function listGroupMembers(groupId: GroupId): IdentityId[] {
  const s = membership.get(gHex(groupId));
  if (!s) return [];
  return [...s].map((h) => new Uint8Array(Buffer.from(h, "hex")));
}

function wrapToWire(w: EpochSecretWrap): Record<string, number[] | number> {
  return {
    memberId: Array.from(w.memberId),
    ephemeralPublic: Array.from(w.ephemeralPublic),
    nonce: Array.from(w.nonce),
    ciphertext: Array.from(w.ciphertext),
  };
}

function wrapFromWire(raw: {
  memberId: number[];
  ephemeralPublic: number[];
  nonce: number[];
  ciphertext: number[];
}): EpochSecretWrap {
  return {
    memberId: new Uint8Array(raw.memberId),
    ephemeralPublic: new Uint8Array(raw.ephemeralPublic),
    nonce: new Uint8Array(raw.nonce),
    ciphertext: new Uint8Array(raw.ciphertext),
  };
}

function broadcastEpoch(client: NexnetClient, groupId: GroupId, epoch: number, wraps: EpochSecretWrap[]): void {
  if (!client.online) return;
  try {
    client.sendWs({
      type: "group.epoch",
      groupId: Array.from(groupId),
      epoch,
      wraps: wraps.map(wrapToWire),
      actor: Array.from(client.identityId),
    });
  } catch {
    // offline — ignore
  }
}

function rotateAndBroadcast(client: NexnetClient, groupId: GroupId, session: GroupSession): void {
  const members = listGroupMembers(groupId);
  const { epoch, wraps } = rotateEpoch(client.crypto, session, members);
  broadcastEpoch(client, groupId, epoch.epoch, wraps);
}

export async function createGroup(client: NexnetClient, name: string, members: IdentityId[]): Promise<GroupId> {
  const nameBytes = new TextEncoder().encode(name.trim());
  const groupId = client.crypto.deriveId(DOMAIN_GROUP_ID, nameBytes);

  initGroupSession(client.crypto, groupId);
  const set = ensureMembership(groupId);
  set.add(gHex(client.identityId));
  for (const m of members) set.add(gHex(m));

  if (client.online) {
    client.sendWs({
      type: "group.create",
      groupId: Array.from(groupId),
      name,
      members: members.map((m) => Array.from(m)),
      creator: Array.from(client.identityId),
    });
  }

  return groupId;
}

/**
 * Register peer's group DH public (for epoch wraps).
 */
export function registerMemberDh(groupId: GroupId, memberId: IdentityId, dhPublic: Uint8Array): void {
  const session = getGroupSession(groupId);
  if (!session) return;
  setMemberDh(session, memberId, dhPublic);
}

export async function addMember(
  client: NexnetClient,
  groupId: GroupId,
  identityId: IdentityId,
  memberDhPublic?: Uint8Array,
): Promise<void> {
  let session = getGroupSession(groupId);
  if (!session) {
    session = initGroupSession(client.crypto, groupId);
  }

  ensureMembership(groupId).add(gHex(identityId));
  if (memberDhPublic) {
    setMemberDh(session, identityId, memberDhPublic);
  }

  if (client.online) {
    client.sendWs({
      type: "group.add_member",
      groupId: Array.from(groupId),
      identityId: Array.from(identityId),
      actor: Array.from(client.identityId),
    });
  }

  // New epoch so prior members' old keys don't cover new membership state
  // and removed secrets aren't reused for the join.
  rotateAndBroadcast(client, groupId, session);
}

export async function removeMember(client: NexnetClient, groupId: GroupId, identityId: IdentityId): Promise<void> {
  let session = getGroupSession(groupId);
  if (!session) {
    session = initGroupSession(client.crypto, groupId);
  }

  ensureMembership(groupId).delete(gHex(identityId));
  session.memberDh.delete(gHex(identityId));

  if (client.online) {
    client.sendWs({
      type: "group.remove_member",
      groupId: Array.from(groupId),
      identityId: Array.from(identityId),
      actor: Array.from(client.identityId),
    });
  }

  // Rotate so removed member cannot decrypt future messages
  rotateAndBroadcast(client, groupId, session);
}

export async function sendGroupMessage(client: NexnetClient, groupId: GroupId, text: string): Promise<void> {
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
    client.signingSecretKey,
  );

  if (client.online) {
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
}

/**
 * Handle group.epoch wrap delivery (call from client event or tests).
 */
export function applyGroupEpochMessage(
  client: NexnetClient,
  groupId: GroupId,
  epoch: number,
  wraps: EpochSecretWrap[],
): boolean {
  let session = getGroupSession(groupId);
  if (!session) {
    session = initGroupSession(client.crypto, groupId);
  }
  const me = gHex(client.identityId);
  const mine = wraps.find((w) => gHex(w.memberId) === me);
  if (!mine) return false;
  applyEpochWrap(client.crypto, session, epoch, mine, client.identityId);
  return true;
}

/**
 * Subscribe to encrypted group messages + epoch wraps on same event bus.
 * Relay should emit `group_message` and may piggyback epoch as `group_message`
 * with type field, or client routes `group.epoch` → applyGroupEpochMessage.
 */
export function onGroupMessage(
  client: NexnetClient,
  groupId: GroupId,
  callback: (data: { text: string; senderId: IdentityId }) => void,
  getSenderPublicKey?: (identityId: IdentityId) => PublicKey | undefined,
): void {
  const groupIdHex = gHex(groupId);

  client.on("group_message", (data) => {
    const msg = data as {
      type?: string;
      groupId?: string | number[];
      epoch?: number;
      nonce?: number[];
      ciphertext?: number[];
      signature?: number[];
      wraps?: Array<{
        memberId: number[];
        ephemeralPublic: number[];
        nonce: number[];
        ciphertext: number[];
      }>;
      payload?: number[];
      sender?: number[];
    };

    const msgGid =
      typeof msg.groupId === "string"
        ? msg.groupId
        : Array.isArray(msg.groupId)
          ? Buffer.from(msg.groupId).toString("hex")
          : undefined;
    if (msgGid !== groupIdHex) return;

    try {
      // Epoch distribution
      if (msg.wraps && msg.epoch != null) {
        applyGroupEpochMessage(client, groupId, msg.epoch, msg.wraps.map(wrapFromWire));
        return;
      }

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

        const plain = decryptGroupMessage(client.crypto, groupId, session.secret, encrypted, senderPk);
        if (!plain) return;

        const payload = client.codec.decode<{ text: string }>(plain);
        callback({ text: payload.text, senderId });
        return;
      }

      if (msg.payload) {
        const payload = client.codec.decode<{ text: string }>(new Uint8Array(msg.payload));
        callback({
          text: payload.text,
          senderId: new Uint8Array(msg.sender ?? []),
        });
      }
    } catch {
      // ignore
    }
  });
}
