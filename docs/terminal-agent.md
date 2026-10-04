# Terminal agent protocol

The terminal UI (`terminal/`, Rust, Crepuscularity) holds no keys and speaks no
network protocol. It talks to an **agent** with newline-delimited JSON. The agent
owns the wallet, signs in, signs events and talks to the gateway.

Agents:

- `packages/agent` (Bun) for Linux and macOS terminals. The UI spawns it as a
  child process and uses its stdin/stdout.
- A browser host bridge for the website's Linux guest, over the serial line
  `/dev/ttyS0`, where every line carries the prefix `@@nexnet ` so it can share
  the debug console.

Each line is one JSON object, at most 65536 bytes, UTF-8.

## Requests (UI to agent)

```json
{"id": 1, "cmd": "hello", "protocol": 1}
{"id": 2, "cmd": "state"}
{"id": 3, "cmd": "identity.create"}
{"id": 4, "cmd": "signin", "method": "wallet"}
{"id": 5, "cmd": "signout"}
{"id": 6, "cmd": "history", "channel": "public", "limit": 50}
{"id": 7, "cmd": "post", "channel": "public", "body": "text"}
{"id": 8, "cmd": "subscribe", "channels": ["updates", "public"]}
```

`method` is `wallet`, `ssh` or `passkey`. `channel` is `updates` or `public`.
`body` is 1 to 2000 UTF-8 bytes.

## Responses (agent to UI)

```json
{"id": 1, "ok": true, "result": {}}
{"id": 7, "ok": false, "error": {"code": "forbidden", "message": "..."}}
```

Error codes: `unconfigured`, `offline`, `unauthenticated`, `forbidden`,
`revoked`, `rate_limited`, `invalid`, `internal`.

## Results

`hello`: `{"agent": "name", "protocol": 1, "methods": ["wallet", "ssh"]}`.
`methods` lists the sign-in methods this agent can perform.

`state` and the `state` event carry:

```json
{
  "gateway": {"status": "online", "url": "https://..."},
  "identity": {"id": "64hex", "short": "nx1abcd…wxyz", "username": null},
  "session": {"method": "ssh", "expiresAt": 1790000000000},
  "owner": false
}
```

`gateway.status` is `unconfigured` (no gateway URL known), `offline` or `online`.
`identity` and `session` are `null` until they exist. `owner` is true only when the
signed-in identity matches the gateway's owner identity.

`history`: `{"channel": "public", "messages": [Message]}` oldest first.
`post`: `{"message": Message}`. `identity.create`, `signin` and `signout`: the
new `state` object.

## Events (agent to UI, no id)

```json
{"event": "message", "channel": "public", "message": Message}
{"event": "state", "state": {}}
{"event": "error", "code": "offline", "message": "..."}
```

`Message`:

```json
{"id": "64hex", "author": {"id": "64hex", "short": "nx1abcd…wxyz", "username": null}, "body": "text", "at": 1790000000000}
```

## Rules for the UI

- Reading works signed out; the UI shows `updates` and `public` history first.
- `updates` is never editable for non-owners; only `owner: true` may post there.
- Posting needs a session; the UI must present identity creation and sign-in
  rather than failing silently.
- The UI never displays raw tokens, keys or signatures.
