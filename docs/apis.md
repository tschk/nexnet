# APIs and services

Interfaces are separated so implementations can evolve independently.

## Chain API

```text
register_username
resolve_username
get_identity_root
publish_relay_record
list_relays
get_protocol_parameters
```

## Presence API

```text
publish_presence_lease
query_presence
subscribe_presence
remove_presence
```

## Signalling API

```text
create_session_offer
send_session_answer
publish_transport_candidate
request_relay_path
close_session
```

## Discovery API

```text
publish_discovery_profile
remove_discovery_profile
search_by_interest
search_by_language
search_nearby
find_mutuals
request_random_match
publish_group_listing
search_groups
```

## Public room API

```text
subscribe_room
unsubscribe_room
publish_room_event
fetch_recent_room_events
announce_room_peer
```

## Client internal API

```text
send_message
retry_outbound_message
acknowledge_delivery
create_group
add_group_member
remove_group_member
send_group_message
join_room
leave_room
send_attachment
sync_device_history
```

```mermaid
flowchart TB
  Client[Client internal API]
  Client --> Presence
  Client --> Signalling
  Client --> Discovery
  Client --> Rooms[Public room API]
  Client --> Chain[Chain API]
  Presence --> Relay
  Signalling --> Relay
  Discovery --> Relay
  Rooms --> Relay
  Chain --> Runtime[Chain runtime]
```

## Local daemon control API v1

`startLocalDaemon` in `@nexnet/client` runs a Bun HTTP service bound only to
`127.0.0.1`. This is a privileged transport-control API, not an agent execution
service. The SDK is `LocalNexnet` from `@nexnet/client/local-sdk`; that entry
imports no device storage, signing keys or Bun server code.

**Keep the control token out of untrusted jobs.** It permits reading this
device's allowed-peer inbox and sending to every configured peer. Keep it in
the principal's trusted controller, not in job environments, container images
or model context. A job-facing API requires scoped grant enforcement, which is
not implemented. Loopback binding does not reduce the token's authority.

Every route requires `Authorization: Bearer TOKEN`, including status. The token
is a host-provided random 32-byte value encoded as 64 lowercase hex characters.
The daemon rejects reuse of the database unlock key as the control token.
Tokens in query strings are not accepted. Browser-origin requests and requests
with a different Host header are rejected. There is no CORS or remote binding
option. Responses disable caching. The SDK rejects redirects and non-loopback
origins rather than forwarding its token.

| Method | Route                     | Result                                                                                                    |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/status`              | Identity, device, authenticated connection status, certificate expiry and a transport-error flag          |
| POST   | `/v1/messages`            | `{peer, text}` becomes an encrypted durable outbox entry; HTTP 202 returns `{messageId, state: "queued"}` |
| GET    | `/v1/messages/:messageId` | `queued` or `delivered`, based on the durable queue and verified receipt-v2 contract                      |
| GET    | `/v1/inbox`               | A non-destructive snapshot of the durable inbox, with message IDs for caller-side deduplication           |
| GET    | `/v1/presence/:peer`      | Relay-observed `online: true`, `false`, or `null` when evidence is unavailable                            |

Successful JSON responses contain `{version: 1, data: ...}`. Errors contain
`{version: 1, error: {code: ...}}`. Authentication failures return 401, forbidden
peers return 403, malformed messages return 400, and transport failures return 503. Provider errors, key material and host paths are not returned over HTTP.
`status.transportError` records whether a transport error occurred since this
daemon started; it does not claim that an application task failed.

Messages are nonempty text of at most 4096 UTF-8 bytes. Unknown message fields
are rejected, and request bodies are limited to 16 KiB. A send response does
not imply delivery. `delivered` means verified durable recipient storage, not
accepted or completed execution. SDK timeouts and lost responses can leave an
ambiguous send result. The SDK does not retry automatically: durable request
idempotency is available through the agent-envelope routes below, not the raw
text-send route. The inbox currently returns the complete allowed-peer snapshot;
pagination, quotas, backpressure and retention remain later work.

### Host ownership and trusted peers

`LocalDaemonConfig.loadDevice()` obtains `PersistentClientConfig` from a
host-owned secret provider and explicitly selects `mode: "open"` or
`mode: "create"`. Creation additionally requires `DeviceCredentials` containing
only device authority. The existing `renewDeviceCertificate` callback returns
a principal-signed certificate, never a principal root key. The host signer
still owns principal authorisation checks; HTTP callers cannot provision
devices, change the signer, renew arbitrary certificates, or retrieve keys.

`loadControlToken()` supplies the independent control token. The host-only
`readOsSecret32({service, name})` helper reads a pre-provisioned hex secret using
`Bun.secrets`: macOS Keychain, Linux Secret Service, or Windows Credential
Manager. Missing, malformed or unavailable secrets reject startup without
environment, file or generated-key fallback. A host can instead use another
secret provider through the callbacks. The daemon does not create or modify
OS credentials, and a compromised host can still read the keys and inbox.

**The real OS Keychain path is untested.** Current tests stub `Bun.secrets.get`;
they prove validation and failure propagation, not native credential access.
A real macOS check requires permission to create, read and delete disposable
Keychain entries in the daemon user's login session, using the deployment Bun
runtime. Separate entries must supply the unlock key and control token. The
check must start the daemon with those readers, persist a message, restart in
a new process and recover it. Missing or malformed entries and an unavailable
or locked credential store must fail without a fallback. The test must not
print secrets, and must remove its entries and disposable database afterward.
Headless service access and any Keychain approval prompts must be checked in
the actual service account context, not inferred from an interactive shell.

`trustedPeerRoots` pins principal public keys. Identity IDs are derived from
those keys, not accepted as claims. Both sends and inbound DM processing
require membership. Disallowed inbound messages are rejected before prekey
lookups, ratchet updates, inbox insertion or acknowledgement. Narrowing the
allowlist while a disallowed peer has pending outbound messages rejects startup,
including messages waiting for backoff. Nothing is silently deleted or sent
under the old policy.

The daemon owns the encrypted device store for its entire lifetime. It waits
for relay authentication before opening the control listener. `close()` stops
new HTTP requests, drains active requests, then closes the client and releases
ownership. Start or restart failures leave the store intact. A host launcher
owns process supervision and OS service installation; neither is automatic.

### Implementation boundary

#9 supplies renewal and transport reception. #10 supplies verified root-free
receipts. #11 supplies crash-safe recovery with single-writer ownership. The
local daemon and SDK add privileged transport control, not receiver-verifiable
grants, bounded execution authority or a usable delegated-agent daemon. The
control token permits reading this device's allowed-peer inbox and sending to
all configured peers; it is not suitable for distribution to untrusted jobs.
Revocation remains open as #4. Certificate renewal does not revoke a stolen
credential. Accepted, completed and failed execution are not inferred from
queued or delivered transport states. A2A remains an optional future HTTP
adapter at agent endpoints, not an A2A-over-Nexnet binding.

## Agent envelopes v1: delivery is not execution

The privileged controller can exchange versioned `request`, `result` and
`error` envelopes over the existing authenticated, encrypted DM transport.
This adds lifecycle records, **not a job executor or permission to execute**.
The same control-token and trusted-peer restrictions above apply. Do not give
these SDK methods or their token to untrusted jobs. Grants remain unimplemented.

| Method | Route                                     | SDK method                       | Purpose                                                                   |
| ------ | ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/v1/agent/requests`                      | `submit(peer, request)`          | Durably queue a request or return the original request's state            |
| GET    | `/v1/agent/requests/:peer/:correlationId` | `execution(peer, correlationId)` | Separate transport and peer-reported execution states                     |
| GET    | `/v1/agent/inbox`                         | `agentInbox()`                   | Requests and explicit rejected-message records                            |
| POST   | `/v1/agent/admit`                         | `admit(peer, correlationId)`     | Record admission or reject expired new admission                          |
| POST   | `/v1/agent/respond`                       | `respond(peer, resultOrError)`   | Reject admission, or record completion or execution error after admission |

POST bodies are `{peer, envelope}`, except admission's `{peer, correlationId}`.
Each envelope has `version: 1`, `kind`, and `correlationId`. Requests additionally
have `capability`, `acceptBefore` (Unix milliseconds) and JSON `input`. Results
have `status: "accepted"`, or `status: "completed"` with JSON `value`. Errors
have `stage: "admission" | "execution"`, `code` and `message`. Unknown versions,
fields, invalid variants, non-JSON values, nesting beyond 12 levels and envelopes
over 4096 UTF-8 bytes are rejected. Correlation IDs use 1–128 ASCII letters,
digits, underscores or hyphens; controllers should generate at least 128 random
bits and persist the ID before submitting. Capability names are identifiers,
not verified capabilities or grant checks.

The outer DM remains CDE-encoded and device-authenticated. Envelope JSON is
inside its encrypted application payload (`contentType: "agent"`); it is not
a separate signature format. Identity comes from the verified DM sender, never
from an envelope's claimed sender. Request equality uses canonical CDE bytes,
so JSON object key order does not create a conflict.

### Admission deadlines do not bound execution

`AgentOutgoing.transport.state` is `queued | delivered`. Separately,
`execution` is one of:

- `{state: "awaiting_evidence"}`: no execution evidence yet, **not failure**.
- `{state: "accepted", outcome: "not_reported"}`: admitted, outcome unknown,
  **not failure and never permission to re-execute**.
- `{state: "completed", result}`: an explicit peer report of completion.
- `{state: "failed", error}`: an explicit peer admission or execution error.

Transport receipts only prove durable storage. There is no generic `unknown`
failure variant and no automatic execution retry. `acceptBefore` only prevents
**new admission** at or after the receiver's local wall-clock deadline. Admission
is checked again at the transaction commit, including after slow certificate or
bundle preparation. An expired request receives `admission_expired`, not a claim
that accepted work was cancelled. Clock synchronisation is the host's concern.

Once accepted, crossing that deadline leaves the state accepted with unknown
outcome until an explicit result or error arrives. Late evidence still counts;
reordered admission evidence cannot regress a terminal outcome. Conflicting
terminal evidence is rejected and exposed in `agentInbox()`, not overwritten.
A hard completion deadline or cancellation guarantee requires executor
cooperation and a cancellation protocol; neither is provided here.
The trusted controller can report an admission error before acceptance, such
as an unsupported capability. An admission error cannot undo accepted work;
only explicit execution evidence can settle its outcome.

### Durable idempotency is not exactly-once side effects

Incoming deduplication is scoped to the authenticated principal sender plus
correlation ID, including messages from different sender devices, within one
receiving device's store. The closed pilot requires one admitting device per
principal endpoint: independent receiving devices do not share admission records
and cannot promise cross-device deduplication. Outgoing records are scoped to recipient plus
correlation ID in this device's store. An identical repeated submission returns
the original message ID and state, even after restart. Changed content under the
same ID returns `correlation_conflict` (HTTP 409); conflicting inbound messages
are durable `rejected` entries rather than merged requests. Errors and results
must match the original authenticated recipient and correlation ID.

Admission returns `kind: "new_admission"` only for the operation that durably
commits acceptance; its type guarantees accepted state. Repeated/concurrent
admission or recovery returns `kind: "existing_decision"`, **never a new work
claim**. No work starts automatically. A trusted external executor must enforce
grants separately before executing anything. Do not treat admission as a grant.

Ratchet advancement, immutable response/request outbox and associated lifecycle
record commit in one encrypted SQLite transaction. Authenticated inbox messages
are replayed into lifecycle records with transactional processed markers, so a
crash between transport reception and application observation does not lose work.
Accepted state commits with its response before the HTTP admission reply. A crash
after that commit but before execution can therefore strand accepted work with
unknown outcome. Recovery must reconcile it, not execute it again. No atomicity
with external side effects or exactly-once execution is claimed.

Idempotency records and inbox/outbox currently have no automatic expiry or
pruning. Retention and quotas are later pieces; never delete deduplication records
while their IDs could be replayed. AD-25's compromised-host and old-snapshot
limitations still apply. Native Keychain round-trip remains untested as described
above. The stack is #9 renewal/reception, #10 verified root-free receipts, #11
crash-safe recovery/single-writer ownership, #12 privileged local daemon/SDK,
and these envelopes. It is still not a usable delegated-agent execution service:
receiver-verifiable grant enforcement is missing, revocation remains #4, and
delivery is not execution.
