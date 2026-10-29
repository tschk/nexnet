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

### AD-18 amendment — 2026-10-29: incomplete evidence ranks, never excludes

The composite-score eligibility cutoff is suspended while verified session
completion and continuity evidence is unavailable. Eligibility still requires
authenticated relay-observed presence, interest or language overlap, no block
in either direction between the pair, exclusion-list compliance, and request
rate limits. Interest and language search were never subject to this cutoff.

Reason: applying 0.25 to an incomplete score excluded a fresh unblocked profile
from random matching for about 8.6 days, making an all-new network unable to
match on day one. Missing evidence is neither evidence of bad behavior nor
earned credit. Do not fabricate session history or silently reduce the cutoff.

Published weights continue to rank eligible candidates. Observed age adds its
weighted contribution; each distinct signed blocker lowers rank. Absence of
reports adds no credit: center the inverse-block term at zero, preserving its
relative ordering. Missing completion and continuity components contribute
zero, with no normalization to pretend a complete score is available.

```text
partial_rank = 0.35 * observed_age - 0.15 * (1 - 1 / (1 + distinct_blockers))
eligibility = hard gates only; no composite-score cutoff
```

Select uniformly from the top-ranked half, including every tie at the cutoff.
This supports zero and negative partial ranks; all equally new candidates
remain selectable rather than being excluded by insertion order.

Public profiles and match results report `reputationEvidence: "insufficient"`.
The TUI labels this **Insufficient reputation evidence · not an adverse rating**.
This describes missing evidence, not account age or a negative assessment.
Observed negative signals affect private ranking independently; never return
numeric ranks, blocker identities, counts or block history. Restoring a
composite cutoff requires a separately reviewed policy change once verifiable
inputs exist; it must not turn on merely because a profile has aged.

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
historical full-evidence cutoff: 0.25 (inactive under the amendment above)
current matching: hard gates pass; partial score ranks only
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
exists. The published weights remain unchanged; the block component is centered
at zero for the partial rank above. Scores and internal timestamps are never
returned in public profile/search output.
