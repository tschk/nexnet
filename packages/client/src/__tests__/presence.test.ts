import { describe, expect, test } from "bun:test";
import { consumePresenceMessage } from "../presence.js";

describe("consumePresenceMessage", () => {
  test("normalizes a presence worker snapshot for queue delivery", () => {
    const updates: unknown[] = [];
    const client = { emit: (_event: string, data: unknown) => updates.push(data) } as never;
    const recipient = "ab".repeat(32);

    expect(consumePresenceMessage(client, JSON.stringify({
      type: "presence_snapshot",
      leases: {
        [recipient]: { status: "online", expiresAt: Date.now() + 60_000 },
        expired: { status: "online", expiresAt: Date.now() - 1 },
      },
    }))).toBe(true);

    expect(updates).toEqual([{
      type: "presence_update",
      identityId: recipient,
      status: "online",
      expiresAt: expect.any(Number),
    }]);
  });

  test("rejects malformed presence data", () => {
    const client = { emit() {} } as never;
    expect(consumePresenceMessage(client, "not-json")).toBe(false);
    expect(consumePresenceMessage(client, { type: "presence_update", status: "online" })).toBe(false);
  });
});
