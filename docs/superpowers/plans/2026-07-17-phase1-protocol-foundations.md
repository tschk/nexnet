# Phase 1 Protocol Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship deterministic protocol types, CDE-CBOR encode/sign/verify, BLAKE3 domain-separated IDs, device certificates, encrypted local event log, and checked-in test vectors — no network yet.

**Architecture:** Tiny Rust workspace. `nexnet-types` holds pure data. `nexnet-crypto` wraps Ed25519 / X25519 / XChaCha20-Poly1305 / BLAKE3 / HKDF. `nexnet-protocol` owns CDE encode, event envelopes, and verification. `nexnet-storage` is an encrypted SQLite append-only log. CDDL schemas and byte fixtures live under `schemas/` and `test-vectors/`.

**Tech Stack:** Rust 2021, Cargo workspace, `ed25519-dalek`, `x25519-dalek`, `chacha20poly1305`, `blake3`, `hkdf`/`sha2`, `minicbor` (or equivalent CDE-capable CBOR), `rusqlite` + SQLCipher-compatible or app-level XChaCha seal of pages, `serde` only if it does not break CDE — prefer explicit minicbor encode.

## Global Constraints

- ISC license; no telemetry; no secret logging
- No invented cryptography — reviewed crates only
- Wire: CBOR + **CDE** (RFC 8949 §4.2) + CDDL (AD-4/4b)
- AEAD: **XChaCha20-Poly1305** (AD-5)
- Hash: **BLAKE3-256** + `derive_key` domain separation (AD-8)
- Signatures: **Ed25519**
- Relays/network out of scope for Phase 1
- Chain `.in` out of scope for Phase 1 (interface types only if needed)
- Prefer CLI-less library crates; tests are the interface
- Every public encode path must be byte-stable under CDE

## File map (create)

```text
Cargo.toml                          # workspace
crates/nexnet-types/Cargo.toml
crates/nexnet-types/src/lib.rs
crates/nexnet-crypto/Cargo.toml
crates/nexnet-crypto/src/lib.rs
crates/nexnet-crypto/src/sign.rs
crates/nexnet-crypto/src/aead.rs
crates/nexnet-crypto/src/hash.rs
crates/nexnet-crypto/src/kdf.rs
crates/nexnet-protocol/Cargo.toml
crates/nexnet-protocol/src/lib.rs
crates/nexnet-protocol/src/cde.rs
crates/nexnet-protocol/src/event.rs
crates/nexnet-protocol/src/device_cert.rs
crates/nexnet-protocol/src/ids.rs
crates/nexnet-storage/Cargo.toml
crates/nexnet-storage/src/lib.rs
crates/nexnet-storage/src/log.rs
schemas/nexnet_event.cddl
schemas/device_certificate.cddl
test-vectors/README.md
test-vectors/events/minimal_event.json   # diagnostic only
test-vectors/events/minimal_event.cde    # raw CDE bytes (hex file OK)
test-vectors/sign/ed25519_known.json
```

---

### Task 1: Workspace skeleton

**Files:**
- Create: `Cargo.toml`
- Create: `crates/nexnet-types/Cargo.toml`
- Create: `crates/nexnet-types/src/lib.rs`
- Create: `crates/nexnet-crypto/Cargo.toml`
- Create: `crates/nexnet-crypto/src/lib.rs`
- Create: `crates/nexnet-protocol/Cargo.toml`
- Create: `crates/nexnet-protocol/src/lib.rs`
- Create: `crates/nexnet-storage/Cargo.toml`
- Create: `crates/nexnet-storage/src/lib.rs`
- Modify: `.gitignore` (ensure `/target/` present)

**Interfaces:**
- Produces: empty workspace members that `cargo test --workspace` runs

- [ ] **Step 1: Write root workspace manifest**

```toml
[workspace]
resolver = "2"
members = [
    "crates/nexnet-types",
    "crates/nexnet-crypto",
    "crates/nexnet-protocol",
    "crates/nexnet-storage",
]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "ISC"
repository = "https://github.com/tschk/nexnet"
```

- [ ] **Step 2: Create four crate manifests + `lib.rs` with `#![forbid(unsafe_code)]` and a trivial test**

Each `crates/nexnet-*/Cargo.toml`:

```toml
[package]
name = "nexnet-types" # change per crate
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
# none yet
```

Each `lib.rs`:

```rust
#![forbid(unsafe_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        assert_eq!(2 + 2, 4);
    }
}
```

- [ ] **Step 3: Run workspace tests**

Run: `cargo test --workspace`

Expected: PASS (4 smoke tests)

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates .gitignore
git commit -m "chore: scaffold Rust workspace for protocol crates"
```

---

### Task 2: `nexnet-crypto` — BLAKE3 domain separation + Ed25519

**Files:**
- Create: `crates/nexnet-crypto/src/hash.rs`
- Create: `crates/nexnet-crypto/src/sign.rs`
- Create: `crates/nexnet-crypto/src/aead.rs`
- Create: `crates/nexnet-crypto/src/kdf.rs`
- Modify: `crates/nexnet-crypto/src/lib.rs`
- Modify: `crates/nexnet-crypto/Cargo.toml`
- Create: `test-vectors/sign/ed25519_known.json`

**Interfaces:**
- Produces:
  - `pub fn derive_id(context: &str, data: &[u8]) -> [u8; 32]`
  - `pub struct SigningKey` / `VerifyingKey` wrappers
  - `pub fn sign(key: &SigningKey, msg: &[u8]) -> [u8; 64]`
  - `pub fn verify(vk: &VerifyingKey, msg: &[u8], sig: &[u8; 64]) -> Result<(), CryptoError>`
  - `pub fn aead_encrypt(key: &[u8; 32], nonce: &[u8; 24], aad: &[u8], pt: &[u8]) -> Result<Vec<u8>, CryptoError>`
  - `pub fn aead_decrypt(...) -> Result<Vec<u8>, CryptoError>`
  - `pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8])`

- [ ] **Step 1: Add dependencies**

```toml
[dependencies]
blake3 = "1"
ed25519-dalek = { version = "2", features = ["rand_core"] }
x25519-dalek = "2"
chacha20poly1305 = "0.10"
hkdf = "0.12"
sha2 = "0.10"
rand_core = { version = "0.6", features = ["getrandom"] }
thiserror = "2"
```

- [ ] **Step 2: Write failing tests for domain-separated IDs**

In `hash.rs` tests:

```rust
#[test]
fn derive_id_domain_separation() {
    let a = derive_id("nexnet event id v1", b"hello");
    let b = derive_id("nexnet room id v1", b"hello");
    assert_ne!(a, b);
    assert_eq!(a, derive_id("nexnet event id v1", b"hello"));
}
```

- [ ] **Step 3: Implement `derive_id` via `blake3::derive_key`**

```rust
pub fn derive_id(context: &str, data: &[u8]) -> [u8; 32] {
    // blake3 derive_key(context) then keyed hash over data — follow crate API:
    // let key = blake3::derive_key(context, /* empty or context bytes per docs */);
    // Prefer: blake3::Hasher::new_derive_key(context).update(data).finalize()
    let mut hasher = blake3::Hasher::new_derive_key(context);
    hasher.update(data);
    *hasher.finalize().as_bytes()
}
```

Contexts (fixed strings):

```text
"nexnet event id v1"
"nexnet room id v1"
"nexnet attachment id v1"
```

- [ ] **Step 4: Implement Ed25519 sign/verify + unit test roundtrip**

```rust
#[test]
fn sign_verify_roundtrip() {
    let sk = SigningKey::generate();
    let msg = b"nexnet-test";
    let sig = sign(&sk, msg);
    assert!(verify(&sk.verifying_key(), msg, &sig).is_ok());
    assert!(verify(&sk.verifying_key(), b"tampered", &sig).is_err());
}
```

- [ ] **Step 5: Implement XChaCha20-Poly1305 encrypt/decrypt roundtrip test**

```rust
#[test]
fn aead_roundtrip() {
    let key = [7u8; 32];
    let nonce = [9u8; 24];
    let ct = aead_encrypt(&key, &nonce, b"aad", b"plaintext").unwrap();
    let pt = aead_decrypt(&key, &nonce, b"aad", &ct).unwrap();
    assert_eq!(pt, b"plaintext");
}
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p nexnet-crypto`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/nexnet-crypto test-vectors
git commit -m "feat(crypto): blake3 derive_id, ed25519, xchacha aead"
```

---

### Task 3: CDE encode helper

**Files:**
- Create: `crates/nexnet-protocol/src/cde.rs`
- Modify: `crates/nexnet-protocol/Cargo.toml`
- Modify: `crates/nexnet-protocol/src/lib.rs`

**Interfaces:**
- Consumes: none from storage
- Produces:
  - `pub fn cde_encode_map(fields: &[(&str, CborValue)]) -> Result<Vec<u8>, ProtocolError>`
  - or explicit encode functions per type (prefer explicit for determinism)
  - Property: same logical map → identical bytes every time

**Dependency note:** Prefer `minicbor` with sorted map keys and preferred integer encodings. If crate cannot guarantee CDE, implement a minimal encoder for the types we need only (integers, bytes, text, arrays, maps with sorted text keys).

- [ ] **Step 1: Write failing determinism test**

```rust
#[test]
fn cde_map_order_independent_construction() {
    let a = encode_demo_event(/* fields in order A */);
    let b = encode_demo_event(/* fields in order B */);
    assert_eq!(a, b);
}
```

- [ ] **Step 2: Implement minimal CDE encoder for needed types**

Rules (document in module rustdoc):

- Map keys: text strings, sorted lexicographically by UTF-8 bytes
- Prefer shortest definite lengths
- No indefinite lengths
- Integers in preferred encoding

- [ ] **Step 3: Run tests**

Run: `cargo test -p nexnet-protocol cde`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/nexnet-protocol
git commit -m "feat(protocol): deterministic CDE CBOR encoder subset"
```

---

### Task 4: Identity IDs, event IDs, core event type

**Files:**
- Create: `crates/nexnet-types/src/ids.rs`
- Create: `crates/nexnet-types/src/event.rs`
- Modify: `crates/nexnet-types/src/lib.rs`
- Create: `crates/nexnet-protocol/src/ids.rs`
- Create: `crates/nexnet-protocol/src/event.rs`
- Create: `schemas/nexnet_event.cddl`

**Interfaces:**
- Produces types:

```rust
pub struct IdentityId(pub [u8; 32]);
pub struct DeviceId(pub [u8; 32]);
pub struct EventId(pub [u8; 32]);
pub struct ConversationId(pub [u8; 32]);

pub struct NexnetEvent {
    pub protocol_version: u16,
    pub event_type: String, // or enum for known types
    pub event_id: EventId,
    pub author_identity_id: IdentityId,
    pub author_device_id: DeviceId,
    pub created_at: u64, // unix ms
    pub sequence: u64,
    pub parent_ids: Vec<EventId>,
    pub payload: Vec<u8>, // already-encoded or raw bytes field
    pub signature: [u8; 64],
}
```

- `event_id = derive_id("nexnet event id v1", cde_bytes_without_signature_and_without_event_id)`  
  (document exact preimage fields — lock in code comments + test-vectors README)

- [ ] **Step 1: Write CDDL**

`schemas/nexnet_event.cddl`:

```cddl
nexnet_event = {
  protocol_version: uint,
  event_type: tstr,
  event_id: bstr .size 32,
  author_identity_id: bstr .size 32,
  author_device_id: bstr .size 32,
  created_at: uint,
  sequence: uint,
  parent_ids: [* bstr .size 32],
  payload: bstr,
  signature: bstr .size 64,
}
```

- [ ] **Step 2: Failing test — sign and verify event**

```rust
#[test]
fn sign_and_verify_event() {
    let sk = SigningKey::generate();
    let mut ev = sample_event_unsigned(&sk);
    let body = encode_signed_preimage(&ev);
    ev.event_id = EventId(derive_id("nexnet event id v1", &body));
    let body2 = encode_signed_preimage(&ev); // include event_id if in signed set — LOCK ONE RULE
    ev.signature = sign(&sk, &body2);
    assert!(verify_event(&ev, &sk.verifying_key()).is_ok());
    ev.payload[0] ^= 1;
    assert!(verify_event(&ev, &sk.verifying_key()).is_err());
}
```

**Lock signing preimage (use this):**

```text
signature = Ed25519.Sign(device_sk, CDE({
  all event fields EXCEPT signature
}))
event_id = BLAKE3-derive_key("nexnet event id v1", CDE({
  all fields EXCEPT signature AND event_id
}))
```

- [ ] **Step 3: Implement encode / id / sign / verify**

- [ ] **Step 4: Reject oversized fields**

```rust
#[test]
fn reject_huge_payload() {
    let mut ev = sample_event_unsigned(&sk);
    ev.payload = vec![0u8; 2_000_000];
    assert!(validate_event_limits(&ev).is_err());
}
```

Limits (initial):

```text
payload max: 256 KiB
parent_ids max: 32
event_type max: 64 bytes
```

- [ ] **Step 5: Run tests + commit**

```bash
cargo test -p nexnet-protocol -p nexnet-types
git add crates schemas
git commit -m "feat(protocol): nexnet_event CDE encode sign verify"
```

---

### Task 5: Device certificates

**Files:**
- Create: `crates/nexnet-protocol/src/device_cert.rs`
- Create: `schemas/device_certificate.cddl`

**Interfaces:**

```rust
pub struct DeviceCertificate {
    pub account_id: IdentityId,
    pub device_id: DeviceId,
    pub device_signing_public_key: [u8; 32],
    pub device_encryption_public_key: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64, // may be u64::MAX for process-lifetime semantic at app layer
    pub capabilities: u64, // bitflags
    pub root_signature: [u8; 64],
}
```

- [ ] **Step 1: CDDL + failing verify test**

- [ ] **Step 2: Implement issue/verify with root SigningKey**

```rust
#[test]
fn device_cert_roundtrip() {
    let root = SigningKey::generate();
    let device = SigningKey::generate();
    let cert = issue_device_cert(&root, &device, now, expires, CAP_MESSAGING);
    assert!(verify_device_cert(&cert, &root.verifying_key()).is_ok());
}
```

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(protocol): device certificate issue and verify"
```

---

### Task 6: Encrypted append-only storage

**Files:**
- Create: `crates/nexnet-storage/src/log.rs`
- Modify: `crates/nexnet-storage/Cargo.toml`
- Modify: `crates/nexnet-storage/src/lib.rs`

**Interfaces:**

```rust
pub struct EventLog {
    // open path + 32-byte key
}

impl EventLog {
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, StorageError>;
    pub fn append(&mut self, event_cde: &[u8]) -> Result<(), StorageError>;
    pub fn contains_event_id(&self, id: &EventId) -> Result<bool, StorageError>;
    pub fn get(&self, id: &EventId) -> Result<Option<Vec<u8>>, StorageError>;
    pub fn iter_conversation(&self, conversation_hint: &[u8]) -> /* iterator */ ;
}
```

**Approach (YAGNI):** SQLite file with table `events(event_id BLOB PRIMARY KEY, cde BLOB NOT NULL, created_at INTEGER)`. Entire DB file optionally sealed later; v1: open with `rusqlite`, store raw CDE, rely on OS file perms + document that full at-rest encryption is next iteration **or** encrypt each `cde` blob with XChaCha using key+event_id-derived nonce.

Prefer **per-row AEAD** with `nonce = first 24 bytes of BLAKE3(key || event_id)` for Phase 1 simplicity without SQLCipher dependency pain.

- [ ] **Step 1: Failing tests — append, dedup, tamper**

```rust
#[test]
fn append_is_idempotent_by_event_id() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = EventLog::open(&dir.path().join("t.db"), &[1u8; 32]).unwrap();
    let ev = sample_signed_event_bytes();
    log.append(&ev).unwrap();
    log.append(&ev).unwrap(); // ok, no second row
    assert_eq!(log.count().unwrap(), 1);
}

#[test]
fn decrypt_fails_on_bitflip() {
    // append, bitflip file or row, get() errors
}
```

- [ ] **Step 2: Implement**

Dependencies: `rusqlite`, `tempfile` (dev).

- [ ] **Step 3: `cargo test -p nexnet-storage` PASS + commit**

```bash
git commit -am "feat(storage): encrypted append-only event log"
```

---

### Task 7: Checked-in test vectors

**Files:**
- Create: `test-vectors/README.md`
- Create: `test-vectors/events/minimal_event.hex`
- Create: `test-vectors/events/minimal_event.meta.json`
- Create: `crates/nexnet-protocol/tests/vectors.rs`

**Interfaces:**
- CI-style test reads hex file and asserts encode/sign/verify match

- [ ] **Step 1: Generate vectors with a small `#[test]` or `examples/gen_vectors.rs` once; check in outputs**

`minimal_event.meta.json`:

```json
{
  "protocol_version": 1,
  "event_type": "test.ping",
  "created_at": 0,
  "sequence": 1,
  "parent_ids": [],
  "payload_hex": "68656c6c6f",
  "signing_seed_hex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
}
```

- [ ] **Step 2: Integration test**

```rust
#[test]
fn vector_minimal_event_matches() {
    let meta = load_meta("test-vectors/events/minimal_event.meta.json");
    let expected = hex::decode(std::fs::read_to_string("test-vectors/events/minimal_event.hex").unwrap().trim()).unwrap();
    let got = rebuild_from_meta(&meta);
    assert_eq!(got, expected);
    assert!(verify_event_bytes(&got).is_ok());
}
```

- [ ] **Step 3: Commit**

```bash
git add test-vectors crates/nexnet-protocol/tests
git commit -m "test: add CDE event fixtures and vector tests"
```

---

### Task 8: Workspace polish + docs pointer

**Files:**
- Modify: `README.md` (status: Phase 1 in progress / crates exist)
- Modify: `docs/phases.md` (Phase 1 acceptance checklist link)
- Create: `docs/superpowers/plans/2026-07-17-phase1-protocol-foundations.md` (this file; already created)

- [ ] **Step 1: `cargo test --workspace` clean**

- [ ] **Step 2: Update README status line**

From "Implementation has not started" → "Phase 1 protocol foundations in progress."

- [ ] **Step 3: Commit**

```bash
git commit -am "docs: point README at Phase 1 workspace progress"
```

---

## Acceptance (Phase 1)

From `docs/phases.md`:

- [x] plan covers deterministic encoding
- [ ] signatures verify across fixtures
- [ ] malformed events rejected (limits + bad sig)
- [ ] duplicate events idempotent in storage

## Out of scope (do not implement in this plan)

- networking, relays, presence
- Double Ratchet sessions
- chain `.in` state machine
- CLI UX
- MLS groups
- onion routing

## Spec coverage check

| Spec item | Task |
|---|---|
| Canonical events | 4 |
| Identity / device IDs | 4–5 |
| Signing / verification | 2, 4, 5 |
| Encrypted local storage | 6 |
| Message/event IDs | 4 |
| Append-only logs | 6 |
| Test vectors | 7 |
| CDE + CDDL | 3, 4, 5 |
| BLAKE3 derive_key | 2 |
| XChaCha AEAD | 2, 6 |

## Placeholder scan

None intentional. Encoder may be a minimal custom CDE subset if `minicbor` cannot guarantee CDE — still real code in Task 3, not TBD.
