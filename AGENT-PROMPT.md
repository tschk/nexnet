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

## Current state (149 tests passing)

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

### 1. Double Ratchet for DM forward secrecy

Currently DMs use a static HKDF-derived conversation key. Implement Signal-style Double Ratchet:

- Per-message keys with DH ratchet
- Forward secrecy (compromised key doesn't reveal past)
- Post-compromise security (ratchet heals)
- Use existing @nexnet/crypto primitives (X25519, HKDF, XChaCha20)
- Create `packages/client/src/double-ratchet.ts`
- Wire into `dm.ts` replacing static conversation key
- See docs/cryptography.md for requirements

**Recommended approach:** Implement the Double Ratchet algorithm from the spec (https://signal.org/docs/specifications/doubleratchet/). Use X25519 for DH, HKDF for KDF, XChaCha20-Poly1305 for AEAD. Store ratchet state in @nexnet/storage.

### 2. MLS for group encryption

Replace the simple shared-key group encryption with Messaging Layer Security:

- Forward secrecy for group messages
- Efficient membership updates
- Epoch-based key rotation (already partially implemented in group-crypto.ts)
- See docs/cryptography.md and docs/groups.md

**Recommended approach:** Check if there's a TypeScript MLS implementation. If not, implement a simplified version using the existing epoch-tracking in group-crypto.ts, adding DH-based key agreement between members.

### 3. WebRTC direct peer connections

Currently all messages go through the relay. Implement direct peer connections:

- Use WebRTC data channels for DMs and attachments
- Relay only used for signalling (session offers/answers/ICE candidates)
- Fallback to relay if direct connection fails
- See docs/transport.md for connection modes

**Recommended approach:** Use `wrtc` or `werift` npm package for WebRTC. The relay already handles signalling. Implement ICE candidate exchange and data channel setup.

### 4. Integration tests

Create end-to-end tests proving:
- Two clients exchange encrypted DMs through relay
- Room messages broadcast correctly
- Group encryption works across members
- Attachment transfer completes
- Moderation (cooldown, votekick) works

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

Expected: 149+ tests passing.

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
