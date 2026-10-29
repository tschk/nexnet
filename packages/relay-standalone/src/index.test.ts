import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateSigningKeyPair } from "@nexnet/crypto";
import { identityIdFromWallet, signIdentityAuthJson, toHex } from "@nexnet/protocol";
import { createRelay } from "./index.js";

interface Identity {
  hex: string;
  id: Uint8Array;
  root: { publicKey: Uint8Array; secretKey: Uint8Array };
  device: string;
}

function makeIdentity(deviceFill: number): Identity {
  const root = generateSigningKeyPair();
  const id = identityIdFromWallet(root.publicKey);
  return { hex: toHex(id), id, root, device: toHex(new Uint8Array(32).fill(deviceFill)) };
}

/** Open a socket for `claimed` and answer the challenge with `signer`'s key. */
async function connectAs(port: number, claimed: Identity, signer: Identity = claimed) {
  const socket = new WebSocket(`ws://localhost:${port}/ws?identity=${claimed.hex}&device=${claimed.device}`);
  const messages = collect(socket);
  await opened(socket);
  const challenge = (await nextMatching(messages, () => true)) as { type?: string; nonce: string };
  if (challenge.type !== "auth_challenge") return { socket, messages }; // pre-auth relay
  const { auth } = signIdentityAuthJson(
    { rootPublicKey: signer.root.publicKey, secretKey: signer.root.secretKey },
    "relay.connect",
    claimed.id,
    { audience: `localhost:${port}`, nonce: challenge.nonce, deviceId: claimed.device },
  );
  socket.send(JSON.stringify({ type: "auth", auth }));
  return { socket, messages };
}

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
  const port = app.server!.port!;
  const aliceId = makeIdentity(1);
  const bobId = makeIdentity(2);
  const { socket: alice, messages: aliceMessages } = await connectAs(port, aliceId);
  const { socket: bob, messages: bobMessages } = await connectAs(port, bobId);
  await nextMatching(aliceMessages, (message) => message.type === "authenticated");
  await nextMatching(bobMessages, (message) => message.type === "authenticated");

  alice.send(JSON.stringify({ type: "dm", to: bobId.hex, envelope: [1, 2, 3] }));
  expect(await nextMatching(bobMessages, (message) => message.type === "dm")).toEqual({
    type: "dm",
    from: aliceId.hex,
    envelope: [1, 2, 3],
  });

  bob.send(
    JSON.stringify({
      type: "delivery_receipt",
      to: aliceId.hex,
      from: "forged",
      receipt: { messageId: [1, 2, 3], recipientDeviceId: [4], storedAt: 1, signature: [5] },
    }),
  );
  expect(await nextMatching(aliceMessages, (message) => message.type === "delivery_receipt")).toEqual({
    type: "delivery_receipt",
    from: bobId.hex,
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
    from: aliceId.hex,
    event: { text: "hi" },
  });

  alice.close();
  bob.close();
});

test("claiming ?identity= without proof receives none of that identity's DMs", async () => {
  app.listen(0);
  const port = app.server!.port!;
  const victim = makeIdentity(1);
  const sender = makeIdentity(3);

  const impostor = new WebSocket(`ws://localhost:${port}/ws?identity=${victim.hex}&device=${victim.device}`);
  const impostorMessages = collect(impostor);
  await opened(impostor);
  const peer = await connectAs(port, sender);
  await within(nextMatching(peer.messages, (m) => m.type === "authenticated"));

  peer.socket.send(JSON.stringify({ type: "dm", to: victim.hex, envelope: [7] }));
  peer.socket.send(JSON.stringify({ type: "session_offer", to: victim.hex, sdp: "x", session_id: "s" }));
  expect(await within(nextMatching(impostorMessages, (m) => m.type === "dm" || m.type === "session_offer"))).toBeNull();

  impostor.close();
  peer.socket.close();
});

test("a proof from another identity's key is rejected and cannot evict the owner", async () => {
  app.listen(0);
  const port = app.server!.port!;
  const victim = makeIdentity(1);
  const mallory = makeIdentity(2);
  const sender = makeIdentity(3);

  const owner = await connectAs(port, victim);
  await within(nextMatching(owner.messages, (m) => m.type === "authenticated"));
  const peer = await connectAs(port, sender);
  await within(nextMatching(peer.messages, (m) => m.type === "authenticated"));

  const forged = await connectAs(port, victim, mallory);
  const forgedClosed = closed(forged.socket);
  expect(await within(nextMatching(forged.messages, (m) => m.type === "authenticated" || m.type === "error"))).toEqual({
    type: "error",
    message: "authentication failed",
  });
  expect(await within(forgedClosed)).toBe(4401);

  // DMs for the victim still reach the real owner, not the impostor.
  peer.socket.send(JSON.stringify({ type: "dm", to: victim.hex, envelope: [7] }));
  expect(await within(nextMatching(owner.messages, (m) => m.type === "dm"))).toEqual({
    type: "dm",
    from: sender.hex,
    envelope: [7],
  });

  owner.socket.close();
  peer.socket.close();
});

test("messages sent before authenticating are not routed", async () => {
  app.listen(0);
  const port = app.server!.port!;
  const sender = makeIdentity(3);
  const target = makeIdentity(4);
  const peer = await connectAs(port, target);
  await within(nextMatching(peer.messages, (m) => m.type === "authenticated"));

  const unproven = new WebSocket(`ws://localhost:${port}/ws?identity=${sender.hex}&device=${sender.device}`);
  const unprovenClosed = closed(unproven);
  await opened(unproven);
  unproven.send(JSON.stringify({ type: "dm", to: target.hex, envelope: [9] }));
  expect(await within(nextMatching(peer.messages, (m) => m.type === "dm"))).toBeNull();
  expect(await within(unprovenClosed)).toBe(4401);
  peer.socket.close();
});

/** Resolve with the value, or null if it does not settle within `ms`. */
function within<T>(promise: Promise<T>, ms = 300): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
}

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
    next: () =>
      new Promise((resolve) => {
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
    const message = (await messages.next().then(({ value }) => value)) as { type?: string };
    if (predicate(message)) return message;
  }
}
