# Open decisions

Intentionally unresolved. Track as design issues before locking for
implementation.

| ID | Decision | Notes |
|---|---|---|
| OD-01 | ~~Production blockchain platform~~ **LOCKED AD-1** | **Own chain**; app logic in inauguration `.in` (`../inauguration`). Not Substrate/Cosmos product. Consensus algorithm still open (OD-01b). |
| OD-01b | Consensus algorithm | e.g. Tendermint-style BFT, HotStuff-like, custom PoS — pick before multi-validator |
| OD-01c | ~~Chain packaging~~ **LOCKED AD-3** | **Same monorepo** — `chain/` (`.in` app) next to `crates/` |
| OD-01d | ~~Language split~~ **LOCKED AD-2** | **Chain app `.in` only**; node/relay/messaging/crypto/CLI = Rust for now |
| OD-02 | Exact token supply and emissions | Deferred past MVP |
| OD-03 | Validator selection | |
| OD-04 | Automatic relay incentives | Deferred; grants first |
| OD-05 | Username anti-spam proof | Free UX vs tiny PoW/deposit |
| OD-06 | Passkey-to-wallet recovery flow | Exact ceremony |
| OD-07 | Device cert / session policy | **Partial AD-6:** passkey on every interactive app open. Background lifetime still open (OD-07b) |
| OD-07b | Background device-cert lifetime | While process alive / suspended: 24h? 7d? until process death? |
| OD-08 | Multi-device DM fanout policy | All devices vs active subset |
| OD-09 | Public room retention defaults | Relay-defined; recommend baseline |
| OD-10 | Random reputation formula | Inputs exist; weights open |
| OD-11 | Nearby discovery post-MVP | Opt-in coarse cells only |
| OD-12 | Routed attachment transfer | Supported or not |
| OD-13 | Relay admission / checksum governance | |
| OD-14 | Group ownership on-chain | Optional |
| OD-15 | Public profile bios/avatars | May omit in first release |
| OD-16 | Presence visibility controls | Global exact first; finer later |
| OD-17 | ~~Canonical encoding~~ **LOCKED AD-4** | **H2: CBOR wire + CDDL schemas**; debug JSON tooling only |
| OD-17b | ~~CBOR deterministic profile~~ **LOCKED AD-4b** | **CDE** (RFC 8949 §4.2); dCBOR not required |
| OD-18 | ~~AEAD choice~~ **LOCKED AD-5** | **XChaCha20-Poly1305**; AES-GCM not required |

Update this table when a decision locks; link to the issue or ADR.
