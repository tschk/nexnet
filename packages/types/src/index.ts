/**
 * @nexnet/types — protocol type definitions
 *
 * This is the single source of truth for all Nexnet protocol types.
 * No implementation. Pure types, interfaces, and constants.
 *
 * AD decisions referenced inline (see docs/open-decisions.md).
 */

// ── ID types (all 32-byte Uint8Arrays) ──────────────────────────────

/** 32-byte identity identifier (wallet-derived, stable) */
export type IdentityId = Uint8Array;
/** 32-byte device identifier */
export type DeviceId = Uint8Array;
/** 32-byte event identifier (BLAKE3-256 derived) */
export type EventId = Uint8Array;
/** 32-byte conversation identifier */
export type ConversationId = Uint8Array;
/** 32-byte room identifier (BLAKE3-256 derived) */
export type RoomId = Uint8Array;
/** 32-byte group identifier */
export type GroupId = Uint8Array;
/** 32-byte message identifier */
export type MessageId = Uint8Array;
/** 32-byte wallet address */
export type WalletAddress = Uint8Array;
/** 32-byte Ed25519 public key */
export type PublicKey = Uint8Array;
/** 64-byte Ed25519 signature */
export type Signature = Uint8Array;

// ── Constants ────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;
export const IDENTITY_ID_LEN = 32;
export const DEVICE_ID_LEN = 32;
export const EVENT_ID_LEN = 32;
export const SIGNATURE_LEN = 64;
export const PUBLIC_KEY_LEN = 32;

// Domain separation contexts for BLAKE3 derive_key (AD-8)
export const DOMAIN_EVENT_ID = "nexnet event id v1";
export const DOMAIN_ROOM_ID = "nexnet room id v1";
export const DOMAIN_ATTACHMENT_ID = "nexnet attachment id v1";
export const DOMAIN_GROUP_ID = "nexnet group id v1";

// Size limits (initial)
export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB
export const MAX_PARENT_IDS = 32;
export const MAX_EVENT_TYPE_LEN = 64;
export const MAX_BIO_LEN = 160; // graphemes (AD-24 / OD-22)
export const MAX_USERNAME_LEN = 32;
export const MIN_USERNAME_LEN = 2;

// Presence (AD-11)
export const PRESENCE_LEASE_TTL_MS = 90_000; // 90 seconds
export const PRESENCE_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── Protocol events ──────────────────────────────────────────────────

export type KnownEventType =
  | "dm.message"
  | "dm.delivery_receipt"
  | "dm.attachment_offer"
  | "room.message"
  | "group.created"
  | "group.member_added"
  | "group.member_removed"
  | "group.metadata_changed"
  | "group.closed"
  | "group.message"
  | "identity.device_authorized"
  | "test.ping";

/** Canonical signed event (AD-4b: CDE-encoded for signatures) */
export interface NexnetEvent {
  protocolVersion: number;
  eventType: string;
  eventId: EventId;
  authorIdentityId: IdentityId;
  authorDeviceId: DeviceId;
  createdAt: number; // unix milliseconds
  sequence: number;
  parentIds: EventId[];
  payload: Uint8Array;
  signature: Signature;
}

/** Preimage fields for signing (everything except signature) */
export interface NexnetEventPreimage {
  protocolVersion: number;
  eventType: string;
  eventId: EventId;
  authorIdentityId: IdentityId;
  authorDeviceId: DeviceId;
  createdAt: number;
  sequence: number;
  parentIds: EventId[];
  payload: Uint8Array;
}

/** Preimage for ID derivation (everything except signature AND eventId) */
export interface NexnetEventIdPreimage {
  protocolVersion: number;
  eventType: string;
  authorIdentityId: IdentityId;
  authorDeviceId: DeviceId;
  createdAt: number;
  sequence: number;
  parentIds: EventId[];
  payload: Uint8Array;
}

// ── Device certificate ───────────────────────────────────────────────

/** Device certificate (AD-6: valid until process death) */
export interface DeviceCertificate {
  accountId: IdentityId;
  deviceId: DeviceId;
  deviceSigningPublicKey: PublicKey;
  deviceEncryptionPublicKey: PublicKey;
  issuedAt: number;
  expiresAt: number;
  capabilities: number;
  rootSignature: Signature;
}

// ── Messages ─────────────────────────────────────────────────────────

/** Outer message envelope (encrypted payload inside) */
export interface MessageEnvelope {
  protocolVersion: number;
  messageId: MessageId;
  conversationId: ConversationId;
  senderIdentityId: IdentityId;
  senderDeviceId: DeviceId;
  recipientIdentityId: IdentityId;
  senderCertificate: DeviceCertificate;
  senderSequence: number;
  parentIds: EventId[];
  createdAt: number;
  ciphertext: Uint8Array;
  signature: Signature;
}

/** Decrypted message payload */
export interface MessagePayload {
  contentType: "text" | "attachment_offer";
  text: string;
  replyToMessageId?: MessageId;
  attachmentOffer?: AttachmentOffer;
  clientMetadata?: Record<string, unknown>;
}

/** Delivered receipt */
export interface DeliveryReceipt {
  messageId: MessageId;
  recipientDeviceId: DeviceId;
  storedAt: number;
  signature: Signature;
}

// ── Attachments (AD-20: direct only) ─────────────────────────────────

export interface AttachmentOffer {
  attachmentId: MessageId;
  filename: string;
  mimeType: string;
  size: number;
  encryptedContentHash: Uint8Array; // BLAKE3-256
  transferCapabilities: string[];
  expiresAt?: number;
}

// ── Presence (AD-11, AD-12) ─────────────────────────────────────────

export interface PresenceLease {
  identityId: IdentityId;
  deviceId: DeviceId;
  status: "online";
  relayHint?: string;
  issuedAt: number;
  expiresAt: number;
  nonce: Uint8Array;
  signature: Signature;
}

// ── Groups (AD-23: on-chain creator) ─────────────────────────────────

export type GroupEventType =
  | "group_created"
  | "group_member_added"
  | "group_member_removed"
  | "group_metadata_changed"
  | "group_closed";

export interface GroupEvent {
  groupId: GroupId;
  eventType: GroupEventType;
  actor: IdentityId;
  timestamp: number;
  data: Uint8Array;
  signature: Signature;
}

export interface GroupInfo {
  groupId: GroupId;
  creator: IdentityId;
  name: string;
  memberCount: number;
}

// ── Rooms ────────────────────────────────────────────────────────────

export interface RoomMessage {
  roomId: RoomId;
  eventId: EventId;
  authorIdentityId: IdentityId;
  authorDeviceId: DeviceId;
  createdAt: number;
  text: string;
  signature: Signature;
}

// ── Discovery (AD-18, AD-19, AD-24) ─────────────────────────────────

export interface DiscoveryProfile {
  identityId: IdentityId;
  username: string;
  bio?: string; // max 160 graphemes, no avatar (AD-24)
  interests: string[]; // canonical tags e.g. "software.rust"
  languages: string[];
  online: boolean;
}

export interface RandomMatchRequest {
  identityId: IdentityId;
  interests: string[];
  languages: string[];
  reputationScore: number;
  exclude: IdentityId[];
}

// ── Chain API interface ──────────────────────────────────────────────

export interface UsernameRecord {
  username: string;
  ownerWallet: WalletAddress;
  identityId: IdentityId;
  registeredAt: number;
}

/** AD-14 stake-ranked validator entry */
export interface ValidatorRecord {
  wallet: WalletAddress;
  bondedStake: number;
  effectivePower: number;
  joinedAt: number;
}

/** Chain client interface (talks to .in chain or dev stub) */
export interface ChainApiClient {
  registerUsername(
    username: string,
    wallet: WalletAddress,
    identityId: IdentityId
  ): Promise<UsernameRecord>;
  resolveUsername(username: string): Promise<UsernameRecord | null>;
  transferUsername(
    username: string,
    newOwner: WalletAddress
  ): Promise<UsernameRecord>;
  getUsernameHistory(username: string): Promise<UsernameRecord[]>;
  getIdentityRoot(
    identityId: IdentityId
  ): Promise<{ wallet: WalletAddress } | null>;
  registerDeviceCertificate(
    wallet: WalletAddress,
    certificate: DeviceCertificate
  ): Promise<DeviceCertificate>;
  resolveDeviceCertificate(
    identityId: IdentityId,
    deviceId: DeviceId
  ): Promise<DeviceCertificate | null>;
  /** Optional AD-14 validator set (dev stub implements) */
  joinValidatorSet?(
    wallet: WalletAddress,
    bondedStake: number
  ): Promise<ValidatorRecord>;
  leaveValidatorSet?(wallet: WalletAddress): Promise<void>;
  listValidators?(): Promise<ValidatorRecord[]>;
}

// ── Crypto API interface ─────────────────────────────────────────────

export interface CryptoProvider {
  /** BLAKE3-256 derive_key domain separation (AD-8) */
  deriveId(context: string, data: Uint8Array): Uint8Array;
  /** Ed25519 sign */
  sign(secretKey: Uint8Array, message: Uint8Array): Signature;
  /** Ed25519 verify */
  verify(
    publicKey: PublicKey,
    message: Uint8Array,
    signature: Signature
  ): boolean;
  /** Generate Ed25519 keypair */
  generateSigningKeyPair(): { secretKey: Uint8Array; publicKey: PublicKey };
  /** XChaCha20-Poly1305 encrypt (AD-5) */
  encrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array
  ): Uint8Array;
  /** XChaCha20-Poly1305 decrypt (AD-5) */
  decrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array
  ): Uint8Array;
  /** Generate 32 random bytes */
  randomBytes(n: number): Uint8Array;
  /** HKDF-SHA256 */
  hkdf(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array;
}

// ── CBOR CDE API interface ───────────────────────────────────────────

export interface CborCdeCodec {
  /** Encode to CDE bytes (AD-4b: deterministic) */
  encode(value: unknown): Uint8Array;
  /** Decode from CDE bytes */
  decode<T = unknown>(bytes: Uint8Array): T;
}

// ── Relay / signalling API ───────────────────────────────────────────

export interface SessionOffer {
  fromIdentityId: IdentityId;
  fromDeviceId: DeviceId;
  toIdentityId: IdentityId;
  sessionId: Uint8Array;
  sdpOffer: string;
  capabilities: string[];
}

export interface SessionAnswer {
  sessionId: Uint8Array;
  sdpAnswer: string;
}

export interface TransportCandidate {
  sessionId: Uint8Array;
  candidate: string;
}

// ── Reputation (AD-18) ───────────────────────────────────────────────

export interface ReputationWeights {
  age: number; // 0.35 default
  completed: number; // 0.35 default
  continuity: number; // 0.15 default
  blockInverse: number; // 0.15 default
}

export const DEFAULT_REPUTATION_WEIGHTS: ReputationWeights = {
  age: 0.35,
  completed: 0.35,
  continuity: 0.15,
  blockInverse: 0.15,
};

export const DEFAULT_REPUTATION_THRESHOLD = 0.25;

// ── Storage queue interface ─────────────────────────────────────────

export type DeliveryState = "pending" | "sent" | "delivered" | "failed";

export interface OutboundQueueItem {
  messageId: MessageId;
  recipientIdentityId: IdentityId;
  encryptedEnvelope: Uint8Array;
  createdAt: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  attemptCount: number;
  deliveryState: DeliveryState;
}

/** Storage-agnostic queue interface for DI */
export interface OutboundQueueLike {
  enqueue(item: OutboundQueueItem): void;
  pending(): OutboundQueueItem[];
  pendingForRecipient(identityId: IdentityId): OutboundQueueItem[];
  markDelivered(messageId: MessageId): void;
  markAttempt(messageId: MessageId): void;
}
