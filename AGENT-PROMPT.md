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

## Current state (218 tests passing)

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

`packages/client/src/double-ratchet.ts` wired into `dm.ts`. X25519 + HKDF + XChaCha20.
`setSessionBackend` + `@nexnet/storage` `SessionStore` for disk.
X3DH: `x3dh.ts` + `prekeys.ts`; first DM uses X3DH when both sides published bundles (wire v2), else conversation HKDF.
Group `addMember`/`removeMember` rotate epoch + wrap secrets.
Presence: `POST /prekeys/publish`, `GET /prekeys/:id` (signed SPK verified). Client: `publishBundleRemote` / `fetchBundleRemote`.
Direct DM: `setDirectTransport(peerManager)` — open data channel preferred over relay; inbound channel → `dm` event.

### 2. MLS for group encryption — ✅ real ts-mls (RFC 9420)

`packages/client/src/mls.ts` uses **ts-mls** (MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519).
Create/add/welcome/encrypt/decrypt. Epoch-secret path remains in `group-crypto.ts` for simple rooms.

### 3. WebRTC — ✅ werift native + PeerManager

`createWeriftPeerConnection()` from `werift-factory.ts`. PeerManager e2e with real ICE/DTLS/SCTP.

### 4. Integration tests — ✅ done

`packages/client/src/__tests__/integration.test.ts`: encrypted DM, group epoch crypto, attachments, room cooldown+votekick.

### 5. Chain .in state machine — ✅ transition rules + validators

`chain/nexnet_chain.in` pure checks (AD-10, anti-squat, transfer off, AD-22/23, AD-14).
`in execute chain/nexnet_chain.in` → Int(0). DevChainClient: join/leave/list validators.
Full state maps deferred until inauguration has map primitives.

## Running tests

```bash
cd /Users/undivisible/projects/nexnet
bun install
bun test --workspace
```

Expected: 218+ tests passing.

## Live workers (CF temporary preview — claim within 60m of deploy)

Claim: https://dash.cloudflare.com/claim-preview?claimToken=E4WzmJCcRoseIJwiqo1scJbDy2LsXonrreb0oTclVJE

| Worker | URL |
|---|---|
| presence | https://nexnet-presence.lead-zinc.workers.dev |
| relay | https://nexnet-relay.lead-zinc.workers.dev |
| discovery | https://nexnet-discovery.lead-zinc.workers.dev |

`ALLOW_UNSIGNED_LEASES=1` on presence for preview. Production needs signed leases + real CF account token.

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
