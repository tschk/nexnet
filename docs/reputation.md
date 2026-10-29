# Reputation

Primarily for **random matching**.

Not a universal public social score.

## Inputs (possible)

- account age
- completed random conversations
- frequency of immediate disconnects
- peer blocks
- signed endorsements
- proof of established mutual relationships
- rate-limit compliance
- local trust lists

## Privacy

Do not put raw reports or detailed behavioural history on-chain.

Prefer signed credentials or local calculations:

```text
reputation_credential {
  subject_identity
  claim_type
  claim_value
  issued_at
  expires_at
  issuer
  signature
}
```

## Sybil resistance

Accounts free; usernames free but **max 1 owned per identity** (AD-10) →
cheap multi-wallet Sybil still possible, harder single-wallet hoarding.

Possible mechanisms:

- account age
- lightweight proof-of-work for match requests
- per-device quotas
- invitation graph weight
- rate limits
- optional refundable token deposits later
- relay-level abuse throttling

## First release (AD-18)

**Locked: numeric score with published weights** (not gates-only).

Use at least:

- account age
- completed random sessions
- immediate disconnect rate
- peer blocks received
- per-device rate-limit compliance
- local block lists / recent-match limits as hard gates beside the score

### v1 published weights (tunable; document changes)

```text
score =
  0.35 * age_component        // observed age lower bound, capped
+ 0.35 * completed_component  // completed sessions, diminishing returns
+ 0.15 * continuity_component // 1 - immediate_disconnect_rate
+ 0.15 * block_component      // inverse of recent blocks received

each component in [0, 1]
match if score >= threshold (initial: 0.25) AND hard gates pass
```

Exact constants live in protocol parameters / client config; this doc is the
canonical weight split until superseded. See OD-21 for fine-tuning.

Discovery currently computes a **conservative partial score**, not chain root
age: `age_component = min(1, (now - firstSeenAt) / REPUTATION_AGE_CAP_MS)`
uses the server-observed first verified profile publication, capped at 30 days.
Upserts preserve this timestamp; deleting and recreating may reset it. Legacy
client creation dates are ignored; their age starts when migrated.
`block_component = 1 / (1 + distinct verified blocking identities)`.
Completed and continuity components are zero until verifiable signed evidence
exists. The published weights and 0.25 gate remain unchanged; scores and
internal timestamps are never returned in public profile/search output.
