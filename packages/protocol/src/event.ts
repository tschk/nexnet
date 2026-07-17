/**
 * NettleEvent signing and verification
 *
 * Signing preimage: all event fields EXCEPT signature.
 * ID preimage: all fields EXCEPT signature AND eventId.
 *
 * eventId = deriveId(DOMAIN_EVENT_ID, cde(idPreimage))
 * signature = sign(sk, cde(signingPreimage))
 */
import type {
  NettleEvent,
  NettleEventPreimage,
  NettleEventIdPreimage,
  EventId,
  Signature,
  PublicKey,
} from "@nettle/types";
import {
  DOMAIN_EVENT_ID,
  MAX_PAYLOAD_BYTES,
  MAX_PARENT_IDS,
  MAX_EVENT_TYPE_LEN,
} from "@nettle/types";
import { deriveId } from "@nettle/crypto";
import { sign, verify } from "@nettle/crypto";
import { cdeEncode } from "./cde.js";

/** Build the ID preimage (everything except signature and eventId). */
function toIdPreimage(
  event: Omit<NettleEvent, "eventId" | "signature">
): NettleEventIdPreimage {
  return {
    protocolVersion: event.protocolVersion,
    eventType: event.eventType,
    authorIdentityId: event.authorIdentityId,
    authorDeviceId: event.authorDeviceId,
    createdAt: event.createdAt,
    sequence: event.sequence,
    parentIds: event.parentIds,
    payload: event.payload,
  };
}

/** Build the signing preimage (everything except signature). */
function toSigningPreimage(event: NettleEvent): NettleEventPreimage {
  return {
    protocolVersion: event.protocolVersion,
    eventType: event.eventType,
    eventId: event.eventId,
    authorIdentityId: event.authorIdentityId,
    authorDeviceId: event.authorDeviceId,
    createdAt: event.createdAt,
    sequence: event.sequence,
    parentIds: event.parentIds,
    payload: event.payload,
  };
}

/** Validate event size limits. */
export function validateEventLimits(event: NettleEvent): void {
  if (event.payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Payload ${event.payload.length} exceeds max ${MAX_PAYLOAD_BYTES}`
    );
  }
  if (event.parentIds.length > MAX_PARENT_IDS) {
    throw new Error(
      `ParentIds ${event.parentIds.length} exceeds max ${MAX_PARENT_IDS}`
    );
  }
  if (event.eventType.length > MAX_EVENT_TYPE_LEN) {
    throw new Error(
      `EventType "${event.eventType}" exceeds max ${MAX_EVENT_TYPE_LEN}`
    );
  }
}

/** Sign an event: compute eventId then sign. Returns complete NettleEvent. */
export function signEvent(
  preimage: Omit<NettleEvent, "eventId" | "signature">,
  secretKey: Uint8Array
): NettleEvent {
  // Compute eventId from id preimage (no signature, no eventId)
  const idBytes = cdeEncode(toIdPreimage(preimage));
  const eventId = deriveId(DOMAIN_EVENT_ID, idBytes) as EventId;

  // Build full event (without signature) for signing
  const event: NettleEvent = {
    ...preimage,
    eventId,
    signature: new Uint8Array(64) as Signature, // placeholder
  };

  // Sign the CDE-encoded signing preimage
  const signBytes = cdeEncode(toSigningPreimage(event));
  event.signature = sign(secretKey, signBytes);

  return event;
}

/** Verify an event's signature against a public key. */
export function verifyEvent(
  event: NettleEvent,
  publicKey: PublicKey
): boolean {
  const signBytes = cdeEncode(toSigningPreimage(event));
  return verify(publicKey, signBytes, event.signature);
}
