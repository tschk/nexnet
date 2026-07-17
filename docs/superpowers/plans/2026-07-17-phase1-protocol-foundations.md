# Superseded Phase 1 plan

This Rust/Cargo plan is superseded. Nexnet's canonical implementation is the
TypeScript/Bun monorepo described in `AGENTS.md`, `docs/stack.md`, and the
repository packages.

The implemented foundation includes protocol types, Noble-backed crypto,
CBOR CDE event signing, device certificates, encrypted local storage, client
flows, Workers, and a TUI. The remaining work is tracked by
[`docs/phases.md`](../../phases.md) and should extend the existing packages
rather than create Rust crates.
