# Nexnet — Continuation Agent Prompt

## Context

You are continuing work on **nexnet** (formerly "nettle"), an open-source P2P social chat network with blockchain-backed identity, local-first history, and privacy-routed discovery.

**Repo:** https://github.com/tschk/nexnet  
**Working directory:** /Users/undivisible/projects/nexnet  
**License:** ISC  
**Stack:** TypeScript (Bun) + Cloudflare Workers + OpenTUI + SolidJS. Chain app in inauguration `.in` (separate project at ../inauguration).

## CRITICAL: Rename in progress

The project was renamed from "nettle" to "nexnet". The GitHub repo is already renamed. The local directory is `/Users/undivisible/projects/nexnet`. **The bash CWD may be stuck on the old path.** Fix this first:

```bash
# Create symlink if needed so tools can find the directory
ln -sf /Users/undivisible/projects/nexnet /Users/undivisible/projects/nettle 2>/dev/null || true
cd /Users/undivisible/projects/nexnet
```

Then verify no remaining "nettle" references:
```bash
grep -r "nettle" --include='*.ts' --include='*.tsx' --include='*.json' --include='*.toml' --include='*.md' . | grep -v node_modules | grep -v '.git/' | grep -v bun.lock
```

Fix any remaining occurrences to "nexnet" (case-sensitive: nettle→nexnet, Nettle→Nexnet, NETTLE→NEXNET, @nettle/→@nexnet/).

## Current state (169 tests passing)

| Package | What | Status |
|---|---|---|
| @nexnet/types | Protocol type definitions | ✅ Complete |
| @nexnet/crypto | Ed25519, X25519, XChaCha20-Poly1305, BLAKE3-256, HKDF | ✅ Complete |
| @nexnet/protocol | CBOR CDE encode, event signing, device certs | ✅ Complete |
| @nexnet/storage | Encrypted SQLite event log, outbound queue | ✅ Complete |
| @nexnet/client | NexnetClient, DM, rooms (with moderation), groups, attachments, chain stub | ✅ Complete |
| @nexnet/tui | OpenTUI + SolidJS terminal client | ✅ Complete |
| @nexnet/relay-standalone | Self-hosted Bun relay server | ✅ Complete |
| workers/relay | Cloudflare Worker relay (WebSocket signalling) | ✅ Complete |
| workers/presence | Cloudflare Worker presence (90s TTL, Ed25519 verify) | ✅ Complete |
| workers/discovery | Cloudflare Worker discovery (profiles, random match) | ✅ Complete |

## Locked architectural decisions (AD-1 through AD-24)

| ID | Decision |
|---|---|
| AD-1 | Own chain (inauguration .in) |
| AD-2 | Chain app .in; client/relay/TUI = TypeScript (Bun + CF Workers) |
| AD-3 | Monorepo (packages/ + workers/ + chain/) |
| AD-4/4b | CBOR + CDDL + CDE determinism |
| AD-5 | XChaCha20-Poly1305 |
| AD-6 | Passkey every open; cert until process death |
| AD-7 | Online-only DM fanout + P2P history sync |
| AD-8 | BLAKE3-256 + derive_key domain separation |
| AD-9 | Chained HotStuff three-chain consensus |
| AD-10 | Max 1 username per wallet (no transfer) |
| AD-11 | Presence lease 90s |
| AD-12 | Global presence visibility |
| AD-13 | Token deferred past MVP |
| AD-14 | Stake-ranked validators, min 4, target 7-21 |
| AD-15 | Grants-only relay incentives |
| AD-16 | Wallet ultimate; passkey re-auths devices |
| AD-17 | Room retention 24h default, relay-overridable |
| AD-18 | Numeric reputation with published weights |
| AD-19 | Nearby discovery post-MVP |
| AD-20 | Attachments direct only |
| AD-21 | Opt-in multi-hop sessions |
| AD-22 | Open relay registry |
| AD-23 | Group creator on-chain |
| AD-24 | Username + bio, no avatar |

## Product direction (recent changes)

- **Username transfer DISABLED** — prevent squatting/flipping
- **Anti-squat:** 7-day account age before username registration; 90-day inactivity release
- **Room moderation:** per-user cooldown (5 msgs/min), votekick (⅔ majority), automod (duplicate spam, caps filter, length limit)
- **Self-hosted relay:** anyone can run relay on PC/VPS via `@nexnet/relay-standalone`

## What to implement next (priority order)

### 1. Double Ratchet for DM forward secrecy — ✅ done

`packages/client/src/double-ratchet.ts` wired into `dm.ts`. X25519 + HKDF + XChaCha20. In-memory sessions; persist later.

### 2. MLS for group encryption — ✅ simplified epoch secrets

Not full MLS. Random epoch secrets + X25519 wrap to members. Membership rotate → new secret. `group-crypto.ts` + encrypted `groups.ts` path.

### 3. WebRTC direct peer connections — ✅ PeerManager (injectable PC)

`packages/client/src/webrtc.ts` — offer/answer/ICE via relay signalling, data channel send. No WebRTC npm dep; inject `RTCPeerConnection` factory (browser native / later wrtc).

### 4. Integration tests — ✅ done

`packages/client/src/__tests__/integration.test.ts`: encrypted DM, group epoch crypto, attachments, room cooldown+votekick.

### 5. Chain .in state machine

The chain application logic in inauguration (.in) at ../inauguration:
- Username registration/lookup
- Identity root records
- Validator set management
- This is a separate project but the chain-client interface exists

## Running tests

```bash
cd /Users/undivisible/projects/nexnet
bun install
bun test --workspace
```

Expected: 169+ tests passing.

## Key files

- `packages/types/src/index.ts` — all protocol types
- `packages/crypto/src/` — crypto primitives
- `packages/protocol/src/` — CBOR CDE, event signing
- `packages/client/src/dm.ts` — DM send/receive (needs Double Ratchet)
- `packages/client/src/rooms.ts` — rooms with moderation
- `packages/client/src/groups.ts` — group management
- `packages/client/src/group-crypto.ts` — group encryption (needs MLS)
- `packages/client/src/attachments.ts` — attachment transfer
- `packages/client/src/client.ts` — WebSocket client
- `packages/tui/src/` — OpenTUI + SolidJS terminal app
- `packages/relay-standalone/src/index.ts` — self-hosted relay
- `workers/relay/src/index.ts` — Cloudflare relay worker
- `workers/presence/src/index.ts` — presence worker
- `workers/discovery/src/index.ts` — discovery worker
- `docs/` — full protocol specification

## Constraints

- ISC license, no telemetry
- No invented cryptography — reviewed libraries only
- CBOR CDE for wire format
- BLAKE3-256 with derive_key for hashing
- XChaCha20-Poly1305 for AEAD
- Ed25519 for signatures
- Relays never store private messages
- Chain holds scarce public state only
- Messages immutable (no edit/unsend)
