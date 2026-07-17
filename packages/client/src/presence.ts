import type { NexnetClient } from "./client.js";

type PresenceMessage = {
  type?: unknown;
  identityId?: unknown;
  status?: unknown;
  expiresAt?: unknown;
  leases?: unknown;
};

function emitUpdate(client: NexnetClient, identityId: unknown, status: unknown, expiresAt?: unknown): boolean {
  if (
    typeof identityId !== "string" ||
    (status !== "online" && status !== "offline") ||
    (expiresAt !== undefined && typeof expiresAt !== "number")
  ) {
    return false;
  }
  if (status === "online" && typeof expiresAt === "number" && expiresAt <= Date.now()) return false;
  client.emit("presence", {
    type: "presence_update",
    identityId,
    status,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  });
  return true;
}

export function consumePresenceMessage(client: NexnetClient, data: unknown): boolean {
  let message: PresenceMessage;
  try {
    message = typeof data === "string" ? JSON.parse(data) : data as PresenceMessage;
  } catch {
    return false;
  }
  if (!message || typeof message !== "object") return false;

  if (message.type === "presence_snapshot" && message.leases && typeof message.leases === "object") {
    let accepted = false;
    for (const [identityId, lease] of Object.entries(message.leases as Record<string, PresenceMessage>)) {
      accepted = emitUpdate(client, identityId, lease?.status, lease?.expiresAt) || accepted;
    }
    return accepted;
  }
  if (message.type === "presence" || message.type === "presence_update") {
    return emitUpdate(client, message.identityId, message.status, message.expiresAt);
  }
  return false;
}
