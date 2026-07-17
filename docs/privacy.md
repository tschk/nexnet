# Privacy boundaries

## What Nexnet cannot guarantee

- that recipients delete messages they already received
- that a relay did not retain network metadata

## What Nexnet can guarantee when implemented correctly

- message authenticity
- message integrity
- end-to-end confidentiality
- local-first storage
- no mandatory central private message history
- username ownership according to chain state
- immutable signed authorship records

## Content vs metadata

| Content privacy | Metadata privacy |
|---|---|
| E2EE payloads | IPs visible to direct peers / adjacent relays |
| No relay private history | Timing, sizes, durations observable |
| Local-only logs | Presence lease patterns |
| Signed authorship | Discovery lookup patterns |

Mitigations for metadata:

- onion routing
- padding
- rotating rendezvous identifiers
- short-lived presence identifiers
- minimal logs
- multi-relay queries

Documentation and UX must distinguish content privacy from metadata privacy.
