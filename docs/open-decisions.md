# Open decisions

Track design locks. Prefer linking AD notes in defaults / topic docs.

## Locked

| ID     | Decision                              | Lock                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-01  | Chain platform                        | **AD-1** own chain; app in inauguration `.in`                                                                                                                                                                                                                                                               |
| OD-01b | Consensus                             | **AD-9** chained HotStuff three-chain — [consensus.md](consensus.md)                                                                                                                                                                                                                                        |
| OD-01c | Packaging                             | **AD-3** monorepo `chain/` + `packages/` + `workers/`                                                                                                                                                                                                                                                       |
| OD-01d | Language split                        | **AD-2** chain app `.in`; client, relay, presence, discovery, and TUI in TypeScript/Bun                                                                                                                                                                                                                     |
| OD-02  | Token supply / emissions              | **AD-13** deferred past MVP — no numbers until needed                                                                                                                                                                                                                                                       |
| OD-03  | Validator selection                   | **AD-14** stake-ranked active set + power cap; min 4; early target 7–21 ([consensus.md](consensus.md))                                                                                                                                                                                                      |
| OD-04  | Automatic relay incentives            | **AD-15** grants only v1 — no bandwidth mining                                                                                                                                                                                                                                                              |
| OD-05  | Username anti-spam                    | **AD-10** max 1 owned per wallet; free creation with rate limits; transfers disabled                                                                                                                                                                                                                        |
| OD-06  | Passkey ↔ wallet recovery             | **AD-16** wallet root ultimate; registered passkey may re-auth devices                                                                                                                                                                                                                                      |
| OD-07  | Device session policy                 | **AD-6** passkey every interactive open; 11h certificates with renewal; explicitly delegated non-interactive jobs use a principal-controlled signer                                                                                                                                                         |
| OD-08  | Multi-device DM fanout                | **AD-7** online devices only; history via P2P sync                                                                                                                                                                                                                                                          |
| OD-09  | Public room retention                 | **AD-17** default **24h inactivity** drop; each relay may override and must advertise                                                                                                                                                                                                                       |
| OD-10  | Random reputation formula             | **AD-18** numeric score with **published weights** (v1 formula in reputation.md)                                                                                                                                                                                                                            |
| OD-11  | Nearby discovery                      | **AD-19** post-MVP only; opt-in coarse cells                                                                                                                                                                                                                                                                |
| OD-12  | Routed attachments                    | **AD-20** **direct only** first routing wave; attachments not onion-carried yet                                                                                                                                                                                                                             |
| OD-12b | Tor-style session routing             | **AD-21** **opt-in** private multi-hop routing for sessions (not only random match)                                                                                                                                                                                                                         |
| OD-13  | Relay admission                       | **AD-22** **open registry** + checksums; clients choose (may pin defaults)                                                                                                                                                                                                                                  |
| OD-14  | Group ownership on-chain              | **AD-23** **on-chain** group id → creator (optional metadata)                                                                                                                                                                                                                                               |
| OD-15  | Public profile fields                 | **AD-24** **username + bio**; **no avatar** in first release                                                                                                                                                                                                                                                |
| OD-16  | Presence visibility                   | **AD-12** global exact online                                                                                                                                                                                                                                                                               |
| OD-16b | Presence lease TTL                    | **AD-11** 90 seconds                                                                                                                                                                                                                                                                                        |
| OD-17  | Wire encoding                         | **AD-4** CBOR + CDDL                                                                                                                                                                                                                                                                                        |
| OD-17b | CBOR determinism                      | **AD-4b** CDE                                                                                                                                                                                                                                                                                               |
| OD-18  | AEAD                                  | **AD-5** XChaCha20-Poly1305                                                                                                                                                                                                                                                                                 |
| OD-19  | Internal hash                         | **AD-8** BLAKE3-256 + derive_key                                                                                                                                                                                                                                                                            |
| OD-20  | Wallet address format                 | 32-byte Ed25519 root signing public key; it verifies device certificates                                                                                                                                                                                                                                    |
| OD-20b | Passkey device authorisation          | Wallet-sign a credential commitment bound to credential ID, COSE key, RP ID, and origin; a verified, single-use assertion authorises or renews a device certificate                                                                                                                                         |
| OD-20c | Client surfaces                       | OpenTUI remains the local reference client; SSH is an additional hosted terminal entry point; no web app in the MVP                                                                                                                                                                                         |
| OD-20d | SSH session authorisation             | SSH public key identifies a device; a live passkey-authenticated OpenTUI client approves each SSH session; SSH session expires on disconnect                                                                                                                                                                |
| OD-20e | SSH keys as wallet-authorised sign-in | A wallet may register an ssh-ed25519 key with a wallet-signed commitment; the key signs a single-use gateway challenge (`SSHSIG`, namespace `nexnet-auth`) to authorise one device certificate. Supersedes OD-20d for registered keys only; unregistered keys still need passkey approval (not implemented) |
| OD-20f | Identity without a username           | Identities are created from a wallet proof; posting needs an identity, not a username                                                                                                                                                                                                                       |

**AD-6 amended 2026-10-30:** non-interactive, principal-delegated agent jobs may
obtain 11-hour device certificates and renewals from a persistent identity
daemon without a passkey assertion on every job start. Root authority stays in
the signer. Receiver-verifiable scoped grants, a trusted-peer allowlist and no
redelegation remain required; a certificate proves identity, not execution
authority. Short TTLs mitigate the missing revocation path tracked in #4.
Interactive cold starts still require passkeys. See the
[policy and implementation boundary](identity.md#session-policy-ad-6).

**AD-18 amended 2026-10-29:** published weights rank random-match candidates,
but incomplete reputation evidence is not an eligibility cutoff. Missing
evidence earns no credit and causes no exclusion. Authenticated presence,
overlap, mutual blocks and rate limits remain hard gates. See the dated
[decision and rationale](reputation.md#first-release-ad-18); this supersedes
the earlier 0.25 gate while session-history evidence is unavailable.

**AD-25 decided 2026-10-30:** restart-safe delegated device state uses a
host-supplied 32-byte unlock key, never stored alongside the database. Missing
or incorrect keys fail closed; no plaintext or empty-store fallback is
permitted. A compromised host can still read everything. OS keychain and
secret-provider integration is deferred to the identity daemon. See the
[decision, limits and crash-consistency contract](storage.md#ad-25-restart-safe-delegated-device-storage-2026-10-30).

## Still open (non-blocking for Phase 1)

| ID    | Topic                                 | Notes                                                            |
| ----- | ------------------------------------- | ---------------------------------------------------------------- |
| OD-21 | Exact token economics when introduced | Supply curve, emission schedule                                  |
| OD-22 | Published reputation weight numbers   | AD-18 locks _that_ weights are published; tune constants in test |
| OD-23 | Bio max length / charset              | Suggest 160 graphemes until set                                  |
| OD-24 | Official client default relay pin set | Operational, not protocol                                        |

Phase 1 (protocol foundations) does not require OD-21–24.
