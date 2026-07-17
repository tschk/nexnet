import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRelay } from "./index.js";

let app: ReturnType<typeof createRelay>;

beforeEach(() => {
  app = createRelay();
});

afterEach(() => {
  if (app.server) app.stop();
});

test("health reports an empty relay", async () => {
  const response = await app.handle(new Request("http://relay/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", clients: 0, rooms: 0 });
});

test("status lists no clients before connections", async () => {
  const response = await app.handle(new Request("http://relay/"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: "nexnet-relay-standalone", clients: [] });
});

test("local server forwards DM and room events", async () => {
  app.listen(0);
  const port = app.server!.port;
  const alice = new WebSocket(`ws://localhost:${port}/ws?identity=alice&device=a1`);
  const bob = new WebSocket(`ws://localhost:${port}/ws?identity=bob&device=b1`);
  const aliceMessages = collect(alice);
  const bobMessages = collect(bob);

  await Promise.all([opened(alice), opened(bob)]);

  alice.send(JSON.stringify({ type: "dm", to: "bob", envelope: [1, 2, 3] }));
  expect(await nextMatching(bobMessages, (message) => message.type === "dm")).toEqual({
    type: "dm",
    from: "alice",
    envelope: [1, 2, 3],
  });

  bob.send(JSON.stringify({
    type: "delivery_receipt",
    to: "alice",
    from: "forged",
    receipt: { messageId: [1, 2, 3], recipientDeviceId: [4], storedAt: 1, signature: [5] },
  }));
  expect(await nextMatching(aliceMessages, (message) => message.type === "delivery_receipt")).toEqual({
    type: "delivery_receipt",
    from: "bob",
    receipt: { messageId: [1, 2, 3], recipientDeviceId: [4], storedAt: 1, signature: [5] },
  });

  alice.send(JSON.stringify({ type: "room_subscribe", room_id: "general" }));
  bob.send(JSON.stringify({ type: "room_subscribe", room_id: "general" }));
  await Promise.all([
    nextMatching(aliceMessages, (message) => message.type === "room_subscribed"),
    nextMatching(bobMessages, (message) => message.type === "room_subscribed"),
  ]);
  alice.send(JSON.stringify({ type: "room_event", room_id: "general", event: { text: "hi" } }));
  expect(await nextMatching(bobMessages, (message) => message.type === "room_event")).toEqual({
    type: "room_event",
    room_id: "general",
    from: "alice",
    event: { text: "hi" },
  });

  alice.close();
  bob.close();
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}

function collect(socket: WebSocket): AsyncIterableIterator<unknown> {
  const messages: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return {
    next: () => new Promise((resolve) => {
      const message = messages.shift();
      if (message !== undefined) resolve({ done: false, value: message });
      else waiters.push((value) => resolve({ done: false, value }));
    }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function nextMatching(
  messages: AsyncIterableIterator<unknown>,
  predicate: (message: { type?: string }) => boolean,
): Promise<unknown> {
  for (;;) {
    const message = await messages.next().then(({ value }) => value) as { type?: string };
    if (predicate(message)) return message;
  }
}
