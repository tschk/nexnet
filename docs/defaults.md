# Initial product defaults

Unless superseded by a later specification:

```text
username registration: free, first come first served
username ownership: max 1 per wallet/identity (AD-10)
username transfer: DISABLED for now (removed to prevent squatting/flipping)
username create rate: limited (e.g. 1 / 24h per identity, requires account age ≥ 7d)
username squatting prevention: account age ≥ 7 days before first username; inactivity release after 90 days no presence
account authority: wallet
login: passkey
passkey policy: every interactive app open (AD-6)
device certificate: valid until process death (AD-6)
dm fanout: online recipient devices only (AD-7)
device history: P2P sync between own devices
recovery: wallet root ultimate; passkey re-auths devices (AD-16)
message history: local only
offline message location: sender device
presence retry interval: 30 minutes
presence lease TTL: 90 seconds (AD-11)
presence: exact online, no last seen
presence visibility: global (AD-12)
receipts: delivered only
read receipts: disabled
message editing: disabled
remote deletion: disabled
attachments: direct encrypted transfer only (AD-20)
direct messages: end-to-end encrypted
private groups: creator controlled; group_id→creator on-chain (AD-23)
public chatrooms: no owner
public room moderation: votekick (⅔ majority), automod (rate limits + spam filter), local blocks
public room retention default: 24h inactivity; relay-overridable (AD-17)
public room cooldown: per-user rate limit (e.g. 5 msgs/min default); anti-flood on join
profile: username + bio; no avatar (AD-24)
random matching: numeric reputation with published weights (AD-18)
routing: direct by default; private routed for randoms; opt-in multi-hop (AD-21)
nearby discovery: post-MVP (AD-19)
relay admission: open registry + checksums (AD-22)
relay self-host: anyone can run relay on PC/VPS (Bun binary or Docker)
relay incentives v1: grants only (AD-15)
token supply/emissions: deferred past MVP (AD-13)
validator selection: stake rank + power cap; min 4; target 7–21 (AD-14)
source code: fully open source
user payment: none required
license: ISC
chain: purpose-built Nexnet chain
chain app language: inauguration (.in)
chain client boundary: nexnet-chain-client
language split: chain app .in; client/relay/node/TUI TypeScript (Bun + CF Workers)
repo packaging: monorepo (packages/ + workers/ + chain/)
consensus: chained HotStuff three-chain commit (AD-9)
consensus votes v1: Ed25519 (BLS QC later)
wire encoding: CBOR
cbor determinism: CDE (RFC 8949 §4.2)
schema language: CDDL
aead: XChaCha20-Poly1305
hash: BLAKE3-256 (derive_key domain separation)
sha-256: external interop boundaries only
```
