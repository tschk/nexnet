/**
 * @nettle/client — Direct messaging
 *
 * Flow: create MessagePayload → CDE encode → encrypt → build MessageEnvelope → sign → send/queue
 */

import type {
  IdentityId,
  MessageId,
  ConversationId,
  MessagePayload,
  MessageEnvelope,
  NettleEvent,
} from "@nettle/types";
import {
  DOMAIN_EVENT_ID,
  PROTOCOL_VERSION,
} from "@nettle/types";
import type { NettleClient } from "./client.js";
import type { OutboundQueueLike } from "@nettle/types";

const DOMAIN_CONVERSATION_ID = "nettle conversation id v1";

export function deriveConversationId(
  crypto: NettleClient["crypto"],
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
  client: NettleClient,
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

  const nonce = client.crypto.randomBytes(24);
  const aad = client.codec.encode({
    conversationId,
    senderIdentityId: client.identityId,
    recipientIdentityId: recipientId,
  });
  const ciphertext = client.crypto.encrypt(
    client.crypto.randomBytes(32),
    nonce,
    aad,
    payloadCde
  );

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
    try {
      client.sendWs({
        type: "send",
        target: Array.from(recipientId),
        envelope: Array.from(client.codec.encode(envelope)),
      });
      return messageId;
    } catch {
      // fall through to queue
    }
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

export function onDirectMessage(
  client: NettleClient,
  callback: (envelope: MessageEnvelope) => void
): void {
  client.on("dm", (data) => {
    const msg = data as {
      envelope: number[];
      ciphertext: Uint8Array;
    };
    try {
      if (msg.envelope) {
        const bytes = new Uint8Array(msg.envelope);
        const envelope = client.codec.decode<MessageEnvelope>(bytes);
        callback(envelope);
      }
    } catch {
      // malformed envelope — ignore
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
