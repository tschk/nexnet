# Recommended technology stack

Coding agents may adjust, but this is the strong default.

## Core

- Rust
- Tokio
- Quinn for QUIC
- libp2p where useful
- WebRTC for browser and NAT traversal compatibility
- rustls
- sqlcipher-compatible SQLite or encrypted SQLite layer
- CBOR via serde

## Cryptography

- ed25519-dalek
- x25519-dalek
- blake3
- chacha20poly1305
- hkdf
- established Double Ratchet implementation
- OpenMLS

## Client

Initial target:

- desktop CLI or TUI reference client
- daemonised networking core
- later GUI clients

## Planned crates

```text
nettle-core / nettle-node
nettle-protocol
nettle-crypto
nettle-storage
nettle-transport
nettle-discovery
nettle-chain-client
nettle-chain-runtime
nettle-relay
nettle-cli
```

Plus supporting crates listed in the root README.

## Blockchain

**Locked:** purpose-built Nettle chain.

- Application state machine and chain logic: **inauguration** `.in`
  (sibling repo `../inauguration`, Core IR → native/JIT)
- Client boundary: Rust `nettle-chain-client` (or equivalent) over stable API
- Host/networking/validator process: may combine `.in` runtime with thin
  Rust (or native) networking until `.in` surface covers it
- Single-node deterministic executor first; multi-validator consensus later

Not using Substrate / Cosmos SDK / foreign L1 as the product chain.

Chain remains isolated behind a clean interface.

## Language split (AD-2)

**Locked for now: A — chain app only in `.in`.**

| Component | Language |
|---|---|
| Username / identity / treasury / relay-registry transitions | inauguration `.in` |
| Node, relay, transport, messaging, crypto, storage, CLI | Rust |
| Chain client API | Rust (`nettle-chain-client`) |

Expand `.in` into validator host later when networking/stdlib ready. Do not
migrate messaging to `.in` in the first implementation wave.

## Repo packaging (AD-3)

**Locked: monorepo.**

```text
nettle/
  crates/          # Rust workspace
  chain/           # inauguration .in chain app + tests/vectors
  docs/
  test-vectors/
```

No separate `nettle-chain` repo and no chain sources inside inauguration.

## Non-negotiables

- reviewed cryptographic libraries only
- no custom primitives
- structured tracing without plaintext or secret keys
- fuzzing for parsers and event verification
