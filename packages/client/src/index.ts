export { NexnetClient } from "./client.js";
export type { NexnetClientConfig, EventType, EventHandler } from "./client.js";

export {
  sendDirectMessage,
  onDirectMessage,
  deriveConversationId,
  deriveConversationKey,
} from "./dm.js";

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
} from "./groups.js";

export { QueueManager } from "./queue-manager.js";
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

export { PeerManager } from "./webrtc.js";
export type {
  PeerManagerOptions,
  PeerSession,
  PeerConnectionFactory,
  PeerConnectionLike,
  DataChannelLike,
  PeerMessageHandler,
} from "./webrtc.js";
