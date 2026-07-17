export { NexnetClient } from "./client.js";
export type { NexnetClientConfig, EventType, EventHandler } from "./client.js";

export {
  sendDirectMessage,
  onDirectMessage,
  deriveConversationId,
  deriveConversationKey,
  DM_WIRE_X3DH,
} from "./dm.js";

export {
  setupLocalPrekeys,
  publishBundle,
  fetchBundle,
  unpublishBundle,
  clearPrekeyDirectory,
  getLocalPrekeys,
  refreshPublishedBundle,
} from "./prekeys.js";

export {
  publishBundleRemote,
  fetchBundleRemote,
  removeBundleRemote,
  bundleToNetwork,
  bundleFromNetwork,
} from "./prekey-network.js";
export type { NetworkPrekeyBundle } from "./prekey-network.js";

export { setDirectTransport, getDirectTransport, trySendDirect } from "./transport.js";

export {
  generateMlsMember,
  mlsCreateGroup,
  mlsAddMember,
  mlsRemoveMember,
  mlsJoin,
  mlsEncrypt,
  mlsDecrypt,
  encodeKeyPackage,
  decodeKeyPackage,
  encodeWelcome,
  decodeWelcome,
  encodeCommit,
  mlsProcessCommit,
  mlsCiphersuite,
} from "./mls.js";
export type {
  MlsMemberKeys,
  ClientState as MlsClientState,
  KeyPackage as MlsKeyPackage,
  Welcome as MlsWelcome,
} from "./mls.js";

export { createWeriftPeerConnection, RTCPeerConnection } from "./werift-factory.js";

export {
  initInitiator,
  initResponder,
  seal as ratchetSeal,
  open as ratchetOpen,
  clearSessions as clearRatchetSessions,
  setSessionBackend,
  serializeState,
  deserializeState,
  saveSession,
  sessionStoreKey,
} from "./double-ratchet.js";
export type {
  RatchetState,
  RatchetHeader,
  SessionBackend,
} from "./double-ratchet.js";

export {
  createLocalPrekeys,
  exportBundle,
  verifyBundle,
  x3dhInitiate,
  x3dhRespond,
} from "./x3dh.js";
export type {
  PrekeyBundle,
  LocalPrekeyMaterial,
  X3dhInitResult,
  X3dhRecvResult,
} from "./x3dh.js";

export {
  joinRoom,
  leaveRoom,
  sendRoomMessage,
  onRoomMessage,
  deriveRoomId,
} from "./rooms.js";

export {
  createGroup,
  addMember,
  removeMember,
  sendGroupMessage,
  onGroupMessage,
  publishMlsKeyPackage,
  applyGroupMembershipMessage,
  listGroupMembers,
  clearMlsGroups,
} from "./mls-groups.js";

export { QueueManager } from "./queue-manager.js";
export { consumePresenceMessage } from "./presence.js";
export { DevChainClient } from "./chain-stub.js";

export {
  deriveGroupKey,
  deriveEpoch,
  createEpoch,
  advanceEpoch,
  wrapEpochSecret,
  unwrapEpochSecret,
  encryptGroupMessage,
  decryptGroupMessage,
  initGroupSession,
  getGroupSession,
  setMemberDh,
  rotateEpoch,
  applyEpochWrap,
  clearGroupSessions,
} from "./group-crypto.js";
export type {
  EncryptedGroupPayload,
  EpochSecretWrap,
  GroupEpoch,
  GroupSession,
} from "./group-crypto.js";

export {
  prepareAttachment,
  sendAttachment,
  AttachmentReceiver,
} from "./attachments.js";
export type { AttachmentTransfer } from "./attachments.js";
export type { DirectAttachmentChunk } from "./attachments.js";

export { PeerManager } from "./webrtc.js";
export type {
  PeerManagerOptions,
  PeerSession,
  PeerConnectionFactory,
  PeerConnectionLike,
  DataChannelLike,
  PeerMessageHandler,
} from "./webrtc.js";
