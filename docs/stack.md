# Recommended technology stack

Coding agents may adjust, but this is the strong default.

## Core

- TypeScript with Bun workspaces
- Cloudflare Workers and Durable Objects for relay, presence, and discovery
- OpenTUI + SolidJS for the reference TUI
- `bun:sqlite` with application-layer encryption for local storage
- `werift` for native WebRTC paths
- **CBOR wire** with **CDE** determinism (AD-4b) + **CDDL** schemas (AD-4)
- `cbor2` for CDE encoding
- Test vectors must be CDE byte-identical across implementations

## Cryptography

- `@noble/curves`, `@noble/ciphers`, and `@noble/hashes`
- `ts-mls` for MLS
- X3DH and Double Ratchet implementations backed by reviewed primitives

## Client

Initial target:

- desktop TUI reference client
- Bun client/networking core
- later GUI clients

## Packages

```text
@nexnet/types
@nexnet/crypto
@nexnet/protocol
@nexnet/storage
@nexnet/client
@nexnet/tui
@nexnet/relay-standalone
workers/relay
workers/presence
workers/discovery
```

## Blockchain

**Locked:** purpose-built Nexnet chain.

- Application state machine and chain logic: **inauguration** `.in`
  (sibling repo `../inauguration`, Core IR → native/JIT)
- Client boundary: TypeScript chain-client interface over a stable API
- Host/networking/validator process: may combine `.in` runtime with thin
  TypeScript/Bun (or native) networking until `.in` surface covers it
- Single-node deterministic executor first; multi-validator consensus later
- **AD-9:** multi-validator = chained HotStuff three-chain (NexnetHotstuff);
  see [consensus.md](consensus.md)

Not using Substrate / Cosmos SDK / foreign L1 as the product chain.

Chain remains isolated behind a clean interface.

## Language split (AD-2)

Chain application and consensus logic stay in **inauguration `.in`**.
Client, relay, presence, discovery, TUI, node, and chain-client use
TypeScript/Bun.

| Component | Language |
|---|---|
| Username / identity / treasury / relay-registry transitions | inauguration `.in` |
| Client, relay, presence, discovery, TUI, node | **TypeScript (Bun)** |
| Cloudflare services | TypeScript (Workers) |
| Chain client API | TypeScript chain-client interface |

Expand `.in` into the validator host later when its networking and standard
library surface is ready.

## Repo packaging (AD-3)

**Locked: monorepo.**

```text
nexnet/
  packages/        # TypeScript/Bun workspace packages
  workers/         # Cloudflare Workers
  chain/           # inauguration .in chain app + tests/vectors
  docs/
  test-vectors/
```

No separate `nexnet-chain` repo and no chain sources inside inauguration.

## Non-negotiables

- reviewed cryptographic libraries only
- no custom primitives
- structured tracing without plaintext or secret keys
- fuzzing for parsers and event verification
