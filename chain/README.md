# Nexnet chain app (`.in`)

Application logic for scarce public state. **No private chat content.**

## Status

Pure transition rules in `nexnet_chain.in`. Maps/storage land when inauguration
state primitives mature; executor may keep state off-language until then.

## Rules encoded

| Code | Meaning |
|------|---------|
| 0 | ok |
| 1 | username too short |
| 2 | username too long |
| 3 | wallet already owns username (AD-10) |
| 4 | account younger than 7d |
| 5 | username taken (owner active) |
| 10 | transfer disabled |
| 11 | group creator already set (AD-23) |
| 12 | relay key empty (AD-22) |
| 13 | identity root already bound |
| 20 | already a validator |
| 21 | insufficient stake |
| 22 | validator set full (max 21) |
| 23 | leave would drop below min 4 |
| 30 | identity id is not derived from the wallet |
| 31 | identity proof is not signed by the wallet |
| 32 | too many ssh keys (max 8) |
| 33 | ssh key already registered |
| 34 | ssh key revoked |
| 35 | credential commitment not signed by the wallet |
| 36 | revocation sequence stale |
| 37 | revocation not signed by the wallet |
| 38 | device certificate revoked (itself or its authorising credential) |
| 39 | device certificate expired |

Constants:

- `MIN_ACCOUNT_AGE_MS` = 7 days
- `INACTIVITY_RELEASE_MS` = 90 days
- validators: min 4, max 21, target 7 (AD-14)

## Run self-check

```bash
in execute chain/nexnet_chain.in
# expect exit / return 0
```

## Client mirror

`packages/client/src/chain-stub.ts` (`DevChainClient`) implements the same
rules in TypeScript for local dev until the `.in` executor is wired.

## Parity with the development chain

`packages/client/src/__tests__/chain-in-parity.test.ts` generates one-rule
programs from `nexnet_chain.in`, runs them with `in execute`, and checks the
exit status against what `DevChainClient` does for the same situation. The test
is skipped when `in` is not installed.

## What `.in` cannot do yet (verified against inauguration)

- **No map or table type.** `let m: Map<Int, Int>` fails with "unknown type in
  `let` annotation", so identities, usernames, credentials and revocations
  cannot live in `.in` state. The rules above take pre-resolved flags.
- **No Ed25519, BLAKE3 or CBOR in the language.** Signature checks, identity
  derivation and event verification stay in TypeScript, and the `.in` rules
  trust the flags the caller computes.
- **No state persistence, networking or consensus host.** There is no validator
  process, no chain endpoint and no light-client checkpoint format, so there is
  nothing for a gateway to point `NEXNET_CHAIN_ENDPOINT` or
  `NEXNET_CHAIN_CHECKPOINT` at. The gateway therefore runs only against the
  in-memory `DevChainClient` and refuses `NEXNET_MODE=chain`.
- Exit statuses carry one small integer, so a rule returns a code, not a value.
