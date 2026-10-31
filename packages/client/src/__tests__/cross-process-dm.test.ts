import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

// Real relay and presence service; each DM peer runs in its own Bun process.
// Loaded by path so this package's typecheck does not pull in other packages.
const RELAY_MODULE = "../../../relay-standalone/src/index.ts";
const PRESENCE_MODULE = "../../../../workers/presence/src/index.ts";

let relay: { server: { port: number } | null; stop(): void };
let presence: ReturnType<typeof Bun.serve>;
const peers: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(async () => {
  const { createRelay } = await import(RELAY_MODULE);
  const { default: presenceWorker, PresenceTracker } = await import(PRESENCE_MODULE);
  relay = createRelay().listen({ port: 0, hostname: "127.0.0.1" });
  const store = new Map<string, unknown>();
  const tracker = new PresenceTracker(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => store.delete(key),
        list: async () => store,
      },
      acceptWebSocket: () => {},
    },
    {},
  );
  const env = {
    PRESENCE: {
      idFromName: () => "global",
      get: () => ({ fetch: (input: RequestInfo, init?: RequestInit) => tracker.fetch(new Request(input, init)) }),
    },
  };
  presence = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => presenceWorker.fetch(req, env) });
});

afterAll(() => {
  for (const peer of peers) peer.kill();
  relay.stop();
  presence.stop(true);
});

function spawnPeer(...extra: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/cross-process-peer.ts"),
      `http://127.0.0.1:${relay.server!.port}`,
      `http://127.0.0.1:${presence.port}`,
      ...extra,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  peers.push(proc);
  const lines = (async function* () {
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("{")) yield JSON.parse(line) as Record<string, unknown>;
      }
    }
  })();
  return {
    async next(event: string): Promise<Record<string, unknown>> {
      // Pull manually: a for-await `return` would close the shared generator.
      for (;;) {
        const { value: message, done } = await lines.next();
        if (done) throw new Error(`peer exited before ${event}`);
        if (message.event === event) return message;
        if (message.event === "error") throw new Error(String(message.message));
      }
    },
  };
}

test("an E2EE DM session works between two separate processes", async () => {
  const bob = spawnPeer();
  const { identity } = await bob.next("ready");
  const alice = spawnPeer(String(identity));

  expect(await alice.next("sent")).toEqual({ event: "sent" });
  expect(await bob.next("dm")).toEqual({ event: "dm", text: "hello" });
  // The reply rides the session bob established as responder in his own process.
  expect(await alice.next("dm")).toEqual({ event: "dm", text: "pong:hello" });
}, 20_000);
