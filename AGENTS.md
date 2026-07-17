# Nettle — agent notes

All responses must be in English.

## Position

Nettle is an open-source peer-to-peer social chat network with
blockchain-backed identity and transferable usernames. Local-first private
history. Sender-held offline messages. Public ownerless rooms. E2EE private
chat. Privacy-routed stranger discovery.

**Status:** architecture specification and documentation. Implementation not
started.

## Non-negotiables

- No invented cryptography — reviewed libraries only
- Relays never permanently store private message bodies
- Chain holds scarce public state only — never private chat content
- Messages immutable: no edit / unsend protocol
- Delivered receipts only; no read receipts / last-seen / typing in v1
- Schemas versioned; operations idempotent where possible
- ISC license; no telemetry; no secret logging

## Stack direction

- Rust workspace monorepo for node/relay/cli (default)
- Tokio, QUIC/WebRTC transports, CBOR+CDE+CDDL (AD-4/4b), encrypted SQLite
- Ed25519 / X25519 / HKDF / XChaCha20-Poly1305 (AD-5)
- Double Ratchet for DMs; OpenMLS for groups
- **Own chain** — application logic in inauguration `.in`
  (`../inauguration`); clients only via `nettle-chain-client`
- **AD-2:** chain app `.in` only; node/relay/messaging/crypto/CLI = Rust
- **AD-3:** monorepo — `chain/` (`.in`) next to `crates/`
- Chain runtime isolated; single-node executor OK until consensus

## Doc map

Read `docs/README.md` first. Architecture: `docs/architecture.md`.
Build order: `docs/phases.md`. Open questions: `docs/open-decisions.md`.
Full agent constraints: `docs/agent-notes.md`.

## Current work policy

Until implementation plans lock:

1. Prefer updating docs and open decisions over speculative code
2. Do not scaffold empty crates without an approved implementation plan
3. When coding starts: test vectors and types before network
