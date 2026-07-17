# Initial product defaults

Unless superseded by a later specification:

```text
username registration: free, first come first served
username transfer: on-chain
account authority: wallet
login: passkey
passkey policy: every interactive app open (AD-6)
device certificate: valid until process death (AD-6)
dm fanout: online recipient devices only (AD-7)
device history: P2P sync between own devices
recovery: wallet-authorised only
message history: local only
offline message location: sender device
presence retry interval: 30 minutes
presence: exact online, no last seen
receipts: delivered only
read receipts: disabled
message editing: disabled
remote deletion: disabled
attachments: direct encrypted transfer
direct messages: end-to-end encrypted
private groups: creator controlled
public chatrooms: no owner
public room moderation: local and relay policy only
random matching: reputation gated
routing: direct by default, private routed for randoms
source code: fully open source
user payment: none required
license: ISC
chain: purpose-built Nettle chain
chain app language: inauguration (.in)
chain client boundary: nettle-chain-client
language split: chain app .in; node/relay/messaging/cli Rust
repo packaging: monorepo (crates/ + chain/)
wire encoding: CBOR
cbor determinism: CDE (RFC 8949 §4.2)
schema language: CDDL
aead: XChaCha20-Poly1305
hash: BLAKE3-256 (derive_key domain separation)
sha-256: external interop boundaries only
```
