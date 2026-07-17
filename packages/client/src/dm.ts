/**
 * @nexnet/client — Direct messaging
 *
 * Flow: create MessagePayload → CDE encode → encrypt → build MessageEnvelope → sign → send/queue
 */

import type {
  IdentityId,
  MessageId,
  ConversationId,
  MessagePayload,
  MessageEnvelope,
  NexnetEvent,
} from "@nexnet/types";
import {
  DOMAIN_EVENT_ID,
  PROTOCOL_VERSION,
} from "@nexnet/types";
import type { NexnetClient } from "./client.js";
import type { OutboundQueueLike } from "@nexnet/types";
import {
  getOrCreateRecvSession,
  getOrCreateSendSession,
  open as ratchetOpen,
  seal as ratchetSeal,
  sessionStoreKey,
} from "./double-ratchet.js";

const DOMAIN_CONVERSATION_ID = "nexnet conversation id v1";
const DOMAIN_CONVERSATION_KEY = "nexnet dm conversation key v1";

/**
 * Derive root shared secret from conversation_id via HKDF.
 * Both sides produce same SK (conversation_id is symmetric).
 * Used as Double Ratchet initial root seed (no X3DH yet).
 */
export function deriveConversationKey(
  crypto: NexnetClient["crypto"],
  conversationId: ConversationId
): Uint8Array {
  return crypto.hkdf(
    conversationId,
    new Uint8Array(0), // no salt
    new TextEncoder().encode(DOMAIN_CONVERSATION_KEY),
    32
  );
}

export function deriveConversationId(
  crypto: NexnetClient["crypto"],
  a: IdentityId,
  b: IdentityId
): ConversationId {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const combined = new Uint8Array(64);
  combined.set(first, 0);
  combined.set(second, 32);
  return crypto.deriveId(DOMAIN_CONVERSATION_ID, combined);
}

export async function sendDirectMessage(
  client: NexnetClient,
  recipientId: IdentityId,
  text: string,
  queue?: OutboundQueueLike
): Promise<MessageId> {
  const conversationId = deriveConversationId(
    client.crypto,
    client.identityId,
    recipientId
  );

  const payload: MessagePayload = {
    contentType: "text",
    text,
  };
  const payloadCde = client.codec.encode(payload);

  const messageId = client.crypto.deriveId(DOMAIN_EVENT_ID, payloadCde);

  const rootSk = deriveConversationKey(client.crypto, conversationId);
  const aad = client.codec.encode({
    conversationId,
    senderIdentityId: client.identityId,
    recipientIdentityId: recipientId,
  });
  const sessionKey = sessionStoreKey(conversationId, recipientId);
  const ratchet = getOrCreateSendSession(sessionKey, rootSk, client.crypto);
  // Wire: version ‖ header ‖ nonce ‖ ciphertext (Double Ratchet)
  const ciphertext = ratchetSeal(client.crypto, ratchet, payloadCde, aad);

  const now = Date.now();
  const envelopePreimage = client.codec.encode({
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    conversationId,
    senderIdentityId: client.identityId,
    senderDeviceId: client.deviceId,
    recipientIdentityId: recipientId,
    senderSequence: now,
    parentIds: [],
    createdAt: now,
    ciphertext,
  });
  const signature = client.crypto.sign(
    client.signingSecretKey,
    envelopePreimage
  );

  const envelope: MessageEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    conversationId,
    senderIdentityId: client.identityId,
    senderDeviceId: client.deviceId,
    recipientIdentityId: recipientId,
    senderSequence: now,
    parentIds: [],
    createdAt: now,
    ciphertext,
    signature,
  };

  if (client.online) {
    const recipientHex = Buffer.from(recipientId).toString("hex");
    const sent = client.sendDm(recipientHex, Array.from(client.codec.encode(envelope)));
    if (sent) return messageId;
    // fall through to queue
  }

  if (queue) {
    queue.enqueue({
      messageId,
      recipientIdentityId: recipientId,
      encryptedEnvelope: client.codec.encode(envelope),
      createdAt: now,
      attemptCount: 0,
      deliveryState: "pending",
    });
    return messageId;
  }

  throw new Error("Not connected and no queue provided");
}

/**
 * Subscribe to incoming DMs. Verifies signature, decrypts payload,
 * and calls callback with the parsed MessagePayload + envelope metadata.
 *
 * @param getSenderPublicKey - optional resolver: identityId → Ed25519 public key.
 *   When provided, the envelope signature is verified. Messages with invalid
 *   or unresolvable signatures are silently dropped.
 */
export function onDirectMessage(
  client: NexnetClient,
  callback: (envelope: MessageEnvelope, payload: MessagePayload) => void,
  getSenderPublicKey?: (identityId: IdentityId) => Uint8Array | undefined
): void {
  client.on("dm", (data) => {
    const msg = data as {
      envelope: number[];
    };
    try {
      if (!msg.envelope) return;

      const bytes = new Uint8Array(msg.envelope);
      const envelope = client.codec.decode<MessageEnvelope>(bytes);

      // 1. Verify Ed25519 signature on envelope preimage
      const preimage = client.codec.encode({
        protocolVersion: envelope.protocolVersion,
        messageId: envelope.messageId,
        conversationId: envelope.conversationId,
        senderIdentityId: envelope.senderIdentityId,
        senderDeviceId: envelope.senderDeviceId,
        recipientIdentityId: envelope.recipientIdentityId,
        senderSequence: envelope.senderSequence,
        parentIds: envelope.parentIds,
        createdAt: envelope.createdAt,
        ciphertext: envelope.ciphertext,
      });

      // Sender public key must be known/looked up externally.
      if (getSenderPublicKey) {
        const senderPk = getSenderPublicKey(envelope.senderIdentityId);
        if (!senderPk) return; // unknown sender, drop
        const valid = client.crypto.verify(senderPk, preimage, envelope.signature);
        if (!valid) return; // invalid signature, drop
      }

      // 2. Decrypt via Double Ratchet (wire v1 in ciphertext)
      if (envelope.ciphertext.length < 2) return;
      const rootSk = deriveConversationKey(
        client.crypto,
        envelope.conversationId
      );
      const aad = client.codec.encode({
        conversationId: envelope.conversationId,
        senderIdentityId: envelope.senderIdentityId,
        recipientIdentityId: envelope.recipientIdentityId,
      });
      // Session keyed by peer (sender) so send+recv share one state
      const sessionKey = sessionStoreKey(
        envelope.conversationId,
        envelope.senderIdentityId
      );
      const ratchet = getOrCreateRecvSession(
        sessionKey,
        rootSk,
        client.crypto
      );
      const plaintext = ratchetOpen(
        client.crypto,
        ratchet,
        envelope.ciphertext,
        aad
      );

      // 3. Parse payload
      const payload = client.codec.decode<MessagePayload>(plaintext);

      callback(envelope, payload);
    } catch {
      // malformed envelope or decryption failure — ignore
    }
  });
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
