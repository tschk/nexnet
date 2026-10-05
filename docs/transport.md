# Transport

## Connection modes

### Direct

```text
sender <-> recipient
```

Lowest latency and infrastructure cost. Peer IPs may be visible to each other.

### Private routed

```text
sender -> entry relay -> hop -> exit relay -> recipient
```

Peers do not directly learn each other's IP. Higher latency and bandwidth.
Each relay sees only a portion of the path.

### Fallback relay

```text
sender -> relay -> recipient
```

Used when direct NAT traversal fails. Relays transient encrypted traffic
**without** retaining private message history.

## Default routing policy

| Context                 | Default                                       |
| ----------------------- | --------------------------------------------- |
| Trusted contacts        | Direct when possible                          |
| Random matching         | Private routed                                |
| Public chatrooms        | Relay-assisted gossip                         |
| Attachments             | Direct only (AD-20)                           |
| Opt-in private sessions | Tor-style multi-hop when user enables (AD-21) |
| NAT failure             | Fallback relay                                |

### Opt-in private routing (AD-21)

Users may enable **Tor-style multi-hop** routing for sessions (not only random
match). Default for trusted contacts remains direct. Random match defaults to
private routed. Attachment **bodies** stay direct (AD-20) until a later lock.

```mermaid
flowchart TD
  Start[Need to connect] --> Known{Trusted contact?}
  Known -->|yes| DirectTry[Try direct]
  Known -->|no random match| Routed[Private routed]
  DirectTry -->|ok| Done[Session up]
  DirectTry -->|fail| Fallback[Fallback relay]
  Fallback --> Done
  Routed --> Done
```

## Signalling

Exchanges:

- session offers / answers
- ICE candidates or equivalent transport data
- ephemeral connection identifiers
- protocol capabilities
- relay path requests

Signalling payloads must be authenticated and minimise persistent identifiers.

## Relay verification

Recognised relays publish:

- relay identity key
- supported protocol versions
- reproducible build hash
- source commit
- binary checksum
- operator identity or pseudonymous operator key
- service endpoints
- uptime information
- optional attestation evidence

Checksum proves binary matches a known build. It does **not** prove the
operator is not logging metadata or modifying the environment.

Layered trust:

- reproducible builds
- signed releases
- multiple independent operators
- optional remote attestation
- client-selected relay sets
- onion-style multi-hop routing

## Pluggability

Transports should be pluggable (QUIC, WebRTC, etc.). Messaging logic depends
on session abstractions, not a single socket type.

See [stack.md](stack.md).
