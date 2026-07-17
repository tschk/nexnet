# Open decisions

Track design locks. Prefer linking AD notes in defaults / topic docs.

## Locked

| ID | Decision | Lock |
|---|---|---|
| OD-01 | Chain platform | **AD-1** own chain; app in inauguration `.in` |
| OD-01b | Consensus | **AD-9** chained HotStuff three-chain — [consensus.md](consensus.md) |
| OD-01c | Packaging | **AD-3** monorepo `chain/` + `packages/` + `workers/` |
| OD-01d | Language split | **AD-2** chain app `.in`; client, relay, presence, discovery, and TUI in TypeScript/Bun |
| OD-02 | Token supply / emissions | **AD-13** deferred past MVP — no numbers until needed |
| OD-03 | Validator selection | **AD-14** stake-ranked active set + power cap; min 4; early target 7–21 ([consensus.md](consensus.md)) |
| OD-04 | Automatic relay incentives | **AD-15** grants only v1 — no bandwidth mining |
| OD-05 | Username anti-spam | **AD-10** max 1 owned per wallet; free creation with rate limits; transfers disabled |
| OD-06 | Passkey ↔ wallet recovery | **AD-16** wallet root ultimate; registered passkey may re-auth devices |
| OD-07 | Device session policy | **AD-6** passkey every interactive open; cert until process death |
| OD-08 | Multi-device DM fanout | **AD-7** online devices only; history via P2P sync |
| OD-09 | Public room retention | **AD-17** default **24h inactivity** drop; each relay may override and must advertise |
| OD-10 | Random reputation formula | **AD-18** numeric score with **published weights** (v1 formula in reputation.md) |
| OD-11 | Nearby discovery | **AD-19** post-MVP only; opt-in coarse cells |
| OD-12 | Routed attachments | **AD-20** **direct only** first routing wave; attachments not onion-carried yet |
| OD-12b | Tor-style session routing | **AD-21** **opt-in** private multi-hop routing for sessions (not only random match) |
| OD-13 | Relay admission | **AD-22** **open registry** + checksums; clients choose (may pin defaults) |
| OD-14 | Group ownership on-chain | **AD-23** **on-chain** group id → creator (optional metadata) |
| OD-15 | Public profile fields | **AD-24** **username + bio**; **no avatar** in first release |
| OD-16 | Presence visibility | **AD-12** global exact online |
| OD-16b | Presence lease TTL | **AD-11** 90 seconds |
| OD-17 | Wire encoding | **AD-4** CBOR + CDDL |
| OD-17b | CBOR determinism | **AD-4b** CDE |
| OD-18 | AEAD | **AD-5** XChaCha20-Poly1305 |
| OD-19 | Internal hash | **AD-8** BLAKE3-256 + derive_key |
| OD-20 | Wallet address format | 32-byte Ed25519 root signing public key; it verifies device certificates |

## Still open (non-blocking for Phase 1)

| ID | Topic | Notes |
|---|---|---|
| OD-21 | Exact token economics when introduced | Supply curve, emission schedule |
| OD-22 | Published reputation weight numbers | AD-18 locks *that* weights are published; tune constants in test |
| OD-23 | Bio max length / charset | Suggest 160 graphemes until set |
| OD-24 | Official client default relay pin set | Operational, not protocol |

Phase 1 (protocol foundations) does not require OD-21–24.
