export { NexnetClient } from "./client.js";
export type { NexnetClientConfig, EventType, EventHandler } from "./client.js";

export {
  sendDirectMessage,
  onDirectMessage,
  deriveConversationId,
} from "./dm.js";

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
  encryptGroupMessage,
  decryptGroupMessage,
} from "./group-crypto.js";
export type { EncryptedGroupPayload } from "./group-crypto.js";

export {
  prepareAttachment,
  sendAttachment,
  AttachmentReceiver,
} from "./attachments.js";
export type { AttachmentTransfer } from "./attachments.js";
