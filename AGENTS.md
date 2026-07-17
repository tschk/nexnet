# Nexnet — agent notes

All responses must be in English.

## Position

Nexnet is an open-source peer-to-peer social chat network with
blockchain-backed identity and scarce usernames. Local-first private
history. Sender-held offline messages. Public ownerless rooms. E2EE private
chat. Privacy-routed stranger discovery.

**Status:** TypeScript/Bun foundation implemented; end-to-end MVP remains.

## Non-negotiables

- No invented cryptography — reviewed libraries only
- Relays never permanently store private message bodies
- Chain holds scarce public state only — never private chat content
- Messages immutable: no edit / unsend protocol
- Delivered receipts only; no read receipts / last-seen / typing in v1
- Passkey on every interactive app open; device cert until process death (AD-6)
- DM fanout only to online devices; history via P2P device sync (AD-7)
- Max 1 username owned per wallet; free creation with rate limits; transfers disabled (AD-10)
- Presence lease TTL 90s (AD-11); global presence visibility (AD-12)
- Recovery: wallet ultimate; passkey re-auths devices (AD-16)
- Room retention default 24h inactivity, relay-overridable (AD-17)
- Reputation: published numeric weights (AD-18)
- Attachments direct only (AD-20); opt-in multi-hop sessions (AD-21)
- Open relay registry (AD-22); group creator on-chain (AD-23)
- Profile: username + bio, no avatar (AD-24)
- Schemas versioned; operations idempotent where possible
- ISC license; no telemetry; no secret logging

## Stack direction

- **TypeScript (Bun)** monorepo for client / relay / presence / discovery / TUI
- **Cloudflare Workers** for relay, presence, discovery services
- **OpenTUI + SolidJS** for terminal client
- Ed25519 / X25519 / XChaCha20-Poly1305 (noble libs — AD-5)
- BLAKE3-256 with derive_key domain separation (AD-8)
- Double Ratchet for DMs (TBD lib)
- **Own chain** — application logic in inauguration `.in`
  (`../inauguration`); clients only via `nexnet-chain-client`
- **AD-2:** chain app `.in` only; client/relay/node/TUI = **TypeScript** (Bun + Cloudflare Workers)
- **AD-3:** monorepo — `chain/` (`.in`) next to `packages/` + `workers/`
- **AD-9:** chained HotStuff three-chain commit; see `docs/consensus.md`
- Chain runtime isolated; single-node executor OK until multi-validator

## Doc map

Read `docs/README.md` first. Architecture: `docs/architecture.md`.
Build order: `docs/phases.md`. Open questions: `docs/open-decisions.md`.
Full agent constraints: `docs/agent-notes.md`.

## Current work policy

Until implementation plans lock:

1. Prefer updating docs and open decisions over speculative code
2. Do not scaffold empty crates without an approved implementation plan
3. When coding starts: test vectors and types before network
