# Presence

Presence is **exact current online status**.

There is **no last-seen** field.

## Presence lease

Short-lived signed leases:

```text
presence_lease {
  identity_id
  device_id
  status: online
  relay_hint?
  issued_at
  expires_at
  nonce
  signature
}
```

**AD-11 locked duration: 90 seconds.**

Clients renew while active (typically before expiry, e.g. ~45–60s).
Expired lease → shown offline.

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Presence service
  participant S as Subscriber

  loop while active
    C->>P: publish_presence_lease
    Note over C,P: TTL 90s (AD-11)
  end
  S->>P: subscribe_presence(identity)
  P-->>S: online
  Note over C: stops renewing
  P-->>S: offline on expiry
```

## Visibility (AD-12)

**Locked v1: global exact online.** Anyone who can query the presence service
can see whether an identity is online. No contact-only gate in the first
release.

```text
v1: everyone can see who else is online (exact online / offline)
no last-seen
no historical presence trail in the product API
```

API should still be structured so later controls (contacts-only, hide from
strangers) can land without rewriting clients — but defaults are open.

## Metadata

Even without last-seen, presence servers observe behavioural timing.

Presence logs should be minimised and not retained longer than operationally
required.

## Interaction with messaging

- offline → sender enqueues locally
- online event → immediate delivery retry
- poll ceiling remains 30 minutes if events missed

See [messaging.md](messaging.md).
