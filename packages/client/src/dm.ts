/**
 * @nexnet/client — Direct messaging
 *
 * Flow: payload → CDE → Double Ratchet seal → envelope sign → send/queue
 * First message may use X3DH when peer bundle + local prekeys exist.
 * Wire v1: ratchet only. Wire v2: X3DH handshake ‖ ratchet.
 */

import type {
  IdentityId,
  MessageId,
  ConversationId,
  MessagePayload,
  MessageEnvelope,
  OutboundQueueLike,
  DeviceCertificate,
  DeviceCertificateResolver,
} from "@nexnet/types";
import { DOMAIN_EVENT_ID, PROTOCOL_VERSION } from "@nexnet/types";
import { verifyDeviceCert } from "@nexnet/protocol";
import type { NexnetClient } from "./client.js";
import {
  getOrCreateRecvSession,
  getOrCreateSendSession,
  getSession,
  initInitiator,
  initResponder,
  open as ratchetOpen,
  saveSession,
  seal as ratchetSeal,
  sessionStoreKey,
  setSession,
} from "./double-ratchet.js";
import {
  fetchBundle,
  getLocalPrekeys,
  refreshPublishedBundle,
} from "./prekeys.js";
import { x3dhInitiate, x3dhRespond } from "./x3dh.js";
import { trySendDirect } from "./transport.js";

const DOMAIN_CONVERSATION_ID = "nexnet conversation id v1";
const DOMAIN_CONVERSATION_KEY = "nexnet dm conversation key v1";

/** Wire v2: X3DH first-message prefix before ratchet blob */
export const DM_WIRE_X3DH = 2;
const X3DH_PREFIX_LEN = 1 + 32 + 32 + 4; // ver || IKa || EKa || otp_id

export interface SendDirectMessageOptions {
  directOnly?: boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameCertificate(a: DeviceCertificate, b: DeviceCertificate): boolean {
  return (
    sameBytes(a.accountId, b.accountId) &&
    sameBytes(a.deviceId, b.deviceId) &&
    sameBytes(a.deviceSigningPublicKey, b.deviceSigningPublicKey) &&
    sameBytes(a.deviceEncryptionPublicKey, b.deviceEncryptionPublicKey) &&
    a.issuedAt === b.issuedAt &&
    a.expiresAt === b.expiresAt &&
    a.capabilities === b.capabilities &&
    sameBytes(a.rootSignature, b.rootSignature)
  );
}

async function senderCertificate(client: NexnetClient): Promise<DeviceCertificate> {
  const cert = client.deviceCertificate;
  if (
    !cert ||
    !client.deviceSigningPublicKey ||
    !client.deviceSigningSecretKey
  ) {
    throw new Error("A root-authorized device certificate is required");
  }
  if (
    !sameBytes(cert.accountId, client.identityId) ||
    !sameBytes(cert.deviceId, client.deviceId) ||
    !sameBytes(cert.deviceSigningPublicKey, client.deviceSigningPublicKey) ||
    cert.issuedAt > Date.now() ||
    cert.expiresAt <= Date.now()
  ) {
    throw new Error("Invalid device certificate");
  }
  if (client.rootPublicKey && verifyDeviceCert(cert, client.rootPublicKey)) {
    return cert;
  }
  const registered = await client.deviceCertificateResolver?.(
    client.identityId,
    client.deviceId
  );
  if (!registered || !sameCertificate(cert, registered)) {
    throw new Error("Invalid device certificate");
  }
  return cert;
}

function handleAuthorizedDirectMessage(
  client: NexnetClient,
  callback: (envelope: MessageEnvelope, payload: MessagePayload) => void,
  envelope: MessageEnvelope,
  bytes: Uint8Array,
  preimage: Uint8Array
): void {
  try {
    const cert = envelope.senderCertificate;
    if (!cert || !client.crypto.verify(cert.deviceSigningPublicKey, preimage, envelope.signature)) return;
    if (client.hasIncomingMessage(envelope.messageId)) return;

    if (envelope.ciphertext.length < 2) return;

    const aad = client.codec.encode({
      conversationId: envelope.conversationId,
      senderIdentityId: envelope.senderIdentityId,
      recipientIdentityId: envelope.recipientIdentityId,
    });
    const sessionKey = sessionStoreKey(
      envelope.conversationId,
      envelope.senderIdentityId
    );

    let ratchetBlob = envelope.ciphertext;
    let existing = getSession(sessionKey);

    if (!existing) {
      const x3dh = decodeX3dhPrefix(envelope.ciphertext);
      const local = getLocalPrekeys(client.identityId);

      if (x3dh && local) {
        const resp = x3dhRespond(
          client.crypto,
          local,
          x3dh.identityDhPublic,
          x3dh.ekPublic,
          x3dh.otpId
        );
        existing = initResponder(resp.sk, client.crypto);
        setSession(sessionKey, existing);
        ratchetBlob = x3dh.ratchetBlob;
        // Drop used OTP from published bundle if we know our sign pk
        // our own sign pk is not in getSenderPublicKey; refresh if local only
        const selfBundle = fetchBundle(client.identityId);
        if (selfBundle) {
          refreshPublishedBundle(
            client.identityId,
            selfBundle.identitySignPublic
          );
        }
      } else {
        const rootSk = deriveConversationKey(
          client.crypto,
          envelope.conversationId
        );
        existing = getOrCreateRecvSession(
          sessionKey,
          rootSk,
          client.crypto
        );
      }
    } else if (envelope.ciphertext[0] === DM_WIRE_X3DH) {
      // Session already exists; strip accidental v2 prefix if re-delivered
      const x3dh = decodeX3dhPrefix(envelope.ciphertext);
      if (x3dh) ratchetBlob = x3dh.ratchetBlob;
    }

    const plaintext = ratchetOpen(
      client.crypto,
      existing,
      ratchetBlob,
      aad
    );
    saveSession(sessionKey, existing);

    const payload = client.codec.decode<MessagePayload>(plaintext);
    if (!client.persistIncomingMessage(envelope.messageId, bytes)) return;
    callback(envelope, payload);
    client.sendDeliveryReceipt(
      Buffer.from(envelope.senderIdentityId).toString("hex"),
      envelope.messageId
    );
  } catch {
  }
}

/**
 * Fallback root SK from conversation_id (no prekeys).
 */
export function deriveConversationKey(
  crypto: NexnetClient["crypto"],
  conversationId: ConversationId
): Uint8Array {
  return crypto.hkdf(
    conversationId,
    new Uint8Array(0),
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

function encodeX3dhPrefix(
  identityDhPublic: Uint8Array,
  ekPublic: Uint8Array,
  otpId?: number
): Uint8Array {
  const out = new Uint8Array(X3DH_PREFIX_LEN);
  out[0] = DM_WIRE_X3DH;
  out.set(identityDhPublic, 1);
  out.set(ekPublic, 33);
  new DataView(out.buffer).setUint32(65, otpId ?? 0);
  return out;
}

function decodeX3dhPrefix(blob: Uint8Array): {
  identityDhPublic: Uint8Array;
  ekPublic: Uint8Array;
  otpId?: number;
  ratchetBlob: Uint8Array;
} | null {
  if (blob.length < X3DH_PREFIX_LEN + 2 || blob[0] !== DM_WIRE_X3DH) {
    return null;
  }
  const otpRaw = new DataView(
    blob.buffer,
    blob.byteOffset + 65,
    4
  ).getUint32(0);
  return {
    identityDhPublic: blob.slice(1, 33),
    ekPublic: blob.slice(33, 65),
    otpId: otpRaw === 0 ? undefined : otpRaw,
    ratchetBlob: blob.subarray(X3DH_PREFIX_LEN),
  };
}

export async function sendDirectMessage(
  client: NexnetClient,
  recipientId: IdentityId,
  message: string | MessagePayload,
  queue?: OutboundQueueLike,
  options: SendDirectMessageOptions = {}
): Promise<MessageId> {
  const certificate = await senderCertificate(client);
  const conversationId = deriveConversationId(
    client.crypto,
    client.identityId,
    recipientId
  );

  const payload: MessagePayload =
    typeof message === "string"
      ? { contentType: "text", text: message }
      : message;
  const payloadCde = client.codec.encode(payload);
  const now = Date.now();
  const messageId = client.crypto.deriveId(
    DOMAIN_EVENT_ID,
    client.codec.encode({
      conversationId,
      senderIdentityId: client.identityId,
      recipientIdentityId: recipientId,
      createdAt: now,
      nonce: client.crypto.randomBytes(16),
      payloadCde,
    })
  );

  const aad = client.codec.encode({
    conversationId,
    senderIdentityId: client.identityId,
    recipientIdentityId: recipientId,
  });
  const sessionKey = sessionStoreKey(conversationId, recipientId);

  let ciphertext: Uint8Array;
  const existing = getSession(sessionKey);

  if (existing) {
    ciphertext = ratchetSeal(client.crypto, existing, payloadCde, aad);
    saveSession(sessionKey, existing);
  } else {
    // Prefer X3DH when peer bundle (local cache or prior fetch) + our material exist
    const local = getLocalPrekeys(client.identityId);
    const remote = fetchBundle(recipientId);

    if (local && remote) {
      const init = x3dhInitiate(
        client.crypto,
        local.identityDh.secretKey,
        remote
      );
      const ratchet = initInitiator(init.sk, client.crypto);
      const sealed = ratchetSeal(client.crypto, ratchet, payloadCde, aad);
      setSession(sessionKey, ratchet);
      const prefix = encodeX3dhPrefix(
        local.identityDh.publicKey,
        init.ekPublic,
        init.usedOneTimePrekeyId
      );
      ciphertext = new Uint8Array(prefix.length + sealed.length);
      ciphertext.set(prefix, 0);
      ciphertext.set(sealed, prefix.length);
    } else {
      const rootSk = deriveConversationKey(client.crypto, conversationId);
      const ratchet = getOrCreateSendSession(
        sessionKey,
        rootSk,
        client.crypto
      );
      ciphertext = ratchetSeal(client.crypto, ratchet, payloadCde, aad);
      saveSession(sessionKey, ratchet);
    }
  }

  const envelopePreimage = client.codec.encode({
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    conversationId,
    senderIdentityId: client.identityId,
    senderDeviceId: client.deviceId,
    recipientIdentityId: recipientId,
    senderCertificate: certificate,
    senderSequence: now,
    parentIds: [],
    createdAt: now,
    ciphertext,
  });
  const signature = client.crypto.sign(
    client.deviceSigningSecretKey!,
    envelopePreimage
  );

  const envelope: MessageEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    conversationId,
    senderIdentityId: client.identityId,
    senderDeviceId: client.deviceId,
    recipientIdentityId: recipientId,
    senderCertificate: certificate,
    senderSequence: now,
    parentIds: [],
    createdAt: now,
    ciphertext,
    signature,
  };

  const recipientHex = Buffer.from(recipientId).toString("hex");
  const encoded = client.codec.encode(envelope);

  // Prefer open WebRTC data channel (AD-20 style direct)
  if (trySendDirect(recipientHex, encoded)) {
    return messageId;
  }

  if (options.directOnly) {
    throw new Error("Direct session is required");
  }

  if (client.online) {
    const sent = client.sendDm(recipientHex, Array.from(encoded));
    if (sent) return messageId;
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
 * @param getSenderPublicKey - identityId → Ed25519 public; verifies envelope.
 * @param getSenderSignPublic - same, used to re-publish bundle after OTP use
 *   (optional; only for refresh after x3dh respond).
 */
export function onDirectMessage(
  client: NexnetClient,
  callback: (envelope: MessageEnvelope, payload: MessagePayload) => void,
  getSenderRootPublicKey?: (identityId: IdentityId) => Uint8Array | undefined,
  resolveDeviceCertificate: DeviceCertificateResolver | undefined = client.deviceCertificateResolver
): void {
  client.on("dm", (data) => {
    const msg = data as { envelope: number[] };
    try {
      if (!msg.envelope) return;

      const bytes = new Uint8Array(msg.envelope);
      const envelope = client.codec.decode<MessageEnvelope>(bytes);

      const preimage = client.codec.encode({
        protocolVersion: envelope.protocolVersion,
        messageId: envelope.messageId,
        conversationId: envelope.conversationId,
        senderIdentityId: envelope.senderIdentityId,
        senderDeviceId: envelope.senderDeviceId,
        recipientIdentityId: envelope.recipientIdentityId,
        senderCertificate: envelope.senderCertificate,
        senderSequence: envelope.senderSequence,
        parentIds: envelope.parentIds,
        createdAt: envelope.createdAt,
        ciphertext: envelope.ciphertext,
      });

      const rootPk = getSenderRootPublicKey?.(envelope.senderIdentityId);
      const cert = envelope.senderCertificate;
      if (
        !cert ||
        !sameBytes(cert.accountId, envelope.senderIdentityId) ||
        !sameBytes(cert.deviceId, envelope.senderDeviceId) ||
        cert.issuedAt > envelope.createdAt ||
        cert.expiresAt < envelope.createdAt
      ) {
        return;
      }
      if (rootPk && verifyDeviceCert(cert, rootPk)) {
        handleAuthorizedDirectMessage(client, callback, envelope, bytes, preimage);
        return;
      }
      if (!resolveDeviceCertificate) return;
      void (async () => {
        try {
          const registered = await resolveDeviceCertificate(
            envelope.senderIdentityId,
            envelope.senderDeviceId
          );
          if (registered && sameCertificate(cert, registered)) {
            handleAuthorizedDirectMessage(client, callback, envelope, bytes, preimage);
          }
        } catch {}
      })();
    } catch {
      // malformed / decrypt fail — drop
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
