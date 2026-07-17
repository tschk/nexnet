import type { GroupId, IdentityId } from "@nexnet/types";
import { DOMAIN_GROUP_ID } from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import {
  decodeWelcome,
  encodeCommit,
  encodeWelcome,
  generateMlsMember,
  mlsAddMember,
  mlsCreateGroup,
  mlsDecrypt,
  mlsEncrypt,
  mlsJoin,
  mlsProcessCommit,
  mlsRemoveMember,
  type ClientState,
  type MlsMemberKeys,
} from "./mls.js";

type GroupSession = {
  creator: string;
  member: MlsMemberKeys;
  members: Set<string>;
  state: ClientState;
};

type MembershipMessage = {
  action: "add" | "remove";
  commit: number[];
  groupId: number[];
  memberId: number[];
  welcome?: number[];
};

const sessions = new WeakMap<NexnetClient, Map<string, GroupSession>>();
const members = new WeakMap<NexnetClient, Promise<MlsMemberKeys>>();
const publishedPackages = new Map<string, MlsMemberKeys>();

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function groupSessions(client: NexnetClient): Map<string, GroupSession> {
  let value = sessions.get(client);
  if (!value) {
    value = new Map();
    sessions.set(client, value);
  }
  return value;
}

function getSession(client: NexnetClient, groupId: GroupId): GroupSession {
  const session = groupSessions(client).get(hex(groupId));
  if (!session) throw new Error("MLS group is not joined");
  return session;
}

async function getMember(client: NexnetClient): Promise<MlsMemberKeys> {
  let member = members.get(client);
  if (!member) {
    member = generateMlsMember(new Uint8Array(client.identityId));
    members.set(client, member);
  }
  return member;
}

function leafIndex(state: ClientState, identityId: IdentityId): number | undefined {
  const target = hex(identityId);
  for (let index = 0; index < state.ratchetTree.length; index += 2) {
    const node = state.ratchetTree[index];
    if (
      node?.nodeType === "leaf" &&
      node.leaf.credential.credentialType === "basic" &&
      hex(node.leaf.credential.identity) === target
    ) {
      return index / 2;
    }
  }
  return undefined;
}

function send(client: NexnetClient, payload: Record<string, unknown>): void {
  if (client.online) client.sendWs(payload);
}

export async function publishMlsKeyPackage(client: NexnetClient): Promise<void> {
  publishedPackages.set(hex(client.identityId), await getMember(client));
}

export function clearMlsGroups(): void {
  publishedPackages.clear();
}

export function listGroupMembers(client: NexnetClient, groupId: GroupId): IdentityId[] {
  return [...getSession(client, groupId).members].map(
    (value) => new Uint8Array(Buffer.from(value, "hex"))
  );
}

export async function createGroup(
  client: NexnetClient,
  name: string,
  memberIds: IdentityId[]
): Promise<GroupId> {
  const normalized = name.trim();
  if (!normalized) throw new Error("Group name is required");
  const groupId = client.crypto.deriveId(
    DOMAIN_GROUP_ID,
    new TextEncoder().encode(normalized)
  );
  const member = await getMember(client);
  groupSessions(client).set(hex(groupId), {
    creator: hex(client.identityId),
    member,
    members: new Set([hex(client.identityId)]),
    state: await mlsCreateGroup(groupId, member),
  });
  send(client, {
    type: "group.create",
    groupId: Array.from(groupId),
    name: normalized,
    creator: Array.from(client.identityId),
  });
  for (const memberId of memberIds) await addMember(client, groupId, memberId);
  return groupId;
}

export async function addMember(
  client: NexnetClient,
  groupId: GroupId,
  identityId: IdentityId
): Promise<void> {
  const session = getSession(client, groupId);
  if (session.creator !== hex(client.identityId)) throw new Error("Only the group creator can change membership");
  const member = publishedPackages.get(hex(identityId));
  if (!member) throw new Error("Member MLS key package is unavailable");
  const result = await mlsAddMember(session.state, member.publicPackage);
  session.state = result.state;
  session.members.add(hex(identityId));
  send(client, {
    type: "group.membership",
    action: "add",
    groupId: Array.from(groupId),
    memberId: Array.from(identityId),
    commit: Array.from(encodeCommit(result.commit)),
    welcome: Array.from(encodeWelcome(result.welcome)),
  });
}

export async function removeMember(
  client: NexnetClient,
  groupId: GroupId,
  identityId: IdentityId
): Promise<void> {
  const session = getSession(client, groupId);
  if (session.creator !== hex(client.identityId)) throw new Error("Only the group creator can change membership");
  const index = leafIndex(session.state, identityId);
  if (index === undefined) throw new Error("Group member does not exist");
  const result = await mlsRemoveMember(session.state, index);
  session.state = result.state;
  session.members.delete(hex(identityId));
  send(client, {
    type: "group.membership",
    action: "remove",
    groupId: Array.from(groupId),
    memberId: Array.from(identityId),
    commit: Array.from(encodeCommit(result.commit)),
  });
}

export async function applyGroupMembershipMessage(
  client: NexnetClient,
  message: MembershipMessage
): Promise<boolean> {
  const groupId = new Uint8Array(message.groupId);
  const groupKey = hex(groupId);
  const memberId = new Uint8Array(message.memberId);
  let session = groupSessions(client).get(groupKey);
  if (message.action === "add" && hex(memberId) === hex(client.identityId) && message.welcome) {
    const member = await getMember(client);
    session = {
      creator: "",
      member,
      members: new Set([hex(client.identityId)]),
      state: await mlsJoin(decodeWelcome(new Uint8Array(message.welcome)), member),
    };
    groupSessions(client).set(groupKey, session);
    return true;
  }
  if (!session) return false;
  session.state = await mlsProcessCommit(session.state, new Uint8Array(message.commit));
  if (message.action === "add") session.members.add(hex(memberId));
  else session.members.delete(hex(memberId));
  return true;
}

export async function sendGroupMessage(
  client: NexnetClient,
  groupId: GroupId,
  text: string
): Promise<void> {
  const session = getSession(client, groupId);
  if (session.state.groupActiveState.kind !== "active") throw new Error("Removed from group");
  const encrypted = await mlsEncrypt(session.state, client.codec.encode({ text }));
  session.state = encrypted.state;
  send(client, {
    type: "group.message",
    groupId: Array.from(groupId),
    wire: Array.from(encrypted.wire),
    sender: Array.from(client.identityId),
    timestamp: Date.now(),
  });
}

export function onGroupMessage(
  client: NexnetClient,
  groupId: GroupId,
  callback: (data: { text: string; senderId: IdentityId }) => void
): void {
  const groupKey = hex(groupId);
  client.on("group_message", (data) => {
    const message = data as { type?: string; groupId?: number[] | string; wire?: number[]; sender?: number[]; action?: "add" | "remove"; commit?: number[]; memberId?: number[]; welcome?: number[] };
    const incomingGroup = Array.isArray(message.groupId)
      ? hex(new Uint8Array(message.groupId))
      : message.groupId;
    if (incomingGroup !== groupKey) return;
    if (message.type === "group.membership" && message.action && message.commit && message.memberId) {
      void applyGroupMembershipMessage(client, {
        ...message,
        groupId: Array.from(groupId),
      } as MembershipMessage);
      return;
    }
    if (!message.wire) return;
    void mlsDecrypt(getSession(client, groupId).state, new Uint8Array(message.wire)).then((result) => {
      getSession(client, groupId).state = result.state;
      const payload = client.codec.decode<{ text: string }>(result.plaintext);
      callback({ text: payload.text, senderId: new Uint8Array(message.sender ?? []) });
    }).catch(() => {});
  });
}
