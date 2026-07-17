/**
 * @nettle/client — Public chatrooms
 *
 * Room ID = deriveId(DOMAIN_ROOM_ID, normalizedRoomName).
 * Messages are signed plaintext published via relay.
 */

import type { RoomId, NettleEvent } from "@nettle/types";
import { DOMAIN_ROOM_ID, PROTOCOL_VERSION } from "@nettle/types";
import type { NettleClient } from "./client.js";

export function deriveRoomId(
  crypto: NettleClient["crypto"],
  roomName: string
): RoomId {
  const normalized = roomName.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  return crypto.deriveId(DOMAIN_ROOM_ID, encoded);
}

export async function joinRoom(
  client: NettleClient,
  roomName: string
): Promise<RoomId> {
  const roomId = deriveRoomId(client.crypto, roomName);
  const roomIdHex = Buffer.from(roomId).toString("hex");

  client.sendWs({
    type: "subscribe",
    channel: "room",
    roomId: roomIdHex,
  });

  return roomId;
}

export async function leaveRoom(
  client: NettleClient,
  roomId: RoomId
): Promise<void> {
  const roomIdHex = Buffer.from(roomId).toString("hex");
  client.sendWs({
    type: "unsubscribe",
    channel: "room",
    roomId: roomIdHex,
  });
}

export async function sendRoomMessage(
  client: NettleClient,
  roomId: RoomId,
  text: string
): Promise<void> {
  const now = Date.now();
  const eventCde = client.codec.encode({
    protocolVersion: PROTOCOL_VERSION,
    eventType: "room.message",
    authorIdentityId: client.identityId,
    authorDeviceId: client.deviceId,
    createdAt: now,
    sequence: now,
    parentIds: [],
    payload: client.codec.encode({ text }),
  });

  const signature = client.crypto.sign(client.signingSecretKey, eventCde);

  client.sendWs({
    type: "publish",
    channel: "room",
    roomId: Buffer.from(roomId).toString("hex"),
    event: Array.from(eventCde),
    signature: Array.from(signature),
  });
}

export function onRoomMessage(
  client: NettleClient,
  roomId: RoomId,
  callback: (event: NettleEvent) => void
): void {
  const roomIdHex = Buffer.from(roomId).toString("hex");

  client.on("room_message", (data) => {
    const msg = data as { roomId?: string; event?: number[] };
    if (msg.roomId === roomIdHex && msg.event) {
      try {
        const bytes = new Uint8Array(msg.event);
        const event = client.codec.decode<NettleEvent>(bytes);
        callback(event);
      } catch {
        // malformed — ignore
      }
    }
  });
}
